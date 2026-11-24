"use strict";
// THE single place an AFE's state changes. Routes call applyTransition(); the UI only
// reflects what it allows; the server enforces (CLAUDE.md: one lifecycle mutator).
//
// States: draft → submitted → in_approval ⇄ on_hold → approved → fa_review → issued →
// tracking → capitalized → closed; side states returned, rejected, withdrawn
// (docs/v0.4-blueprint.md §5.1). Stage 2 implements the request-to-approval half. The
// Fixed Assets actions land here too: fa_return, fa_record_io, add_child_io, move_budget,
// capitalize and close. The last two are FOUR EYES: the preparer capitalizes, and a different
// person on the FA team closes. That is the one control in this table where the guard is not
// about a role but about an identity.
//
// This is the one orchestrator under lib/domain that touches storage. Every effect runs
// guard → repo write → audit.record → notify.enqueue, in that order, and the routing
// snapshot is frozen here at send and only ever annotated afterwards.
const audit = require("../audit");
const notify = require("../notify");
const afeRules = require("./afeRules");
const people = require("./people");
const coordination = require("./coordination");
const conversation = require("./conversation");
const docusign = require("../integrations/docusign");
const envelopeDocs = require("../envelopeDocs");
const routingSvc = require("../routing");
const redFlags = require("./redFlags");
const sapSheet = require("./sapSheet");
const ioRegistry = require("./ioRegistry");
const snapshots = require("../ingest/snapshots");
const { ORDER_TYPES, CAPITALIZATION_TOLERANCE, FA_HANDOFF, ISSUE_HANDBACK, FA_ISSUE_APPROVAL, COMMENT_STATES, THREAD_SIDES, HANDOFF_STEPS } = require("./refData");
const envelopeSpec = require("../integrations/envelopeSpec");
const issuedPack = require("../pdf/issuedPack");
const attachments = require("../attachments");
const { issueApprovers, issueApproverChoice } = require("./issueApproval");
const resume = require("./resume");
const { afeView, permissionsFor } = require("../views/afeView");

const nowIso = () => new Date().toISOString();
const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
const titleOf = (afe) => (afe.project && afe.project.title) || "(untitled AFE)";
const describe = (afe) => `"${titleOf(afe)}" · ${money(afeRules.total(afe))} · cost centre ${afe.costCenter || "?"}`;
const nameOf = (ctx) => (ctx.userRow && ctx.userRow.displayName) || (ctx.user && ctx.user.displayName) || (ctx.user && ctx.user.email) || "system";

// ---- reading the routing ---------------------------------------------------------------
const signers = (routing) => ((routing && routing.recipients) || []).filter((r) => r.role !== "cc");
const holder = (routing) => signers(routing).find((r) => r.status === "sent") || null;    // who has it now
const nextPending = (routing) => signers(routing).filter((r) => r.status === "pending").sort((a, b) => a.order - b.order)[0] || null;
const signerCount = (routing) => signers(routing).filter((r) => r.order !== null).length;
const recipientById = (routing, id) => ((routing && routing.recipients) || []).find((r) => r.id === id) || null;

// ---- who may do what -------------------------------------------------------------------
const roles = (ctx) => (ctx && ctx.roles) || [];
const IS = {
  requester: (ctx, afe) => Boolean(afe.requester && ctx.user && afe.requester.email === ctx.user.email),
  preparer: (ctx, afe) => Boolean(afe.preparer && ctx.user && afe.preparer.email === ctx.user.email),
  coordinator: (ctx, afe) => roles(ctx).includes("coordinator") &&
    ((ctx.coordinatorFor || []).includes(afe.division) || Boolean(afe.coordinator && ctx.user && afe.coordinator.email === ctx.user.email)),
  system: (ctx) => roles(ctx).includes("system"),
  holder: (ctx, afe, routing) => people.userMatches(ctx, holder(routing)),
  fa: (ctx) => roles(ctx).includes("fa_preparer") || roles(ctx).includes("fa_checker"),
  faPreparer: (ctx) => roles(ctx).includes("fa_preparer"),
};
IS.owner = (ctx, afe) => IS.requester(ctx, afe) || IS.preparer(ctx, afe);
IS.ownerSide = (ctx, afe) => IS.owner(ctx, afe) || IS.coordinator(ctx, afe);
// Who REVIEWS this AFE and who may send it (R157): the assigned coordinator, or a coordinator of
// the division standing in who did not raise it; the owner only where there is no coordinator
// (R41). `IS.coordinator` above is still the broader "holds coordination for the division",
// which decides what somebody may see and which side of the thread they write on.
IS.coordinates = (ctx, afe) => coordination.coordinates(ctx, afe);
IS.sender = (ctx, afe) => coordination.maySend(ctx, afe);

// ---- effects --------------------------------------------------------------------------------
function ownerSideEmails(afe) {
  const out = [];
  for (const p of [afe.requester, afe.preparer, afe.coordinator]) if (p && p.email && !out.includes(p.email)) out.push(p.email);
  return out;
}
/**
 * ONE mail for one event (R164): the first address on the To line, everyone else copied, each
 * person once however many hats they wear. "How many emails will one AFE send from beginning to
 * end?" (Judithmelanie, Meeting #7) — the answer was three copies of the same news whenever it concerned
 * the requester, the preparer and the coordinator, because each was a row of their own.
 */
function oneMail(emails, names) {
  const seen = new Set();
  const list = [];
  for (const e of emails || []) { const n = people.normEmail(e); if (n && !seen.has(n)) { seen.add(n); list.push(e); } }
  if (!list.length) return null;
  return { recipientEmail: list[0], recipientName: (names && names[people.normEmail(list[0])]) || null, cc: list.slice(1) };
}
/** The AFE's own people as one mail — the requester addressed — plus anyone else named, the actor left out. */
function ownerMail(afe, extra, actorEmail) {
  const base = ownerSideMail(afe, actorEmail || null);
  const actor = people.normEmail(actorEmail);
  const rest = (extra || []).filter((e) => e && people.normEmail(e) !== actor);
  if (!base) return oneMail(rest);
  const mail = oneMail([base.recipientEmail].concat(base.cc, rest));
  mail.recipientName = base.recipientName;
  return mail;
}
/**
 * Whose a returned AFE is (R147): the requester, always.
 *
 * "At any workflow, if it gets rejected, it should go back to the project manager's bucket,
 * whoever raised the initial AFE" (Jarrod, Meeting #6). `returnedTo` used to record only who sent
 * it back, and the mail went to the requester, the preparer and the coordinator as three equal
 * addressees, so the coordinator was told it was theirs exactly as loudly as the person who
 * raised it. This says whose it IS, not who may touch it: anyone on the owner side may still
 * fix it and resubmit.
 */
const returnee = (afe) => (afe.requester && afe.requester.email
  ? { email: people.normEmail(afe.requester.email), name: afe.requester.name || afe.requester.email } : null);
/**
 * ONE mail to the owner side: the requester addressed, the preparer and the coordinator copied,
 * and never the person acting, who is not mailed about their own action. When that IS the
 * requester, the next of them is addressed, so the mail still reaches somebody.
 */
function ownerSideMail(afe, actorEmail) {
  const actor = people.normEmail(actorEmail);
  const out = [];
  for (const p of [afe.requester, afe.preparer, afe.coordinator]) {
    const e = people.normEmail(p && p.email);
    if (e && e !== actor && !out.some((x) => x.email === e)) out.push({ email: e, name: p.name || null });
  }
  if (!out.length) return null;
  return { recipientEmail: out[0].email, recipientName: out[0].name, cc: out.slice(1).map((x) => x.email) };
}
/**
 * The mail the approver whose turn it is actually receives.
 *
 * It is DocuSign's, not ours: the same subject as the envelope, the same message, the same
 * reminder and expiry wording — built from the definition sitting on the envelope, so what is
 * queued here in simulation is what DocuSign sends once the integration key exists. Nobody
 * composes it and nobody sets it up.
 */
async function notifySigner(repos, afe, routing, rec, envelope) {
  // On a LIVE envelope DocuSign sends this mail itself (R164): queuing ours as well would put two
  // signing requests in the approver's inbox for one signature.
  if (envelope && envelope.provider && envelope.provider !== "simulated") return;
  const spec = (envelope && envelope.spec)
    || envelopeSpec.buildSpec({ afe, routing, documents: [], anchors: [] });
  const mail = envelopeSpec.signatureRequestEmail({ afe, spec, recipient: rec, envelope });
  await notify.enqueue(repos, {
    recipientEmail: rec.email, recipientName: rec.name, afeId: afe.id, kind: "approval_needed",
    subject: mail.subject, body: mail.body,
    meta: { envelopeId: envelope ? envelope.envelopeId : null, provider: envelope ? envelope.provider : null },
  });
}
/**
 * The shared Fixed Assets mailbox: the org rule that already copies FA on every envelope,
 * marked `handoff` (seed/org-rules.json rule-0004, R58) — business config as data, editable in
 * Admin, never a literal here. FA_MAILBOX overrides it per environment.
 */
async function handoffMailbox(repos) {
  const rule = (await repos.orgRules.all((x) => x.kind === "cc" && x.active !== false && x.handoff))[0] || null;
  return {
    email: String(process.env.FA_MAILBOX || "").trim() || (rule && rule.person ? rule.person.email : ""),
    name: (rule && rule.person && rule.person.name) || "Fixed Assets",
  };
}

/**
 * What SAP has told us about one order number: the AuC recon's lines and the latest active
 * order-master batch's row. Read for `ioRegistry.sapConflict`, which decides.
 */
async function sapRowsFor(repos, number) {
  const n = String(number);
  const rows = (await repos.tracker.all((t) => String(t.ioNumber) === n)).map((t) => ({
    source: "AuC recon", description: t.ioDescription || null, costCenter: t.costCenter || null,
    openedOn: t.issueDate || null, aucNumber: t.aucNumber || null, afeId: t.afeId || null,
  }));
  const batch = await snapshots.activeFor(repos, "io_master");
  if (batch) {
    for (const m of await repos.ioMaster.all((x) => x.batchId === batch.id && String(x.ioNumber) === n)) {
      rows.push({ source: "SAP order master", description: m.description || null, costCenter: m.costCenter || null,
        openedOn: m.createdOn || null, aucNumber: null, afeId: null });
    }
  }
  return rows;
}

async function validationFor(repos, afe) {
  return (await afeView(repos, afe, null)).validation;
}
/** Void the envelope and close the routing round; nothing is deleted, statuses say what happened. */
async function closeRound(routing, envelope, reason, at, routingStatus) {
  if (envelope) await docusign.voidEnvelope(envelope, reason, at);
  if (routing) {
    routing.status = routingStatus || "superseded";
    routing.voidedAt = at;
    routing.voidReason = reason;
    // `returned` is the holder of a round that a send-back paused (R148).
    for (const r of routing.recipients) if (["pending", "sent", "returned"].includes(r.status)) r.status = "superseded";
    const pause = resume.currentPause(routing);
    if (pause) { pause.closedAt = at; pause.closedBecause = reason; }
  }
}

/** The supporting documents an AFE carries now: everything that is not the tool's own output. */
const supportingDocs = (afe) => (afe.documents || [])
  .filter((d) => !envelopeDocs.OWN_OUTPUT.includes(d.role))
  .map((d) => ({ attachmentId: d.attachmentId, filename: d.filename }));

/** Whether a returned AFE goes back into its round (R148), with the chain the check needs. */
async function roundCheck(repos, afe, routing, envelope) {
  const preview = routing && routing.status === "returned" ? await routingSvc.preview(repos, afe) : null;
  return resume.resumeCheck({ afe, routing, envelope, preview, documents: supportingDocs(afe) });
}

/**
 * The round goes on (R148): back to whoever was holding it, on the same envelope, with every
 * signature already given still on it. For a Fixed Assets return, straight back to them.
 */
async function goOn({ repos, ctx, afe, routing, envelope, check, at }) {
  const fixed = afe.returnedTo || {};
  afe.returnedTo = null;
  afe.hold = null;
  if (check.mode === "signed") {
    afe.fa = afe.fa || {};
    afe.fa.receivedAt = at;
    const faPreparers = await repos.users.all((u) => u.active !== false && (u.roles || []).includes("fa_preparer"));
    await notify.enqueue(repos, Object.assign(oneMail(faPreparers.map((u) => u.email)) || { recipientEmail: null }, {
      afeId: afe.id, kind: "afe_resubmitted",
      subject: `Back with Fixed Assets: ${titleOf(afe)}`,
      body: `${describe(afe)}\n${nameOf(ctx)} fixed what ${fixed.byName} asked for ("${fixed.reason}"). Nothing that decides it changed, so the signatures stand. Open ${notify.link(`/fa/${afe.id}/judge`)}`,
    }));
    return { state: "fa_review", note: "back with Fixed Assets — nothing that decides it changed, so the signatures stand",
      audit: { signaturesStand: true, fixedReason: fixed.reason, returnedBy: fixed.byEmail } };
  }

  const pause = resume.currentPause(routing);
  const rec = recipientById(routing, check.holder.id);
  routing.status = "active";
  rec.status = "sent";
  rec.notifiedAt = at;
  // DocuSign kept the envelope while it was back, and the poll job held whatever it reported in
  // that time rather than apply it to an AFE that was not in approval. The next poll reads it
  // again, whatever its own look-back says.
  if (envelope && envelope.provider !== "simulated") envelope.reconcile = true;
  const changed = resume.changedFields(pause.values, afe);
  const kept = check.signed.length;
  Object.assign(pause, { resumedAt: at, resumedByEmail: ctx.user.email, resumedByName: nameOf(ctx), changed, kept });
  const stand = kept === 1 ? `${check.signed[0].name}'s signature stands` : kept ? `the ${kept} signatures already given stand` : "";
  const copy = ownerSideMail(afe, ctx.user.email);
  await notify.enqueue(repos, {
    recipientEmail: rec.email, recipientName: rec.name, cc: copy ? [copy.recipientEmail].concat(copy.cc) : [],
    afeId: afe.id, kind: "approval_resumed",
    subject: `Back for signature: ${titleOf(afe)}`,
    body: [
      describe(afe), "",
      `${nameOf(ctx)} resubmitted it after ${fixed.byName || "an approver"} sent it back${fixed.reason ? `: "${fixed.reason}"` : ""}.`,
      changed.length ? `Changed: ${changed.join(", ")}.` : "Nothing on the form was edited.",
      `Nothing that decides it changed${stand ? `, so ${stand}` : ""}. It is the same envelope, and it is with ${rec.name} again.`,
      `Open ${notify.link(`/approve/${afe.id}`)}`,
    ].join("\n"),
  });
  return {
    state: "in_approval",
    note: `back with ${rec.name} — nothing that decides it changed${stand ? `, so ${stand}` : ""}`,
    audit: { resumed: true, recipientId: rec.id, holder: rec.name, kept, changed, fixedReason: fixed.reason || null,
      returnedBy: fixed.byEmail || null, envelopeId: envelope ? envelope.envelopeId : null },
  };
}

/** A paused round that will not go on is closed, and saved at once: no second envelope is ever open. */
async function closePaused(repos, routing, envelope, check, at) {
  await closeRound(routing, envelope, `superseded — ${check.reasons.map((r) => r.text).join("; ")}`, at, "superseded");
  await repos.routings.update(routing.id, routing);
  if (envelope) await repos.envelopes.update(envelope.id, envelope);
}
/** Which side of the conversation the person writing is on (R149). */
function sideOf(ctx, afe, routing) {
  if (IS.requester(ctx, afe)) return "requester";
  if (IS.preparer(ctx, afe)) return "preparer";
  if (IS.coordinator(ctx, afe)) return "coordinator";
  if (IS.fa(ctx)) return "fa";
  if (signers(routing).some((r) => people.userMatches(ctx, r))) return "approver";
  return "other";
}
const FA_STATES = ["approved", "fa_review", "issued", "tracking", "capitalized"];
const screenFor = (afe, side) => (side === "fa" ? `/fa/${afe.id}/judge` : side === "approver" ? `/approve/${afe.id}` : `/afe/${afe.id}`);

/**
 * Who hears an ASK (R149, R163): the other side of the AFE, and only the other side.
 *
 * The AFE's own people — requester, preparer, coordinator — as ONE mail, the requester addressed
 * and the others copied (R147's shape), when somebody else asks; and when one of them asks,
 * everybody off the owner side in the conversation as a second: whoever has already spoken on
 * this AFE at the stage it is at now, and whoever holds it — the approver with the envelope while
 * it is in approval, Fixed Assets' shared mailbox once it is theirs. So a Fixed Assets ask reaches
 * the requester with the coordinator copied, and no approver. The asker is never mailed.
 *
 * A plain comment tells nobody: "too noisy" (Judithmelanie, Meeting #7).
 *
 * @param {"owner"|"other"} only  which group to address — always the one the asker is NOT in
 * @returns {Promise<Array<{recipientEmail, recipientName, cc, path}>>}
 */
async function audienceFor(repos, ctx, afe, routing, only) {
  const me = people.normEmail(ctx.user.email);
  const owners = [afe.requester, afe.preparer, afe.coordinator].filter((p) => p && p.email).map((p) => people.normEmail(p.email));
  const out = [];
  // While the coordinator has it (conversation.askTarget): the coordinator asks the requester's
  // side — ONE mail, the requester addressed, the preparer copied, the asker left out — and the
  // requester's side asks the coordinator who is reviewing it.
  if (only === "requester") {
    const mine = ownerSideMail(Object.assign({}, afe, { coordinator: null }), me);
    if (mine) out.push(Object.assign(mine, { path: `/afe/${afe.id}` }));
    return out;
  }
  if (only === "coordinator") {
    const c = afe.coordinator;
    if (c && c.email && people.normEmail(c.email) !== me) out.push({ recipientEmail: people.normEmail(c.email), recipientName: c.name || null, cc: [], path: `/afe/${afe.id}/coordinate` });
    return out;
  }
  if (only === "owner") {
    const mine = ownerSideMail(afe, me);
    if (mine) out.push(Object.assign(mine, { path: `/afe/${afe.id}` }));
    return out;
  }

  // Only the people relevant to where the AFE is NOW: once Fixed Assets has it, the approvers who
  // sent it back weeks ago are not in this conversation any more, and while it is in approval
  // Fixed Assets is not in it yet. Anywhere else, everybody who has spoken. A line written before
  // sides were recorded is read by what it carries: a recipient id is an approver's.
  const stage = FA_STATES.includes(afe.state) ? "fa" : ["in_approval", "on_hold"].includes(afe.state) ? "approver" : null;
  const sideOfLine = (t) => t.side || (t.recipientId ? "approver" : /\(Fixed Assets\)$/.test(t.byName || "") ? "fa" : null);
  const others = new Map();
  for (const t of afe.thread || []) {
    const e = people.normEmail(t.byEmail);
    if (!e || e === me || owners.includes(e) || t.byEmail === "system") continue;
    if (stage && sideOfLine(t) !== stage) continue;
    others.set(e, { name: String(t.byName || "").replace(/ \(Fixed Assets\)$/, ""), path: screenFor(afe, sideOfLine(t)) });
  }
  const h = holder(routing);
  if (h && h.email && ["in_approval", "on_hold"].includes(afe.state)) others.set(people.normEmail(h.email), { name: h.name, path: `/approve/${afe.id}` });
  if (FA_STATES.includes(afe.state)) {
    const fa = await handoffMailbox(repos);
    if (fa.email) others.set(people.normEmail(fa.email), { name: fa.name, path: `/fa/${afe.id}/judge` });
  }
  others.delete(me);
  const list = Array.from(others.entries());
  if (list.length) {
    const [[firstEmail, first], ...rest] = list;
    out.push({ recipientEmail: firstEmail, recipientName: first.name || null, cc: rest.map(([e]) => e), path: first.path });
  }
  return out;
}

/** "Judithmelanie Ware (Fixed Assets)" — who wrote a line, in the words a mail uses. */
const lineAuthor = (entry) => `${entry.byName}${THREAD_SIDES[entry.side] ? ` (${THREAD_SIDES[entry.side]})` : ""}`;

/** Put the ask to its audience: one mail per group, the asker never among them. */
async function sendAsk(repos, afe, audience, entry) {
  const told = [];
  for (const a of audience) {
    await notify.enqueue(repos, {
      recipientEmail: a.recipientEmail, recipientName: a.recipientName, cc: a.cc || [], afeId: afe.id, kind: "ask",
      subject: `${entry.byName} asks about ${titleOf(afe)}`,
      body: [describe(afe), "", `${lineAuthor(entry)} asks:`, entry.text, "", `Answer on the AFE: ${notify.link(a.path)}`].join("\n"),
    });
    told.push(a.recipientName || a.recipientEmail);
  }
  return told;
}

/**
 * The asks a line has just answered, each asker told once (R163). Only a plain comment sends this:
 * a send-back, a question or an answer already mails the people it concerns, and an ask that
 * answers an ask reaches its asker as an ask.
 */
async function tellTheAnswered(repos, ctx, afe, closed, entry) {
  const me = people.normEmail(ctx.user.email);
  const byAsker = new Map();
  for (const a of closed) {
    const e = people.normEmail(a.byEmail);
    if (!e || e === me) continue;
    if (!byAsker.has(e)) byAsker.set(e, { name: String(a.byName || "").replace(/ \(Fixed Assets\)$/, "") || null, side: a.side, asks: [] });
    byAsker.get(e).asks.push(a);
  }
  const told = [];
  for (const [email, who] of byAsker) {
    await notify.enqueue(repos, {
      recipientEmail: email, recipientName: who.name, afeId: afe.id, kind: "ask_answered",
      subject: `${entry.byName} answered: ${titleOf(afe)}`,
      body: [describe(afe), "", "You asked:", ...who.asks.map((a) => a.text), "",
        `${lineAuthor(entry)} answered:`, entry.text, "", `On the AFE: ${notify.link(screenFor(afe, who.side))}`].join("\n"),
    });
    told.push(who.name || email);
  }
  return told;
}

function threadEntry(afe, entry) {
  afe.thread = afe.thread || [];
  const row = Object.assign({ id: `${afe.id}-t${afe.thread.length + 1}`, resolvedAt: null }, entry);
  afe.thread.push(row);
  return row;
}

/**
 * Freeze the chain, create the envelope, hand it to the first signer. Shared by `send`
 * and by `submit` when the division has no coordinator.
 *
 * `from` is the round a returned AFE came out of, when Send is pressed on one: the coordinator's
 * Send decides exactly as the requester's Submit does (R148). It used to open a new round every
 * time, so the same AFE kept its signatures or lost them depending on who pressed the button.
 */
async function sendNow({ repos, ctx, afe, routing: from, envelope: fromEnvelope }) {
  const v = await validationFor(repos, afe);
  if (!v.ok) return { error: `${v.blocks.length} thing${v.blocks.length > 1 ? "s" : ""} still block${v.blocks.length > 1 ? "" : "s"} this AFE: ` + v.blocks.map((b) => b.message).join(" "), blocks: v.blocks };
  let again = null;
  if (afe.state === "returned" && from) {
    const check = await roundCheck(repos, afe, from, fromEnvelope);
    if (check.applies && check.can) return goOn({ repos, ctx, afe, routing: from, envelope: fromEnvelope, check, at: nowIso() });
    if (check.applies) again = check;
  }
  if (!v.sendable) return { error: "Still waiting on: " + v.pending.map((p) => p.message).join(" "), pending: v.pending };

  const preview = await routingSvc.preview(repos, afe);
  if (preview.blockers.length) {
    return { error: preview.blockers.map((b) => b.message).join(" "), blockers: preview.blockers, needsEmail: preview.needsEmail };
  }

  const at = nowIso();
  // Nothing can refuse the send from here, so the round it came out of is closed now, first.
  if (again && again.mode === "paused") await closePaused(repos, from, fromEnvelope, again, at);
  const round = routingSvc.nextRound(afe);
  // The money and the cost centre the signatures cover, frozen with the chain: after a
  // Fixed Assets return, an unchanged fingerprint means the signatures still stand.
  preview.basis.fingerprint = redFlags.financialFingerprint(afe);
  // ...and the budget and the case, which the same decision reads (R148).
  preview.basis.case = resume.caseFingerprint(afe);
  // The exceptions the approvers are being shown, frozen with the chain.
  //
  // They are printed on the form, so they are part of what gets signed — and the form's hash is
  // the promise that what was signed can be re-produced byte for byte. Validation is derived at
  // read time and legitimately changes afterwards (a new extract, a matrix edit, a corrected
  // figure), so re-deriving it on every render would make that promise depend on today's data
  // and the hash check would cry wolf. Snapshots, not references: what was true at send is what
  // the form says for ever.
  preview.basis.exceptions = afeRules.exceptions(v);
  // Snapshots, not references: the frozen routing must not share objects with the live matrix
  // row (or anything else), or a later extract would silently rewrite what was signed against.
  const frozen = JSON.parse(JSON.stringify(preview));
  const routing = await repos.routings.insert(Object.assign({}, frozen, {
    afeId: afe.id, round, status: "active", createdAt: at, activatedAt: at, completedAt: null, voidedAt: null, voidReason: null,
  }));

  // The form is generated now, from the frozen routing, and its hash goes on the envelope:
  // re-rendering later proves that what the approvers signed is what the tool still holds.
  let envelopeDoc, pack;
  try {
    pack = await envelopeDocs.buildSendPackage(repos, ctx, afe, routing);
    envelopeDoc = await docusign.createEnvelope({
      afe, routing, documents: pack.documents, formHash: pack.formHash, anchors: pack.anchors, now: at,
    });
  } catch (e) {
    await repos.routings.update(routing.id, { status: "voided", voidedAt: at, voidReason: e.message });
    await audit.record(repos, ctx, { entity: "afe", entityId: afe.id, type: "send_refused", payload: { reason: e.message, routingId: routing.id } });
    return { error: e.message };
  }
  // The form layout the hash was taken under (R102) is OURS, not DocuSign's, so it is recorded
  // on the envelope here rather than threaded through both providers — neither of which has any
  // business knowing which generation of our form it is carrying.
  // WHICH documents were bound into the form is frozen with the envelope, like the chain and the
  // layout version. The form's Documents page prints "Bound into this PDF" beside each one, so
  // the merge decision is part of the page the hash was taken over — and a later verification
  // has to reproduce the same decision or it is comparing two different forms. Snapshots, not
  // references: attaching a quote tomorrow must not make yesterday's signature look tampered.
  // What they were given, all of it, bound in or not: a resubmission compares against it (R148).
  const supportingDocumentIds = supportingDocs(afe).map((d) => d.attachmentId);
  const envelope = await repos.envelopes.insert(Object.assign(
    { afeId: afe.id, routingId: routing.id, formLayoutVersion: pack.formLayoutVersion,
      boundDocumentIds: pack.bound.map((b) => b.attachmentId), supportingDocumentIds }, envelopeDoc));
  // Two records, because they answer different questions: the FORM is what `verifyFormHash`
  // re-renders and compares, and the PACKET is the single file the approvers were actually given
  // with every supporting document bound in behind it (R112).
  afe.documents = (afe.documents || []).filter((d) => d.role !== "afe_form_pdf" && d.role !== "sent_packet").concat([{
    attachmentId: pack.formAttachmentId, role: "afe_form_pdf", filename: pack.formFilename,
    sizeBytes: pack.formBytes.length, sha256: pack.formHash, generated: true,
  }, {
    attachmentId: pack.packetAttachmentId, role: "sent_packet", filename: pack.documents[0].filename,
    sizeBytes: pack.documents[0].bytes.length, sha256: pack.packetHash, generated: true,
    pages: pack.packetPages, bound: pack.bound.map((b) => ({ filename: b.filename, role: b.role, pages: b.pages, truncated: b.truncated })),
  }]);

  for (const r of routing.recipients) {
    const er = envelope.recipients.find((x) => x.routingRecipientId === r.id);
    if (er) r.docusignRecipientId = er.docusignRecipientId;
  }
  const first = nextPending(routing);
  first.status = "sent";
  first.notifiedAt = at;
  await repos.routings.update(routing.id, routing);

  afe.routingId = routing.id;
  afe.envelopeId = envelope.id;
  afe.round = round;
  afe.sentAt = at;
  afe.returnedTo = null;
  afe.hold = null;

  // every segregation-of-duties exclusion is audited (CLAUDE.md non-negotiable 4)
  for (const ex of routing.sod.excluded) {
    await audit.record(repos, ctx, { entity: "afe", entityId: afe.id, type: "sod_excluded",
      payload: { routingId: routing.id, round, name: ex.name, email: ex.email, reason: ex.reason, wouldHaveBeen: ex.wouldHaveBeen, standIn: ex.standIn } });
  }
  await notifySigner(repos, afe, routing, first, envelopeDoc);
  return {
    state: "in_approval",
    note: `sent to ${first.name} (1 of ${signerCount(routing)})${envelope.provider === "simulated" ? " — simulated envelope" : ""}${again ? ` — a new round, because ${again.reasons[0].text}` : ""}`,
    audit: Object.assign({ routingId: routing.id, envelopeId: envelope.id, provider: envelope.provider, round, signers: signerCount(routing),
      formHash: pack.formHash, formAttachmentId: pack.formAttachmentId, formPages: pack.pages, documents: pack.documents.length,
      packetHash: pack.packetHash, packetPages: pack.packetPages,
      boundIn: pack.bound.map((b) => `${b.filename} (${b.pages}p)`),
      sentSeparately: pack.listed.map((l) => `${l.filename} — ${l.why}`) },
      again ? { roundAgain: true, because: again.reasons.map((r) => r.text) } : {}),
  };
}

// ---- the transition table --------------------------------------------------------------------
// allowed(ctx, afe, routing, envelope) → boolean · run({repos, ctx, afe, routing, envelope, payload})
// → { state, note?, audit?, then? } or { error, ...detail }
const TRANSITIONS = {
  submit: {
    from: ["draft", "returned"],
    allowed: IS.ownerSide,
    async run({ repos, ctx, afe, routing, envelope }) {
      const v = await validationFor(repos, afe);
      if (!v.ok) return { error: `${v.blocks.length} thing${v.blocks.length > 1 ? "s" : ""} still block${v.blocks.length > 1 ? "" : "s"} this AFE.`, blocks: v.blocks };
      const at = nowIso();
      afe.submittedAt = at;
      // Back into the round it came out of when nothing that decides it changed; round again,
      // with the old round closed first, when something did (R148). A Fixed Assets return with
      // the money unchanged is the same decision in its other mode (`resume.resumeCheck`).
      let again = null;
      if (afe.state === "returned") {
        const check = await roundCheck(repos, afe, routing, envelope);
        if (check.applies && check.can) return goOn({ repos, ctx, afe, routing, envelope, check, at });
        if (check.applies) {
          again = check.reasons;
          if (check.mode === "paused") await closePaused(repos, routing, envelope, check, at);
        }
      }
      const because = again ? `it goes round again, because ${again[0].text}` : "";
      const roundAgain = again ? { roundAgain: true, because: again.map((r) => r.text) } : null;
      if (!afe.coordinator) {                                          // no coordinator: the requester sends
        const sent = await sendNow({ repos, ctx, afe });
        return sent.error || !roundAgain ? sent : Object.assign(sent, { audit: Object.assign({}, sent.audit, roundAgain) });
      }
      if (afe.coordinator.email !== ctx.user.email) {
        await notify.enqueue(repos, {
          recipientEmail: afe.coordinator.email, recipientName: afe.coordinator.name, afeId: afe.id, kind: "afe_submitted",
          subject: `To review and send: ${titleOf(afe)}`,
          body: `${describe(afe)}\nRaised by ${afe.requester ? afe.requester.name : "?"}.${because ? ` Resubmitted: ${because}.` : ""} Open ${notify.link(`/afe/${afe.id}/coordinate`)} to check it, shape the chain and send.`,
        });
      }
      return { state: "submitted", note: `with ${afe.coordinator.name} to review and send${because ? ` — ${because}` : ""}`,
        audit: roundAgain || undefined };
    },
  },

  send: {
    from: ["submitted", "draft", "returned"],
    allowed: IS.sender,
    run: sendNow,
  },

  question: {
    from: ["in_approval"],
    allowed: IS.holder,
    async run({ repos, ctx, afe, routing, payload }) {
      const text = String(payload.text || "").trim();
      if (!text) return { error: "Type the question." };
      const me = holder(routing);
      const at = nowIso();
      const entry = threadEntry(afe, { kind: "question", recipientId: me.id, byEmail: ctx.user.email, byName: me.name, side: "approver", text, at });
      afe.hold = { recipientId: me.id, threadId: entry.id, since: at };
      await notify.enqueue(repos, Object.assign(ownerMail(afe, [], ctx.user.email) || { recipientEmail: null }, {
        afeId: afe.id, kind: "question",
        subject: `${me.name} has a question on ${titleOf(afe)}`,
        body: `${describe(afe)}\n\n${me.name} (${me.level || me.role}) asks:\n${text}\n\nAnswer at ${notify.link(`/afe/${afe.id}/thread`)} — the clock is paused with them until you do.`,
      }));
      return { state: "on_hold", note: `${me.name} asked a question`, audit: { recipientId: me.id, threadId: entry.id } };
    },
  },

  answer: {
    from: ["on_hold"],
    allowed: IS.ownerSide,
    async run({ repos, ctx, afe, routing, payload }) {
      const text = String(payload.text || "").trim();
      if (!text) return { error: "Type the answer." };
      const at = nowIso();
      const open = (afe.thread || []).filter((t) => t.kind === "question" && !t.resolvedAt).slice(-1)[0] || null;
      if (open) open.resolvedAt = at;
      const entry = threadEntry(afe, { kind: "answer", inReplyTo: open ? open.id : null, byEmail: ctx.user.email, byName: nameOf(ctx), side: sideOf(ctx, afe, routing), text, at });
      const rec = holder(routing);
      afe.hold = null;
      if (rec && rec.email) {
        await notify.enqueue(repos, {
          recipientEmail: rec.email, recipientName: rec.name, afeId: afe.id, kind: "answer",
          subject: `Your question on ${titleOf(afe)} is answered`,
          body: `${describe(afe)}\n\n${nameOf(ctx)} replies:\n${text}\n\nOpen ${notify.link(`/approve/${afe.id}`)} to continue.`,
        });
      }
      return { state: "in_approval", note: rec ? `answered — back with ${rec.name}` : "answered", audit: { threadId: entry.id, inReplyTo: open ? open.id : null } };
    },
  },

  send_back: {
    from: ["submitted", "in_approval", "on_hold"],
    allowed: (ctx, afe, routing) => IS.coordinates(ctx, afe) || (["in_approval", "on_hold"].includes(afe.state) && IS.holder(ctx, afe, routing)),
    async run({ repos, ctx, afe, routing, envelope, payload }) {
      const reason = String(payload.reason || "").trim();
      if (!reason) return { error: "Say what needs to change — the requester reopens the wizard on your words." };
      const at = nowIso();
      const byRecipient = IS.holder(ctx, afe, routing) ? holder(routing) : null;
      const byName = byRecipient ? byRecipient.name : nameOf(ctx);
      // Mid-chain the round is PAUSED, not voided (R148): the envelope and every signature on it
      // are kept, and the decision moves to resubmission. Back to whoever holds it now if nothing
      // that decides it changes; round again, and only then closed, if something does. A send-back
      // from `submitted` has no round in flight and closes whatever it has, as it always did.
      const midChain = ["in_approval", "on_hold"].includes(afe.state) && Boolean(routing) && routing.status === "active";
      let kept = 0;
      if (midChain) {
        const current = holder(routing);
        routing.status = "returned";
        routing.pauses = (routing.pauses || []).concat([{
          at, holderId: current ? current.id : null, byEmail: ctx.user.email, byName, reason,
          // A round sent before R148 froze no case; this is the last moment nobody could have edited it.
          case: routing.basis && routing.basis.case ? null : resume.caseFingerprint(afe),
          // ...and what the form says now, so a resubmission can name what is different.
          values: resume.fieldValues(afe),
        }]);
        if (current) current.status = "returned";
        kept = signers(routing).filter((r) => r.status === "signed").length;
      } else {
        await closeRound(routing, envelope, `sent back by ${byName}: ${reason}`, at, "superseded");
      }
      const step = payload.step === undefined || payload.step === null || payload.step === "" ? null : Number(payload.step);
      // `role` is who sent it back and `to` is whose it now is. `submit`'s fast path reads `role`.
      afe.returnedTo = { step: Number.isFinite(step) ? step : null, reason, byEmail: ctx.user.email, byName,
        role: byRecipient ? "approver" : "coordinator", recipientId: byRecipient ? byRecipient.id : null, from: afe.state, at,
        to: returnee(afe) };
      threadEntry(afe, { kind: "send_back", recipientId: byRecipient ? byRecipient.id : null, byEmail: ctx.user.email, byName,
        side: byRecipient ? "approver" : sideOf(ctx, afe, routing), text: reason, at });
      afe.hold = null;
      const whose = afe.returnedTo.to ? afe.returnedTo.to.name : "the requester";
      const mail = ownerSideMail(afe, ctx.user.email);
      if (mail) {
        await notify.enqueue(repos, Object.assign(mail, {
          afeId: afe.id, kind: "sent_back",
          subject: `Sent back: ${titleOf(afe)}`,
          body: `${describe(afe)}\n\n${byName} sent it back to ${whose}:\n${reason}\n\n${kept ? `${kept === 1 ? "The signature" : `The ${kept} signatures`} so far stand${kept === 1 ? "s" : ""} unless the money, the budget, the case, the documents or who signs changes. ` : ""}Fix it and submit again at ${notify.link(`/afe/${afe.id}/edit/${afe.returnedTo.step || 1}`)}.`,
        }));
      }
      return { state: "returned", note: `sent back to ${whose}`,
        audit: { reason, step: afe.returnedTo.step, recipientId: afe.returnedTo.recipientId, byName,
          to: afe.returnedTo.to ? afe.returnedTo.to.email : null, toName: afe.returnedTo.to ? afe.returnedTo.to.name : null,
          paused: midChain, kept } };
    },
  },

  recipient_signed: {
    from: ["in_approval"],
    allowed: (ctx, afe, routing) => IS.system(ctx) || IS.holder(ctx, afe, routing),
    async run({ repos, ctx, afe, routing, envelope, payload }) {
      const me = holder(routing);
      if (!me) return { error: "No one holds this envelope right now." };
      if (payload.recipientId && payload.recipientId !== me.id) {
        const asked = recipientById(routing, payload.recipientId);
        return { error: `${asked ? asked.name : payload.recipientId} does not hold the envelope — it is with ${me.name}.` };
      }
      const at = payload.signedAt || nowIso();
      let next;
      // `fromProvider` is the poll job reflecting what DocuSign already recorded. Without it
      // a live envelope refuses: nobody signs a real envelope by clicking in this tool.
      try { ({ next } = docusign.recordSigned(envelope, me.id, at, { fromProvider: IS.system(ctx) })); }
      catch (e) { return { error: e.message }; }
      me.status = "signed";
      me.signedAt = at;
      me.evidence = { provider: envelope.provider, byEmail: ctx.user ? ctx.user.email : "system", comment: payload.comment || null, at };

      if (next) {
        const rec = recipientById(routing, next.routingRecipientId);
        rec.status = "sent";
        rec.notifiedAt = at;
        await notifySigner(repos, afe, routing, rec, envelope);
        return { state: "in_approval", note: `signed by ${me.name} — now with ${rec.name} (${rec.order} of ${signerCount(routing)})`,
          audit: { recipientId: me.id, next: rec.id } };
      }

      routing.status = "completed";
      routing.completedAt = at;
      for (const c of routing.recipients.filter((r) => r.role === "cc")) { c.status = "sent"; c.notifiedAt = at; }
      afe.approvedAt = at;
      afe.fa = afe.fa || {};
      afe.fa.receivedAt = at;

      // Store the signed set and the certificate, and check the signatures against the chain
      // frozen at send. A failure here must not lose the approvals: it is recorded and
      // surfaced to Fixed Assets rather than thrown away.
      let completion = null;
      try {
        completion = await envelopeDocs.completeEnvelope(repos, ctx, afe, routing, envelope);
      } catch (e) {
        envelope.completed = Object.assign({}, envelope.completed, { error: e.message, verifiedAt: at });
        await audit.record(repos, ctx, { entity: "envelope", entityId: envelope.id, afeId: afe.id, type: "envelope_completion_failed",
          payload: { reason: e.message, envelopeId: envelope.envelopeId } });
      }
      const unverified = completion ? completion.verification.filter((v) => v.st !== "ok") : [];

      // The hand-off to Fixed Assets: ONE mail to the shared AFE mailbox with the requester and
      // the coordinator in copy, under a standard subject the FA team can hang a mailbox rule or
      // a Power Automate flow off (refData.FA_HANDOFF), with the same facts repeated as X-AFE-*
      // headers for a flow that would rather not parse a subject line. The mailbox itself is an
      // App Service setting, never a literal here; until it is set the same mail goes to the
      // named FA preparers, so nothing is lost while the shared mailbox is being arranged.
      const totalUsd = afeRules.total(afe);
      const signedBy = routing.recipients.filter((r) => r.status === "signed")
        .map((r) => `${r.name}${r.level ? ` (${r.level})` : ""}`).join(", ");
      const handoff = {
        afeId: afe.id, kind: "afe_approved",
        subject: FA_HANDOFF.subject(afe, totalUsd),
        headers: FA_HANDOFF.headers(afe, totalUsd),
        body: [
          describe(afe),
          `Requested by ${afe.requester ? afe.requester.name : "?"}${afe.coordinator ? `, prepared by ${afe.coordinator.name}` : ""}.`,
          "",
          `All ${signerCount(routing)} signatures are in${envelope.provider === "simulated" ? " (simulated envelope)" : ""}: ${signedBy}`,
          unverified.length
            ? `${unverified.length} signature${unverified.length > 1 ? "s do" : " does"} not match the approved chain — check before keying SAP.`
            : "Every signature matches the chain frozen when it was sent.",
          "",
          "Next: create the internal order (KO01) and record the number back on the AFE — that number is the AFE number.",
          `The signed set and the certificate are on the AFE. Open ${notify.link(`/fa/${afe.id}/judge`)}`,
          `Envelope ${envelope.envelopeId}.`,
        ].join("\n"),
      };
      // Where the shared mailbox comes from: the org rule that already copies Fixed Assets on
      // every envelope, marked `handoff` (seed/org-rules.json rule-0004, R58) — business config
      // as data, editable in Admin, never a literal here. FA_MAILBOX overrides it per
      // environment; with neither, the mail falls back to the named FA preparers so nothing is
      // lost while the shared mailbox is being arranged.
      const { email: faMailbox, name: faName } = await handoffMailbox(repos);
      // The AFE's own people are COPIED on the hand-off, and that copy is their "fully signed"
      // (R164): a separate `afe_approved_owner` to each of them made the same news three mails.
      const handoffCc = ownerSideEmails(afe);
      let handedTo = [];
      if (faMailbox) {
        await notify.enqueue(repos, Object.assign({ recipientEmail: faMailbox, recipientName: faName, cc: handoffCc }, handoff));
        handedTo = [faMailbox];
      } else {
        // Before the shared mailbox exists, the named preparers — as ONE mail, not one each.
        const faPreparers = await repos.users.all((u) => u.active !== false && (u.roles || []).includes("fa_preparer"));
        const one = oneMail(faPreparers.map((u) => u.email).concat(handoffCc));
        if (one) await notify.enqueue(repos, Object.assign(one, handoff));
        handedTo = faPreparers.map((u) => u.email);
      }
      // A copy recipient the hand-off has not already reached gets the completed set — the
      // Fixed Assets mailbox is a routing copy too, and it has just been sent the hand-off.
      const reached = new Set(handedTo.concat(handoffCc).map(people.normEmail));
      for (const c of routing.recipients.filter((r) => r.role === "cc" && r.email && !reached.has(people.normEmail(r.email)))) {
        reached.add(people.normEmail(c.email));
        await notify.enqueue(repos, { recipientEmail: c.email, recipientName: c.name, afeId: afe.id, kind: "copy_completed",
          subject: `Completed: ${titleOf(afe)}`, body: `${describe(afe)}\nThe signed set is on the AFE at ${notify.link(`/afe/${afe.id}`)}.` });
      }
      return { state: "approved", note: "all signatures in — handed to Fixed Assets",
        audit: { recipientId: me.id, signers: signerCount(routing),
          verified: completion ? unverified.length === 0 : null,
          combinedPdfAttachmentId: completion ? completion.combinedPdfAttachmentId : null,
          certificateAttachmentId: completion ? completion.certificateAttachmentId : null },
        then: { type: "fa_handover", state: "fa_review", note: "with Fixed Assets" } };
    },
  },

  decline: {
    from: ["in_approval"],
    allowed: IS.holder,
    async run({ repos, ctx, afe, routing, envelope, payload }) {
      const reason = String(payload.reason || "").trim();
      if (!reason) return { error: "Say why you are declining — the requester needs to know." };
      const me = holder(routing);
      const at = nowIso();
      try { docusign.recordDeclined(envelope, me.id, reason, at, { fromProvider: IS.system(ctx) }); } catch (e) { return { error: e.message }; }
      me.status = "declined";
      me.evidence = { provider: envelope.provider, byEmail: ctx.user.email, reason, at };
      routing.status = "voided";
      routing.voidedAt = at;
      routing.voidReason = `declined by ${me.name}: ${reason}`;
      for (const r of routing.recipients) if (["pending", "sent"].includes(r.status)) r.status = "superseded";
      afe.declined = { byName: me.name, byEmail: ctx.user.email, recipientId: me.id, reason, at };
      threadEntry(afe, { kind: "decline", recipientId: me.id, byEmail: ctx.user.email, byName: me.name, side: "approver", text: reason, at });
      // A hard rejection is told the same way as a send-back (R147): to whoever raised it.
      const mail = ownerSideMail(afe, ctx.user.email);
      if (mail) {
        await notify.enqueue(repos, Object.assign(mail, {
          afeId: afe.id, kind: "declined", subject: `Declined: ${titleOf(afe)}`,
          body: `${describe(afe)}\n\n${me.name} (${me.level || me.role}) declined:\n${reason}\n\nA new AFE is needed if the project goes ahead.`,
        }));
      }
      return { state: "rejected", note: `declined by ${me.name}`, audit: { recipientId: me.id, reason } };
    },
  },

  // ---- R149: a comment is a line on the record, not a move -----------------------------------------
  // "Instead of hard rejection… let's use the comment section only. Better to avoid Teams or
  // emails. It will have the audit trail — what we asked and what they responded" (Jarrod,
  // Meeting #6). The question/answer pair already existed and could not carry this: it is the
  // holder's alone, only while the AFE is in approval, and it pauses the approval clock, which
  // means nothing once Fixed Assets has the AFE. A comment changes no state, may be written by
  // anyone who can see the AFE, and tells the rest of the conversation. A hard rejection stays a
  // hard rejection (`fa_return`): "we need written information in the AFE for documentation
  // proof" (Imogen) is what the thread is, not what replaces it.
  comment: {
    from: COMMENT_STATES,
    allowed: (ctx, afe, routing, envelope) => permissionsFor(afe, ctx, { routing, envelope }).canComment,
    async run({ repos, ctx, afe, routing, payload }) {
      const text = String(payload.text || "").trim();
      if (!text) return { error: "Type the comment." };
      if (text.length > 2000) return { error: "Keep a comment under 2,000 characters — attach a document for anything longer." };
      const at = nowIso();
      const side = sideOf(ctx, afe, routing);
      // A comment is a line on the record and e-mails nobody; an ASK is the one line that tells
      // the other side, and it stays open until somebody there answers (R163).
      const ask = payload.ask === true || payload.ask === "true";
      const target = conversation.askTarget(side, afe);
      const audience = ask ? await audienceFor(repos, ctx, afe, routing, target) : [];
      if (ask && !audience.length) return { error: "There is nobody on the other side of this AFE to ask yet. Post it as a comment." };
      const openBefore = new Set(conversation.openAsks(afe.thread).map((a) => a.id));
      const entry = threadEntry(afe, Object.assign({ kind: ask ? "ask" : "comment", byEmail: ctx.user.email, byName: nameOf(ctx), side, text, at },
        ask ? { askedOf: target } : {}));
      const closed = conversation.asks(afe.thread).filter((a) => openBefore.has(a.id) && a.answeredById === entry.id);
      const told = ask ? await sendAsk(repos, afe, audience, entry) : await tellTheAnswered(repos, ctx, afe, closed, entry);
      return { state: afe.state,
        note: ask ? `asked — ${told.join(" and ")} told` : told.length ? `posted — ${told.join(" and ")} told it is answered` : "posted",
        audit: Object.assign({ threadId: entry.id, byName: entry.byName, side, text, told },
          ask ? { ask: true } : {}, closed.length ? { answered: closed.map((a) => a.id) } : {}) };
    },
  },

  // ---- Fixed Assets ------------------------------------------------------------------------------
  fa_return: {
    from: ["fa_review"],
    allowed: IS.fa,
    async run({ repos, ctx, afe, routing, payload }) {
      const reason = String(payload.reason || "").trim();
      if (!reason) return { error: "Say what Fixed Assets needs changed — the requester reopens the wizard on your words." };
      const at = nowIso();
      const step = payload.step === undefined || payload.step === null || payload.step === "" ? null : Number(payload.step);
      afe.returnedTo = { step: Number.isFinite(step) ? step : null, reason, byEmail: ctx.user.email, byName: nameOf(ctx),
        role: "fa", recipientId: null, from: afe.state, at, fingerprint: routing && routing.basis ? routing.basis.fingerprint || null : null,
        // The budget and the case, for a round sent before R148 froze them (resume.resumeCheck).
        case: routing && routing.basis && routing.basis.case ? null : resume.caseFingerprint(afe),
        to: returnee(afe) };
      threadEntry(afe, { kind: "send_back", recipientId: null, byEmail: ctx.user.email, byName: `${nameOf(ctx)} (Fixed Assets)`, side: "fa", text: reason, at });
      afe.fa = afe.fa || {};
      afe.fa.returns = (afe.fa.returns || []).concat([{ reason, byEmail: ctx.user.email, byName: nameOf(ctx), at }]);
      const whose = afe.returnedTo.to ? afe.returnedTo.to.name : "the requester";
      const mail = ownerSideMail(afe, ctx.user.email);
      if (mail) {
        await notify.enqueue(repos, Object.assign(mail, {
          afeId: afe.id, kind: "sent_back",
          subject: `Fixed Assets sent back: ${titleOf(afe)}`,
          body: `${describe(afe)}\n\n${nameOf(ctx)} (Fixed Assets) sent it back to ${whose}:\n${reason}\n\nThe signatures stand as long as the money and the cost centre do not change. Fix it and submit again at ${notify.link(`/afe/${afe.id}/edit/${afe.returnedTo.step || 1}`)}.`,
        }));
      }
      return { state: "returned", note: `sent back to ${whose}`,
        audit: { reason, step: afe.returnedTo.step, byName: nameOf(ctx),
          to: afe.returnedTo.to ? afe.returnedTo.to.email : null, toName: afe.returnedTo.to ? afe.returnedTo.to.name : null } };
    },
  },

  // ---- R101: somebody senior signs the issue off before SAP is touched -----------------------
  // "FA Supervisor/Manager approval before creating Internal order. Judithmelanie Ware is FA
  // supervisor, Jarrod Dane is FA Manager." (Lyndsay, 2026-09-18.)
  //
  // The AFE does not change state. An approval is a fact recorded ON an AFE that is still in
  // Fixed Assets' hands, exactly like a judgment row or a flag acknowledgement — inventing a
  // state for it would mean every screen, every queue and every red flag learning about a
  // status that means "in review, but a bit further along".
  fa_approve_issue: {
    from: ["fa_review"],
    allowed: IS.fa,                                  // narrowed to the NAMED approvers below
    async run({ repos, ctx, afe, payload }) {
      const approvers = await issueApprovers(repos);
      if (!approvers.length) {
        return { error: "No one is named as an FA issue approver, so nothing can be approved. "
          + "Admin › Org rules, kind fa_issue_approver." };
      }
      const me = people.normEmail(ctx.user && ctx.user.email);
      const { chosen, wasChosen } = issueApproverChoice(afe, approvers);
      const mine = chosen.find((a) => a.email === me);
      if (!mine) {
        const named = chosen.map((a) => a.name + (a.group ? ` (${a.group})` : "")).join(" or ");
        return { error: wasChosen
          ? `This AFE was sent to ${named} for approval. ${approvers.find((a) => a.email === me)
              ? "Fixed Assets can change who it is with." : "Only a named issue approver can act on it."}`
          : `Only ${named} approves an AFE for issue.`,
        approvers: chosen.map((a) => a.name) };
      }
      // The standing rule, in the one place it could otherwise be forgotten: nobody clears
      // their own AFE. An approver who raised, prepared or coordinated it is still that.
      if (IS.ownerSide(ctx, afe)) {
        return { error: "You raised, prepared or coordinated this AFE, so you cannot also approve it for issue. "
          + `${approvers.filter((a) => a.email !== me).map((a) => a.name).join(" or ") || "Another approver"} can.` };
      }
      if (afe.fa && afe.fa.issueApproval) {
        const prev = afe.fa.issueApproval;
        return { error: `${prev.byName} already approved this for issue on ${String(prev.at).slice(0, 10)}.` };
      }

      // Readiness is the server's to decide, as it is at fa_record_io — approving an AFE whose
      // red flags are open would be approving something nobody has finished looking at.
      const { faView } = require("../views/faView");
      const fv = await faView(repos, afe, ctx, { light: true });
      if (!fv.redFlags.ready) {
        const open = fv.redFlags.blocks.filter((f) => !f.cleared);
        return { error: `${open.length} red flag${open.length > 1 ? "s" : ""} still to clear or acknowledge before this can be approved: ${open.map((f) => f.title).join("; ")}`,
          flags: open.map((f) => f.id) };
      }

      const at = nowIso();
      const note = String(payload.note || "").trim().slice(0, 500) || null;
      afe.fa = afe.fa || {};
      afe.fa.issueApproval = { byEmail: me, byName: nameOf(ctx), group: mine.group || null, at, note };

      // The preparers are told, because the approval is what unblocks them.
      const mailbox = await handoffMailbox(repos);
      if (mailbox.email) {
        await notify.enqueue(repos, {
          afeId: afe.id, kind: "afe_issue_approved", recipientEmail: mailbox.email, recipientName: mailbox.name,
          subject: `Approved to issue: ${titleOf(afe)}`,
          body: `${describe(afe)}\n${nameOf(ctx)}${mine.group ? ` (${mine.group})` : ""} approved this for issue`
            + `${note ? `: “${note}”` : "."}\nThe internal order can be created now — open ${notify.link(`/afe/${afe.id}/issue`)}.`,
        });
      }
      return { state: afe.state, note: `approved for issue by ${nameOf(ctx)}`,
        audit: { byEmail: me, byName: nameOf(ctx), group: mine.group || null, note } };
    },
  },

  fa_record_io: {
    from: ["fa_review"],
    allowed: IS.faPreparer,
    async run({ repos, ctx, afe, routing, payload }) {
      // The server decides readiness; the screen only hides the button.
      const { faView } = require("../views/faView");
      const fv = await faView(repos, afe, ctx, { light: true });
      if (!fv.redFlags.ready) {
        const open = fv.redFlags.blocks.filter((f) => !f.cleared);
        return { error: `${open.length} red flag${open.length > 1 ? "s" : ""} still to clear or acknowledge: ${open.map((f) => f.title).join("; ")}`, flags: open.map((f) => f.id) };
      }
      if (fv.judgment.open) {
        const rows = fv.judgment.rows.filter((r) => r.st !== "ok");
        return { error: `${rows.length} judgment row${rows.length > 1 ? "s" : ""} still open: ${rows.map((r) => r.t).join("; ")}`, rows: rows.map((r) => r.id) };
      }
      // R101. The approval gate, and then four eyes ON it: the rule is by IDENTITY, not by
      // role, because Judithmelanie holds fa_preparer and fa_checker both, and a person holding two
      // roles must not be able to do both halves of a two-person control. The same shape as
      // capitalize/close.
      if (FA_ISSUE_APPROVAL.required) {
        const approval = afe.fa && afe.fa.issueApproval;
        if (!approval) {
          const approvers = await issueApprovers(repos);
          return { error: "This has not been approved for issue yet. "
            + `${approvers.map((a) => a.name + (a.group ? ` (${a.group})` : "")).join(" or ") || "An FA issue approver"} approves it first.`,
            needs: "fa_approve_issue" };
        }
        if (people.normEmail(approval.byEmail) === people.normEmail(ctx.user && ctx.user.email)) {
          return { error: `You approved this for issue yourself, so somebody else records the internal order. `
            + "Two people, by name — the same rule as capitalize and close.", needs: "four_eyes" };
        }
      }

      const ioNumber = String(payload.ioNumber || "").trim();
      if (!sapSheet.validIoNumber(ioNumber)) return { error: "Type the internal-order number SAP assigned on save — 6 to 10 digits." };
      const orderType = payload.orderType || (afe.fa && afe.fa.orderType) || null;
      if (!ORDER_TYPES.some((o) => o.code === orderType)) return { error: "Pick the order type — Z002 or Z005, by the nature of the AFE." };
      const taken = await repos.ios.find((i) => i.ioNumber === ioNumber);
      const takenAfe = taken ? null : await repos.afes.find((a) => a.id !== afe.id && a.afeNo === ioNumber);
      if (taken || takenAfe) return { error: `Internal order ${ioNumber} is already recorded on AFE ${(taken || {}).afeId || takenAfe.id}.` };
      const inSap = ioRegistry.sapConflict(ioNumber, afe, await sapRowsFor(repos, ioNumber), { parent: true });
      if (inSap) return { error: inSap.error, sap: inSap.row };

      // child orders, one per cost line, typed now or added later from the project page (R52)
      const plan = sapSheet.buildChildPlan(afe);
      const children = [];
      for (const c of Array.isArray(payload.children) ? payload.children : []) {
        if (!c || !String(c.ioNumber || "").trim()) continue;
        const line = plan.find((p) => p.seq === Number(c.seq));
        if (!line) return { error: `There is no cost line ${c.seq} on this AFE.` };
        const n = String(c.ioNumber).trim();
        if (!sapSheet.validIoNumber(n)) return { error: `${line.site}: ${n} is not an internal-order number (6 to 10 digits).` };
        if (n === ioNumber || children.some((x) => x.ioNumber === n)) return { error: `${line.site}: ${n} is used twice.` };
        if (await repos.ios.find((i) => i.ioNumber === n)) return { error: `Internal order ${n} is already recorded.` };
        const childInSap = ioRegistry.sapConflict(n, afe, await sapRowsFor(repos, n));
        if (childInSap) return { error: `${line.site}: ${childInSap.error}`, sap: childInSap.row };
        children.push({ line, ioNumber: n });
      }

      const at = nowIso();
      const total = afeRules.total(afe);
      const split = children.reduce((s, c) => s + (c.line.amountUsd || 0), 0);
      const common = {
        afeId: afe.id, division: afe.division || null, region: afe.region || null, companyCode: afe.companyCode || null,
        costCenter: afe.costCenter || null, plant: afe.plant || null, orderType,
        budgetCategory: (afe.budget && afe.budget.budgetCategory) || null, afeCategory: (afe.budget && afe.budget.afeCategory) || null,
        function: null, subFunction: null, issuedAt: at, recordedByEmail: ctx.user.email, budgetMoves: [], aucNumber: null, status: "open",
      };
      const parent = await repos.ios.insert(Object.assign({}, common, {
        ioNumber, kind: "parent", parentIoNumber: null, country: null, site: afe.location || null,
        description: titleOf(afe),
        // the parent holds what is not split out to a child yet; Stage 6 moves budget between them
        allocatedBudgetUsd: Math.max(0, total - split),
      }));
      const childIds = [];
      for (const c of children) {
        const row = await repos.ios.insert(Object.assign({}, common, {
          ioNumber: c.ioNumber, kind: "child", parentIoNumber: ioNumber, country: c.line.country || null, site: c.line.site || null,
          lineSeq: c.line.seq, description: `${titleOf(afe)} — ${c.line.site}`, allocatedBudgetUsd: c.line.amountUsd || 0,
        }));
        childIds.push(row.id);
      }

      afe.afeNo = ioNumber;                                    // the AFE number IS the SAP internal-order number
      afe.ioNumbers = [ioNumber].concat(children.map((c) => c.ioNumber));
      afe.fa = afe.fa || {};
      afe.fa.orderType = orderType;
      afe.fa.issuedAt = at;
      afe.fa.issuedByEmail = ctx.user.email;
      afe.fa.steps = Object.assign({}, afe.fa.steps, { KO01_IO: { doneAt: at, byEmail: ctx.user.email, byName: nameOf(ctx), value: ioNumber } });

      const childText = children.length ? ` with ${children.length} child order${children.length > 1 ? "s" : ""} (${children.map((c) => `${c.line.site} ${c.ioNumber}`).join(", ")})` : "";

      // NO PACK HERE any more, and that is the structural change. The document Fixed Assets
      // actually sends back carries the AuC number and the SAP budget table, and neither of them
      // exists at KO01 — the order has only just been created. Building it now produced a file
      // with two empty boxes in it, which is why Fixed Assets went on making their own by hand.
      // `fa_issue_pack` builds it, after KO22 and AS01, when Fixed Assets says so.
      //
      // The requester is still told the number straight away, because that is what unblocks
      // their purchase requisition — it just arrives without the finished document attached.
      await notify.enqueue(repos, Object.assign({
        afeId: afe.id, kind: "afe_issued",
        subject: ISSUE_HANDBACK.subject(afe, ioNumber, titleOf(afe)),
        body: `${describe(afe)}\n\n${ISSUE_HANDBACK.body(ioNumber)}\n\n`
          + `Internal order ${ioNumber} (${orderType})${childText}.\n`
          + `The budget is posted with KO22 next; the project page shows budget, actual and commitment as SAP reports them.\n`
          + `The issued AFE — the signed form with this number on it, the AuC number and the budget evidence — follows once Fixed Assets has finished in SAP.\n`
          + `Open ${notify.link(`/afe/${afe.id}`)}.`,
      }, ownerMail(afe, [(await handoffMailbox(repos)).email]) || { recipientEmail: null }));
      return { state: "issued", note: `issued — AFE ${ioNumber}${children.length ? ` + ${children.length} child IO${children.length > 1 ? "s" : ""}` : ""}`,
        audit: { ioNumber, orderType, parentIoId: parent.id, children: children.map((c) => ({ seq: c.line.seq, site: c.line.site, ioNumber: c.ioNumber })), childIds, totalUsd: total } };
    },
  },

  /**
   * R93, R99, R100, R103, R104 — send the issued AFE.
   *
   * The file Fixed Assets builds by hand today with a PDF editor and four or five minutes
   * (Imogen, 62:04): the signed form with the internal order in the AFE NO box, the AuC number
   * and the plant and the profit centre in red, the SAP budget table beside them, and the quote
   * bound in behind. It is built HERE rather than at KO01 because half of what it carries does
   * not exist until the SAP work is done.
   *
   * Fixed Assets chooses the moment, as they do today. The state does not change: an AFE that
   * is issued stays issued, and this records that the document went out.
   */
  fa_issue_pack: {
    from: ["issued", "tracking"],
    allowed: IS.fa,
    async run({ repos, ctx, afe, payload }) {
      const ioNumber = afe.afeNo;
      if (!ioNumber) return { error: "There is no internal order on this AFE yet." };
      const steps = (afe.fa && afe.fa.steps) || {};

      // The gate (R103). The pack is the thing that proves the order exists AND the budget is
      // loaded, so it cannot be built from a state where only the first of those is true.
      const missing = [];
      if (!steps.KO22_BUDGET) missing.push("the budget is not loaded (KO22)");
      if (!steps.AS01_AUC) missing.push("there is no AuC number (AS01)");
      if (!(afe.documents || []).some((d) => d.role === "budget_evidence")) {
        missing.push("the Budget / Actual / Commitments screenshot is not attached");
      }
      if (missing.length) {
        return { error: `The issued AFE carries the AuC number and the budget evidence, and ${missing.join(", and ")}.`,
          needs: missing };
      }

      const at = nowIso();
      const routing = afe.routingId ? await repos.routings.get(afe.routingId) : null;
      const v = await validationFor(repos, afe);
      const note = String(payload.note || "").trim().slice(0, 400) || null;
      // A note sent blank CLEARS the saved one (R166): the sheet always sends what it shows, and a
      // note somebody deleted must not come back on the page because blank meant "keep".
      if (payload.note !== undefined) { afe.fa = afe.fa || {}; afe.fa.issuedNote = note; }
      if (payload.profitCentre !== undefined) {
        afe.fa = afe.fa || {};
        afe.fa.profitCentre = String(payload.profitCentre || "").trim() || null;
      }

      let built;
      try {
        built = await issuedPack.buildIssuedPack(repos, afe, routing, {
          ioNumber, aucNumber: (afe.fa && afe.fa.aucNumber) || null, plant: afe.plant,
          profitCentre: (afe.fa && afe.fa.profitCentre) || null,
          budgetLoadedUsd: (afe.fa && afe.fa.budgetLoadedUsd) !== undefined ? afe.fa.budgetLoadedUsd : null,
          note: (afe.fa && afe.fa.issuedNote) || null,
          fx: (afe.fa && afe.fa.fx) || null,
          orderType: (afe.fa && afe.fa.orderType) || null, issuedAt: afe.fa.issuedAt || at,
          approvedBy: (afe.fa.issueApproval && afe.fa.issueApproval.byName) || null,
        }, {
          merge: Array.isArray(payload.mergeDocs) ? payload.mergeDocs : undefined,
          exclude: Array.isArray(payload.excludeDocs) ? payload.excludeDocs : undefined,
          validation: v,
        });
      } catch (e) {
        return { error: `The issued AFE would not assemble: ${String(e.message).slice(0, 160)}` };
      }

      // Through `attachments.put`, like every other document the tool produces — it was the one
      // output written straight to the store, so the issued AFE was the only generated document
      // with NO sha256 on it (R156). That is the document the requester is sent and the one the
      // record ends on; "it remains untampered" is not a claim you can make about bytes nobody
      // hashed.
      const meta = await attachments.put(repos, {
        afeId: afe.id, filename: built.filename, role: "issued_pack",
        bytes: built.bytes, byEmail: ctx.user.email,
      });
      // ONE issued AFE (R156). A rebuilt pack supersedes the one before it — the same discipline
      // as a routing round: the old one is marked and kept, never deleted, and every screen and
      // `document.pdf` show the newest. `issued-pack.pdf` already resolved to the latest; the
      // Documents panels offered every generation as a row of its own.
      for (const d of afe.documents || []) {
        if (d.role === "issued_pack" && !d.supersededAt) { d.supersededAt = at; d.supersededBy = meta.id; }
      }
      afe.documents = (afe.documents || []).concat([{
        attachmentId: meta.id, role: "issued_pack", filename: built.filename,
        sizeBytes: meta.sizeBytes, sha256: meta.sha256, mimeType: "application/pdf",
        generated: true, vendor: null, amountUsd: null,
        pages: built.pages, signedPages: built.signedPages, signedAttachmentId: built.signedAttachmentId,
      }]);
      afe.fa.packSentAt = at;
      afe.fa.packSentBy = { byEmail: ctx.user.email, byName: nameOf(ctx) };

      // The requester and the coordinator get it, Fixed Assets is copied, and so are the two who
      // approve the issue — "this version goes to Judithmelanie/Jarrod for final review" (Shashank).
      // They RECEIVE it rather than gate it: the gate is before the order (R101), and a second
      // blocking approval on a document that is already sent was declined.
      const approvers = (await issueApprovers(repos)).map((a) => a.email);
      const cc = [(await handoffMailbox(repos)).email].concat(approvers).filter((e, i, all) => e && all.indexOf(e) === i);
      const bound = built.merged.length ? `\n\nAdded behind it: ${built.merged.map((m) => `${m.filename} (${m.pages} ${m.pages === 1 ? "page" : "pages"}${m.truncated ? `, ${m.truncated} more not included` : ""})`).join("; ")}.` : "";
      const packTo = ownerMail(afe, cc) || { recipientEmail: null };
      await notify.enqueue(repos, Object.assign({
        afeId: afe.id, kind: "afe_issued_pack",
        subject: `Issued AFE ${ioNumber} — ${titleOf(afe)}`,
        body: `${describe(afe)}\n\nThe issued AFE is attached: the AFE exactly as it was signed, with internal order ${ioNumber}`
          + `${afe.fa.aucNumber ? `, AuC ${afe.fa.aucNumber}` : ""}${afe.plant ? `, plant ${afe.plant}` : ""}`
          + ` marked in red on page 1, and the SAP budget evidence.${bound}`
          + `${note ? `\n\n${note}` : ""}`
          + `\n\n${ISSUE_HANDBACK.body(ioNumber)}\n\nOpen ${notify.link(`/afe/${afe.id}`)}.`,
        attachments: [{ attachmentId: meta.id, filename: built.filename, role: "issued_pack" }],
      }, packTo));

      return { state: afe.state, note: `issued AFE sent — ${built.pages} pages`,
        audit: { ioNumber, attachmentId: meta.id, filename: built.filename, pages: built.pages,
          signedAttachmentId: built.signedAttachmentId, signedPages: built.signedPages, carried: built.carried,
          evidencePage: built.evidencePage, approvalPage: built.approvalPage,
          merged: built.merged.map((m) => ({ filename: m.filename, pages: m.pages, truncated: m.truncated })),
          listed: built.listed.map((l) => ({ filename: l.filename, why: l.why })), recipients: [packTo.recipientEmail].concat(packTo.cc || []) } };
    },
  },

  // A child order for a cost line that did not get one at KO01. The money comes OUT of the
  // parent as a ± pair, never as a new figure: the allocation always ties back to what was
  // approved (R52).
  add_child_io: {
    from: ["issued", "tracking"],
    allowed: IS.fa,
    async run({ repos, ctx, afe, payload }) {
      const ios = await repos.ios.all((i) => i.afeId === afe.id);
      const parent = ios.find((i) => i.kind === "parent");
      if (!parent) return { error: "This AFE has no parent order to draw the budget from." };
      const seq = Number(payload.seq);
      const bad = ioRegistry.validateChild(afe, ios, { seq, ioNumber: payload.ioNumber });
      if (bad) return { error: bad };
      const line = ioRegistry.childPlan(afe, ios).find((p) => p.seq === seq);
      const ioNumber = String(payload.ioNumber).trim();
      if (await repos.ios.find((i) => i.ioNumber === ioNumber)) return { error: `Internal order ${ioNumber} is already recorded on another AFE.` };
      const inSap = ioRegistry.sapConflict(ioNumber, afe, await sapRowsFor(repos, ioNumber));
      if (inSap) return { error: inSap.error, sap: inSap.row };
      const amount = Math.round((line.amountUsd || 0) * 100) / 100;
      const available = Math.round((parent.allocatedBudgetUsd || 0) * 100) / 100;
      if (amount > available) {
        return { error: `${line.site} needs ${money(amount)} and order ${parent.ioNumber} holds only ${money(available)}. Move budget between the orders first, or correct the cost line.` };
      }
      const at = nowIso();
      const who = { byEmail: ctx.user.email, byName: nameOf(ctx) };
      const move = Object.assign({ fromIo: parent.ioNumber, toIo: ioNumber, amountUsd: amount, note: `budget for ${line.site} moved to its own order`, at }, who);
      const child = await repos.ios.insert({
        afeId: afe.id, ioNumber, kind: "child", parentIoNumber: parent.ioNumber, lineSeq: seq,
        country: line.country || null, site: line.site || null, description: `${titleOf(afe)} — ${line.site}`,
        division: afe.division || null, region: afe.region || null, companyCode: afe.companyCode || null,
        costCenter: afe.costCenter || null, plant: afe.plant || null, orderType: parent.orderType || null,
        budgetCategory: (afe.budget && afe.budget.budgetCategory) || null, afeCategory: (afe.budget && afe.budget.afeCategory) || null,
        function: null, subFunction: null, issuedAt: at, recordedByEmail: ctx.user.email,
        allocatedBudgetUsd: amount, budgetMoves: amount ? [Object.assign({ deltaUsd: amount }, move)] : [],
        aucNumber: null, status: "open",
      });
      if (amount) {
        await repos.ios.update(parent.id, {
          allocatedBudgetUsd: Math.round((available - amount) * 100) / 100,
          budgetMoves: (parent.budgetMoves || []).concat([Object.assign({ deltaUsd: -amount }, move)]),
        });
      }
      afe.ioNumbers = (afe.ioNumbers || []).concat([ioNumber]);
      // No mail (R164): nobody has to act on a new child order, and the project page shows it.
      return { state: "tracking", note: `child order ${ioNumber} added for ${line.site}`,
        audit: { ioNumber, site: line.site, country: line.country, seq, amountUsd: amount, fromIo: parent.ioNumber, ioId: child.id } };
    },
  },

  // Budget between two orders on the same AFE. Always a pair — a reduction on one and an
  // addition on the other, the way Aiden's tracker records it — so the approved total never moves.
  move_budget: {
    from: ["issued", "tracking"],
    allowed: IS.fa,
    async run({ repos, ctx, afe, payload }) {
      const ios = await repos.ios.all((i) => i.afeId === afe.id);
      const plan = ioRegistry.planMove(afe, ios, payload || {});
      if (plan.error) return { error: plan.error };
      const at = nowIso();
      const who = { byEmail: ctx.user.email, byName: nameOf(ctx) };
      const base = Object.assign({ fromIo: plan.from.ioNumber, toIo: plan.to.ioNumber, amountUsd: plan.amountUsd, note: plan.note, at }, who);
      await repos.ios.update(plan.from.id, { allocatedBudgetUsd: plan.fromAfterUsd,
        budgetMoves: (plan.from.budgetMoves || []).concat([Object.assign({ deltaUsd: -plan.amountUsd }, base)]) });
      await repos.ios.update(plan.to.id, { allocatedBudgetUsd: plan.toAfterUsd,
        budgetMoves: (plan.to.budgetMoves || []).concat([Object.assign({ deltaUsd: plan.amountUsd }, base)]) });
      // No mail (R164): the move is Fixed Assets' own, audited and shown on the project page.
      return { state: "tracking", note: `${money(plan.amountUsd)} moved from ${plan.from.ioNumber} to ${plan.to.ioNumber}`,
        audit: { fromIo: plan.from.ioNumber, toIo: plan.to.ioNumber, amountUsd: plan.amountUsd, note: plan.note,
          fromAfterUsd: plan.fromAfterUsd, toAfterUsd: plan.toAfterUsd } };
    },
  },

  // The AuC settles to a fixed asset (AIBU). What Fixed Assets records here is what SAP did:
  // the asset number and the date. The tolerance is the one from the AuC recon workbook —
  // beyond 105 % of what was approved, a supplemental AFE comes first (refData).
  capitalize: {
    from: ["issued", "tracking"],
    allowed: IS.faPreparer,
    async run({ repos, ctx, afe, payload }) {
      // The run is SAP's order, and capitalizing ends it. It was allowed straight after the order
      // was recorded: the budget, the AuC and the settlement rule could then never be recorded,
      // and — because the issued AFE is built only from `issued`/`tracking` — the requester would
      // never be sent it (found 2026-10-16). Each step that is still open is named.
      const st = (afe.fa && afe.fa.steps) || {};
      const open = HANDOFF_STEPS.filter((s) => s.key !== "KO01_IO" && !(st[s.key] && st[s.key].doneAt));
      if (open.length) {
        const named = { KO22_BUDGET: "the budget (KO22)", AS01_AUC: "the AuC (AS01)", KO02_SETTLEMENT: "the settlement rule (KO02)" };
        return { error: `Record ${open.map((s) => named[s.key] || s.title).join(", ")} first — once it is capitalized they can no longer be recorded.`,
          openSteps: open.map((s) => s.key) };
      }
      if (!(afe.fa && afe.fa.packSentAt)) {
        return { error: "Send the issued AFE to the requester first — once it is capitalized it can no longer be built.", openSteps: ["ISSUED_PACK"] };
      }
      const assetNumber = String(payload.assetNumber || "").trim();
      if (!/^\d{6,12}$/.test(assetNumber)) return { error: "Type the fixed-asset number AIBU settled to — 6 to 12 digits." };
      const at = payload.capitalizedAt || nowIso().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) return { error: "The capitalization date reads yyyy-mm-dd." };
      // A posting date may be in the future; a capitalization date may not. "How can we
      // capitalize the future date?" (Lyndsay, Meeting #5 40:17) — an asset is capitalized when it
      // is in service, which is something that has already happened.
      const today = nowIso().slice(0, 10);
      if (at > today) return { error: `An asset cannot be capitalized on ${at} — that is in the future. Use today or the date it was actually put to use.` };
      const ios = await repos.ios.all((i) => i.afeId === afe.id);
      if (!ios.length) return { error: "This AFE has no internal order to settle." };
      const approved = afeRules.total(afe);
      const amountUsd = payload.amountUsd === undefined || payload.amountUsd === null || payload.amountUsd === ""
        ? null : Math.round(Number(payload.amountUsd) * 100) / 100;
      if (amountUsd !== null && !(amountUsd > 0)) return { error: "The capitalized amount has to be a number greater than zero." };
      const settled = amountUsd === null ? approved : amountUsd;
      const limit = Math.round(approved * CAPITALIZATION_TOLERANCE * 100) / 100;
      const waived = Boolean(payload.supplementalAfeId);
      if (approved > 0 && settled > limit && !waived) {
        return { error: `${money(settled)} is over the ${Math.round(CAPITALIZATION_TOLERANCE * 100)} % tolerance on ${money(approved)} approved (${money(limit)}). A supplemental AFE covers the difference before this can be capitalized.`,
          approvedUsd: approved, settledUsd: settled, limitUsd: limit };
      }
      if (waived) {
        const supp = await repos.afes.get(String(payload.supplementalAfeId));
        if (!supp || supp.kind !== "supplemental") return { error: `${payload.supplementalAfeId} is not a supplemental AFE.` };
        if (!["issued", "tracking", "capitalized", "closed"].includes(supp.state)) {
          return { error: `The supplemental "${titleOf(supp)}" is ${supp.state.replace(/_/g, " ")} — it has to be issued before it can cover the overspend.` };
        }
      }
      const when = nowIso();
      afe.fa = afe.fa || {};
      afe.fa.capitalized = { assetNumber, capitalizedAt: at, amountUsd: settled, approvedUsd: approved,
        overTolerance: approved > 0 && settled > limit, supplementalAfeId: payload.supplementalAfeId || null,
        note: payload.note ? String(payload.note).trim() : null, byEmail: ctx.user.email, byName: nameOf(ctx), at: when };
      afe.fa.steps = Object.assign({}, afe.fa.steps, { AIBU_CAPITALIZE: { doneAt: when, byEmail: ctx.user.email, byName: nameOf(ctx), value: assetNumber } });
      for (const io of ios) await repos.ios.update(io.id, { status: "capitalized", aucNumber: io.aucNumber || null, assetNumber, capitalizedAt: at });
      await notify.enqueue(repos, Object.assign(ownerMail(afe, [], ctx.user.email) || { recipientEmail: null }, {
        afeId: afe.id, kind: "afe_capitalized",
        subject: `Capitalized: ${titleOf(afe)}`,
        body: `${describe(afe)}\nThe asset under construction settled to fixed asset ${assetNumber} on ${at}${settled !== approved ? ` at ${money(settled)}` : ""}.\nDepreciation starts from the in-service date. Nothing further is needed from you.`,
      }));
      const checkers = await repos.users.all((u) => u.active !== false && (u.roles || []).includes("fa_checker") && u.email !== ctx.user.email);
      await notify.enqueue(repos, Object.assign(oneMail(checkers.map((u) => u.email)) || { recipientEmail: null }, {
        afeId: afe.id, kind: "close_review",
        subject: `To close: ${titleOf(afe)}`,
        body: `${describe(afe)}\n${nameOf(ctx)} capitalized it to asset ${assetNumber} on ${at}. A second person closes it — open ${notify.link(`/fa/${afe.id}/issue`)}.`,
      }));
      return { state: "capitalized", note: `capitalized to asset ${assetNumber}`,
        audit: { assetNumber, capitalizedAt: at, amountUsd: settled, approvedUsd: approved,
          overTolerance: afe.fa.capitalized.overTolerance, supplementalAfeId: payload.supplementalAfeId || null, orders: ios.length } };
    },
  },

  // Four eyes: whoever capitalized it cannot be the one who closes it. The rule is about the
  // person, not the role — an FA who holds both roles still cannot do both halves.
  close: {
    from: ["capitalized"],
    allowed: (ctx, afe) => {
      if (!roles(ctx).includes("fa_checker")) return false;
      const cap = (afe.fa && afe.fa.capitalized) || null;
      return !cap || cap.byEmail !== (ctx.user && ctx.user.email);
    },
    async run({ repos, ctx, afe, payload }) {
      const cap = (afe.fa && afe.fa.capitalized) || null;
      if (cap && cap.byEmail === ctx.user.email) {
        return { error: "You capitalized this one — a second person closes it (four eyes)." };
      }
      const at = nowIso();
      afe.fa = afe.fa || {};
      afe.fa.closed = { byEmail: ctx.user.email, byName: nameOf(ctx), at, note: payload.note ? String(payload.note).trim() : null };
      for (const io of await repos.ios.all((i) => i.afeId === afe.id)) await repos.ios.update(io.id, { status: "closed", closedAt: at });
      return { state: "closed", note: `closed by ${nameOf(ctx)} — checked against ${cap ? cap.byName : "the preparer"}'s capitalization`,
        audit: { capitalizedBy: cap ? cap.byEmail : null, closedBy: ctx.user.email, assetNumber: cap ? cap.assetNumber : null, note: afe.fa.closed.note } };
    },
  },

  withdraw: {
    from: ["draft", "submitted", "in_approval", "on_hold", "returned"],
    allowed: IS.ownerSide,
    async run({ repos, ctx, afe, routing, envelope, payload }) {
      const at = nowIso();
      const reason = String(payload.reason || "").trim() || "withdrawn by the requester side";
      const wasWith = holder(routing);
      await closeRound(routing, envelope, `withdrawn by ${nameOf(ctx)}: ${reason}`, at, "voided");
      afe.withdrawn = { byEmail: ctx.user.email, byName: nameOf(ctx), reason, at };
      afe.hold = null;
      const to = ownerMail(afe, wasWith && wasWith.email ? [wasWith.email] : [], ctx.user.email);
      if (to) await notify.enqueue(repos, Object.assign(to, { afeId: afe.id, kind: "withdrawn", subject: `Withdrawn: ${titleOf(afe)}`,
        body: `${describe(afe)}\n\n${nameOf(ctx)} withdrew it: ${reason}. Nothing further is needed.` }));
      return { state: "withdrawn", note: `withdrawn by ${nameOf(ctx)}`, audit: { reason } };
    },
  },
};

/**
 * Apply a lifecycle action. Returns { ok: true, afe, note, routing, envelope } or
 * { ok: false, status, error, detail }. The AFE, its routing and its envelope are written
 * back here, then the transition is audited — one place, one order.
 */
async function applyTransition(repos, ctx, afe, action, payload) {
  const t = TRANSITIONS[action];
  if (!t) return { ok: false, status: 400, error: `unknown action ${action}` };
  if (!t.from.includes(afe.state)) {
    return { ok: false, status: 409, error: `cannot ${action.replace("_", " ")} an AFE that is ${afe.state.replace("_", " ")}`, state: afe.state };
  }
  const routing = afe.routingId ? await repos.routings.get(afe.routingId) : null;
  const envelope = afe.envelopeId ? await repos.envelopes.get(afe.envelopeId) : null;
  if (!t.allowed(ctx || {}, afe, routing, envelope)) {
    return { ok: false, status: 403, error: `you cannot ${action.replace("_", " ")} this AFE — it is not yours, or it is not with you` };
  }

  const fromState = afe.state;
  const result = await t.run({ repos, ctx: ctx || {}, afe, routing, envelope, payload: payload || {} });
  if (result.error) {
    const detail = Object.assign({}, result);
    delete detail.error;
    return { ok: false, status: 422, error: result.error, detail: Object.keys(detail).length ? detail : null };
  }

  const at = nowIso();
  afe.state = result.state;
  afe.updatedAt = at;
  if (routing) await repos.routings.update(routing.id, routing);
  if (envelope) await repos.envelopes.update(envelope.id, envelope);
  await repos.afes.update(afe.id, afe);
  await audit.record(repos, ctx, { entity: "afe", entityId: afe.id, type: action, fromState, toState: result.state,
    payload: Object.assign({ note: result.note || null }, result.audit || {}) });

  if (result.then) {
    afe.state = result.then.state;
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, ctx, { entity: "afe", entityId: afe.id, type: result.then.type, fromState: result.state, toState: result.then.state,
      payload: { note: result.then.note || null } });
  }
  return { ok: true, afe, note: result.note || null, routing, envelope };
}

module.exports = { applyTransition, TRANSITIONS, holder, nextPending, signerCount, IS, notifySigner };
