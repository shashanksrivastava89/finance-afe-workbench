"use strict";
// The KO01 keying sheet — "SAP smoothness" for the FA preparer (R39).
//
// Captured field-for-field from the recording Judithmelanie walked through on 2026-08-31
// (IO 313403 "Autolabe 390S", order type Z002). The real tab order is:
//   Assignments · Control data · Prd-end closing · General data · Investments
// Control data and Prd-end closing take nothing; the Investments tab stays empty
// (asset class happens at AS01); Estimated costs stays 0.00 (the budget rides KO22).
//
// This is DATA derived at read time from the FA-effective AFE, so the sheet always shows
// the case of record. A value we do not hold prints `— not recorded` in red; it is never
// filled with a sample.
const { ORDER_TYPES, BUDGET_EXEMPT_TYPES } = require("./refData");

const BLANK = "— not recorded";
const money = (n) => (n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US"));

function totalOf(afe) {
  const m = (afe && afe.money) || {};
  const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
  return n(m.capexUsd) + n(m.cloudCapexUsd) + n(m.opexUsd);
}

/**
 * The KO01 screens in the order SAP presents them.
 * @param {object} afe  the AFE aggregate (post-approval)
 * @returns {Array<{screen,field,value,note?,required?,system?}>}
 */
function buildKo01(afe) {
  const a = afe || {};
  const p = a.project || {};
  const s = a.schedule || {};
  const cc = String(a.costCenter || "").trim();
  const description = String(p.title || "").toUpperCase().replace(/\s+/g, " ").slice(0, 40);
  const orderType = (a.fa && a.fa.orderType) || ORDER_TYPES.map((o) => o.code).join(" or ");
  const person = (a.requester && a.requester.name) || (a.preparer && a.preparer.name) || "";

  return [
    { screen: "KO01 · Initial screen", field: "Order Type", value: orderType, required: true,
      note: a.fa && a.fa.orderType ? "chosen for this AFE" : "pick by the nature of the AFE — the preparer knows which" },
    { screen: "KO01 · Initial screen", field: "Controlling Area", value: "BR00",
      note: "Acme global CO area" },

    { screen: "KO01 · Order header", field: "Order", value: "leave blank — SAP assigns it on save", system: true,
      note: "the number SAP generates IS the AFE number; record it back on this AFE" },
    { screen: "KO01 · Order header", field: "Description", value: description || BLANK, required: true,
      note: "40 characters, from the AFE title" },

    { screen: "KO01 · Assignments", field: "Company Code", value: a.companyCode || BLANK, required: true },
    { screen: "KO01 · Assignments", field: "Responsible CCtr", value: cc || BLANK, required: true },
    { screen: "KO01 · Assignments", field: "Requesting CCtr", value: cc || BLANK,
      note: "same as Responsible unless the AFE names another (sample IO: identical)" },
    { screen: "KO01 · Assignments", field: "Plant", value: a.plant || "from the cost centre master",
      note: "the approver matrix can list several plants for one CCtr — confirm against the AFE location" },
    { screen: "KO01 · Assignments", field: "Object Class", value: "Investment", required: true },
    { screen: "KO01 · Assignments", field: "Profit Center", value: "defaults from the cost centre master",
      note: "record the value SAP fills in" },
    { screen: "KO01 · Assignments", field: "Functional Area", value: "defaults",
      note: "leave as defaulted unless instructed (sample IO showed Z010)" },

    { screen: "KO01 · Control data / Prd-end closing", field: "—", value: "nothing to key on either tab", system: true,
      note: "status and currency fill themselves" },

    { screen: "KO01 · General data", field: "Person Responsible", value: person || BLANK,
      note: "the AFE requester" },
    { screen: "KO01 · General data", field: "Work Start", value: s.startDate || BLANK,
      note: "estimated start from the AFE — aging runs from the IO issue date SAP records, not this" },
    { screen: "KO01 · General data", field: "End of Work", value: s.finishDate || BLANK,
      note: "estimated finish from the AFE" },
    { screen: "KO01 · General data", field: "Estimated costs", value: "leave 0.00", system: true,
      note: "the budget goes on with KO22, not here (sample IO: 0.00)" },

    { screen: "KO01 · Investments", field: "—", value: "leave the whole tab empty", system: true,
      note: "asset class and capitalization date are set at AS01, not here (sample IO: all blank)" },
  ];
}

/**
 * The steps after KO01 — structured exactly as KO01 is, and for the same reason (R122).
 *
 * These used to be `lines: [ …four sentences… ]`, and the screen printed them: eleven sentences
 * of running prose with one badge and one button, and not a single input on the row. "Keying in
 * SAP is a nightmare" (Shashank, 2026-09-21). But every one of those sentences was really a
 * FIELD and a VALUE —
 *
 *     "Distribution rule: Category FXA (full settlement), Receiver = the new AUC, 100%."
 *       → { field: "Distribution rule", value: "FXA · Receiver = 169006773 · 100%" }
 *
 * — and the person reading it is alt-tabbing between two windows, so what they need is the value
 * itself, one click from the clipboard, not a paragraph describing it. `buildKo01` already knew
 * this; the steps after it did not.
 *
 * `expect` is separate on purpose: it is what SAP will say BACK, which is not something to type.
 * KO22 is skipped for the budget-exempt request types ("Not required for Demo & RRC" —
 * Judithmelanie's checklist).
 *
 * @param {object} afe
 * @param {object} [ctx] `{ ioNumber, aucNumber }` — what earlier steps produced, so a later
 *   step names the real number rather than "the new AUC".
 */
function buildSteps(afe, ctx) {
  const a = afe || {};
  const c = ctx || {};
  const p = a.project || {};
  const total = totalOf(a);
  const io = c.ioNumber || (a.fa && a.fa.ioNumber) || a.afeNo || null;
  const auc = c.aucNumber || (a.fa && a.fa.aucNumber) || null;
  const cc = String(a.costCenter || "").trim();
  const description = String(p.title || "").toUpperCase().replace(/\s+/g, " ").slice(0, 40);
  const exempt = BUDGET_EXEMPT_TYPES.indexOf(a.requestType) >= 0;
  const capital = (a.money || {}).opexUsd && !((a.money || {}).capexUsd || (a.money || {}).cloudCapexUsd) ? "OpEx" : "CapEx";

  return [
    exempt ? null : {
      key: "KO22", handoffKey: "KO22_BUDGET", txn: "KO22",
      title: "Load the budget on the IO",
      path: "Change Original Budget",
      rows: [
        { field: "Order", value: io || BLANK, required: true, note: io ? "the order you just created" : "record the IO number first" },
        { field: "Post Addition to Budget", value: total ? money(total) : BLANK, required: true,
          note: "the approved total on this AFE" },
      ],
      expect: ['"User status EXEC is active" — expected, and it does not block.'],
      then: "Run Budget / Actual / Commitments and attach the screenshot. A tick proves nothing; the SAP table does.",
    },
    {
      key: "AS01", handoffKey: "AS01_AUC", txn: "AS01",
      title: "Create the Asset Under Construction",
      path: "Create Asset",
      rows: [
        { field: "Asset Class", value: (a.fa && a.fa.assetClass) || "per spend nature — e.g. 16902 AuC Machinery", required: true,
          note: a.fa && a.fa.assetClass ? "recorded on this AFE" : "the AuC class, not the final asset class" },
        { field: "General · Description", value: description || BLANK, required: true, note: "the same text as the IO" },
        { field: "Time-dependent · Cost Centre", value: cc || BLANK, required: true, note: "copy from the IO" },
        { field: "Time-dependent · Plant", value: a.plant || "copy from the IO", note: "copy from the IO" },
        { field: "Time-dependent · Profit Center", value: (a.fa && a.fa.profitCentre) || "copy from the IO" },
        { field: "Time-dependent · Location / Room", value: a.location || BLANK, required: true,
          note: "the property-tax master needs it — this is the field most often left blank" },
        { field: "Origin · Internal Order", value: io || BLANK, required: true },
        { field: "Origin · Requester", value: (a.requester && a.requester.name) || BLANK },
      ],
      expect: [],
      then: "Save, and record the AuC number SAP assigns.",
    },
    {
      key: "KO02", handoffKey: "KO02_SETTLEMENT", txn: "KO02",
      title: "Set the settlement rule",
      path: "Change Internal Order → Settlement Rule → Maintain",
      rows: [
        { field: "Order", value: io || BLANK, required: true },
        { field: "Category", value: "FXA", required: true, note: "full settlement to a fixed asset" },
        { field: "Receiver", value: auc || "the AuC from AS01", required: true, note: auc ? "the AuC you just created" : "create the AuC first" },
        { field: "Percentage", value: "100%", required: true },
        { field: "Settlement structure", value: capital, system: true,
          note: "the structure matching " + capital + " cost elements — this AFE's own nature" },
      ],
      expect: [],
      then: "Save.",
    },
  ].filter(Boolean);
}

/** Child IOs are keyed the same way, one per country/site line (R52). */
function buildChildPlan(afe) {
  const lines = ((afe || {}).money || {}).lines || [];
  return lines.filter((l) => l && l.amountUsd).map((l, i) => ({
    seq: i + 1,
    site: l.site || l.country || `line ${i + 1}`,
    country: l.country || "",
    description: l.description || l.site || "",
    amountUsd: l.amountUsd,
    note: "child IO under the parent order; budget split per this line",
  }));
}

// An SAP internal-order number: six digits on the classic ranges (312286), ten on the newer
// ones (3000200976). Typed by Fixed Assets after KO01 saves — never generated here.
const IO_NUMBER_PATTERN = /^\d{6,10}$/;
const validIoNumber = (s) => IO_NUMBER_PATTERN.test(String(s || "").trim());

module.exports = { buildKo01, buildSteps, buildChildPlan, BLANK, IO_NUMBER_PATTERN, validIoNumber };
