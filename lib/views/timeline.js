"use strict";
// An AFE's history, from the one place that already knows it (R129).
//
// Nothing was missing from the DATA. `stateMachine.applyTransition` stamps `submittedAt`,
// `sentAt` and `approvedAt` on the AFE, nests a dated record for everything else, and writes an
// append-only audit row for every transition carrying `fromState`, `toState`, the actor and the
// moment. What was missing was anywhere to READ it: this function lived inside `projectView`,
// covered eleven of the sixteen transitions, and was rendered on exactly one screen.
//
// So it moves here, it covers all sixteen, and `smoke-boot` compares the map against the state
// machine's own table — because a hand-kept list of the lifecycle's events is precisely the kind
// of copy that goes stale silently, which is the lesson R118 paid for.
const audit = require("../audit");
const afeRules = require("../domain/afeRules");
const refData = require("../domain/refData");
const people = require("../domain/people");

const usd = (n) => (typeof n === "number" && isFinite(n) ? "$" + Math.round(n).toLocaleString("en-US") : "");
const p = (e) => e.payload || {};
const clip = (t) => { const s = String(t || "").split("\n")[0]; return s.length > 120 ? s.slice(0, 119) + "…" : s; };

/** A resubmission that went back into its own round (R148), by Submit or by Send. */
const wentOn = (e) => (e.toState === "fa_review" ? "Back with Fixed Assets — signatures stood"
  : p(e).resumed ? `Back with ${p(e).holder || "the approver"} — ${p(e).kept ? `${p(e).kept} ${p(e).kept === 1 ? "signature" : "signatures"} stood` : "the same envelope"}`
  : null);

/**
 * One label per transition. A function gets the audit row and may read its payload; a string is
 * used as it stands. `kind` colours the node: done, warn, stop, or none for a plain step.
 */
const TIMELINE = {
  afe_created: { kind: "step", text: () => "Raised" },
  submit: { kind: "step", text: (e) => wentOn(e) || (p(e).roundAgain ? `Resubmitted — round again: ${(p(e).because || [])[0] || "something changed"}` : "Submitted") },
  send: { kind: "step", text: (e) => wentOn(e) || `Sent for signature${p(e).signers ? ` · ${p(e).signers} signers` : ""}${p(e).roundAgain ? " — a new round" : ""}` },
  question: { kind: "warn", text: (e) => `On hold — a question from ${p(e).byName || "an approver"}` },
  answer: { kind: "step", text: () => "Question answered — back out for signature" },
  // R147: `toName` is whose it now is. Rows written before it existed read "the requester",
  // which was always the intent and is now also what the mail says.
  send_back: { kind: "warn", text: (e) => `Sent back to ${p(e).toName || "the requester"}${p(e).reason ? `: ${p(e).reason}` : ""}` },
  // The last signature's note is "all signatures in — handed to Fixed Assets", and the hand-over
  // is its own line straight after — so the history said the hand-over twice, the first in lower
  // case. The last signature reads as a signature.
  recipient_signed: { kind: "done", text: (e) => (p(e).note && !/^all signatures in/i.test(p(e).note) ? String(p(e).note).replace(/^signed by /, "Signed by ") : "Signed — the last signature") },
  fa_handover: { kind: "done", text: () => "Fully signed — with Fixed Assets" },
  decline: { kind: "stop", text: (e) => `Declined by ${p(e).byName || "an approver"}${p(e).reason ? `: ${p(e).reason}` : ""}` },
  withdraw: { kind: "stop", text: (e) => `Withdrawn${p(e).reason ? `: ${p(e).reason}` : ""}` },
  fa_return: { kind: "warn", text: (e) => `Fixed Assets sent it back to ${p(e).toName || "the requester"}${p(e).reason ? `: ${p(e).reason}` : ""}` },
  fa_approve_issue: { kind: "done", text: (e) => `Approved for issue by ${p(e).byName || "Fixed Assets"}` },
  fa_record_io: { kind: "done", text: (e) => `Internal order ${p(e).ioNumber || ""} created${p(e).children && p(e).children.length ? ` with ${p(e).children.length} child ${p(e).children.length === 1 ? "order" : "orders"}` : ""}` },
  fa_step_done: { kind: "done", text: (e) => ({
    KO22_BUDGET: `Budget loaded (KO22)${typeof p(e).amountUsd === "number" ? ` · ${usd(p(e).amountUsd)}` : ""}`,
    AS01_AUC: `Asset under construction created${p(e).value ? ` · ${p(e).value}` : ""}`,
    KO02_SETTLEMENT: "Settlement rule set (KO02)",
  }[p(e).step] || "SAP step done") },
  fa_issue_pack: { kind: "done", text: () => "Issued AFE sent back to the requester" },
  add_child_io: { kind: "step", text: (e) => `Child order ${p(e).ioNumber || ""} added for ${p(e).site || "a cost line"}` },
  move_budget: { kind: "step", text: (e) => `${usd(p(e).amountUsd) || "Budget"} moved from ${p(e).fromIo} to ${p(e).toIo}` },
  capitalize: { kind: "done", text: (e) => `Capitalized as asset ${p(e).assetNumber || ""}${typeof p(e).amountUsd === "number" ? ` · ${usd(p(e).amountUsd)}` : ""}` },
  close: { kind: "done", text: () => "Closed" },
  red_flag_digest_drafted: { kind: "warn", text: () => "Fixed Assets drafted a red-flag email" },
  // R149. The text is on the record in full; the spine carries its first line.
  comment: { kind: "step", text: (e) => `${p(e).byName || "Somebody"}${p(e).side === "fa" ? " (Fixed Assets)" : ""}${p(e).ask ? " asked" : ""}: ${clip(p(e).text)}` },
  // R170. Where a figure came from is part of the history: what the reader proposed, at what
  // confidence, and what a person did with it.
  quote_read: { kind: "step", text: (e) => `${p(e).filename || "A quote"} read — proposed ${readList(p(e).offered) || "nothing it was sure of"}` },
  // An ADMINISTRATOR's line: the reason is about the platform ("its identity needs the Cognitive
  // Services User role…"), and it sat in a requester's history on afe-0032 (15 Oct). Everyone else
  // sees on the quote card that it was not read and that their typed figures are the ones used.
  quote_read_failed: { kind: "step", adminOnly: true, text: (e) => `${p(e).filename || "A quote"} could not be read: ${clip(p(e).reason)}` },
  quote_reading_used: { kind: "step", text: (e) => `Figures read from ${p(e).filename || "the quote"} used${Object.keys(p(e).applied || {}).length ? ` — ${Object.keys(p(e).applied).map((f) => ({ amountUsd: "total", quoteDate: "date", vendor: "vendor" }[f] || f)).join(", ")}` : ""}` },
  quote_reading_set_aside: { kind: "step", text: (e) => `Reading of ${p(e).filename || "the quote"} set aside — the typed figures stand` },
};

/** "total $20,000 (94%), dated 2026-06-12 (91%), vendor Vaisala (88%)". */
function readList(offered) {
  const o = offered || {};
  const pct = (f) => (typeof f.confidence === "number" ? ` (${Math.round(f.confidence * 100)}%)` : "");
  return [
    o.amount ? `${o.amount.readAs || "total"} ${o.amount.currency && o.amount.currency !== "USD" ? `${o.amount.currency} ${Number(o.amount.value).toLocaleString("en-US")}` : usd(o.amount.value)}${pct(o.amount)}` : "",
    o.quoteDate ? `dated ${o.quoteDate.value}${pct(o.quoteDate)}` : "",
    o.vendor ? `vendor ${o.vendor.value}${pct(o.vendor)}` : "",
  ].filter(Boolean).join(", ");
}

// ---- what somebody else changed (R157) ------------------------------------------------------
//
// "Before it is routing it to approvals… we should be able to make those modifications" (Aiden,
// Meeting #7). The coordinator edits the requester's AFE in the wizard, and the wizard saves
// field by field, so the trail holds one `afe_edited` row per keystroke-pause. Listing them would
// bury the history; leaving them out, as it did, means the requester never learns that the
// Financials they skipped were filled in by somebody else. So a run of edits by one person who
// did not raise or prepare the AFE — nobody else's row in between, no gap longer than
// `EDIT_RUN_MS` — becomes ONE line naming the steps they touched. The owner's own saves stay
// out: an AFE's author does not need telling that they wrote it.
const EDIT_RUN_MS = 15 * 60 * 1000;

/** The wizard step a saved path belongs to: the FIELDS table where it has a row. */
const STEP_OF = afeRules.FIELDS.reduce((m, f) => { if (f.step) m[f.id] = f.step; return m; }, {});
/** …and, for the paths written whole or not rule-bearing, by where the wizard asks them. */
const STEP_BY_PREFIX = [
  [/^financials\./, 8], [/^cloud\./, 5], [/^(money|budget)\./, 3],
  [/^(costCenter|location|region|chargeTo|requester)(\.|$)/, 2],
  [/^(schedule\.(startDate|finishDate)|project\.(description|justification|scope|alternatives|buyVsLease|ehsImpact|assistAsset|surplusChecked))$/, 4],
  [/^(project|projectCode|requestType|kind|supplementalOf)(\.|$)/, 1], [/^sourcing$/, 6],
];
const STEP_LABEL = refData.WIZARD_STEPS.reduce((m, s) => { m[s.n] = s.label; return m; }, {});

function stepsOf(applied) {
  const steps = new Set();
  for (const path of Object.keys(applied || {})) {
    if (path === "approverNote") { steps.add("note"); continue; }
    const n = STEP_OF[path] || (STEP_BY_PREFIX.find(([re]) => re.test(path)) || [])[1];
    if (n) steps.add(n);
  }
  return [...steps];
}

/** "the How much and Financials steps", in the order the requester meets them. */
function stepsText(steps) {
  const order = refData.WIZARD_STEPS.map((s) => s.n);
  const named = order.filter((n) => steps.includes(n)).map((n) => STEP_LABEL[n]);
  const note = steps.includes("note");
  const list = named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  if (!named.length) return note ? "the note to approvers" : "the AFE";
  return `the ${list} ${named.length === 1 ? "step" : "steps"}${note ? " and the note to approvers" : ""}`;
}

function editLine(run) {
  const moved = run.reassigned;
  return `Edited ${stepsText(run.steps)}${moved ? ` — it moved to ${moved.division || "another division"}${moved.coordinatorName ? `, ${moved.coordinatorName} reviews it now` : ""}` : ""}`;
}

/**
 * @param {object} repos
 * @param {string} afeId
 * @param {object} [opts] `{ oldestFirst: true }` for a spine read top to bottom
 * @returns {Promise<Array<{at, type, kind, text, byEmail, byName}>>}
 */
async function timelineFor(repos, afeId, opts) {
  const rows = await audit.forAfe(repos, afeId);
  const afe = await repos.afes.get(afeId);
  const owners = new Set([afe && afe.requester, afe && afe.preparer]
    .map((p) => people.normEmail(p && p.email)).filter(Boolean));
  const out = [];
  let run = null;
  for (const e of rows) {
    const byEmail = e.actingAsEmail || e.actorEmail;
    if (e.type === "afe_edited") {
      const who = people.normEmail(byEmail);
      if (!who || byEmail === "system" || owners.has(who)) continue;
      const pl = p(e);
      const steps = stepsOf(pl.applied);
      if (!steps.length && !pl.reassigned) continue;
      const t = Date.parse(e.createdAt);
      if (run && run.who === who && t - run.last <= EDIT_RUN_MS) {
        for (const s of steps) if (!run.steps.includes(s)) run.steps.push(s);
        if (pl.reassigned) run.reassigned = pl.reassigned;
        run.last = t;
        run.entry.text = editLine(run);
      } else {
        run = { who, steps: steps.slice(), reassigned: pl.reassigned || null, last: t, entry: null };
        run.entry = { at: e.createdAt, type: "afe_edited", kind: "step", text: editLine(run), byEmail };
        out.push(run.entry);
      }
      continue;
    }
    const entry = TIMELINE[e.type];
    if (!entry) continue;
    if (entry.adminOnly && !(opts && opts.admin)) continue;
    run = null;
    out.push({
      at: e.createdAt,
      type: e.type,
      kind: entry.kind || "step",
      text: typeof entry.text === "function" ? entry.text(e) : entry.text,
      byEmail,
    });
  }
  // A person's name, where the tool knows them — "shashank_srivastava@example.com" is an
  // address, and the spine is read by people who know each other by name.
  const emails = [...new Set(out.map((r) => people.normEmail(r.byEmail)).filter(Boolean))];
  if (emails.length) {
    const known = await repos.users.all((u) => emails.includes(people.normEmail(u.email)));
    const nameOf = new Map(known.map((u) => [people.normEmail(u.email), u.displayName || u.name]));
    for (const r of out) { const n = nameOf.get(people.normEmail(r.byEmail)); if (n) r.byName = n; }
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  if (!(opts && opts.oldestFirst)) out.reverse();
  return out;
}

/**
 * The handful of moments a reader wants above the fold, in the order they happen — the ones that
 * are the same question on every AFE: when was it raised, sent, approved, ordered, capitalized.
 * A milestone with no row yet is returned with `at: null` so the spine can show what is still to
 * come rather than silently ending.
 */
const MILESTONES = [
  { key: "raised", label: "Raised", types: ["afe_created"] },
  { key: "submitted", label: "Submitted", types: ["submit"] },
  { key: "sent", label: "Sent for signature", types: ["send"] },
  { key: "approved", label: "Fully signed", types: ["fa_handover"] },
  { key: "order", label: "Internal order", types: ["fa_record_io"] },
  { key: "budget", label: "Budget loaded", types: ["fa_step_done"], step: "KO22_BUDGET" },
  { key: "auc", label: "AuC created", types: ["fa_step_done"], step: "AS01_AUC" },
  { key: "issued", label: "Issued to the requester", types: ["fa_issue_pack"] },
  { key: "capitalized", label: "Capitalized", types: ["capitalize"] },
];

function milestonesFrom(timeline) {
  const rows = (timeline || []).slice().sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return MILESTONES.map((m) => {
    const hit = rows.find((r) => m.types.includes(r.type) && (!m.step || String(r.text).includes(m.step === "KO22_BUDGET" ? "KO22" : "construction")));
    return { key: m.key, label: m.label, at: hit ? hit.at : null, text: hit ? hit.text : null, byEmail: hit ? hit.byEmail : null };
  });
}

module.exports = { timelineFor, milestonesFrom, TIMELINE, MILESTONES, EDIT_RUN_MS };
