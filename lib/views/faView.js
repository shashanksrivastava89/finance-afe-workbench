"use strict";
// What Fixed Assets sees: the AFE projection plus everything derived for the judgment —
// red flags (rules re-run now, matrix drift, envelope verification, SoD, waivers, the form
// hash), Judithmelanie's judgment rows, the KO01 keying sheet, and whether an internal order may
// be recorded. Nothing here is stored; a reload recomputes it from the facts.
const afeRules = require("../domain/afeRules");
const redFlags = require("../domain/redFlags");
const faJudgment = require("../domain/faJudgment");
const sapSheet = require("../domain/sapSheet");
const envelopeDocs = require("../envelopeDocs");
const notify = require("../notify");
const audit = require("../audit");
const { afeView, afeBrief } = require("./afeView");
const { HANDOFF_STEPS, ORDER_TYPES, FA_ISSUE_APPROVAL } = require("../domain/refData");
const people = require("../domain/people");
const issuedPack = require("../pdf/issuedPack");
const { issueApprovers, issueApproverChoice } = require("../domain/issueApproval");

/** Did this person raise, prepare or coordinate the AFE? Nobody clears their own. */
function ownerSide(ctx, afe) {
  const me = people.normEmail(ctx && ctx.user && ctx.user.email);
  if (!me) return false;
  return [afe.requester, afe.preparer, afe.coordinator]
    .some((p) => p && people.normEmail(p.email) === me);
}

const FA_STATES = ["fa_review", "issued", "tracking", "capitalized", "closed"];

/**
 * The AFEs in Fixed Assets' hands — what `/fa/queue` lists — and the ones of those still to be
 * checked. One definition, read by the queue and by the boot warm-up, so the AFEs warmed are the
 * AFEs the screens open.
 */
const inFaHands = (a) => ["approved"].concat(FA_STATES).includes(a.state)
  || (a.state === "returned" && Boolean(a.returnedTo) && a.returnedTo.role === "fa");
const toCheck = (a) => ["approved", "fa_review"].includes(a.state);

/** Audited edits made after the AFE was sent — what can legitimately change the form hash. */
async function editsSinceSend(repos, afe) {
  if (!afe.sentAt) return [];
  const rows = await audit.forAfe(repos, afe.id);
  return rows
    .filter((e) => e.createdAt > afe.sentAt && ["afe_edited", "fa_reclassified", "fa_record_io"].includes(e.type))
    .map((e) => ({
      at: e.createdAt, byEmail: e.actingAsEmail || e.actorEmail, type: e.type,
      paths: e.type === "fa_reclassified" ? ["money.classification"]
        : e.type === "fa_record_io" ? ["afeNo"]                    // the number SAP assigned, written back by design
        : Object.keys((e.payload && e.payload.applied) || {}),
    }));
}

/**
 * @param {object} opts { light: true } skips the PDF re-render and the audit scan (queue rows)
 */
async function faView(repos, afe, ctx, opts) {
  const o = opts || {};
  const v = await afeView(repos, afe, ctx, { full: true });
  const routing = v.routing;
  const envelope = v.envelope;
  const matrixRowNow = afe.costCenter ? await repos.matrix.find((m) => m.costCenter === String(afe.costCenter)) : null;
  const currentBatchId = repos.meta && repos.meta.matrixBatch ? repos.meta.matrixBatch.batchId : null;

  let formHash = null;
  let edits = [];
  if (!o.light && routing && envelope && envelope.formHash) {
    try { formHash = await envelopeDocs.verifyFormHash(afe, routing, envelope); } catch (e) { formHash = { checked: false, ok: null, reason: e.message }; }
    edits = await editsSinceSend(repos, afe);
  }
  const sentFingerprint = routing && routing.basis ? routing.basis.fingerprint || null : null;
  const fingerprintChanged = Boolean(sentFingerprint) && redFlags.financialFingerprint(afe) !== sentFingerprint;
  const total = v.totalUsd;
  const quoteCoveragePct = total ? Math.round((v.quoteTotalUsd / total) * 100) : null;

  const flags = redFlags.computeRedFlags({
    afe, routing, envelope, matrixRowNow, currentBatchId,
    validation: v.validation,
    verification: envelope && envelope.completed ? envelope.completed.verification : [],
    formHash, editsSinceSend: edits, fingerprintChanged,
    possibleDuplicates: v.possibleDuplicates,
    quoteCoveragePct,
  });
  const judgment = faJudgment.buildJudgment({ afe, totalUsd: total, quoteTotalUsd: v.quoteTotalUsd, possibleDuplicates: v.possibleDuplicates });
  // R98 — the judgment is locked until somebody records that they have read the form and the
  // signatures. Derived here so the screen and the route cannot disagree about it.
  judgment.formReviewed = (afe.fa && afe.fa.formReviewed) || null;
  judgment.locked = Boolean(afe.state === "fa_review" && !judgment.formReviewed);

  // R101. Who may approve this for issue, whether anyone has, and — because holding two roles
  // must not let one person do both halves — whether THIS reader is still allowed to key SAP.
  // Derived at read time like everything else here: the org rules are business config and a
  // change to them takes effect on the next load.
  const approvers = await issueApprovers(repos);
  const approval = (afe.fa && afe.fa.issueApproval) || null;
  const me = people.normEmail(ctx && ctx.user && ctx.user.email);
  // Whose approval this one is waiting on — the preparer may have named one of the three (R145).
  const { chosen, wasChosen } = issueApproverChoice(afe, approvers);
  const issue = {
    required: FA_ISSUE_APPROVAL.required,
    approvers,                                       // everyone the org rules name
    chosen,                                          // who THIS AFE is with
    wasChosen,                                       // did somebody pick, or is it open to all
    approval,
    // "I am one of the people it is with, this is not my own AFE, and nobody has approved it."
    canApprove: Boolean(FA_ISSUE_APPROVAL.required && !approval && afe.state === "fa_review"
      && chosen.some((a) => a.email === me) && !ownerSide(ctx, afe)),
    // The preparer decides who it goes to, and may change their mind until it is approved.
    canChoose: Boolean(FA_ISSUE_APPROVAL.required && !approval && afe.state === "fa_review"
      && v.permissions.canJudge),
    approvedByMe: Boolean(approval && people.normEmail(approval.byEmail) === me),
  };

  const why = [];
  if (afe.state !== "fa_review") why.push(`This AFE is ${String(afe.state).replace(/_/g, " ")}, not with Fixed Assets for review.`);
  if (flags.summary.openBlocks) why.push(`${flags.summary.openBlocks} red flag${flags.summary.openBlocks > 1 ? "s" : ""} to clear or acknowledge.`);
  if (judgment.locked) why.push("The form and the signatures have not been reviewed yet.");
  if (judgment.open) why.push(`${judgment.open} judgment row${judgment.open > 1 ? "s" : ""} still open${judgment.rows.some((r) => r.id === "order_type" && r.st !== "ok") ? " — including the order type" : ""}.`);
  if (issue.required && !approval) {
    why.push(`Not approved for issue yet — ${chosen.map((a) => a.name).join(" or ") || "an FA issue approver"} approves it first.`);
  } else if (issue.approvedByMe) {
    why.push("You approved this for issue yourself, so somebody else records the internal order.");
  }
  const readiness = { canRecord: v.permissions.canRecordIo && why.length === 0, why };

  // Each hand-off step, what it still needs, and whether it can be started at all — derived
  // from the same declarations the route enforces, so the screen cannot offer a step the API
  // would refuse (R99, R100, R103).
  const doneSteps = (afe.fa && afe.fa.steps) || {};
  const steps = HANDOFF_STEPS.map((s) => {
    const evidence = s.needsEvidence
      ? (afe.documents || []).filter((d) => d.role === s.needsEvidence.role)
      : [];
    return Object.assign({}, s, {
      done: doneSteps[s.key] || null,
      blockedBy: s.after && !doneSteps[s.after] ? s.after : null,
      hasEvidence: s.needsEvidence ? evidence.length > 0 : true,
      evidence: evidence.map((d) => ({ attachmentId: d.attachmentId, filename: d.filename, mimeType: d.mimeType || "application/pdf" })),
    });
  });
  // R93/R104 — the issued AFE: whether it can be sent, what would bind into it, and whether
  // one has gone already. Derived from the same rules `fa_issue_pack` enforces.
  const packMissing = [];
  if (!afe.afeNo) packMissing.push("there is no internal order yet");
  if (afe.afeNo && !doneSteps.KO22_BUDGET) packMissing.push("the budget is not loaded (KO22)");
  if (afe.afeNo && !doneSteps.AS01_AUC) packMissing.push("there is no AuC number (AS01)");
  if (afe.afeNo && !(afe.documents || []).some((d) => d.role === "budget_evidence")) {
    packMissing.push("the Budget / Actual / Commitments screenshot is not attached");
  }
  const packs = (afe.documents || []).filter((d) => d.role === "issued_pack");
  // Which screenshot the pack would actually DRAW. `issuedPack` takes the LAST budget_evidence
  // image and un-merges only that one; a second screenshot stays an ordinary attachment and is
  // bound in as a page of its own. This view used to call EVERY budget_evidence image drawn, so
  // on an AFE carrying two of them the screen promised "printed on the page" for both while the
  // builder bound one — a preview that does not agree with the thing it previews.
  const drawnId = (afe.documents || [])
    .filter((d) => d.role === "budget_evidence" && /^image\/(png|jpeg)$/.test(d.mimeType || ""))
    .map((d) => d.attachmentId)
    .pop() || null;

  // The pack is built ON the signed set (R156), so what is already inside it is not a choice:
  // it is shown as the signed AFE's own contents, and only what is added behind it can be ticked.
  // The same derivation as the builder's, from `issuedPack` itself, so the two cannot disagree.
  const signedSet = issuedPack.signedSetOf(afe);
  const carried = new Set(await issuedPack.carriedBy(repos, afe, envelope, signedSet));
  const signedPages = signedSet ? await issuedPack.pagesOf(repos, signedSet) : null;

  const pack = {
    can: Boolean(["issued", "tracking"].includes(afe.state) && !packMissing.length && v.permissions.canTickSteps),
    missing: packMissing,
    sentAt: (afe.fa && afe.fa.packSentAt) || null,
    sentBy: (afe.fa && afe.fa.packSentBy) || null,
    latest: packs.length ? packs[packs.length - 1] : null,
    count: packs.length,
    signed: signedSet ? { attachmentId: signedSet.attachmentId, filename: signedSet.filename, sizeBytes: signedSet.sizeBytes || 0, pages: signedPages } : null,
    // What would go inside it, and what would only be listed — so nobody has to build one to
    // find out (R93: the certificate and the KO22 evidence are added by default). The tool's own
    // generations of the AFE are never offered: the newest signed set IS the base, and the rest
    // are the same document at an earlier moment.
    willMerge: (afe.documents || [])
      .filter((d) => !issuedPack.GENERATIONS.includes(d.role))
      .map((d) => {
        if (carried.has(d.attachmentId)) {
          return {
            attachmentId: d.attachmentId, filename: d.filename, role: d.role, sizeBytes: d.sizeBytes || 0,
            inSigned: true, byDefault: true, can: true, drawn: false, why: "inside the AFE as it was signed",
          };
        }
        // The screenshot is DRAWN at the top of page one, beside the numbers it is evidence for,
        // never appended as a page of its own. `bindIn` learned to place an image on a page for
        // the send package (R112), which made this one merge-ABLE for the first time — and drawn
        // AND bound is the same picture twice. The pack builder refuses it for the same reason;
        // this is the view telling a person the same thing before they press the button.
        const drawn = d.attachmentId === drawnId;
        const m = issuedPack.mergeability(d, { mimeType: d.mimeType || "application/pdf", sizeBytes: d.sizeBytes });
        return {
          attachmentId: d.attachmentId, filename: d.filename, role: d.role,
          sizeBytes: d.sizeBytes || 0,
          byDefault: issuedPack.MERGE_BY_DEFAULT.includes(d.role),
          can: drawn ? false : m.can,
          drawn,
          why: drawn ? "drawn at the top of page 1, beside the numbers" : m.why || null,
        };
      }),
    approvers: approvers.map((a) => a.name),
    // Who approved the issue, as the builder prints it — named in red at the top of page one and
    // recorded on a page of its own after the index (R168). The builder's own function, so the
    // preview and the pack cannot describe two different approvals.
    approval: issuedPack.approvalOf(afe),
  };

  const out = Object.assign({}, v, {
    redFlags: flags,
    judgment,
    pack,
    // The steps carry what the earlier ones produced, so KO02 names the real AuC number rather
    // than "the new AUC" — the difference between an instruction and a value you can copy.
    ko01: { rows: sapSheet.buildKo01(afe), children: sapSheet.buildChildPlan(afe), orderTypes: ORDER_TYPES,
      steps: sapSheet.buildSteps(afe, { ioNumber: (afe.fa && afe.fa.ioNumber) || afe.afeNo || null, aucNumber: (afe.fa && afe.fa.aucNumber) || null }) },
    handoff: steps,
    issue,
    readiness,
    matrix: {
      sentBatchId: flags.drift.sentBatchId, currentBatchId, batchChanged: flags.drift.batchChanged,
      then: routing && routing.basis && routing.basis.matrixRow ? routing.basis.matrixRow.levels : null,
      now: matrixRowNow ? matrixRowNow.levels : null,
      levels: routing && routing.basis ? routing.basis.levels : [],
    },
    formHash,
    editsSinceSend: edits,
    fingerprintChanged,
    receivedAt: (afe.fa && afe.fa.receivedAt) || afe.approvedAt || null,
    // The supplementals raised on this AFE, so capitalizing over the tolerance can name the one
    // that covers it. The refusal said "a supplemental covers the difference" and the sheet had
    // nowhere to say which (2026-10-16).
    supplementals: (await repos.afes.all((x) => x.kind === "supplemental" && x.supplementalOf && x.supplementalOf.afeId === afe.id))
      .map((x) => ({ id: x.id, title: (x.project && x.project.title) || x.id, state: x.state, totalUsd: afeRules.total(x),
        issued: ["issued", "tracking", "capitalized", "closed"].includes(x.state) })),
  });
  // One name for the public address, and it is `notify.link`'s. This read `PUBLIC_BASE_URL`
  // until 2026-09-14 — a second spelling nobody sets, so the digest a coordinator receives was
  // the one mail in the system with dead links in it.
  if (!o.light) out.digest = redFlags.buildRedFlagDigest(afe, flags.flags, { totalUsd: total, baseUrl: notify.link("") });
  return out;
}

/** A queue row: the brief plus the little Fixed Assets needs to pick the next one. */
async function faQueueRow(repos, afe, ctx, now) {
  const fv = await faView(repos, afe, ctx, { light: true });
  const brief = afeBrief(afe);
  const received = fv.receivedAt;
  const verification = (fv.envelope && fv.envelope.completed && fv.envelope.completed.verification) || [];
  return Object.assign(brief, {
    receivedAt: received,
    days: received ? Math.floor((new Date(now).getTime() - new Date(received).getTime()) / 86400000) : null,
    flags: { openBlocks: fv.redFlags.summary.openBlocks, openWarns: fv.redFlags.summary.openWarns, drift: fv.redFlags.summary.drift, driftCleared: fv.redFlags.summary.driftCleared,
      first: (fv.redFlags.open[0] && fv.redFlags.open[0].title) || null },
    verified: { ok: verification.filter((r) => r.st === "ok").length, of: verification.length },
    judgment: { open: fv.judgment.open, of: fv.judgment.rows.length },
    provider: fv.envelope ? fv.envelope.provider : null,
    orderType: (afe.fa && afe.fa.orderType) || null,
    issueApproval: (afe.fa && afe.fa.issueApproval) || null,
    // Whether THIS caller is the one holding it up. Four eyes on the creation of an internal
    // order only works if the two people can see what is waiting for them (R142).
    canApproveIssue: Boolean(fv.issue && fv.issue.canApprove),
    // The SAME conditions the transition itself enforces, minus "am I one of the two". The
    // judgment is deliberately NOT among them: the approval answers "should an internal order
    // exist", the judgment is the preparer's own checklist, and `fa_record_io` still refuses
    // until that is done. Two jobs, two people. A chip stricter than the guard would have said
    // "not waiting on anybody" about an AFE that was.
    needsIssueApproval: Boolean(fv.issue && fv.issue.required && !fv.issue.approval
      && afe.state === "fa_review" && fv.redFlags.ready),
    issueApprovers: (fv.issue && fv.issue.chosen) || [],
    ioNumbers: afe.ioNumbers || [],
    steps: (afe.fa && afe.fa.steps) || {},
    // So the row can say what comes next all the way to Close, not stop at AS01.
    packSentAt: (afe.fa && afe.fa.packSentAt) || null,
    capitalizedBy: (afe.fa && afe.fa.capitalized && afe.fa.capitalized.byName) || null,
    returnedTo: afe.state === "returned" ? afe.returnedTo || null : null,
    total: afeRules.total(afe),
  });
}

module.exports = { faView, faQueueRow, FA_STATES, inFaHands, toCheck };
