"use strict";
// Whether a returned AFE goes back into the round it came out of, or round again (R148).
//
// "If they need to redo this entire approval workflow, it would be a real challenge for the
// requester… it will delay the process" (Judithmelanie, Meeting #6). Jarrod: "if any critical
// information is getting changed… ideally it should go for re-approval." And Imogen drew the
// line: the amount, the cost centre and the budget matter; the start date, the end date and the
// description do not.
//
// So a send-back no longer voids the envelope. The round is PAUSED, and the decision moves to
// resubmission, where this function makes it. It is the same function the review screen asks
// beforehand, so a screen can never promise "it goes straight back" about an AFE the transition
// then sends round again.
//
// What the signatures cover, and so what must be unchanged for them to stand:
//   · the money: `redFlags.financialFingerprint`, frozen at send (the cost centre, the
//     classification, the four amounts, the cost lines, the charge-to, the requester, the kind);
//   · the budget and the case: `caseFingerprint` (budgeted or not, the pot, its category and
//     year, and the NPV, IRR, ROI and payback the approvers were shown). Imogen named the budget,
//     and an approver can send an AFE back to the Financials step (R118), so resuming after the
//     NPV moved would ask the next signer to sign the wrong one;
//   · who signs: the chain the tool would build now against the chain frozen at send, because a
//     signer the coordinator added while it was back has to be on the envelope;
//   · what they were given: the supporting documents. The envelope's document cannot change once
//     somebody has signed it, so a quote added while it was back would be a quote nobody signed.
// Everything else — the description, the dates, the scope — is text, and Imogen's word stands.
//
// A Fixed Assets return is the other mode. The chain is complete, so there is nobody left to sign
// and nothing to resume: the money and the case decide, exactly as they always have (the
// documents and the chain do not, because Fixed Assets may bind more in at issue).
//
// Pure: everything it reads is handed in.
const redFlags = require("./redFlags");
const people = require("./people");
const financials = require("./financials");
const { FIELD_BY_ID } = require("./afeRules");
const { FINANCIALS } = require("./refData");

const OPEN = ["sent", "delivered", "created"];

/** What each part of the two fingerprints is called when it is the thing that changed. */
const LABELS = {
  costCenter: "the cost centre", classification: "the classification",
  capexUsd: "the CapEx", cloudCapexUsd: "the Cloud CapEx", opexUsd: "the OpEx", laborUsd: "the labour cost",
  lines: "the cost lines", chargeTo: "the charge-to", requester: "the requester", kind: "the kind of AFE",
  supplementalOf: "the order it tops up",
  budgeted: "whether it is budgeted", potId: "the budget pot", budgetCategory: "the budget category",
  otherBudget: "which budget it comes out of",
  fiscalYear: "the fiscal year", npv: "the NPV", irr: "the IRR", roiPct: "the ROI", payback: "the payback",
};

/**
 * The half of "what they decided" that `financialFingerprint` does not hold: the budget the
 * money comes out of and the case made for spending it.
 *
 * Kept apart from `financialFingerprint` on purpose. That one is frozen on every routing already
 * sent, so adding a field to it would make every AFE in flight look changed.
 */
function caseFingerprint(afe) {
  const a = afe || {};
  const b = a.budget || {};
  const f = financials.fromAfe(a, FINANCIALS);
  const r1 = (n) => (typeof n === "number" && isFinite(n) ? Math.round(n * 10) / 10 : null);
  return JSON.stringify({
    budgeted: b.budgeted || null,
    potId: b.potId || null,
    budgetCategory: b.budgetCategory || null,
    // Present only when typed (R167): a key that is always there, even null, would make every AFE
    // paused before it look changed and send it round again.
    otherBudget: String(b.otherBudget || "").trim() || undefined,
    fiscalYear: (a.schedule && a.schedule.fiscalYear) || null,
    npv: f ? Math.round(f.npv) : null,
    irr: f ? r1(f.irr) : null,
    roiPct: f ? r1(f.roiPct) : null,
    payback: f ? r1(f.payback) : null,
  });
}

/** The keys of two fingerprints whose values differ. */
function changedKeys(was, now) {
  if (was === now) return [];
  let a, b;
  try { a = JSON.parse(was); b = JSON.parse(now); } catch (e) { return ["money"]; }
  return Object.keys(Object.assign({}, a, b)).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
}

const signing = (recipients) => (recipients || [])
  .filter((r) => r.role !== "cc" && r.order !== null && r.order !== undefined)
  .sort((a, b) => a.order - b.order);
const copies = (recipients) => (recipients || []).filter((r) => r.role === "cc");
const who = (r) => people.normName(r.name) || people.normEmail(r.email) || "?";

/** The pause this round is in, if it is in one. */
function currentPause(routing) {
  const pauses = (routing && routing.pauses) || [];
  const last = pauses[pauses.length - 1];
  return last && !last.resumedAt ? last : null;
}

/**
 * What the approvers were given with this envelope: `supportingDocumentIds` is frozen at send;
 * an envelope older than that is read from what it recorded binding in and sending alongside.
 */
function documentsGiven(envelope) {
  if (!envelope) return [];
  if (Array.isArray(envelope.supportingDocumentIds)) return envelope.supportingDocumentIds.slice();
  const ids = new Set(envelope.boundDocumentIds || []);
  for (const d of envelope.documents || []) if (d.attachmentId && d.role !== "sent_packet") ids.add(d.attachmentId);
  return Array.from(ids);
}

const valueAt = (o, path) => String(path).split(".").reduce((x, k) => (x === null || x === undefined ? undefined : x[k]), o);

/**
 * Every field the form asks, as the AFE stands, taken when a send-back pauses the round, so a
 * resubmission can say what is DIFFERENT rather than what was touched. The edit log could only
 * say the second: an amount typed and put back read as "Changed: CapEx" beside "nothing that
 * decides it changed", which is two true statements that contradict each other.
 */
function fieldValues(afe) {
  const out = {};
  for (const id of Object.keys(FIELD_BY_ID)) {
    const v = valueAt(afe, id);
    out[id] = JSON.stringify(v === undefined ? null : v);
  }
  out.financials = JSON.stringify((afe && afe.financials) || null);
  return out;
}

/** The labels of the fields whose value is not what `fieldValues` recorded. */
function changedFields(snapshot, afe) {
  if (!snapshot) return [];
  const now = fieldValues(afe);
  return Array.from(new Set(Object.keys(now).filter((k) => now[k] !== snapshot[k]).map(fieldLabel)));
}

/** "Project description", for a field path. */
function fieldLabel(path) {
  const p = String(path || "");
  const f = FIELD_BY_ID[p];
  if (f && f.label) return f.label;
  if (p.startsWith("financials")) return "Financial case";
  if (p.startsWith("cloud.")) return "Cloud CapEx answers";
  if (p === "approverNote") return "Note to approvers";
  return p;
}

/**
 * @param {object} o
 *   afe        the AFE as it stands now
 *   routing    the round it came out of (`afe.routingId`)
 *   envelope   that round's envelope
 *   preview    the chain the tool would build now; a paused round needs it, a signed one does not
 *   documents  the supporting documents the AFE carries now, [{ attachmentId, filename }]
 * @returns {{ applies, mode, can, holder, signed, reasons }}
 *   applies   false when there is no round to go back into (it was never sent, or the round
 *             was closed), and the caller simply sends a new one
 *   mode      "paused" — sent back mid-chain, resumes at `holder` on the same envelope;
 *             "signed" — returned by Fixed Assets with every signature in, goes back to them
 *   can       every check passed; `reasons` says what did not, in words for the screen
 */
function resumeCheck(o) {
  const { afe, routing, envelope } = o || {};
  const none = { applies: false, mode: null, can: false, holder: null, signed: [], reasons: [] };
  if (!afe || afe.state !== "returned" || !routing) return none;
  const returned = afe.returnedTo || {};
  let mode = null;
  if (routing.status === "returned") mode = "paused";
  else if (returned.role === "fa" && routing.status === "completed" && envelope && envelope.status === "completed") mode = "signed";
  if (!mode) return none;

  const signers = (routing.recipients || []).filter((r) => r.role !== "cc");
  const pause = mode === "paused" ? currentPause(routing) : null;
  const reasons = [];

  // 1. The money, against what the round froze when it was sent.
  const basis = routing.basis || {};
  if (!basis.fingerprint) reasons.push({ key: "fingerprint", text: "this round kept no record of the money it was sent with" });
  else for (const k of changedKeys(basis.fingerprint, redFlags.financialFingerprint(afe))) reasons.push({ key: k, text: `${LABELS[k] || k} changed` });

  // 2. The budget and the case. Frozen at send from R148 on; a round sent before that was
  // snapshotted when it came back, which is the last moment nobody could have edited it.
  const caseWas = basis.case || (pause && pause.case) || returned.case || null;
  if (caseWas) for (const k of changedKeys(caseWas, caseFingerprint(afe))) reasons.push({ key: k, text: `${LABELS[k] || k} changed` });

  let holder = null;
  if (mode === "paused") {
    // 3. There is still an envelope to go back into.
    if (!envelope || !OPEN.includes(String(envelope.status).toLowerCase())) {
      reasons.push({ key: "envelope", text: "the envelope is no longer open" });
    }
    holder = (pause && signers.find((r) => r.id === pause.holderId)) || null;
    if (!holder) reasons.push({ key: "holder", text: "nobody was holding it when it came back" });

    // 4. Who signs. Compared by person and order, so a new matrix name, a signer the coordinator
    // added and one they took out all count; the ids differ by round and are not compared.
    if (!o.preview) reasons.push({ key: "chain", text: "who signs could not be checked" });
    else {
      const was = signing(routing.recipients), now = signing(o.preview.recipients);
      const wasKeys = was.map(who), nowKeys = now.map(who);
      if (wasKeys.join("|") !== nowKeys.join("|")) {
        const added = now.filter((r) => !wasKeys.includes(who(r))).map((r) => r.name);
        const gone = was.filter((r) => !nowKeys.includes(who(r))).map((r) => r.name);
        const parts = [added.length ? `${added.join(", ")} added` : "", gone.length ? `${gone.join(", ")} taken off` : ""].filter(Boolean);
        reasons.push({ key: "chain", text: parts.length ? `who signs changed — ${parts.join("; ")}` : "the signing order changed" });
      }
      const ccWas = copies(routing.recipients).map(who).sort().join("|");
      const ccNow = copies(o.preview.recipients).map(who).sort().join("|");
      if (ccWas !== ccNow) reasons.push({ key: "copies", text: "who is copied changed" });
    }

    // 5. What they were given.
    const given = documentsGiven(envelope);
    const now = (o.documents || []).filter((d) => d && d.attachmentId);
    const added = now.filter((d) => !given.includes(d.attachmentId));
    const gone = given.filter((id) => !now.some((d) => d.attachmentId === id));
    if (added.length || gone.length) {
      const parts = [added.length ? `${added.map((d) => d.filename || "a document").join(", ")} added` : "",
        gone.length ? `${gone.length === 1 ? "a document" : `${gone.length} documents`} taken off` : ""].filter(Boolean);
      reasons.push({ key: "documents", text: `the documents changed — ${parts.join("; ")}` });
    }
  }

  return {
    applies: true, mode, can: reasons.length === 0,
    holder: holder ? { id: holder.id, name: holder.name, email: holder.email || null, level: holder.level || null } : null,
    signed: signers.filter((r) => r.status === "signed").map((r) => ({ id: r.id, name: r.name, signedAt: r.signedAt || null })),
    reasons,
  };
}

module.exports = { resumeCheck, caseFingerprint, currentPause, documentsGiven, fieldLabel, fieldValues, changedFields, changedKeys, LABELS };
