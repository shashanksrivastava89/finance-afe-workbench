"use strict";
// What Fixed Assets still decides once the wizard has done the checking.
//
// v0.2 ran Judithmelanie's full 13-row checklist because the AFE arrived as a PDF and every
// row was a presence question ("is the cost centre there?", "is the quote attached?").
// With validation at source (R50) those are answered before the AFE can be submitted, so
// what is left is what only a person can say: is this an asset, is the money sensible, is
// the classification right, is it a duplicate, and which order type applies.
//
// Rows are DATA. Add or reword them here, never in a renderer. Each row is either
// `auto` (we can evidence it and the FA confirms) or `manual` (judgment only).
const { ORDER_TYPES, QUOTE_COVERAGE_MIN } = require("./refData");

const ROWS = [
  {
    id: "asset_not_expense",
    t: "This is an asset, not an expense",
    section: "Judgment",
    kind: "manual",
    help: "Capitalizable spend with a future benefit. If it is maintenance or a service, it belongs in OpEx and no internal order is issued.",
  },
  {
    id: "amount_reasonable",
    t: "The amount is reasonable for the type of project",
    section: "Judgment",
    kind: "auto",
    help: "Compare the total against the vendor quote and against similar AFEs on this cost centre.",
    evaluate: (c) => {
      const total = c.totalUsd || 0;
      const quoted = c.quoteTotalUsd;
      if (!quoted) return { ok: false, sub: "No quote total recorded — check the attached quote" };
      const pct = total ? quoted / total : 0;
      // ONE threshold, the rule's own (QUOTE_COVERAGE_MIN, Q34). This row agreed at 60 % while the
      // header chip and the requester's warning stopped at 70 %, so "the evidence agrees" sat under
      // a yellow chip about the same quote.
      return pct >= QUOTE_COVERAGE_MIN
        ? { ok: true, sub: `Quote covers ${Math.round(pct * 100)}% of the estimate` }
        : { ok: false, sub: `Quote covers only ${Math.round(pct * 100)}% of the estimate` };
    },
  },
  {
    id: "classification_agreed",
    t: "CapEx / OpEx / Cloud CapEx classification is right",
    section: "Judgment",
    kind: "auto",
    help: "Accounting cares about classification, not the amount (Aiden, 2026-09-03). Cloud CapEx follows the decision tree on the form.",
    evaluate: (c) => {
      const m = c.afe.money || {};
      if (!m.classification) return { ok: false, sub: "Classification not declared" };
      const cloud = c.afe.cloud || {};
      if (m.classification === "cloud_capex" && cloud.outcome !== "cloud_capex") {
        return { ok: false, sub: "Declared Cloud CapEx but the decision tree does not reach that outcome" };
      }
      if (cloud.fpaReviewRequired) {
        return { ok: false, sub: "Externally hosted software — FP&A Business Partner review required" };
      }
      return { ok: true, sub: `Declared ${m.classification.replace("_", " ")}` };
    },
  },
  {
    id: "no_duplicate_io",
    t: "No open internal order already covers this",
    section: "Judgment",
    kind: "auto",
    help: "Same cost centre, similar description, still open.",
    evaluate: (c) => (c.possibleDuplicates && c.possibleDuplicates.length
      ? { ok: false, sub: `${c.possibleDuplicates.length} open IO(s) on this cost centre look similar` }
      : { ok: true, sub: "No similar open order found" }),
  },
  {
    id: "order_type",
    t: "Order type chosen (Z002 or Z005)",
    section: "SAP",
    kind: "auto",
    help: "Chosen by the nature of the AFE; the preparer knows which.",
    evaluate: (c) => (c.afe.fa && c.afe.fa.orderType
      ? { ok: true, sub: `${c.afe.fa.orderType} — ${(ORDER_TYPES.find((o) => o.code === c.afe.fa.orderType) || {}).label || ""}`.trim() }
      : { ok: false, sub: "Not chosen yet" }),
  },
];

const SECTIONS = ["Judgment", "SAP"];

/**
 * Evaluate the judgment rows for one AFE.
 * @param {object} ctx { afe, totalUsd, quoteTotalUsd, possibleDuplicates }
 * @returns {{rows: Array, open: number, sections: string[]}}
 */
function buildJudgment(ctx) {
  const ticks = (ctx.afe.fa && ctx.afe.fa.judgment) || {};
  const rows = ROWS.map((row) => {
    const confirmed = ticks[row.id] === true;
    // What the row reads when it is NOT ticked — so a screen can show an untick at once, before
    // the server has answered, without guessing whether the evidence agreed.
    let untickedSt = "open";
    let sub = "";
    if (row.kind === "auto" && typeof row.evaluate === "function") {
      let r;
      try { r = row.evaluate(ctx) || {}; } catch (e) { r = { ok: false, sub: "could not evaluate" }; }
      sub = r.sub || "";
      untickedSt = r.ok ? "ready" : "open"; // `ready` = evidence agrees, awaiting the FA tick
    }
    const st = confirmed ? "ok" : untickedSt;
    return { id: row.id, t: row.t, section: row.section, kind: row.kind, help: row.help, st, untickedSt, sub, confirmed };
  });
  return { rows, open: rows.filter((r) => r.st !== "ok").length, sections: SECTIONS };
}

module.exports = { ROWS, SECTIONS, buildJudgment };
