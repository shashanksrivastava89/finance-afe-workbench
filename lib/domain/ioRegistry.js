"use strict";
// Internal orders on one AFE: the parent, a child per country/site line, and the budget moved
// between them (R52).
//
// Pure. Takes the AFE and the IO rows, returns plans, validations and the ± pairs a move
// becomes — the routes do the storage, the state machine the transitions.
//
// Two rules matter and both come from Aiden's tracker:
//   · a move is a PAIR, never an edit — "Reduction" on one order and an addition on the other,
//     so the history reads the way the workbook does and the total never changes;
//   · what the parent holds is the AFE total minus what the children hold, so the allocation
//     always ties back to what was approved.
const { validIoNumber } = require("./sapSheet");

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;
const nameOf = (l, i) => l.site || l.country || `line ${i + 1}`;

/** The child orders the cost lines call for, and which of them exist yet. */
function childPlan(afe, ios) {
  const lines = ((afe && afe.money && afe.money.lines) || []).filter((l) => l && l.amountUsd);
  const children = (ios || []).filter((i) => i.kind === "child");
  return lines.map((l, i) => {
    const seq = i + 1;
    const io = children.find((c) => c.lineSeq === seq) || null;
    return {
      seq, site: nameOf(l, i), country: l.country || "", description: l.description || "",
      amountUsd: round(l.amountUsd),
      ioNumber: io ? io.ioNumber : null, ioId: io ? io.id : null,
      allocatedUsd: io ? round(io.allocatedBudgetUsd) : 0,
      recorded: Boolean(io),
    };
  });
}

/** What is allocated where, against what was approved. */
function allocation(afe, ios, approvedTotalUsd) {
  const parent = (ios || []).find((i) => i.kind === "parent") || null;
  const children = (ios || []).filter((i) => i.kind === "child");
  const childTotal = children.reduce((n, c) => n + round(c.allocatedBudgetUsd), 0);
  const parentTotal = parent ? round(parent.allocatedBudgetUsd) : 0;
  const allocated = round(parentTotal + childTotal);
  const approved = round(approvedTotalUsd);
  return {
    approvedUsd: approved, allocatedUsd: allocated, parentUsd: parentTotal, childUsd: childTotal,
    children: children.length, unallocatedUsd: round(approved - allocated),
    balanced: Math.abs(approved - allocated) < 0.01,
  };
}

/**
 * Check a child order before it is created.
 * @returns {string|null} the message to refuse with, or null
 */
function validateChild(afe, ios, { seq, ioNumber }) {
  const plan = childPlan(afe, ios);
  const line = plan.find((p) => p.seq === Number(seq));
  if (!line) return `There is no cost line ${seq} on this AFE.`;
  if (line.recorded) return `${line.site} already has internal order ${line.ioNumber}.`;
  const n = String(ioNumber || "").trim();
  if (!validIoNumber(n)) return `${line.site}: ${n || "(blank)"} is not an internal-order number (6 to 10 digits).`;
  if ((ios || []).some((i) => i.ioNumber === n)) return `Internal order ${n} is already recorded on this AFE.`;
  return null;
}

/**
 * Does SAP already hold this number for another order? (2026-09-28)
 *
 * A typed number was checked only against the tool itself — its own orders and its own AFEs.
 * SAP's records arrive through the AuC recon and the order master and were never asked, so on
 * UAT an AFE was recorded as 313403, which the recon lists as "Autolabe 390S" on cost centre
 * 10270, and from then on the tracker printed the AFE's title against somebody else's AuC.
 *
 * A number SAP lists is NOT refused on sight: an order created for THIS AFE turns up in the next
 * order-master extract, and Fixed Assets may record it after that has run. It is refused when
 * SAP's own record says it cannot be this AFE's order —
 *   - the recon already ties it to another AFE;
 *   - SAP opened it before this AFE was raised (a day of slack for the time zones), which no
 *     order created for it can have done;
 *   - it is the AFE's own (parent) order and SAP has it under another cost centre — KO01 keys
 *     the AFE's cost centre as the responsible one, per the run sheet. Not for a child: a child
 *     for another country may sit under a local cost centre the tool does not know.
 * The recon's dates are typed by hand ("#N/A" is one of them), so only a date that reads as a
 * date counts as evidence; a line with no date and no cost centre says nothing either way.
 *
 * Pure: `rows` is what SAP says about the number, each
 * `{ source, description, costCenter, openedOn, aucNumber, afeId }`.
 * @returns {null|{error: string, row: object}}
 */
function sapConflict(number, afe, rows, opts) {
  const parent = Boolean(opts && opts.parent);
  const a = afe || {};
  const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ""));
  const cc = (x) => String(x || "").trim().replace(/^0+(?=\d)/, "");
  const raised = String(a.createdAt || "").slice(0, 10);
  const slack = isDay(raised) ? new Date(Date.parse(`${raised}T00:00:00Z`) - 86400000).toISOString().slice(0, 10) : null;
  for (const row of rows || []) {
    let why = null;
    if (row.afeId && row.afeId !== a.id) why = `The AuC recon ties it to ${row.afeId}`;
    else if (slack && isDay(row.openedOn) && row.openedOn < slack) why = `SAP opened it on ${dayText(row.openedOn)}, before this AFE was raised on ${dayText(raised)}`;
    else if (parent && cc(row.costCenter) && cc(a.costCenter) && cc(row.costCenter) !== cc(a.costCenter)) why = `This AFE's order is keyed under cost centre ${cc(a.costCenter)}`;
    if (!why) continue;
    const said = [row.description ? `“${row.description}”` : null, cc(row.costCenter) ? `cost centre ${cc(row.costCenter)}` : null,
      row.aucNumber ? `AuC ${row.aucNumber}` : null].filter(Boolean).join(", ");
    return { row, error: `${number} is already an order in SAP${said ? `: ${said}` : ""} (${row.source}). ${why}, so it is not this AFE's order — check the number KO01 gave on save.` };
  }
  return null;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayText = (d) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;

/**
 * A budget move between two orders on the same AFE, as the ± pair it is stored as.
 * @returns {{error}|{from, to, amountUsd, pair}}
 */
function planMove(afe, ios, move) {
  const from = (ios || []).find((i) => i.ioNumber === String(move.fromIo || "").trim()) || null;
  const to = (ios || []).find((i) => i.ioNumber === String(move.toIo || "").trim()) || null;
  if (!from) return { error: `Internal order ${move.fromIo || "(blank)"} is not on this AFE.` };
  if (!to) return { error: `Internal order ${move.toIo || "(blank)"} is not on this AFE.` };
  if (from.id === to.id) return { error: "Pick two different orders — a move needs somewhere to come from and somewhere to go." };
  const amountUsd = round(move.amountUsd);
  if (!(amountUsd > 0)) return { error: "How much is moving? Enter an amount greater than zero." };
  const available = round(from.allocatedBudgetUsd);
  if (amountUsd > available) {
    return { error: `Order ${from.ioNumber} holds ${available.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 })} — it cannot give up more than that.` };
  }
  const note = String(move.note || "").trim();
  if (!note) return { error: "Say why the budget is moving — it is printed on both orders and audited." };
  const at = new Date().toISOString();
  const pair = [
    { ioId: from.id, ioNumber: from.ioNumber, deltaUsd: -amountUsd, direction: "reduction" },
    { ioId: to.id, ioNumber: to.ioNumber, deltaUsd: amountUsd, direction: "addition" },
  ];
  return { from, to, amountUsd, note, at, pair,
    fromAfterUsd: round(available - amountUsd), toAfterUsd: round(to.allocatedBudgetUsd) + amountUsd };
}

/** Every move on this AFE, newest first, as one list across the orders. */
function moveHistory(ios) {
  const out = [];
  for (const io of ios || []) {
    for (const m of io.budgetMoves || []) {
      if (m.deltaUsd < 0) continue;                       // one row per pair — the addition side carries it
      out.push({ fromIo: m.fromIo, toIo: m.toIo, amountUsd: Math.abs(m.deltaUsd), note: m.note, byName: m.byName, byEmail: m.byEmail, at: m.at });
    }
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  return out;
}

module.exports = { childPlan, allocation, validateChild, sapConflict, planMove, moveHistory };
