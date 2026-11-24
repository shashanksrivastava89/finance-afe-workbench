"use strict";
// Reference data. Everything here is DATA, not code — regional variations, new
// company codes, band changes are edits to this file only.

// Approval bands from Global AFE Form 06.01.GLB.FRM.00070 Rev 6.
// Cumulative: the required chain is the concatenation of every band up to the
// one containing the Total Project Cost. Ordering & repeat-signer rule pending
// stakeholder confirmation (PRD Q1 — assumption A-CHAIN: each person signs once).
const BANDS = [
  { maxUsd: 25000,     levels: ["M1"],       label: "$0 – $25,000" },
  { maxUsd: 100000,    levels: ["A1", "A2"], label: "$25,001 – $100,000" },
  { maxUsd: 300000,    levels: ["A3", "A2"], label: "$100,001 – $300,000" },
  { maxUsd: 500000,    levels: ["A5", "A4"], label: "$300,001 – $500,000" },
  { maxUsd: 1000000,   levels: ["A7", "A4"], label: "$500,001 – $1,000,000" },
  { maxUsd: 5000000,   levels: ["A8", "A6"], label: "$1,000,001 – $5,000,000" },
  { maxUsd: 20000000,  levels: ["A9", "A6"], label: "$5,000,001 – $20,000,000" },
  { maxUsd: Infinity,  levels: ["BOARD"],    label: "Over $20,000,000" },
];

const LEVEL_TITLES = {
  M1: "Cost Center Owner", A1: "Senior Manager", A2: "Div. Controller / Fin. Partner",
  A3: "Directors & VPs", A4: "Corporate or Group Controller", A5: "Senior Vice President",
  A6: "Chief Financial Officer", A7: "Executive Vice President", A8: "Chief Operating Officer",
  A9: "Chief Executive Officer", BOARD: "Board of Directors",
};

// The levels in ascending order of authority. "Next higher level" (the segregation-of-duties
// stand-in, Q47) and "highest row a person holds" (one person, one signature — R45) both
// walk this list, so it is the one place the order is written down.
const LEVEL_LADDER = ["M1", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "BOARD"];

// The form's Project Approvals block has four rows. Pre-approvers, charge-to owners and
// signers who hold no matrix level print there (R42); a fifth overflows to a warning.
const PROJECT_APPROVAL_ROWS = 4;

// Every approver is an employee, so every mailbox is on the company domain. A typed
// address outside it is refused rather than guessed at (R60).
const MAIL_DOMAIN = "example.com";

// Where a recipient's mailbox came from, and which of those count as confirmed enough to
// create an envelope. `guessed` (First_Last pattern) and `unresolved` (no address at all)
// keep the routing at preview until the coordinator confirms or types the address.
const CONFIRMED_EMAIL_SOURCES = ["users", "directory", "rule", "typed", "confirmed"];

// The AFE lifecycle (docs/v0.4-blueprint.md §5.1). Listed here so screens and tests can
// name states without re-typing them; the transitions live in stateMachine.js.
const STATES = ["draft", "submitted", "in_approval", "on_hold", "approved", "fa_review", "issued",
  "tracking", "capitalized", "closed", "returned", "rejected", "withdrawn"];

// 13 company codes in FA scope (US + Mexico + Canada + 10 APAC). Names/currencies to be
// completed with the Q2 matrix answer; CO 1000 is the SOP-documented pilot.
const COMPANY_CODES = [
  { code: "1000", name: "Acme US (pilot)", region: "NA", currency: "USD" },
  // remaining 12 codes land here once shared (PRD Q2)
];

// AUC quarterly-review inclusion rules. These are NOT generic flags: the AuC Recon
// workbook states them verbatim as the review population, and each drives a different
// action (see AUC_ACTIONS). Rule 4 is an *exclusion*, implemented as `firmDateOnFile`
// in flags.js:
//   1) AuC spent is equal or greater than 80% of budgeted amount
//   2) Is aged 6 months or older from the IO issue date
//   3) Greater than $100K
//   4) Excluded - AuC assets/projects previously confirmed with future go-live dates
//      beyond the current reviewed period.
const FLAG_RULES = {
  consumedPct: 0.8,      // budget utilization >= 80%
  ageingDays: 180,       // aged >= 180 days (6 months) from IO creation date
  balanceUsd: 100000,    // AUC balance > $100K
};

// What each inclusion rule actually asks the reviewer for (working session 2026-08-31).
// >$100K deliberately has no cadence of its own: it is a prioritisation marker, so the
// high-value items are never the ones that get missed.
const AUC_ACTIONS = {
  consumed80: { cadence: "monthly", ask: "Confirm the in-service date and whether further cost is expected." },
  aged180:    { cadence: "quarterly", ask: "Confirm the in-service (put-to-use) date." },
  over100k:   { cadence: null, priority: true, ask: "Confirm the probable in-service date (high-value item)." },
};

// Capitalization is allowed up to 105% of the approved budget. Beyond that a
// supplemental AFE/budget must be requested before the asset can be capitalized.
// (Working session 2026-08-31 - pending written confirmation, PRD Q24.)
const CAPITALIZATION_TOLERANCE = 1.05;

// SAP internal-order types. Which one applies is a property of the AFE, known to the
// preparer - the tool must not guess it. (PRD Q25: the Z002/Z005 selection rule.)
const ORDER_TYPES = [
  { code: "Z002", label: "Capital Investment Order" },
  { code: "Z005", label: "Second order type" },
];

// The KO22 budget step does not apply to these case types.
// Checklist remark: "Not required for Demo & RRC".
const BUDGET_EXEMPT_TYPES = ["Demo", "RRC"];

// Vendor-quote vs CapEx tolerance (assumption pending PRD Q6 — warn, don't block)
const QUOTE_TOLERANCE = 0.8;

const REQUEST_TYPES = ["Normal", "Demo", "RRC"];

// R&D-type IOs are exempt from the KO22 budget step (identification rule pending PRD Q7)
function isBudgetExempt(afe) {
  return afe.projectType === "R&D";
}

// ---- v0.4 additions (docs/v0.4-blueprint.md) --------------------------------------

// The CAPITAL nature of an AFE — which is not the same question as "is there any OpEx".
//
// A project is either normal CapEx or Cloud CapEx and never both (Imogen, 2026-09-03), but most
// AFEs carry an operating amount as well: "in most of the AFE, the question for both CapEx and
// OpEx over the same AFE" (Lyndsay, Meeting #5 05:46; Euan agreed, 06:32). So `classification`
// answers the capital question and `money.opexUsd` stands beside it, independent. `none` is the
// AFE with no capital component at all — services, maintenance, a licence renewal.
//
// `none` is no longer OFFERED (R158): "OPEX, we don't use AFE form at all, unless it is part of the
// existing project" (Aiden, Meeting #7). It stays a valid value because AFEs were sent with it, and
// a value the store holds must keep meaning what it meant when it was signed.
const CLASSIFICATIONS = [
  { id: "capex", label: "CapEx", help: "Capitalizable spend — equipment, construction, tooling." },
  { id: "cloud_capex", label: "Cloud CapEx (CCA)", help: "Subscription software Acme cannot re-host — see the decision tree." },
  { id: "none", label: "No capital spend", help: "Operating expense only: maintenance, licensing, services." },
];

/**
 * An AFE is for capital, and only above this (R158). "Anything above 2500 should be capex"
 * (Aiden, Meeting #7): at $2,500 or less the spend is an expense and goes on a purchase
 * requisition. Read as the AFE's CAPITAL amount — CapEx or Cloud CapEx — not per asset, which is
 * open for the 9 October review.
 */
const CAPITALIZATION_THRESHOLD_USD = 2500;

// The Cloud CapEx decision tree printed on the V7 template's Cloud CapEx sheet.
// Only the path software -> externally hosted -> subscription -> cannot change host
// reaches Cloud CapEx; every other path is regular CapEx. Any externally hosted
// software also needs the FP&A Business Partner's review (the sheet's own conclusion).
const CLOUD_TREE = [
  { id: "q1Software", q: "Does this AFE relate to the purchase, development, or modification of any new (either internally or externally developed) or existing software?", options: ["Yes", "No"], noOutcome: "regular_capex" },
  { id: "q2ExternallyHosted", q: "Is the software externally hosted — i.e. hosted by any organization other than Acme?", options: ["Yes", "No"], noOutcome: "regular_capex" },
  { id: "q3Subscription", q: "Does Acme own a perpetual license for the software (permanent legal ownership), or is it subscription based (not owned)?", options: ["Perpetual", "Subscription"], perpetualOutcome: "regular_capex" },
  { id: "q4CanChangeHost", q: "If the software is subscription-based, can Acme change the host (host locally or move to a different hosting company) without significant cost?", options: ["Yes", "No"], yesOutcome: "regular_capex", noOutcome: "cloud_capex" },
];

// Division decides who coordinates an AFE and which budget pots apply. The authoritative
// source is the AuC recon extract, which names a division per cost centre — but it covers
// only the cost centres that have had an AUC, so ~1,100 of the 1,197 in the matrix are not
// in it. For those, these keywords read the matrix description ("3026 SG IT -
// Infrastructure"). The vocabulary is the recon file's own, not one we invented. Anything
// that matches nothing stays null and the coordinator or admin sets it — never a guess
// dressed up as a fact.
const DIVISION_KEYWORDS = [
  { division: "CORP_IT", match: /\bIT\b|\bERP\b|\bnetwork\b|\bSAP\b|digital workplace/i },
  { division: "Facilities", match: /facilit|\bbuilding\b|\bsite services\b/i },
  { division: "MFG", match: /manufactur|production|\bQSD\b|fill\/cap|warehouse/i },
  { division: "Marketing", match: /marketing|trade show|brand/i },
  { division: "Selling", match: /\bsales\b|\bselling\b|\bFAS\b|commercial/i },
  { division: "Logistic", match: /logistic|supply|distribution/i },
];

// Controllership review threshold, from the form: "All capital project value >1mil USD".
// The V7 template dropped Rev 6's "in Labor Cost" qualifier, so both are checked.
const CONTROLLERSHIP_THRESHOLD_USD = 1000000;
// Where the controllership signer sits in the chain (PRD Q33 — after the financial ladder).
const CONTROLLERSHIP_PLACEMENT = "after_matrix";

// Supplemental AFEs: does the chain re-run on the increment or on the new cumulative
// total? Default is the cumulative total; PRD Q39 confirms.
const SUPPLEMENTAL_BASIS = "new_total";

// In-tool chase cadence. DocuSign runs its own reminders on the envelope (R54).
const REMINDER_DAYS = 3;
const ENVELOPE_POLICY = {
  reminderDelayDays: 2,      // first nudge after 2 days
  reminderFrequencyDays: 3,  // then every 3
  expireAfterDays: 30,
  expireWarnDays: 3,
  subjectMaxChars: 100,      // DocuSign's own limit
};

// The hand-off to Fixed Assets once every signature is in.
//
// It goes to the shared AFE mailbox with the requester in copy, and its subject is a standard,
// machine-matchable line so the FA team can hang a mailbox rule or a Power Automate flow off it
// without anyone reading the body: everything a downstream flow needs is in the subject, in a
// fixed order, separated by pipes. The mailbox itself is an App Service setting (`FA_MAILBOX`),
// never a literal in the source.
const FA_HANDOFF = {
  subjectPrefix: "AFE APPROVED",
  /** `AFE APPROVED | 30145 | USD 215,000 | PC Hardware Lifecycle Replacement APAC | afe-0007` */
  subject(afe, totalUsd) {
    const money = "USD " + Number(totalUsd || 0).toLocaleString("en-US", { maximumFractionDigits: 0 });
    const title = (afe.project && afe.project.title) || "AFE";
    return [FA_HANDOFF.subjectPrefix, afe.costCenter || "no cost centre", money, title, afe.id].join(" | ");
  },
  /** The same facts as headers, for a flow that would rather not parse a subject. */
  headers(afe, totalUsd) {
    return {
      "X-AFE-Workbench": "afe-approved",
      "X-AFE-Id": String(afe.id),
      "X-AFE-Cost-Centre": String(afe.costCenter || ""),
      "X-AFE-Total-USD": String(Math.round(Number(totalUsd || 0))),
    };
  },
};

// Vendor quote must cover this share of the estimate before the AFE can be sent.
// 60-70% was the range Imogen gave; the coordinator may waive it with a reason (Q34).
const QUOTE_COVERAGE_MIN = 0.7;

// A quote older than this when the AFE is SENT is flagged (R169). "We want that latest quotation
// should be there from the vendor side" (Imogen, UAT review 2026-10-14) — a requester reusing one
// they had from before; ninety days is the line Shashank drew the same day. A warning a requester
// can explain, never a block: a vendor may well hold a price for longer, and the approvers weigh it.
const QUOTE_MAX_AGE_DAYS = 90;

// Every AFE is raised in USD; local-currency quotes are converted by the requester.
const CURRENCY = "USD";

/**
 * The four SAP screens Fixed Assets keys by hand after the AFE is approved, and — from
 * 2026-09-20 — what each of them has to come back with.
 *
 * They were ticks. "Many times, IO number is generated, do not allow to proceed further before a
 * screenshot of the table Budget/Actual/Commitments is uploaded" (Shashank, 2026-09-18): the
 * order gets created and the budget never gets loaded, and nothing in the tool noticed because
 * ticking a box is not evidence of anything. Each step now says what it needs, in data, and the
 * route refuses it without them.
 *
 *   needsAmount    a figure the person types, which the issued version then prints (R99)
 *   needsValue     a number SAP gave back, with the shape it has to be (R100)
 *   needsEvidence  a document role that must be attached to the AFE first (R103)
 *   after          the step that has to be done before this one can be
 */
/**
 * The financial case's own constants, taken from the template's sheet rather than chosen (R94).
 *
 *   years          the sheet runs B..L, eleven columns from the start year (row 2)
 *   discountRate   row 55, a flat 10 % across every year
 *   taxRate        row 51, `=(B50)*0.23`
 *
 * `requiredAboveUsd` is the old Q31 and is still unanswered: above what value must an AFE carry
 * a financial case rather than merely offer one? `null` means the section warns and never
 * blocks, which is the right behaviour while nobody has said. Jarrod and Judithmelanie to set it.
 */
const FINANCIALS = {
  years: 11,
  discountRate: 0.10,
  taxRate: 0.23,
  requiredAboveUsd: null,
};

/**
 * Which generation of the printed form this build renders (R102).
 *
 * Frozen onto the envelope beside `formHash` at send, and compared BEFORE the hash is. A hash
 * only means anything between two renders of the same layout: change the pages and every
 * previously signed AFE stops matching, through no fault of anyone's.
 *
 *   1  v0.4–v0.5. The V7 template's own pages, footers drawn per page as each was laid out.
 *   2  2026-09-20. The issued copy prints what Fixed Assets records in red, carries the KO22
 *      budget table, and draws every footer in one pass once the page count is settled.
 *
 * BUMP THIS whenever `lib/pdf/` changes what the form draws. Not bumping it turns a deploy into
 * a tamper alarm on every AFE in flight.
 */
//   3  2026-09-21. The Financials pages, the Asset Acquisition block and Cloud CapEx on every
//      capital AFE.
/**
 * The requester's journey, in the order it is walked.
 *
 * It lived in `wizard.js` as one constant and was COPIED — as a literal, by hand — into the
 * send-back picker on three screens (the approver's, the coordinator's and Fixed Assets'). So
 * when Cloud CapEx and the Financials step joined the wizard, all three pickers went on offering
 * the five steps that existed before them, and there was no way to send an AFE back to the
 * financial case it was wrong about. Reported 2026-09-21: "the new steps didn't make it to Send
 * back."
 *
 * The step NUMBERS are already the server's — every rule in `afeRules.FIELDS` carries one — so
 * the labels belong beside them and everything reads the one list. `n` is the id, which is also
 * the URL; the ORDER of this array is the journey, which is why 8 sits fourth (see CLAUDE.md).
 * Review is not here: "reopens at Review" is not a thing anyone means.
 */
// Financials comes AFTER Why (2026-10-16): before it, the case asked for an in-service date the
// requester had not yet given, and a negative NPV pointed at a justification on a step not yet
// reached. The ids stay — they are the URLs — and only the order moves.
const WIZARD_STEPS = [
  { n: 1, label: "What" },
  { n: 2, label: "Who pays" },
  { n: 3, label: "How much" },
  { n: 4, label: "Why" },
  { n: 8, label: "Financials" },
  { n: 5, label: "Cloud CapEx" },
  { n: 6, label: "Quote" },
];
const REVIEW_STEP = { n: 7, label: "Review" };

const FORM_LAYOUT_VERSION = 4;

/**
 * What a person attaches in support of the request, before it is sent: printed on the form's
 * Documents page and bound into the one file the approvers sign. Stable for the life of the AFE,
 * which is what lets the form's hash keep its promise (R112). ONE list, sent to the browser with
 * the rest of the reference data, because it was typed out in a dozen places and a new role would
 * have reached some of them.
 *   internal_quote     the quotation Acme itself generates when the equipment comes out of its
 *                      own inventory (R150): a second kind of quote, not a new field
 *   material_evidence  a screenshot of that material as SAP displays it
 */
const SUPPORTING_ROLES = ["quote", "sow", "backup", "internal_quote", "material_evidence"];
/** The ones that carry a price, and so what quote coverage adds up. */
const QUOTE_ROLES = ["quote", "sow", "internal_quote"];
/**
 * Where the equipment comes from (R150): an outside vendor, or Acme's own inventory. Asked
 * only of an AFE that buys something physical; `vendor` is the default and needs nothing said.
 */
const SOURCING = [{ id: "vendor", label: "An outside vendor" }, { id: "internal", label: "Acme inventory" }];

/**
 * Where a comment can be written (R149): every state an AFE is still alive in. A closed,
 * declined or withdrawn AFE is a finished record, and its conversation is finished with it.
 */
const COMMENT_STATES = ["draft", "submitted", "in_approval", "on_hold", "returned", "approved", "fa_review", "issued", "tracking", "capitalized"];
/** Who wrote a line in the conversation, in the words a screen and a mail both use. */
const THREAD_SIDES = { requester: "Requester", preparer: "Preparer", coordinator: "Coordinator", fa: "Fixed Assets", approver: "Approver", other: "" };

const HANDOFF_STEPS = [
  { key: "KO01_IO", seq: 1, title: "Create Internal Order (KO01)" },
  {
    key: "KO22_BUDGET", seq: 2, title: "Load budget on the IO (KO22)", after: "KO01_IO",
    needsAmount: {
      field: "budgetLoadedUsd",
      label: "Budget loaded (USD)",
      help: "What you actually posted on the order. It is usually the approved total, and when it is not, the difference is the thing everyone downstream wants to know about.",
    },
    needsEvidence: {
      role: "budget_evidence",
      label: "Budget / Actual / Commitments",
      help: "The table SAP shows back after KO22. It is the proof the order exists AND the budget is unlocked — and it prints at the top of the issued AFE, where Fixed Assets pastes it by hand today.",
    },
  },
  {
    key: "AS01_AUC", seq: 3, title: "Create the AuC (AS01)", after: "KO22_BUDGET",
    needsValue: {
      field: "aucNumber",
      label: "AuC number",
      pattern: "^\\d{6,12}$",
      shape: "6 to 12 digits",
      help: "The Asset under Construction number SAP assigns. It is written onto the issued AFE in red, beside the AFE number.",
    },
  },
  { key: "KO02_SETTLEMENT", seq: 4, title: "Set the settlement rule (KO02)", after: "AS01_AUC" },
];
const CAPITALIZE_STEP = { key: "AIBU_CAPITALIZE", seq: 5, title: "Capitalize the asset (AIBU)" };

// ---- v0.5 additions (Meeting #5, 2026-09-11) -------------------------------------

// What may be attached. Facilities packs are the big ones: "I have received a PDF over mail
// with 60 or 65 pages" (Imogen, 15:38-16:53). The old 10 MB per-file cap was well under what
// the mail channel it replaces already carries, so it moves to Outlook's own 25 MB. The
// per-AFE cap is ours: a hundred megabytes is a generous project pack and a cheap guard
// against an accident.
const ATTACHMENT_LIMITS = {
  perFileBytes: 25 * 1024 * 1024,
  perAfeBytes: 100 * 1024 * 1024,
  maxFiles: 25,
  // DocuSign refuses a single document over 25 MB, which is the same number by coincidence;
  // named separately so a change to one does not silently move the other.
  docusignPerDocumentBytes: 25 * 1024 * 1024,
};

// What Fixed Assets writes back by hand today, once the internal order exists. Taken verbatim
// from Lyndsay's mail of 2026-09-11 (screenshot at 65:45) so the tool's version reads exactly
// like the one the PR and PO teams already act on.
const ISSUE_HANDBACK = {
  subject: (afe, ioNumber, title) => `AFE ${ioNumber}: ${title}`,
  glAccount: "602620",
  // A template literal with real line breaks, so what is written here is exactly what is sent.
  body: (ioNumber) => `Attached is the assigned AFE ${ioNumber}.

For capitalized expenses, please use GL account 602620 and reference the AFE number in the IO field (do not enter the cost center) when setting up the Purchase Requisition account assignment. Ensure all costs directly related to this IO use GL account 602620. Sales and use tax, customs duty, and freight associated with purchasing or acquiring a capital asset will be capitalized as part of the asset cost.

Please let me know if you have any questions.`,
};

// Who signs off before Fixed Assets creates the internal order. "Before creating the AFE, team
// members take approval either from Judithmelanie or myself, depending on the project cost" (Jarrod,
// 70:02). The threshold is Jarrod's to set; until he does, every issue needs a second pair of
// eyes, which is the safe direction to be wrong in.
/**
 * The kinds of routing rule an administrator may write (`orgRules`).
 *
 * Named here rather than in the admin route because master data validates against the same
 * list when a rule arrives from a spreadsheet, and two copies of it drift the first time one
 * is extended — which is exactly what happened when `fa_issue_approver` was added for R101.
 */
const ORG_RULE_KINDS = [
  { id: "pre_approver", help: "signs first and prints in Project Approvals" },
  { id: "override", help: "adds someone whatever the band" },
  { id: "controllership", help: "the >$1M review" },
  { id: "additional", help: "an extra signer on a named row" },
  { id: "cc", help: "receives a copy" },
  { id: "coordinator", help: "prepares and sends for a division" },
  { id: "assistant", help: "checks before a named signer, and never signs" },
  { id: "fa_issue_approver", help: "approves an AFE for issue before Fixed Assets creates the internal order" },
];
const ORG_RULE_KIND_IDS = ORG_RULE_KINDS.map((k) => k.id);

const FA_ISSUE_APPROVAL = {
  required: true,
  // Above this, name the person rather than accepting any checker. null until Jarrod confirms.
  escalateAboveUsd: null,
  escalateTo: null,
};

// The chase ladder. One nudge repeated for ever is not a follow-up, it is noise: "reminder one,
// reminder two, or something like that" (Euan, 48:44). Steps are cumulative days since the
// recipient received it; `cc` copies somebody else in; `every` repeats the last step.
// Overridden per environment in settings/reminders (Admin > Reminders).
const REMINDER_LADDER = {
  steps: [
    { afterDays: 3, cc: null, label: "First reminder" },
    { afterDays: 7, cc: "coordinator", label: "Second reminder, coordinator copied" },
    { afterDays: 14, cc: "coordinator", every: 7, label: "Weekly, coordinator copied" },
  ],
  // Senior approvers are given longer before the first nudge (R54: "VPs get 1-2 weeks").
  slowLevels: ["A4", "A5", "A6", "A7", "A8", "A9"],
  slowMultiplier: 2,
};

// How far a machine-read quote value is trusted, and when disagreeing with it becomes a flag
// every approver sees rather than a private correction. `minConfidence` is a placeholder until
// the spike over twenty real quotes sets it from data (docs/v0.4-blueprint.md §11).
const DI_POLICY = {
  minConfidence: 0.80,
  overrideFlagPct: 5,
  lineItemTolerancePct: 1,
  models: ["prebuilt-invoice", "prebuilt-layout"],
};

module.exports = { BANDS, LEVEL_TITLES, LEVEL_LADDER, PROJECT_APPROVAL_ROWS, MAIL_DOMAIN,
  CONFIRMED_EMAIL_SOURCES, STATES, COMPANY_CODES, FLAG_RULES, AUC_ACTIONS,
  CAPITALIZATION_TOLERANCE, ORDER_TYPES, BUDGET_EXEMPT_TYPES, QUOTE_TOLERANCE, REQUEST_TYPES,
  isBudgetExempt, HANDOFF_STEPS, CAPITALIZE_STEP,
  CLASSIFICATIONS, CAPITALIZATION_THRESHOLD_USD, CLOUD_TREE, DIVISION_KEYWORDS, CONTROLLERSHIP_THRESHOLD_USD, CONTROLLERSHIP_PLACEMENT,
  SUPPLEMENTAL_BASIS, REMINDER_DAYS, ENVELOPE_POLICY, FA_HANDOFF, QUOTE_COVERAGE_MIN, QUOTE_MAX_AGE_DAYS, CURRENCY,
  ATTACHMENT_LIMITS, ISSUE_HANDBACK, FA_ISSUE_APPROVAL, REMINDER_LADDER, DI_POLICY,
  ORG_RULE_KINDS, ORG_RULE_KIND_IDS, FORM_LAYOUT_VERSION, FINANCIALS,
  WIZARD_STEPS, REVIEW_STEP, COMMENT_STATES, THREAD_SIDES, SUPPORTING_ROLES, QUOTE_ROLES, SOURCING };
