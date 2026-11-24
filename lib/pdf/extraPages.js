"use strict";
// The pages that follow the AFE Form: Project Details, the cost lines by site, and the Cloud
// CapEx questions. Hand-authored, unlike lib/pdf/afeFormLayout.js — the AFE Form is the sheet
// that gets signed, so that one is generated from the template itself and matched to the PDF
// Excel prints; these carry the template's wording on the same grid and the same page, but
// their spacing is ours. Generating them from their own sheets is the next step.
//
// They share page 1's page size and column boundaries so the whole document lines up.
const form = require("./afeFormLayout");

const COLS = form.COLS;
const PAGE = {
  width: form.PAGE.width, height: form.PAGE.height,
  marginX: COLS[0], marginTop: 40, marginBottom: 42,
};
const x = (col) => COLS[col];
const w = (col, span) => COLS[Math.min(col + (span || 1), COLS.length - 1)] - COLS[col];

// Ink. A finance document that is printed, signed and filed: black on white, with the form's
// own tints where a band needs one. It deliberately does not carry the app's palette.
const INK = {
  text: [0, 0, 0], rule: [0, 0, 0], hint: [0.41, 0.44, 0.42],
  head: [0.847, 0.847, 0.847],        // #D8D8D8, the form's heading grey
  band: [0.863, 0.902, 0.945],        // #DCE6F2, the form's blue tint
  warm: [0.949, 0.863, 0.859],        // #F2DCDB, the form's pink tint
  // "We mark comments in red" (Imogen). Everything Fixed Assets adds AFTER the signatures is in
  // red on the copy they send back, because a reader has to be able to tell at a glance what was
  // approved from what was recorded afterwards. #C00000 is the red the marked-up BriCare AFE
  // uses, and it is dark enough to photocopy.
  red: [0.753, 0, 0],
};
const SIZE = { title: 9.72, head: 7.32, label: 7.32, value: 7.32, small: 6.72, note: 6.12 };

const PROJECT_DETAILS = [
  { label: "Description", v: "details.description", h: 74 },
  { label: "Scope", v: "details.scope", h: 74 },
  { label: "Justification Rationale", v: "details.justification", h: 74 },
  { label: "Alternatives Considered", v: "details.alternatives", h: 74 },
  { label: "Environmental Regulatory Safety Impact", v: "details.ehsImpact", h: 74 },
  // The template's AFE Form has no cell for the budget pot, so it is carried here rather than
  // printed onto a form that does not have a box for it.
  { label: "Budget", v: "budget.potNote", h: 20, short: true, hint: "Which pot the money comes from" },
  // Only on an AFE in another currency (R161): which one page 1's local columns are in, and whose
  // rate. A US-dollar AFE prints the page it always printed.
  { label: "Local currency", v: "details.localCurrency", h: 20, short: true, hint: "The currency of page 1's local columns, and the rate they use", when: "details.hasLocalCurrency" },
  // Fixed Assets reconciles AuC against this date; the year alone was not enough (Lyndsay,
  // Meeting #5 08:35). It is the same field the wizard collects, printed where FA will look.
  { label: "Expected completion", v: "details.finishDate", h: 20, short: true, hint: "When it is expected to be in service" },
  { label: "New Equipment Purchases :", v: "details.newEquipment", h: 20, short: true, hint: "Yes / No / NA" },
  { label: "Buy vs Lease", v: "details.buyVsLease", h: 20, short: true, hint: "Have you completed a Buy vs Lease Analysis with the Procurement Team?" },
  // Only printed when the AFE buys something physical (afeRules.surplusCheckApplies).
  { label: "Surplus equipment checked", v: "details.surplusChecked", h: 20, short: true, hint: "Have you checked the 925 surplus area?", when: "details.surplusApplies" },
  // Only on an AFE whose equipment comes out of Acme's own inventory (R150).
  { label: "Sourced from", v: "details.sourcing", h: 20, short: true, hint: "Not an outside vendor: a Acme quotation and the SAP material are attached", when: "details.fromInventory" },
];

/**
 * What filled the bottom of page 2 with white in the screenshot at 68:00 — and what the room
 * was actually asking for when they looked at it.
 *
 * Three blocks, each printed only when it has something to say, so the page ends where the
 * content ends instead of leaving a hand's width of nothing under the last row:
 *
 *   EXCEPTIONS   a red flag that was accepted, and the reason the requester gave. Imogen asked
 *                for the text box (24:26); Euan said why it matters — an approver who meets
 *                an exception either sends it back or starts a conversation, and the reason
 *                saves them both (24:46).
 *   DOCUMENTS    what came with the AFE. Some of it is merged into this PDF and some is not:
 *                a 60-page facilities pack or a spreadsheet does not belong inside a signed
 *                form, so it is listed with a link instead of being cut off at the margin.
 *   ISSUED       what Fixed Assets writes onto the form by hand today, in red, after the
 *                signatures: the AFE number, the AuC number, the plant. "We want at the end we
 *                can put the AFE number and AUC number and plant detail and budget screenshot"
 *                (Imogen, 67:54). Printed only on the issued copy.
 */
const EXCEPTIONS_BLOCK = {
  title: "Exceptions accepted",
  intro: "A check that did not pass, and the reason it was accepted anyway. Raised before this AFE was sent, and carried to every approver.",
  rowHeight: 30,
};

const DOCUMENTS_BLOCK = {
  title: "Documents submitted with this AFE",
  columns: [
    { key: "filename", label: "File", chars: 46 },
    { key: "roleLabel", label: "What it is", chars: 16 },
    { key: "size", label: "Size", chars: 9 },
    { key: "where", label: "Where it is", chars: 29 },
  ],
  rowHeight: 14,
};

/**
 * The SAP table on a page of its own.
 *
 * This was the "Issued by Fixed Assets" block on page two, and R137 deleted it: everything it
 * carried prints in red at the top of page one now, where it is read without scrolling. What
 * survives is the fallback for a screenshot whose SHAPE will not survive the box up there —
 * a whole-window grab, a thin strip of one row — which takes a page at full size rather than
 * being dropped.
 */
const EVIDENCE_PAGE = {
  caption: "Budget / Actual / Commitments — SAP, after KO22",
  maxHeight: 150,
};


/**
 * The financial case, on two landscape pages (R94).
 *
 * Eleven years across a portrait A4 at 7pt is 48 points a column with nowhere for a thousands
 * separator, so these two turn the page. The rows are the spreadsheet's own, in the
 * spreadsheet's own order, with its row numbers in the comments of `lib/domain/financials.js`.
 */
const FINANCIALS_PAGE = {
  title: "Financials (NPV, ROI & PB)",
  note: "All amounts in USD. Prepared with the Finance Business Partner. Red on the sheet denotes a calculated field; here everything below Total Cash Outflows is calculated.",
  labelChars: 30,                       // the row-label column, in character widths
  rowHeight: 13,
  // Which computed series each printed row shows, and how it is set.
  rows: [
    { label: "Capital Expenditures", section: true },
    { key: "capexRows", detail: true },
    { label: "Total CapEx", key: "capex", bold: true, rule: true },
    { label: "Operating Expenses", section: true },
    { key: "opexRows", detail: true },
    { label: "Total OpEx", key: "opex", bold: true, rule: true },
    { label: "Cloud CapEx", section: true },
    { key: "cloudRows", detail: true },
    { label: "Total Cloud CapEx", key: "cloud", bold: true, rule: true },
    { label: "TOTAL CASH OUTFLOWS", key: "outflows", bold: true, band: true },
    { label: "Recurring Costs & Benefits", section: true },
    { key: "benefitRows", detail: true },
    { label: "Total", key: "benefits", bold: true, rule: true },
    { label: "Net Cashflow before taxes", key: "netBeforeTax" },
    { label: "Add: Total Depreciation/Amortization", key: "depreciation" },
    { label: "Net Taxable Income (Expense)", key: "taxableIncome" },
    { label: "Income Taxes", key: "taxes", pctOfPolicy: "taxRate" },
    { label: "Net Cash flow", key: "netCashFlow", bold: true, band: true },
    { label: "Accumulated Net Cash Flow", key: "accumulated" },
    { label: "NPV by year", key: "npvByYear", ratePolicy: "discountRate" },
  ],
  // The four figures a reader looks for first.
  summary: [
    { label: "NPV", key: "npv", money: true },
    { label: "ROI %", key: "roiPct", pct: true },
    { label: "Payback (years)", key: "payback", plain: true },
    { label: "IRR %", key: "irr", pct: true },
  ],
};

/**
 * The Asset Acquisition block and the depreciation schedule behind it (R96, R97).
 *
 * This is the block that prints `#DIV/0!` down the Annl Depr column and `Jan-00` down the EOL
 * column of a real signed AFE when the life is left blank. Neither can be printed here: the
 * life is required before the AFE can be sent.
 */
const ASSET_PAGE = {
  title: "Asset Acquisition and Depreciation",
  note: "Asset class and asset life are SAP's own designations, chosen from the template's list. The annual charge is the cost over the life; the year an asset goes into service and the year it leaves each carry half of it.",
  columns: [
    { key: "description", label: "Asset Description", chars: 42 },
    { key: "cost", label: "Cost", chars: 16, align: "r" },
    { key: "life", label: "Life", chars: 7, align: "r" },
    { key: "inService", label: "In service", chars: 13, align: "c" },
    { key: "eol", label: "EOL", chars: 13, align: "c" },
    { key: "annual", label: "Annl Depr", chars: 16, align: "r" },
    { key: "assetLife", label: "Asset Life in years", chars: 30 },
    { key: "assetClass", label: "Asset Class", chars: 40 },
  ],
  rowHeight: 15,
  scheduleTitle: "Depreciation / Amortization",
  costCentreTitle: "Cost Centre Mapping",
  costCentreColumns: [
    { key: "description", label: "AFE (IO) Descr", chars: 44 },
    { key: "budgetUsd", label: "Budget USD", chars: 18, align: "r" },
    { key: "budgetLocal", label: "Local Curr", chars: 16, align: "r" },
    { key: "costCentre", label: "Cost Centre", chars: 16 },
    { key: "owner", label: "Owner", chars: 26 },
    { key: "legalEntity", label: "Legal Entity", chars: 22 },
  ],
};

// Printed only when the tree is triggered (Q50).
const CLOUD_PAGE = {
  title: "Cloud CapEx",
  intro: "Please answer questions below. Based on the answers, further follow-up may be needed with the relevant FP&A Business Partner to determine whether the project has a cloud capex component. The relevant FP&A Business Partner is the Business Partner responsible for the underlying cost center.",
  questions: [
    { id: "q1Software", n: 1, q: "Does this AFE relate to the purchase, development, or modification of any new (either internally or externally developed) or existing software?",
      options: [{ value: "Yes", label: "Yes" }, { value: "No", label: "No - Do not fill out rest of form" }] },
    { id: "q2ExternallyHosted", n: 2, q: "Is the software externally hosted – i.e. hosted by any organization other than Acme.",
      options: [{ value: "Yes", label: "Yes - Contact FP&A Business Partner" }, { value: "No", label: "No - Do not fill out rest of form" }] },
    { id: "q3Subscription", n: 3, q: "Does Acme own a perpetual license for the software (i.e. permanent legal ownership), or is it subscription based (not owned)?",
      options: [{ value: "Perpetual", label: "Perpetual" }, { value: "Subscription", label: "Subscription" }] },
    { id: "q4CanChangeHost", n: 4, q: "If the software is subscription-based, can Acme change the host (i.e. host locally or move to different hosting company) without significant cost?",
      options: [{ value: "Yes", label: "Yes" }, { value: "No", label: "No" }] },
  ],
  conclusion: "Conclusion: Any software project that has an externally hosted component needs to be reviewed by the relevant FP&A Business Partner to determine if it should be classified as CCA.",
};

// Printed when the wizard collected site/country lines (R52).
const LINES_PAGE = {
  title: "Project Costs by Site",
  note: "These lines are the plan for the child internal orders Fixed Assets creates under the parent AFE. All amounts are USD.",
  columns: [
    { key: "site", label: "Site", chars: 40 },
    { key: "country", label: "Country", chars: 16 },
    { key: "description", label: "Description", chars: 60 },
    { key: "amountUsd", label: "Amount (USD)", chars: 24, align: "r" },
  ],
};

module.exports = { PAGE, COLS, x, w, INK, SIZE, PROJECT_DETAILS, CLOUD_PAGE, LINES_PAGE,
  EXCEPTIONS_BLOCK, DOCUMENTS_BLOCK, EVIDENCE_PAGE, FINANCIALS_PAGE, ASSET_PAGE };
