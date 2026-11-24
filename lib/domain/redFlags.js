"use strict";
// Red flags — what Fixed Assets must clear or acknowledge before an internal order exists.
//
// Pure, and derived at read time (CLAUDE.md: derived, never stored). Everything here is
// computed from stored facts the caller hands in: the AFE, the routing frozen at send, the
// envelope as the provider reported it, the SAP approver matrix AS IT IS NOW, the rule
// validation re-run today, and the audited edits since send. Storing a flag would let it
// drift from the data it is about — the flag lives exactly as long as its cause.
//
// Five sources (docs/v0.4-blueprint.md §5.4):
//   (a) rules — a block, warn or pending that is still true at receipt (the wizard blocked
//       the blocks before send; a date passing or a matrix row deactivating can raise one now)
//   (b) matrix drift — for every level the band required, the name in the frozen chain vs
//       the name the current matrix holds. A change means the person SAP now holds
//       accountable did not sign. Cleared only with evidence: an email approval attached and
//       acknowledged against that level (R46).
//   (c) envelope verification — the provider's recipients vs the frozen chain (miss,
//       mismatch, declined, pending), and the signed set's own storage error if any
//   (d) segregation of duties — an excluded matrix level with no stand-in
//   (e) waivers, and the form re-rendered today not hashing to what was signed
//
// Severity: `block` stops the internal order until cleared or acknowledged; `warn` is shown
// and can be acknowledged. Every acknowledgement is a stored fact on the AFE
// (`fa.flagAcks`, `fa.driftAck`) and an audit event — the flag itself is never written.
const people = require("./people");
const { LEVEL_TITLES, LEVEL_LADDER } = require("./refData");

const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";

/** Which financial facts, if changed, mean the signatures no longer cover the AFE. */
function financialFingerprint(afe) {
  const a = afe || {};
  const m = a.money || {};
  const n = (v) => (typeof v === "number" && isFinite(v) ? Math.round(v * 100) / 100 : 0);
  const lines = (m.lines || []).filter((l) => l && l.amountUsd).map((l) => ({ site: l.site || "", country: l.country || "", amountUsd: n(l.amountUsd) }));
  return JSON.stringify({
    costCenter: a.costCenter || null,
    classification: m.classification || null,
    capexUsd: n(m.capexUsd), cloudCapexUsd: n(m.cloudCapexUsd), opexUsd: n(m.opexUsd), laborUsd: n(m.laborUsd),
    lines,
    chargeTo: a.chargeTo && a.chargeTo.ownerName ? { owner: people.normName(a.chargeTo.ownerName), costCenter: a.chargeTo.costCenter || null } : null,
    requester: a.requester ? people.normEmail(a.requester.email) || people.normName(a.requester.name) : null,
    kind: a.kind || "original",
    supplementalOf: a.supplementalOf && a.supplementalOf.ioNumber ? String(a.supplementalOf.ioNumber) : null,
  });
}

/**
 * Matrix drift, level by level. Compares the matrix row frozen in the routing basis with the
 * row the matrix holds now, for every level the band required — including a level whose row
 * was `skipped` (the person signed once, higher) or `sod_blocked` (a stand-in signed): if
 * the matrix now names someone else there, that someone has not signed.
 *
 * @returns {{ changed: Array, unchanged: Array, rowMissing: boolean, batchChanged: boolean, checkedAt }}
 */
function matrixDrift(routing, matrixRowNow, currentBatchId) {
  const out = { changed: [], unchanged: [], rowMissing: false, batchChanged: false, sentBatchId: null, currentBatchId: currentBatchId || null };
  if (!routing || !routing.basis) return out;
  const basis = routing.basis;
  out.sentBatchId = basis.matrixBatchId || null;
  out.batchChanged = Boolean(currentBatchId && basis.matrixBatchId && currentBatchId !== basis.matrixBatchId);
  const then = (basis.matrixRow && basis.matrixRow.levels) || {};
  if (!matrixRowNow) { out.rowMissing = Boolean(basis.matrixRow); return out; }
  const now = matrixRowNow.levels || {};
  const levels = (basis.levels || []).filter((l) => l !== "BOARD" && LEVEL_LADDER.includes(l));
  for (const level of levels) {
    const was = then[level] && then[level].name ? String(then[level].name).trim() : "";
    const is = now[level] && now[level].name ? String(now[level].name).trim() : "";
    const rec = (routing.recipients || []).find((r) => r.role === "matrix" && r.level === level && !r.standInFor) || null;
    const row = { level, title: LEVEL_TITLES[level] || level, was, now: is, recipientId: rec ? rec.id : null,
      recipientStatus: rec ? rec.status : null, signedAt: rec ? rec.signedAt || null : null };
    if (people.normName(was) === people.normName(is)) out.unchanged.push(row);
    else out.changed.push(row);
  }
  return out;
}

/**
 * @param {object} input {
 *   afe, routing, envelope, matrixRowNow, currentBatchId,
 *   validation   — afeRules.validate() run now,
 *   verification — envelopeVerify rows (or envelope.completed.verification),
 *   formHash     — { checked, ok } from envelopeDocs.verifyFormHash, or null when not run,
 *   editsSinceSend — [{ at, byEmail, paths: [] }] audited edits after sentAt,
 *   possibleDuplicates — from afeView,
 *   now }
 * @returns {{ flags, blocks, warns, open, drift, ready, summary }}
 */
function computeRedFlags(input) {
  const afe = input.afe || {};
  const routing = input.routing || null;
  const envelope = input.envelope || null;
  const fa = afe.fa || {};
  const acks = new Map((fa.flagAcks || []).map((a) => [a.flagId, a]));
  const driftAcks = fa.driftAck || [];
  const flags = [];
  const add = (f) => {
    const ack = acks.get(f.id) || null;
    flags.push(Object.assign({ severity: "block", source: "rule", recipientId: null, level: null, evidence: null, showMe: null }, f, {
      ack, cleared: Boolean(ack) || Boolean(f.clearedBy),
    }));
  };

  // (a) rules, re-run now
  const v = input.validation || { blocks: [], warns: [], pending: [] };
  for (const e of v.blocks || []) {
    add({ id: `rule:${e.rule || e.field}`, source: "rule", severity: "block",
      title: e.message, detail: `Still true at receipt. The wizard would not have sent it like this — check what changed since ${day(afe.sentAt) || "send"}.`,
      field: e.field || null, step: e.step || null, showMe: { kind: "form", step: e.step || null, field: e.field || null } });
  }
  for (const e of v.pending || []) {
    add({ id: `pending:${e.rule || e.field}`, source: "rule", severity: "warn",
      title: e.message, detail: "A fact the tool could not confirm on its own.", field: e.field || null, step: e.step || null,
      showMe: { kind: "form", step: e.step || null, field: e.field || null } });
  }
  for (const e of v.warns || []) {
    // An AFE whose coordinator waived the coverage before R67 made it a warning keeps that waiver
    // as its one flag (below), because it carries the reason. Every other AFE gets the warning
    // itself: it was skipped here for a waiver that can no longer be created, so a quote covering
    // a third of the estimate reached Fixed Assets with no flag at all.
    if (e.rule === "quote_covers_estimate" && (afe.waivers || []).some((w) => w.ruleId === e.rule)) continue;
    const said = e.note ? `Sent with the reason “${e.note}”${e.noteByName ? ` — ${e.noteByName}` : ""}.` : null;
    if (e.rule === "quote_covers_estimate") {
      const pct = input.quoteCoveragePct === null || input.quoteCoveragePct === undefined ? null : input.quoteCoveragePct;
      add({ id: "warn:quote_covers_estimate", source: "rule", severity: "warn",
        title: `Quotes cover ${pct === null ? "less than the minimum" : `${pct}%`} of the estimate`,
        detail: said || "Below the minimum, and nobody said why. Acknowledge it, or ask for the quote.",
        field: e.field || null, step: e.step || null, showMe: { kind: "documents", role: "quote" } });
      continue;
    }
    add({ id: `warn:${e.rule || e.field}`, source: "rule", severity: "warn", title: e.message,
      detail: said || "A warning the requester side saw and sent anyway.", field: e.field || null, step: e.step || null,
      showMe: { kind: "form", step: e.step || null, field: e.field || null } });
  }

  // (e) waivers — a rule the coordinator switched off for this AFE, with their reason
  for (const w of afe.waivers || []) {
    add({ id: `waiver:${w.ruleId}`, source: "waiver", severity: "warn",
      title: w.ruleId === "quote_covers_estimate"
        ? `Quotes cover ${input.quoteCoveragePct === null || input.quoteCoveragePct === undefined ? "less than required" : input.quoteCoveragePct + "%"} of the estimate — waived by ${w.byName || w.byEmail}`
        : `Rule ${w.ruleId} waived by ${w.byName || w.byEmail}`,
      detail: `“${w.reason}” — waived ${day(w.at)}${afe.sentAt && w.at < afe.sentAt ? ", before send" : ""}. A warning, not a block: acknowledge it, or ask for the quote in the digest.`,
      showMe: { kind: "documents", role: "quote" } });
  }

  // (b) matrix drift
  const drift = matrixDrift(routing, input.matrixRowNow, input.currentBatchId);
  if (drift.rowMissing) {
    add({ id: "drift:row", source: "drift", severity: "block", level: null,
      title: `Cost centre ${afe.costCenter} is no longer in the SAP approver matrix`,
      detail: `It was there when this was sent (batch ${drift.sentBatchId || "?"}). Confirm with Fixed Assets' matrix owner before keying an order against it.`,
      showMe: { kind: "matrix" } });
  }
  for (const d of drift.changed) {
    const ack = driftAcks.find((a) => a.level === d.level && people.normName(a.now || "") === people.normName(d.now)) || null;
    const signedBy = d.recipientStatus === "signed" ? `${d.was} signed` : d.recipientStatus === "skipped" ? `${d.was} signed once, at a higher row` : d.recipientStatus === "sod_blocked" ? `${d.was} was excluded (party to the AFE) and a stand-in signed` : `${d.was || "(blank)"} was named`;
    add({ id: `drift:${d.level}`, source: "drift", severity: "block", level: d.level, recipientId: d.recipientId,
      title: d.now
        ? `Matrix changed at ${d.level} — ${signedBy}; the matrix now names ${d.now}`
        : `Matrix changed at ${d.level} — ${signedBy}; the matrix now has no one there`,
      detail: `Approver matrix batch ${drift.sentBatchId || "?"} when sent${drift.currentBatchId ? ` → ${drift.currentBatchId} now` : ""}. The chain was frozen at send, so nothing on this AFE moved — but the person SAP now holds accountable at ${d.level} (${d.title}) has not signed. Attach ${d.now ? firstName(d.now) + "'s" : "the new approver's"} email approval as evidence, or say why the signed chain stands.`,
      was: d.was, now: d.now, signedAt: d.signedAt,
      clearedBy: ack ? { kind: "email_approval", attachmentId: ack.attachmentId, byName: ack.byName, at: ack.at, note: ack.note } : null,
      showMe: { kind: "matrix", level: d.level } });
  }

  // (c) the envelope
  const verification = input.verification || (envelope && envelope.completed && envelope.completed.verification) || [];
  for (const row of verification) {
    if (row.st === "ok") continue;
    add({ id: `verify:${row.recipientId || row.name}`, source: "envelope", severity: "block", recipientId: row.recipientId || null, level: row.level || null,
      title: row.st === "miss" ? `${row.name} is on the approved chain but never signed the envelope`
        : row.st === "mismatch" ? `The envelope carries a signature the chain did not ask for — ${row.name}`
        : row.st === "declined" ? `${row.name} declined on the envelope` : `${row.name} has not completed on the envelope`,
      detail: `${row.note || ""} The verdict comes from the provider's recipient data against the chain frozen at send; the Certificate of Completion is stored as evidence.`,
      showMe: { kind: "documents", role: "certificate" } });
  }
  if (envelope && envelope.completed && envelope.completed.error) {
    add({ id: "envelope:documents", source: "envelope", severity: "block",
      title: "The signed set could not be stored when the envelope completed",
      detail: `${envelope.completed.error}. The approvals stand; fetch the documents from ${envelope.provider === "simulated" ? "the simulation" : "DocuSign"} before keying SAP.`,
      showMe: { kind: "documents", role: "envelope_pdf" } });
  }
  if (envelope && envelope.voidError) {
    add({ id: "envelope:void", source: "envelope", severity: "warn", title: "DocuSign did not confirm a void on an earlier round",
      detail: envelope.voidError, showMe: null });
  }

  // (e) the form as it stands vs what was signed
  const fh = input.formHash || null;
  // R102 — the form's own layout moved under it. That is our doing, not the requester's, and
  // it is stated rather than raised as a tamper alarm: we cannot prove equality across two
  // layouts, and pretending otherwise in either direction would be a lie.
  if (fh && fh.layoutChanged) {
    add({ id: "form:layout", source: "form", severity: "warn",
      title: `This was signed under form layout v${fh.signedUnder}; the tool now prints v${fh.now}`,
      detail: "The signed copy is stored exactly as it was signed and is what counts. Re-rendering "
        + "the form today produces a different document, so the two cannot be compared byte for byte — "
        + "the form changed, not the AFE. Read the stored signed set, which is unchanged.",
      showMe: { kind: "documents", role: "envelope_pdf" } });
  }
  if (fh && fh.checked && fh.ok === false) {
    const edits = input.editsSinceSend || [];
    const paths = Array.from(new Set(edits.flatMap((e) => e.paths || [])));
    const explained = paths.length > 0;
    add({ id: "form:hash", source: "form", severity: explained ? "warn" : "block",
      title: explained ? `The form was edited after signing — ${paths.length} field${paths.length > 1 ? "s" : ""} changed` : "The form as it stands does not match what was signed",
      detail: explained
        ? `Changed since send: ${paths.join(", ")} (${edits.length} audited edit${edits.length > 1 ? "s" : ""}). The signed copy is stored unchanged; the money and cost centre ${input.fingerprintChanged ? "DID change — the signatures no longer cover it" : "did not change, so the signatures still cover it"}.`
        : "Re-rendering the AFE Form today does not hash to the value frozen on the envelope, and no audited edit explains it. Compare the stored signed set with the form before keying SAP.",
      showMe: { kind: "documents", role: "envelope_pdf" } });
  }

  // (d) segregation of duties with nobody to stand in
  const excluded = (routing && routing.sod && routing.sod.excluded) || [];
  for (const ex of excluded) {
    if (ex.standIn) continue;
    if (!ex.wouldHaveBeen || !LEVEL_LADDER.includes(ex.wouldHaveBeen)) continue;
    add({ id: `sod:${ex.recipientId}`, source: "sod", severity: "block", recipientId: ex.recipientId, level: ex.wouldHaveBeen,
      title: `${ex.name} could not sign as the ${ex.reason} and nobody stood in at ${ex.wouldHaveBeen}`,
      detail: "Segregation of duties excluded them; the matrix had no higher level free to stand in. Fixed Assets routes this level by hand and records the evidence.",
      showMe: { kind: "chain", recipientId: ex.recipientId } });
  }

  // possible duplicates — a word, never a block (recurring programmes repeat)
  for (const d of input.possibleDuplicates || []) {
    add({ id: `dup:${d.id}`, source: "duplicate", severity: "warn",
      title: `Another AFE on this cost centre looks similar — “${d.title}” (${d.state.replace(/_/g, " ")}, ${money(d.totalUsd)})`,
      detail: "Recurring programmes legitimately repeat. Check that this is not the same project raised twice before an order exists.",
      showMe: { kind: "afe", afeId: d.id } });
  }

  const blocks = flags.filter((f) => f.severity === "block");
  const warns = flags.filter((f) => f.severity === "warn");
  const open = flags.filter((f) => !f.cleared);
  const openBlocks = blocks.filter((f) => !f.cleared);
  return {
    flags, blocks, warns, open,
    drift,
    ready: openBlocks.length === 0,
    summary: {
      total: flags.length, blocks: blocks.length, warns: warns.length,
      openBlocks: openBlocks.length, openWarns: warns.filter((f) => !f.cleared).length,
      drift: drift.changed.length, driftCleared: drift.changed.filter((d) => flags.find((f) => f.id === `drift:${d.level}` && f.cleared)).length,
      verified: verification.filter((r) => r.st === "ok").length, signers: verification.length,
    },
  };
}

/**
 * The red-flag digest — one email per AFE listing every flag, drafted for Fixed Assets to
 * verify and send themselves (R51). Deterministic, like aucReview.buildPack: the same AFE
 * and flags read the same every time. `to` is the coordinator (the person who shaped the
 * chain and can fix most of it), the requester in copy; without a coordinator the requester
 * is the addressee.
 */
function buildRedFlagDigest(afe, flags, opts) {
  const o = opts || {};
  const title = (afe.project && afe.project.title) || "(untitled AFE)";
  const total = o.totalUsd !== undefined ? o.totalUsd : 0;
  const open = (flags || []).filter((f) => !f.cleared);
  const blocks = open.filter((f) => f.severity === "block");
  const warns = open.filter((f) => f.severity === "warn");
  const toPerson = afe.coordinator || afe.requester || null;
  const cc = afe.coordinator && afe.requester && afe.requester.email && afe.requester.email !== afe.coordinator.email ? [afe.requester.email] : [];
  const base = o.baseUrl ? String(o.baseUrl).replace(/\/$/, "") : "";
  const body = [];
  body.push(`Hi${toPerson ? " " + firstName(toPerson.name) : ""},`);
  body.push("");
  body.push(`Fixed Assets is reviewing "${title}" (${money(total)}, cost centre ${afe.costCenter || "?"}${afe.division ? ", " + afe.division : ""}).`);
  if (!open.length) {
    body.push("Every signature checks out and nothing is flagged — this note is for the record only; the internal order follows.");
  } else {
    body.push(`Before we create the internal order, ${open.length === 1 ? "one thing needs" : open.length + " things need"} a look:`);
    body.push("");
    let n = 0;
    for (const f of blocks.concat(warns)) {
      n += 1;
      body.push(`${n}. ${f.title}${f.severity === "block" ? "" : " (for your information)"}`);
      if (f.detail) body.push("   " + f.detail);
      if (f.source === "drift") body.push(`   What we need: the current ${f.level} approver's email approval, forwarded to Fixed Assets, or a word on why the signed chain stands.`);
      body.push("");
    }
    body.push(`Reply to this email or fix it on the AFE${base ? ` (${base}/afe/${afe.id})` : ""}. Nothing is keyed in SAP until these are cleared.`);
  }
  body.push("");
  body.push("Thanks,");
  body.push("Fixed Assets · Acme FSSC");
  return {
    to: toPerson && toPerson.email ? toPerson.email : "",
    toName: toPerson ? toPerson.name : "",
    cc,
    subject: `AFE review: ${title} — ${open.length ? `${blocks.length} to clear${warns.length ? `, ${warns.length} to note` : ""}` : "no red flags"}`,
    body: body.join("\n"),
    flagIds: open.map((f) => f.id),
    afeId: afe.id,
    draftOnly: true,
  };
}

module.exports = { computeRedFlags, matrixDrift, buildRedFlagDigest, financialFingerprint };
