"use strict";
// The single server-side projection of an AFE.
//
// Every screen — requester wizard, coordinator review, approver decision, FA judgment —
// renders this one object, so they cannot disagree about what is true. Everything derived
// (validation, band, the chain preview, permissions) is computed here at read time from
// stored facts; nothing derived is ever written back.
const afeRules = require("../domain/afeRules");
const financials = require("../domain/financials");
const { FINANCIALS, COMMENT_STATES } = require("../domain/refData");
const cloudTree = require("../domain/cloudTree");
const people = require("../domain/people");
const rbac = require("../domain/rbac");
const features = require("../domain/features");
const coordination = require("../domain/coordination");
const conversation = require("../domain/conversation");
const routingSvc = require("../routing");
const resume = require("../domain/resume");
const { OWN_OUTPUT } = require("../envelopeDocs");

const EDITABLE_BY_OWNER = ["draft", "returned"];
/** Where the owner side's Ask reaches Fixed Assets (R163). */
const ASK_FA_STATES = ["approved", "fa_review", "issued", "tracking", "capitalized"];
const OPEN_STATES = ["draft", "submitted", "in_approval", "on_hold", "returned"];

/** What this caller may do with this AFE, decided server-side. */
function permissionsFor(afe, ctx, extra) {
  const roles = (ctx && ctx.roles) || [];
  const email = ctx && ctx.user ? ctx.user.email : null;
  const coordinatorFor = (ctx && ctx.coordinatorFor) || [];
  const routing = extra && extra.routing ? extra.routing : null;
  const envelope = extra && extra.envelope ? extra.envelope : null;
  const state = afe.state;

  const isRequester = Boolean(email) && Boolean(afe.requester) && afe.requester.email === email;
  const isPreparer = Boolean(email) && Boolean(afe.preparer) && afe.preparer.email === email;
  const isCoordinator = roles.includes("coordinator") &&
    (coordinatorFor.includes(afe.division) || Boolean(afe.coordinator && afe.coordinator.email === email));
  const isFa = roles.includes("fa_preparer") || roles.includes("fa_checker");
  const isLeadership = roles.includes("leadership");
  const isAdmin = roles.includes("admin");
  const ownerSide = isRequester || isPreparer || isCoordinator;

  const recipients = (routing && routing.recipients) || [];
  const isRecipient = recipients.some((r) => r.role !== "cc" && people.userMatches(ctx, r));
  const current = routing && routing.status === "active" ? recipients.find((r) => r.status === "sent") : null;
  const isCurrentRecipient = Boolean(current) && people.userMatches(ctx, current);
  const simulated = !envelope || envelope.provider === "simulated";
  // Who reviews THIS AFE (R157) — the lifecycle guard's own rule, not a second copy of it. A
  // coordinator of the division who raised it is `isCoordinator` (they see it, and write on the
  // owner side of the thread) but not `coordinates`: the assigned coordinator reviews it.
  const coordinates = coordination.coordinates(ctx || {}, afe);
  const canSend = ["draft", "submitted", "returned"].includes(state) && coordination.maySend(ctx || {}, afe);
  const canComment = (ownerSide || isRecipient || isFa || isLeadership || isAdmin) && COMMENT_STATES.includes(state);
  // Who an Ask would reach (R163) — named, so the button can say it. Somebody off the owner side
  // asks the requester; the owner side asks whoever holds the AFE now, and before anybody else
  // has it there is nobody to ask. The transition decides the audience itself and refuses an ask
  // that would reach nobody; this is the same answer in the words a button uses.
  const firstName = (p) => (p && p.name ? String(p.name).split(" ")[0] : null);
  const mySide = isRequester ? "requester" : isPreparer ? "preparer" : isCoordinator ? "coordinator" : null;
  const target = ownerSide ? conversation.askTarget(mySide, afe) : null;
  const askWho = !canComment ? null
    : !ownerSide ? firstName(afe.requester) || "the requester"
    : target === "requester" ? firstName(afe.requester) || "the requester"
    : target === "coordinator" ? firstName(afe.coordinator) || "the coordinator"
    : ["in_approval", "on_hold"].includes(state) ? (current ? firstName(current) : null)
    : ASK_FA_STATES.includes(state) ? "Fixed Assets"
    : state === "returned" && afe.returnedTo && afe.returnedTo.role !== "coordinator" ? firstName({ name: afe.returnedTo.byName })
    : null;

  return {
    isRequester, isPreparer, isCoordinator, coordinates, isFa, isLeadership, isAdmin, isRecipient, isCurrentRecipient,
    canView: ownerSide || isRecipient || isFa || isLeadership || isAdmin,
    canEdit: (EDITABLE_BY_OWNER.includes(state) && ownerSide) || (state === "submitted" && coordinates),
    canSubmit: EDITABLE_BY_OWNER.includes(state) && ownerSide,
    canSend,
    canEditRouting: canSend,
    canCoordinate: coordinates,
    canSign: state === "in_approval" && isCurrentRecipient && simulated,
    canQuestion: state === "in_approval" && isCurrentRecipient,
    canDecline: state === "in_approval" && isCurrentRecipient,
    canSendBack: (["in_approval", "on_hold"].includes(state) && isCurrentRecipient) ||
      (["submitted", "in_approval", "on_hold"].includes(state) && coordinates),
    canAnswer: state === "on_hold" && ownerSide,
    // Anyone who can see it may say something on it while it is alive (R149). Saying it tells
    // nobody; ASKING tells the other side and waits for their answer (R163).
    canComment,
    canAsk: Boolean(askWho),
    askWho,
    // What the composer's main button ANSWERS, when something waits on this viewer (2026-10-16).
    // Two look-alike systems had opposite rules: a comment did NOT answer an approver's pausing
    // question (only the separate Answer button did — the hold stayed, the approver was not
    // told), while a comment DID answer an ask, under a placeholder saying nobody is e-mailed.
    answerTo: (() => {
      if (state === "on_hold" && ownerSide) {
        const q = (afe.thread || []).filter((t) => t.kind === "question" && !t.resolvedAt).slice(-1)[0];
        if (q) return { mode: "question", byName: q.byName || null, text: String(q.text || "").slice(0, 200) };
      }
      if (!canComment) return null;
      const lineSide = mySide || (isFa ? "fa" : isRecipient ? "approver" : null);
      if (!lineSide) return null;
      const mine = String(email || "").toLowerCase();
      const waiting = conversation.openAsks(afe.thread)
        .filter((x) => String(x.byEmail || "").toLowerCase() !== mine && conversation.answers(x, { side: lineSide })).slice(-1)[0];
      return waiting ? { mode: "ask", byName: waiting.byName || null, text: String(waiting.text || "").slice(0, 200) } : null;
    })(),
    canWithdraw: ownerSide && OPEN_STATES.includes(state),
    canJudge: isFa && state === "fa_review",
    canRecordIo: roles.includes("fa_preparer") && state === "fa_review",
    canReturn: isFa && state === "fa_review",
    canReclassify: isFa && state === "fa_review",
    canAckFlags: isFa && state === "fa_review",
    canDraftDigest: isFa && state === "fa_review",
    canAttachEvidence: isFa && state === "fa_review",         // an email approval, as drift evidence
    canTickSteps: isFa && ["issued", "tracking"].includes(state),
    canCapitalize: roles.includes("fa_preparer") && ["issued", "tracking"].includes(state),
    // Four eyes: whoever capitalized it cannot close it, whatever roles they hold.
    canClose: roles.includes("fa_checker") && state === "capitalized" &&
      !(afe.fa && afe.fa.capitalized && afe.fa.capitalized.byEmail === email),
    capitalizedByMe: Boolean(afe.fa && afe.fa.capitalized && afe.fa.capitalized.byEmail === email),
  };
}

/** The little the list and queue screens need to know about where the chain stands. */
/**
 * The financial case as the screens and the printed pages both read it (R94).
 *
 * `null` when there is nothing in it: an empty grid is not a case with zeroes in it, and the
 * wizard shows an invitation rather than eleven columns of nothing.
 */
function financialsFor(afe) {
  return financials.fromAfe(afe, FINANCIALS);
}

function routingBrief(routing) {
  if (!routing) return null;
  const signers = routing.recipients.filter((r) => r.role !== "cc");
  const holder = signers.find((r) => r.status === "sent") || null;
  return {
    id: routing.id, round: routing.round, status: routing.status,
    signed: signers.filter((r) => r.status === "signed").length,
    of: signers.filter((r) => r.order !== null).length,
    holder: holder ? { recipientId: holder.id, name: holder.name, level: holder.level, role: holder.role, since: holder.notifiedAt } : null,
  };
}

/**
 * @param {object} repos
 * @param {object} afe    the stored aggregate
 * @param {object} ctx    request context (may be null for internal callers)
 * @param {object} opts   { full: true } to include the heavier derived parts
 */
async function afeView(repos, afe, ctx, opts) {
  const options = opts || {};
  const routing = afe.routingId ? await repos.routings.get(afe.routingId) : null;
  const envelope = afe.envelopeId ? await repos.envelopes.get(afe.envelopeId) : null;

  // "May this person do the thing they are asking for" needs the routing and the envelope and
  // nothing else. Every write route used to answer it by building the whole projection — the
  // matrix scan, the pot's siblings, the duplicate search, the location list and forty-odd
  // validation rules — and then build it a second time for the response. On the wizard that was
  // twice per keystroke (R92).
  if (options.permissionsOnly) {
    return { afe, permissions: permissionsFor(afe, ctx || {}, { routing, envelope }) };
  }

  const matrixRow = afe.costCenter
    ? await repos.matrix.find((m) => m.costCenter === String(afe.costCenter))
    : null;

  // The budget pot this AFE draws on, with what is left after other AFEs on the same pot.
  let pot = null;
  if (afe.budget && afe.budget.potId) {
    const row = await repos.budgetPots.get(afe.budget.potId);
    if (row) {
      const siblings = await repos.afes.all(
        (x) => x.id !== afe.id && x.budget && x.budget.potId === row.id &&
          !["withdrawn", "rejected", "returned", "draft"].includes(x.state)
      );
      // `remaining` excludes this AFE deliberately: a draft has not consumed anything, and
      // "what is left before mine" is what the approver's question needs answering.
      const committed = siblings.reduce((n, x) => n + afeRules.total(x), 0);
      pot = Object.assign({}, row, {
        committedUsd: committed,
        remainingUsd: row.amountUsd - committed,
        thisAfeUsd: afeRules.total(afe),
        remainingAfterThisUsd: row.amountUsd - committed - afeRules.total(afe),
      });
    }
  }

  // Another open AFE on the same cost centre with a similar title is worth a word, never a
  // block — recurring programmes legitimately repeat (R52, hardware refresh).
  const possibleDuplicates = [];
  if (afe.costCenter && afe.project && afe.project.title) {
    const words = String(afe.project.title).toLowerCase().split(/\W+/).filter((w) => w.length > 3);
    const cutoff = Date.now() - afeRules.THRESHOLDS.duplicateWindowDays * 86400000;
    const others = await repos.afes.all((x) => x.id !== afe.id && x.costCenter === afe.costCenter &&
      !["withdrawn", "rejected", "closed"].includes(x.state) && new Date(x.createdAt).getTime() > cutoff);
    for (const o of others) {
      const t = String((o.project && o.project.title) || "").toLowerCase();
      const shared = words.filter((w) => t.includes(w)).length;
      if (words.length && shared / words.length >= 0.5) {
        possibleDuplicates.push({ id: o.id, title: o.project.title, state: o.state, totalUsd: afeRules.total(o) });
      }
    }
  }

  // The order a supplemental tops up: one this tool issued, or a line the AuC recon extract
  // knows about (most orders predate the workbench).
  let originalIo = null;
  if (afe.kind === "supplemental" && afe.supplementalOf && afe.supplementalOf.ioNumber) {
    const number = String(afe.supplementalOf.ioNumber).trim();
    originalIo = await repos.ios.find((i) => i.ioNumber === number);
    if (!originalIo) {
      const recon = await repos.tracker.find((t) => t.ioNumber === number);
      if (recon) originalIo = { ioNumber: number, source: "auc_recon", description: recon.ioDescription, costCenter: recon.costCenter, issuedAt: recon.issueDate };
    }
  }

  // The active location codes, so `location_in_list` can tell a real site from a typo. Reading
  // them here rather than importing a constant is the point of R88: the list is master data the
  // business maintains, not something a deploy changes.
  const locations = (await repos.locations.all((l) => l.active !== false)).map((l) => l.code);

  const validation = afeRules.validate(afe, {
    matrixRow,
    today: new Date().toISOString().slice(0, 10),
    pot,
    originalIo,
    possibleDuplicates,
    locations,
  });

  // Pot balances are the coordinator's and Fixed Assets' to see, not the requester's (R167). The
  // rule says THAT an AFE does not fit; the figure travels as data and is printed here for a viewer
  // who may see pots. Somebody who signs this AFE sees it too: they are deciding whether to spend
  // the money, and the exception printed on the form they sign carries the figure anyway. No viewer
  // at all is an internal caller — the send that freezes those exceptions onto the form — so the
  // approvers keep reading exactly what they read before.
  const signsThis = Boolean(ctx) && Boolean(routing)
    && (routing.recipients || []).some((r) => r.role !== "cc" && people.userMatches(ctx, r));
  const seesPots = !ctx || signsThis || rbac.can(ctx, "pots.read") || rbac.can(ctx, "pots.all");
  const touched = [];
  for (const item of [].concat(validation.blocks || [], validation.warns || [], validation.pending || [])) {
    if (!item.data || item.data.remainingUsd === undefined) continue;
    touched.push(item);
    if (seesPots) item.message = `${String(item.message).replace(/\.$/, "")}: $${Math.round(item.data.remainingUsd).toLocaleString("en-US")}.`;
    else delete item.data.remainingUsd;
  }
  if (touched.length) {
    // Both lists below were copied from the items before the figure was settled.
    validation.exceptions = afeRules.exceptions(validation);
    validation.noteable = (validation.noteable || []).map((n) => {
      const item = touched.find((t) => t.rule === n.rule && t.field === n.field);
      return item ? Object.assign({}, n, { message: item.message }) : n;
    });
  }
  const potSeen = pot && !seesPots
    ? { id: pot.id, division: pot.division, region: pot.region, fiscalYear: pot.fiscalYear, budgetCategory: pot.budgetCategory }
    : pot;

  const view = {
    afe,
    validation,
    totalUsd: afeRules.total(afe),
    lineTotalUsd: afeRules.lineTotal(afe),
    quoteTotalUsd: afeRules.quoteTotal(afe),
    band: validation.band,
    costCentre: matrixRow ? {
      costCenter: matrixRow.costCenter, description: matrixRow.description,
      plant: matrixRow.plant, status: matrixRow.status, levels: matrixRow.levels,
    } : null,
    pot: potSeen,
    // Whether a priced document is read when it is attached (R170) — so the quote step can offer
    // "Read it" on one attached before the switch, and say nothing at all while it is off.
    readerOn: await features.isOn(repos, "quoteReading"),
    cloud: cloudTree.evaluate((afe.cloud) || {}),
    // The financial case, computed at read time like everything else here (R94). It is derived
    // and never stored: change an amount and the NPV moves on the next read, which is the only
    // way a figure on a screen and a figure on the printed page can be the same figure.
    financials: financialsFor(afe),
    possibleDuplicates,
    routingBrief: routingBrief(routing),
    envelopeBrief: envelope ? { id: envelope.id, provider: envelope.provider, status: envelope.status, envelopeId: envelope.envelopeId,
      sentAt: envelope.sentAt, completedAt: envelope.completedAt, voidedAt: envelope.voidedAt } : null,
    permissions: permissionsFor(afe, ctx || {}, { routing, envelope }),
    // Each ask in the conversation and whether it is still open (R163), derived from the thread.
    asks: conversation.asks(afe.thread),
  };

  if (options.full) {
    view.routing = routing;
    view.envelope = envelope;
    // The chain as it would be sent — derived while the AFE can still change; frozen after.
    view.routingPreview = ["draft", "submitted", "returned"].includes(afe.state) ? await routingSvc.preview(repos, afe) : null;
    const history = await repos.routings.all((r) => r.afeId === afe.id && r.id !== afe.routingId);
    view.routingHistory = history
      .sort((a, b) => (a.round || 0) - (b.round || 0))
      .map((r) => Object.assign(routingBrief(r), { createdAt: r.createdAt, voidedAt: r.voidedAt || null, voidReason: r.voidReason || null }));
    view.thread = afe.thread || [];
    view.ios = await repos.ios.all((i) => i.afeId === afe.id);
  }
  // What a resubmission would do (R148), asked of the SAME function the transition decides
  // with, so the review screen cannot promise "straight back" about an AFE Submit then sends round
  // again. On every view, not only the full one: the wizard refreshes it after each save, and an
  // edit to the money is exactly what flips the answer.
  if (afe.state === "returned" && routing) {
    const preview = routing.status === "returned" ? (view.routingPreview || await routingSvc.preview(repos, afe)) : null;
    const documents = (afe.documents || []).filter((d) => !OWN_OUTPUT.includes(d.role))
      .map((d) => ({ attachmentId: d.attachmentId, filename: d.filename }));
    view.resume = resume.resumeCheck({ afe, routing, envelope, preview, documents });
  } else {
    view.resume = null;
  }
  return view;
}

/** A compact row for lists — queues, "my requests", the coordinator's inbox. */
function afeBrief(afe) {
  return {
    id: afe.id,
    afeNo: afe.afeNo || null,
    state: afe.state,
    kind: afe.kind,
    round: afe.round || 1,
    title: (afe.project && afe.project.title) || "(untitled)",
    projectType: (afe.project && afe.project.projectType) || null,
    requester: afe.requester || null,
    preparer: afe.preparer || null,
    coordinator: afe.coordinator || null,
    division: afe.division || null,
    region: afe.region || null,
    costCenter: afe.costCenter || null,
    classification: (afe.money && afe.money.classification) || null,
    totalUsd: afeRules.total(afe),
    band: afeRules.bandFor(afe).label,
    budgeted: (afe.budget && afe.budget.budgeted) || null,
    // Where the equipment comes from (R150), or null for an AFE the question is not asked of.
    sourcing: sourcingOfAfe(afe),
    hold: afe.hold || null,
    createdAt: afe.createdAt,
    updatedAt: afe.updatedAt,
    submittedAt: afe.submittedAt || null,
    sentAt: afe.sentAt || null,
    approvedAt: afe.approvedAt || null,
    // The last word in the conversation, so a list can say whose turn it is (R149), and the ask
    // still waiting for an answer — which is what puts an AFE in somebody's "Needs you" (R163).
    talk: lastTalk(afe),
    openAsk: lastOpenAsk(afe),
  };
}
function sourcingOfAfe(afe) { return afeRules.sourcingApplies(afe) ? afeRules.sourcingOf(afe) : null; }
function lastOpenAsk(afe) {
  const a = conversation.openAsks(afe && afe.thread).slice(-1)[0];
  return a ? { id: a.id, side: a.side, askedOf: a.askedOf || null, byName: a.byName, at: a.at, text: String(a.text || "").slice(0, 140) } : null;
}
function lastTalk(afe) {
  const t = ((afe && afe.thread) || []).slice(-1)[0];
  return t ? { kind: t.kind, side: t.side || null, byName: t.byName || null, at: t.at || null } : null;
}

module.exports = { afeView, afeBrief, permissionsFor, routingBrief, sourcingOfAfe };
