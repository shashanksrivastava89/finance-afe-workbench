"use strict";
// Validation at source — the rules the wizard enforces BEFORE an AFE can be submitted,
// and the same rules Fixed Assets sees aggregated as red flags afterwards.
//
// This is what makes the old FA presence-checklist unnecessary (Manaia, Early Review:
// "those checks go away automatically") and it is where Imogen's list of what FA checks by
// hand now lives (R50, transcript 57:11–59:44).
//
// Everything is DATA plus a small evaluator. Field ids are DOT PATHS into the AFE
// aggregate, so the wizard's autosave (`PATCH /api/afes/:id {"project.title": "…"}`), the
// error it shows, and the value the PDF prints are all the same name. Add or change a rule
// here — never in a screen.
//
// Deterministic by design: no model is consulted (R62). Three severities:
//   block   the AFE cannot be submitted
//   warn    advice; never blocks
//   pending a fact the tool has not been given yet (an unknown cost centre, a quote total
//           not typed). Never blocks Continue; blocks Send, and says why.
const { BANDS, CLASSIFICATIONS, QUOTE_COVERAGE_MIN, QUOTE_MAX_AGE_DAYS, CONTROLLERSHIP_THRESHOLD_USD, CAPITALIZATION_THRESHOLD_USD, SUPPLEMENTAL_BASIS, QUOTE_ROLES, SOURCING, FINANCIALS } = require("./refData");
const cloudTree = require("./cloudTree");
const financials = require("./financials");

// Reference lists lifted from the template's hidden Reference / DataVal sheets.
const PROJECT_TYPES = ["Automation", "Compliance", "Cost Savings", "GM Improvement", "In Sourcing",
  "Maintenance/Repair", "New Construction", "New Equipment", "NPI", "Office Equip/Furniture", "Other",
  "Process Improvement", "Quality", "Regulatory", "Revenue Growth", "Safety"];
const CONSTRUCTION_TYPES = ["New Construction", "Office Equip/Furniture"];

/**
 * "Checked the 925 surplus area first?" asks whether the requester looked in the surplus-
 * equipment store at Site A before buying new — so it only makes sense when the AFE buys
 * a physical thing that could already be sitting on that shelf. Asking it of a software
 * subscription is noise, and noise on a form is how the rest of the form stops being read.
 *
 * Two tests, and both must pass:
 *   · the project type is one that buys goods or fits out a space; and
 *   · the AFE has not declared itself software — Cloud CapEx by classification, or "Yes" to
 *     the Cloud questionnaire's first question, which is exactly where the template puts the
 *     software/not-software decision (there is no "Software" project type on the form).
 *
 * The types left out are the ones that describe an OUTCOME rather than a purchase — Cost
 * Savings, GM Improvement, Process Improvement, Revenue Growth, Compliance, Regulatory. When
 * one of those does buy equipment, it is almost always classed as New Equipment as well.
 * "Other" stays in: the one type that could be anything is the one worth asking about.
 */
const TANGIBLE_TYPES = ["Automation", "In Sourcing", "Maintenance/Repair", "New Construction",
  "New Equipment", "NPI", "Office Equip/Furniture", "Other", "Quality", "Safety"];

function isSoftwareAfe(afe) {
  if (get(afe, "money.classification") === "cloud_capex") return true;
  return String(get(afe, "cloud.q1Software") || "") === "Yes";
}

/** Does the 925 surplus question apply to this AFE? Read at validation, print and paint time. */
function surplusCheckApplies(afe) {
  const type = get(afe, "project.projectType");
  if (!type) return true;                         // nothing chosen yet — keep asking
  return TANGIBLE_TYPES.indexOf(type) >= 0 && !isSoftwareAfe(afe);
}
/**
 * Where the equipment comes from (R150). Imogen brought a whole class of AFE the tool had never
 * met: an instrument moved out of Acme's own inventory rather than bought, carried by a
 * quotation Acme generates and a screenshot of the material in SAP, with no vendor quote to
 * attach (AFE 313147, QX700 ddPCR instruments, Site H). It is asked of exactly the AFEs the
 * 925 surplus question is asked of, something physical and not software, and it defaults to an
 * outside vendor so that no AFE already in flight gains a question it cannot answer.
 */
const SOURCING_IDS = SOURCING.map((s) => s.id);
function sourcingApplies(afe) { return surplusCheckApplies(afe); }
function sourcingOf(afe) { return sourcingApplies(afe) && get(afe, "sourcing") === "internal" ? "internal" : "vendor"; }
const CLASSIFICATION_IDS = CLASSIFICATIONS.map((c) => c.id);
const YES_NO = ["Yes", "No"];
const YES_NO_NA = ["Yes", "No", "N/A"];

/** `budget.potId` when the money comes from a budget that is not one of the pots (R167). */
const OTHER_POT = "other";

const THRESHOLDS = {
  titleMaxChars: 40,                                     // SAP order description limit — hard
  quoteCoverageMin: QUOTE_COVERAGE_MIN,                  // 60–70% was Imogen's range; 70 until Q34
  quoteMaxAgeDays: QUOTE_MAX_AGE_DAYS,                   // older than this when sent is flagged (R169)
  npvRequiredAboveUsd: FINANCIALS.requiredAboveUsd,      // Q31 — ONE value, refData's; null until Jarrod and Judithmelanie set it
  controllershipUsd: CONTROLLERSHIP_THRESHOLD_USD,       // form: "All capital project value >1mil USD"
  descriptionMinChars: 20,
  duplicateWindowDays: 90,
};

// --- tiny path helpers -------------------------------------------------------------
function get(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj, path, value) {
  const keys = String(path).split(".");
  const last = keys.pop();
  let node = obj;
  for (const k of keys) { if (node[k] == null || typeof node[k] !== "object") node[k] = {}; node = node[k]; }
  node[last] = value;
  return obj;
}
const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const isEmpty = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
// A message that quotes a figure should quote it the way the screen does. Rules are pure, so
// this is the one place the domain formats money, and it matches public/js/core/format.js.
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
/** A calendar day written YYYY-MM-DD that is a real day — 2026-02-30 is not. */
const isDay = (s) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ""))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * The form as the wizard collects it.
 *   step  the wizard screen that owns the field, so an error points at the right place
 *   owner requester | preparer  (preparer fields are the coordinator's to complete)
 *   type  text | money | int | date | enum | list | derived
 */
const FIELDS = [
  // 1 · What
  { id: "project.title", step: 1, type: "text", required: true, max: THRESHOLDS.titleMaxChars, label: "Title", owner: "requester" },
  { id: "project.projectType", step: 1, type: "enum", required: true, options: PROJECT_TYPES, label: "Project type", owner: "requester" },

  // 2 · Who pays
  { id: "costCenter", step: 2, type: "text", required: true, pattern: /^\d{4,6}$/, label: "Cost centre", owner: "requester" },
  { id: "location", step: 2, type: "text", required: true, label: "Location", owner: "preparer" },
  { id: "division", step: 2, type: "text", required: false, label: "Division", owner: "preparer" },
  { id: "region", step: 2, type: "enum", required: false, options: ["NLAM", "EMEA", "APAC", "Global"], label: "Region", owner: "preparer" },

  // 3 · How much
  { id: "money.classification", step: 3, type: "enum", required: true, options: CLASSIFICATION_IDS, label: "Classification", owner: "preparer" },
  { id: "money.capexUsd", step: 3, type: "money", required: false, min: 0, label: "CapEx (USD)", owner: "requester" },
  { id: "money.opexUsd", step: 3, type: "money", required: false, min: 0, label: "OpEx (USD)", owner: "requester" },
  { id: "money.cloudCapexUsd", step: 3, type: "money", required: false, min: 0, label: "Cloud CapEx (USD)", owner: "preparer" },
  { id: "money.laborUsd", step: 3, type: "money", required: false, min: 0, label: "Labour cost (USD)", owner: "requester" },
  { id: "money.lines", step: 3, type: "list", required: false, label: "Cost by site or country", owner: "requester" },
  { id: "budget.budgeted", step: 3, type: "enum", required: true, options: YES_NO, label: "Is this budgeted?", owner: "preparer" },
  { id: "budget.potId", step: 3, type: "text", required: false, label: "Budget pot", owner: "preparer" },
  // "Other" (R167): a budget that is not one of the division's pots, in the requester's words —
  // `budget.potId = "other"` where pots exist, the line alone where a division has none yet.
  { id: "budget.otherBudget", step: 3, type: "text", required: false, max: 120, label: "Which budget", owner: "requester" },
  { id: "schedule.fiscalYear", step: 3, type: "int", required: false, min: 2000, label: "Fiscal year", owner: "preparer" },
  { id: "kind", step: 3, type: "enum", required: false, options: ["original", "supplemental"], label: "Supplemental?", owner: "requester" },

  // 6 · Quote. Optional with a default, never blank: see sourcingApplies (R150).
  { id: "sourcing", step: 6, type: "enum", required: false, options: SOURCING_IDS, label: "Where does it come from?", owner: "requester" },

  // 4 · Why
  { id: "schedule.startDate", step: 4, type: "date", required: true, label: "Estimated start date", owner: "requester" },
  // Fixed Assets reconciles AuC against a DATE, not a year — "we need the actual estimate date,
  // not the year only" (Lyndsay, Meeting #5 08:35). This field already held it; it is relabelled so
  // the room recognises it, and the AuC review reads it as the expected go-live. The fiscal year
  // stays a year and stays where it is.
  { id: "schedule.finishDate", step: 4, type: "date", required: true, label: "Expected completion (in-service) date", owner: "requester" },
  { id: "project.description", step: 4, type: "text", required: true, min: THRESHOLDS.descriptionMinChars, label: "Project description", owner: "requester" },
  { id: "project.justification", step: 4, type: "text", required: true, min: THRESHOLDS.descriptionMinChars, label: "Justification rationale", owner: "requester" },
  { id: "project.scope", step: 4, type: "text", required: false, label: "Scope", owner: "requester" },
  { id: "project.alternatives", step: 4, type: "text", required: false, label: "Alternatives considered", owner: "requester" },
  { id: "project.ehsImpact", step: 4, type: "text", required: false, label: "Environmental / regulatory / safety impact", owner: "requester" },
  { id: "project.surplusChecked", step: 4, type: "enum", required: surplusCheckApplies, options: YES_NO, label: "Checked the 925 surplus area first?", owner: "requester" },
  { id: "project.buyVsLease", step: 4, type: "enum", required: true, options: YES_NO_NA, label: "Buy-vs-lease reviewed with Procurement?", owner: "requester" },
  { id: "project.assistAsset", step: 4, type: "enum", required: true, options: YES_NO, label: "Any Assist assets?", owner: "requester" },
];

const FIELD_BY_ID = FIELDS.reduce((m, f) => { m[f.id] = f; return m; }, {});

// --- money -------------------------------------------------------------------------
const num = (a, p) => toNum(get(a, p)) || 0;
function total(afe) {
  const a = afe || {};
  return num(a, "money.capexUsd") + num(a, "money.opexUsd") + num(a, "money.cloudCapexUsd");
}
function lineTotal(afe) {
  const lines = get(afe, "money.lines") || [];
  return lines.reduce((n, l) => n + (toNum(l && l.amountUsd) || 0), 0);
}
// A Acme quotation is a quote like any other for coverage (R150): the arithmetic does not
// care who priced it.
function quoteTotal(afe) {
  return quotes(afe).reduce((n, d) => n + (toNum(d.amountUsd) || 0), 0);
}
function quotes(afe) {
  return ((afe && afe.documents) || []).filter((d) => QUOTE_ROLES.includes(d.role));
}
const docsOf = (afe, role) => ((afe && afe.documents) || []).filter((d) => d.role === role);

/**
 * Cross-field rules. Each `check` returns null when satisfied, or an object describing the
 * problem. `severity` defaults to "block"; `pending: true` on the result overrides it.
 */
const RULES = [
  { id: "breakup_positive", step: 3, check: (a) => (total(a) > 0 ? null
    : { field: "money.capexUsd", message: "Enter at least one amount — CapEx, OpEx or Cloud CapEx." }) },

  // Two different questions, and Meeting #5 showed we had been answering only one of them.
  //
  // CAPITAL NATURE is exclusive: a project is either normal CapEx or Cloud CapEx, never both
  // (Imogen, 2026-09-03) — the accounting treatment differs and the Cloud CapEx decision tree
  // picks one. OPEX IS NOT PART OF THAT CHOICE: "in most of the AFE, the question for both
  // CapEx and OpEx over the same AFE" (Lyndsay, Meeting #5 05:46), and Euan agreed that a
  // single AFE routinely carries both, itemised. So `money.opexUsd` stands beside whichever
  // capital amount applies, and `classification: "none"` is the AFE with no capital half at all.
  //
  // The band is unaffected either way: `total()` has always summed all three.
  { id: "classification_exclusive", step: 3, check: (a) => {
    const capex = num(a, "money.capexUsd"), cloud = num(a, "money.cloudCapexUsd");
    if (capex > 0 && cloud > 0) return { field: "money.cloudCapexUsd",
      message: "An AFE is either normal CapEx or Cloud CapEx — not both. Move the amount to one of them." };
    const c = get(a, "money.classification");
    if (c === "capex" && cloud > 0) return { field: "money.cloudCapexUsd", message: "Classified as CapEx, but there is a Cloud CapEx amount." };
    if (c === "cloud_capex" && capex > 0) return { field: "money.capexUsd", message: "Classified as Cloud CapEx, but there is a CapEx amount." };
    if (c === "none" && (capex > 0 || cloud > 0)) return { field: "money.classification",
      message: "Marked as having no capital spend, but a CapEx or Cloud CapEx amount is entered." };
    return null;
  } },

  // Something has to be being asked for. Previously implied by the classification; now that
  // CapEx and OpEx are independent, it needs saying.
  { id: "amount_present", step: 3, check: (a) => (total(a) > 0 ? null
    : { field: "money.capexUsd", message: "How much is this? Enter a CapEx amount, an OpEx amount, or both." }) },

  // AN AFE IS CAPITAL (R158). "Anything above 2500 should be capex… OPEX, we don't use AFE form
  // at all, unless it is part of the existing project" (Aiden, Meeting #7). OpEx still stands
  // beside the capital — the warranty, the licences, the installation — but it cannot be the AFE.
  //
  // Asked only while the AFE is being written. Red flags re-run every live rule at Fixed Assets,
  // so an AFE sent before this rule existed must not meet a block it can no longer answer: the
  // signatures on it were given under the rules of the day.
  // A financial case REQUIRED above Q31's threshold — dormant until somebody sets
  // `refData.FINANCIALS.requiredAboveUsd`. Until then nothing blocks and `hints()` says the case
  // is missing instead. Only while the AFE is unsent, like capital_threshold: red flags re-run
  // every live rule at Fixed Assets, and a threshold set later must not land on a signed AFE.
  { id: "financial_case_required", step: 8, check: (a) => {
    const above = FINANCIALS.requiredAboveUsd;
    if (above === null || above === undefined || a.sentAt) return null;
    if (num(a, "money.capexUsd") + num(a, "money.cloudCapexUsd") <= above || hasCase(a)) return null;
    return { field: "financials", message: `Above ${money(above)} a financial case is required. Fill in the Financials step.` };
  } },

  { id: "capital_threshold", step: 3, check: (a) => {
    if (a && a.sentAt) return null;
    if (!(total(a) > 0)) return null;                      // amount_present says so
    const cloud = num(a, "money.cloudCapexUsd");
    const capital = num(a, "money.capexUsd") + cloud;
    if (capital > CAPITALIZATION_THRESHOLD_USD) return null;
    const field = cloud > 0 || get(a, "money.classification") === "cloud_capex" ? "money.cloudCapexUsd" : "money.capexUsd";
    return capital > 0
      ? { field, message: `At ${money(CAPITALIZATION_THRESHOLD_USD)} or less this is an expense. Raise a purchase requisition instead of an AFE.` }
      : { field, message: "An AFE is for capital. Enter the CapEx or Cloud CapEx — OpEx on its own goes on a purchase requisition." };
  } },

  // The tree decides; the declared classification must agree with it.
  { id: "cloud_tree_consistent", step: 5, check: (a) => {
    if (!cloudTree.isTriggered(a)) return null;
    const r = cloudTree.evaluate((a && a.cloud) || {});
    if (!r.outcome) return { pending: true, field: "cloud." + (r.nextQuestion ? r.nextQuestion.id : "q1Software"),
      message: "Answer the Cloud CapEx questions so the classification can be derived." };
    const declared = get(a, "money.classification");
    // A block that names a field and offers no way to change it is a dead end, and this one is
    // reachable by answering four questions honestly: the tree lands on regular CapEx, the AFE
    // still says Cloud CapEx, and Continue is dead with nothing on the screen to press. "OK then
    // allow me to fix it here" (Shashank, 2026-09-21). `fix` is DATA — the field and the value
    // that would resolve it, plus what to call the button — so the rule stays pure and the
    // screen does not have to know which rule it is looking at.
    if (r.outcome === "cloud_capex" && declared !== "cloud_capex") return { field: "money.classification",
      message: "The Cloud CapEx questions point to CCA — classify this as Cloud CapEx or revisit the answers.",
      fix: { field: "money.classification", value: "cloud_capex", label: "Make it Cloud CapEx" } };
    if (r.outcome === "regular_capex" && declared === "cloud_capex") return { field: "money.classification",
      message: "The Cloud CapEx questions do not reach CCA — this is regular CapEx.",
      fix: { field: "money.classification", value: "capex", label: "Make it regular CapEx" } };
    return null;
  } },

  // Cost lines by site/country become the child-IO plan (R52), so they must add up.
  { id: "lines_sum_to_total", step: 3, check: (a) => {
    const lines = get(a, "money.lines") || [];
    if (!lines.length) return null;
    const diff = Math.abs(lineTotal(a) - total(a));
    return diff < 0.005 ? null : { field: "money.lines",
      message: "The site amounts add up to " + lineTotal(a).toFixed(2) + ", the AFE total is " + total(a).toFixed(2) + "." };
  } },

  // A real pot, or "Other" in words, answers it (R167). "Other" with nothing typed is asked again,
  // on the line itself.
  { id: "budget_pot_when_budgeted", step: 3, severity: "warn", check: (a) => {
    if (get(a, "budget.budgeted") !== "Yes") return null;
    const potId = get(a, "budget.potId");
    const other = String(get(a, "budget.otherBudget") || "").trim();
    if ((potId && potId !== OTHER_POT) || other) return null;
    return potId === OTHER_POT
      ? { field: "budget.otherBudget", message: "Say which budget it comes out of." }
      : { field: "budget.potId", message: "Which budget does this come out of? Approvers ask." };
  } },

  // THAT the AFE does not fit is the rule's to say; BY HOW MUCH is a pot balance, which is the
  // coordinator's and Fixed Assets' to see and not the requester's (R167). The figure travels as
  // `data`, and `afeView` prints it for a viewer who may see pots.
  { id: "budget_pot_available", step: 3, severity: "warn", needs: "budget pot", check: (a, ctx) => {
    if (get(a, "budget.budgeted") !== "Yes") return null;
    const potId = get(a, "budget.potId");
    if (!potId || potId === OTHER_POT || !ctx || !ctx.pot) return null;
    const remaining = toNum(ctx.pot.remainingUsd);
    if (remaining === null) return null;
    return total(a) <= remaining ? null : { field: "budget.potId",
      message: "This is more than the pot has left.", data: { remainingUsd: remaining } };
  } },

  { id: "unbudgeted_reason", step: 3, check: (a) => (
    get(a, "budget.budgeted") !== "No" || get(a, "budget.unbudgetedReason") ? null
      : { field: "budget.unbudgetedReason", message: "Say why this is unbudgeted — every approver will ask." }) },

  { id: "supplemental_needs_original", step: 3, check: (a) => {
    if (get(a, "kind") !== "supplemental") return null;
    const io = get(a, "supplementalOf.ioNumber");
    return io && /^\d{6,10}$/.test(String(io).trim()) ? null
      : { field: "supplementalOf.ioNumber", message: "A supplemental AFE needs the internal order it tops up." };
  } },

  { id: "supplemental_original_exists", step: 3, needs: "the original AFE", check: (a, ctx) => {
    if (get(a, "kind") !== "supplemental") return null;
    const io = get(a, "supplementalOf.ioNumber");
    if (!io) return null;
    if (!ctx || !ctx.originalIo) return { pending: true, field: "supplementalOf.ioNumber",
      message: "Internal order " + io + " is not in the tool yet — Fixed Assets will confirm it." };
    return null;
  } },

  { id: "finish_after_start", step: 4, check: (a) => {
    const s = get(a, "schedule.startDate"), f = get(a, "schedule.finishDate");
    return (!s || !f || new Date(f) >= new Date(s)) ? null
      : { field: "schedule.finishDate", message: "The finish date is before the start date." };
  } },

  // Approvals routinely take weeks and can take a month, so a start date in the past is
  // normal enough to warn about rather than block (transcript 41:20).
  { id: "start_not_past", step: 4, severity: "warn", check: (a, ctx) => {
    const s = get(a, "schedule.startDate");
    if (!s) return null;
    const today = (ctx && ctx.today) || new Date().toISOString().slice(0, 10);
    return new Date(s) >= new Date(today) ? null
      : { field: "schedule.startDate", message: "The start date has already passed — approvals typically take one to four weeks." };
  } },

  { id: "single_year_span", step: 4, severity: "warn", check: (a) => {
    const s = get(a, "schedule.startDate"), f = get(a, "schedule.finishDate");
    if (!s || !f) return null;
    return days(s, f) <= 400 ? null : { field: "schedule.finishDate",
      message: "This spans more than a year. Finance asked for one AFE per year — split it unless there is a reason." };
  } },

  { id: "fiscal_year_matches_start", step: 3, severity: "warn", check: (a) => {
    const fy = toNum(get(a, "schedule.fiscalYear")), s = get(a, "schedule.startDate");
    if (!fy || !s) return null;
    const y = new Date(s).getUTCFullYear();
    return Math.abs(fy - y) <= 1 ? null : { field: "schedule.fiscalYear",
      message: "Fiscal year " + fy + " does not match a start date in " + y + "." };
  } },

  // What stands behind the price depends on where the equipment comes from (R150).
  { id: "quote_present", step: 6, check: (a) => {
    if (sourcingOf(a) === "internal") return docsOf(a, "internal_quote").length ? null
      : { field: "documents", message: "Attach the Acme quotation for the equipment coming from inventory." };
    return docsOf(a, "quote").length || docsOf(a, "sow").length ? null
      : { field: "documents", message: "Attach at least one vendor quote or SOW." };
  } },
  { id: "material_evidence_present", step: 6, check: (a) => (sourcingOf(a) !== "internal" || docsOf(a, "material_evidence").length ? null
    : { field: "documents", message: "Attach a screenshot of the material in SAP (Display Material)." }) },

  // "Don't block them. Give them a red flag only." (Imogen, Meeting #5 22:44.) A quote that does
  // not cover the estimate is a fact an approver should weigh, not a door — so this warns, and
  // the waiver it used to need is gone with the block. The arithmetic is spelled out because a
  // flag that carries its own evidence is one an approver can act on without opening anything.
  { id: "quote_covers_estimate", step: 6, severity: "warn", needs: "the quote total", check: (a) => {
    const qs = quotes(a);
    if (!qs.length) return null;                                   // quote_present reports that
    if (qs.some((q) => toNum(q.amountUsd) === null)) return { pending: true, field: "documents",
      message: "Type the quote total so we can check it covers the estimate." };
    const t = total(a); if (!t) return null;
    const qt = quoteTotal(a);
    const ratio = qt / t;
    if (ratio >= THRESHOLDS.quoteCoverageMin) return null;
    return { field: "documents", message:
      `${qs.length} quote${qs.length > 1 ? "s" : ""} · ${money(qt)} = ${Math.round(ratio * 100)}% of the `
      + `${money(t)} estimate — at least ${Math.round(THRESHOLDS.quoteCoverageMin * 100)}% is expected. `
      + "Say why below and the reason travels with the AFE." };
  } },

  // A quote has a shelf life (R169): "the quotation should be the latest one" (Imogen, UAT review
  // 2026-10-14), over QUOTE_MAX_AGE_DAYS by Shashank's line. Measured to the day the AFE was SENT, so it never ages into a flag while it waits
  // on signatures or on Fixed Assets — what the approvers weighed is the age it had when they got
  // it. Only a TYPED date can be old; a quote nobody has dated is asked about while the AFE is a
  // draft and is nobody's to answer once it has gone, so no AFE already sent gains a question.
  { id: "quote_recent", step: 6, severity: "warn", check: (a, ctx) => {
    const qs = quotes(a);
    if (!qs.length) return null;                                   // quote_present reports that
    const sent = get(a, "sentAt");
    const asOf = String(sent || (ctx && ctx.today) || new Date().toISOString()).slice(0, 10);
    const old = qs.filter((q) => isDay(q.quoteDate) && days(q.quoteDate, asOf) > THRESHOLDS.quoteMaxAgeDays);
    if (old.length) {
      const q = old[0], age = days(q.quoteDate, asOf);
      return { field: "documents", data: { attachmentId: q.attachmentId, ageDays: age },
        message: `${q.vendor ? `${q.vendor}'s quote` : q.filename} ${sent ? `was ${age} days old when this was sent` : `is ${age} days old`} — `
          + `over ${THRESHOLDS.quoteMaxAgeDays} is flagged. Get a fresh one, or say below why it still holds.` };
    }
    if (sent) return null;
    const undated = qs.filter((q) => !isDay(q.quoteDate));
    return undated.length ? { field: "documents", data: { attachmentId: undated[0].attachmentId },
      message: `What date is ${undated[0].vendor ? `${undated[0].vendor}'s quote` : undated[0].filename}? Quotes over ${THRESHOLDS.quoteMaxAgeDays} days old are flagged.` } : null;
  } },

  // The location list is the AFE template's own, and it carries the building number Fixed
  // Assets files property tax against ("the 725 is the building number" — Lyndsay, 26:29). A site
  // that is not on it is warned about rather than refused: a new building exists before anybody
  // updates a master, and the requester should not be the one held up by that.
  { id: "location_in_list", step: 2, severity: "warn", needs: "the location list", check: (a, ctx) => {
    const loc = String(get(a, "location") || "").trim();
    if (!loc) return null;                                         // the field rule reports that
    const known = ctx && ctx.locations;
    if (!known) return null;                                       // not loaded — do not guess
    if (known.some((l) => String(l).trim().toLowerCase() === loc.toLowerCase())) return null;
    return { field: "location", message:
      `"${loc}" is not on the location list, so the building will not be recognised for property tax. `
      + "Pick the closest match if there is one, or ask Admin to add this site." };
  } },

  { id: "cost_center_active", step: 2, needs: "the SAP approver matrix", check: (a, ctx) => {
    if (!get(a, "costCenter")) return null;                        // the field rule reports that
    if (!ctx || !ctx.matrixRow) return { pending: true, field: "costCenter",
      message: "Cost centre not found in the SAP approval matrix — Fixed Assets will confirm it." };
    return String(ctx.matrixRow.status || "Active").toLowerCase() === "active" ? null
      : { field: "costCenter", message: "Cost centre " + get(a, "costCenter") + " is " + ctx.matrixRow.status + " in SAP." };
  } },

  // "Prepared By" is a printed field on the form and one of Imogen's mandatory checks. It is
  // the preparer, not the requester (screenshot 13:20: Aiden's own name on a PM's AFE).
  { id: "prepared_by_present", step: 2, check: (a) => {
    const p = (a && a.preparer) || (a && a.requester);
    return p && p.name ? null : { field: "preparer.name", message: "Prepared By is not set." };
  } },

  { id: "charge_to_owner_named", step: 2, check: (a) => {
    const c = a && a.chargeTo;
    if (!c) return null;
    return c.ownerName ? null : { field: "chargeTo.ownerName",
      message: "Name the business owner who signs for the chargeback." };
  } },

  { id: "duplicate_open_request", step: 1, severity: "warn", needs: "open AFEs", check: (a, ctx) => {
    const hits = (ctx && ctx.possibleDuplicates) || [];
    // The matches travel with the warning, so the screen can name them: it said "1 other open AFE
    // looks similar" and offered no way to see which (2026-10-16).
    return hits.length ? { field: "project.title",
      message: hits.length + " other open AFE" + (hits.length > 1 ? "s" : "") + " on this cost centre look" +
        (hits.length > 1 ? "" : "s") + " similar — check you are not duplicating one.",
      data: { matches: hits.slice(0, 5).map((h) => ({ id: h.id, title: h.title || null, state: h.state || null })) } } : null;
  } },
];

/** Which optional sections this AFE needs, and why — so the wizard shows or skips them. */
function conditionalSections(afe) {
  const a = afe || {};
  const t = total(a);
  const out = [];
  if (cloudTree.isTriggered(a)) {
    const r = cloudTree.evaluate(a.cloud || {});
    out.push({ id: "cloud_questionnaire", step: 5, label: "Cloud CapEx questions",
      why: "software or a Cloud CapEx amount", answered: Boolean(r.outcome), outcome: r.outcome || null,
      fpaReviewRequired: r.fpaReviewRequired });
  }
  if (CONSTRUCTION_TYPES.indexOf(get(a, "project.projectType")) >= 0) {
    out.push({ id: "facilities_sow", step: 5, label: "Facilities cost sheet", why: "construction / fit-out project type" });
  }
  if (THRESHOLDS.npvRequiredAboveUsd === null) {
    out.push({ id: "npv_model", step: 5, label: "NPV / ROI / payback model", pending: "threshold not set",
      why: "attach the Financials sheet for large projects — the threshold is not set yet" });
  } else if (t > THRESHOLDS.npvRequiredAboveUsd) {
    out.push({ id: "npv_model", step: 5, label: "NPV / ROI / payback model", why: "amount above the threshold" });
  }
  if (t > THRESHOLDS.controllershipUsd || num(a, "money.laborUsd") > THRESHOLDS.controllershipUsd) {
    out.push({ id: "controllership_review", step: 5, label: "Controllership Review",
      why: "capital project value above $1M — accounting reviews the classification" });
  }
  return out;
}

/** The approval band and required levels for this total — the same engine the router uses. */
function bandFor(afe, opts) {
  const o = opts || {};
  let t = total(afe);
  if (get(afe, "kind") === "supplemental" && SUPPLEMENTAL_BASIS === "new_total") {
    t += toNum(get(afe, "supplementalOf.approvedTotalUsd")) || 0;
  }
  let levels = [];
  for (const b of BANDS) {
    levels = levels.concat(b.levels);
    if (t <= b.maxUsd) return { label: b.label, levels: dedupe(levels), totalUsd: t, basisKind: SUPPLEMENTAL_BASIS };
  }
  const last = BANDS[BANDS.length - 1];
  return { label: last.label, levels: dedupe(levels), totalUsd: t, basisKind: SUPPLEMENTAL_BASIS };
}
const dedupe = (xs) => xs.filter((x, i) => xs.indexOf(x) === i);

/**
 * Everything wrong with ONE field's own value, given its spec. Shape, not consequence: this
 * knows nothing about any other field, the matrix, the pot or the clock, which is exactly why
 * the browser can run it on every keystroke (R105).
 *
 * `spec` is a FIELDS row or the JSON projection of one from `fieldSpec()`, so the server and
 * `public/js/core/fieldCheck.js` evaluate the same table in the same order and cannot produce
 * two different sentences. `required` is a flag, the NAME of an answer in `applies`, or — only
 * ever server-side, where the whole AFE is in hand — a predicate.
 */
function fieldProblem(spec, value, applies, afe) {
  const f = spec;
  const at = (message) => ({ field: f.id, step: f.step, severity: "block", message });
  if (isEmpty(value)) {
    // `required` is a flag or a question: a field that only applies to some AFEs says so as
    // a predicate rather than as a special case somewhere else (project.surplusChecked).
    const needed = typeof f.required === "function" ? f.required(afe || {})
      : typeof f.required === "string" ? Boolean(applies && applies[f.required])
      : f.required;
    // A label that is already a QUESTION cannot take "is required" after it: the toggles on
    // "How much" produced "Is this budgeted? is required.", which is not a sentence. They are
    // all pick-one controls, so say that.
    return needed ? at(/\?$/.test(f.label) ? f.label + " Pick one." : f.label + " is required.") : null;
  }
  if (f.type === "text") {
    const s = String(value);
    if (f.max && s.length > f.max) return at(f.label + " is " + s.length + " characters — the limit is " + f.max + ".");
    if (f.min && s.trim().length < f.min) return at(f.label + " needs a little more — at least " + f.min + " characters.");
    const re = f.pattern instanceof RegExp ? f.pattern : f.pattern ? new RegExp(f.pattern.source, f.pattern.flags) : null;
    if (re && !re.test(s)) return at(f.label + " does not look right (" + s + ").");
    return null;
  }
  if (f.type === "money" || f.type === "int") {
    const n = toNum(value);
    if (n === null) return at(f.label + " must be a number.");
    if (f.min !== undefined && n < f.min) return at(f.label + " cannot be " + (f.min === 0 ? "negative" : "below " + f.min) + ".");
    return null;
  }
  if (f.type === "enum" && f.options.indexOf(value) < 0) return at(f.label + ": choose one of " + f.options.join(" / ") + ".");
  if (f.type === "date" && Number.isNaN(new Date(value).getTime())) return at(f.label + " is not a date.");
  return null;
}

/**
 * The field table as JSON the browser can hold: the predicate `required`s become the NAME of
 * the answer in `validation.applies`, and a RegExp becomes its source and flags. Nothing here
 * is a second copy of the rules — it is the same rows, projected, which is what lets
 * `smoke-afe-rules` assert the two evaluators agree sentence for sentence.
 */
function fieldSpec() {
  return FIELDS.filter((f) => f.type !== "derived" && f.type !== "list").map((f) => {
    const out = { id: f.id, step: f.step, type: f.type, label: f.label, owner: f.owner };
    // A predicate travels as the NAME of its answer. One that has not been registered travels
    // as "not required": the browser then stays quiet about it and the server still asks, which
    // is the right way round. `smoke-afe-rules` refuses to let an unregistered one ship.
    out.required = typeof f.required === "function" ? (PREDICATE_REQUIRED[f.id] || false) : Boolean(f.required);
    if (f.max !== undefined) out.max = f.max;
    if (f.min !== undefined) out.min = f.min;
    if (f.options) out.options = f.options;
    if (f.pattern) out.pattern = { source: f.pattern.source, flags: f.pattern.flags };
    return out;
  });
}
// Which key in `validation.applies` answers a predicate `required`. One line per predicate, so
// adding a conditional field without saying how the browser asks the question fails the smoke.
const PREDICATE_REQUIRED = { "project.surplusChecked": "surplusCheck" };

/**
 * What is wrong with the financial case (R94, R97).
 *
 * `financials.problems` already returns the right shape; this only says which wizard step owns
 * them. It is the one piece of validation that is not a FIELDS row or a RULES row, because a
 * grid of eleven years by ten rows is not a field and pretending otherwise would mean a rule
 * per cell.
 */
function financialProblems(afe) {
  const f = (afe && afe.financials) || null;
  if (!f || !f.assets || !f.assets.length) return [];
  return financials.problems(f).map((p) => Object.assign({ step: FINANCIALS_STEP }, p));
}

/** The wizard screen that owns the financial case. See `public/js/screens/requester/wizard.js`. */
const FINANCIALS_STEP = 8;

/** Whether the AFE carries a financial case at all: an asset is what the case depreciates. */
function hasCase(a) {
  const f = a && a.financials;
  return Boolean(f && Array.isArray(f.assets) && f.assets.length);
}

/**
 * What is worth doing and decides NOTHING (2026-10-16). A hint is never a block, a warning, a
 * flag note, an exception on the form or a red flag — it is said on the review screen and in the
 * coordinator's "Before it goes", and that is all.
 *
 * The KT walkthrough sent a capital AFE to its coordinator with no financial case, and nothing on
 * any screen had said so: the coordinator found out by reading the AFE and asked. Whether a case
 * is REQUIRED is Q31's, still unanswered, so until it is this is a hint and not a rule; once it is,
 * `financial_case_required` blocks above the threshold and the hint stands aside. Only while the
 * AFE is unsent, so nothing already signed gains anything.
 */
function hints(afe) {
  const a = afe || {};
  const out = [];
  const capital = num(a, "money.capexUsd") + num(a, "money.cloudCapexUsd");
  const above = FINANCIALS.requiredAboveUsd;
  const required = above !== null && above !== undefined && capital > above;
  if (!a.sentAt && capital > 0 && !hasCase(a) && !required) {
    out.push({ id: "financial_case_missing", step: FINANCIALS_STEP, severity: "hint",
      message: "No financial case yet — on a capital AFE the coordinator and the approvers look for its NPV and payback.",
      fix: { step: FINANCIALS_STEP, label: "Set it up" } });
  }
  return out;
}

function fieldProblems(afe) {
  const applies = appliesFor(afe);
  const out = [];
  for (const f of FIELDS) {
    const problem = fieldProblem(f, get(afe, f.id), applies, afe);
    if (problem) out.push(problem);
  }
  return out;
}

/** The answers to the conditional questions, as the browser is given them in `validation`. */
function appliesFor(afe) {
  return { surplusCheck: surplusCheckApplies(afe), sourcing: sourcingApplies(afe) };
}

// ---- exceptions: a flag, and why it was accepted anyway ---------------------------------------

/** The rules a person may write a justification against — the ones that do not stop anything. */
const NOTEABLE_RULES = RULES.filter((r) => r.severity === "warn").map((r) => r.id)
  .concat(["quote_override_large"]);

/** `afe.flagNotes` keyed by rule, most recent wins. */
function notesByRule(afe) {
  const out = {};
  for (const n of (afe && afe.flagNotes) || []) {
    if (!n || !n.ruleId || !String(n.note || "").trim()) continue;
    const prev = out[n.ruleId];
    if (!prev || String(n.at || "") >= String(prev.at || "")) out[n.ruleId] = n;
  }
  return out;
}

/** Is this a rule a note can be written against, and is the note usable? */
function checkFlagNote(ruleId, note) {
  const problems = [];
  if (!NOTEABLE_RULES.includes(ruleId)) {
    problems.push(`"${ruleId}" is not something a note can be attached to — notes explain a flag, `
      + "and a rule that blocks is fixed rather than explained.");
  }
  const text = String(note === null || note === undefined ? "" : note).trim();
  if (text.length > 500) problems.push(`that note is ${text.length} characters — the limit is 500.`);
  return problems;
}

/**
 * Every flag a person has justified, in the shape the PDF, the approver screen and the envelope
 * message all print. Derived, never stored: a note whose flag has since gone away stops showing.
 */
function exceptions(validation) {
  const v = validation || {};
  return [].concat(v.warns || [], v.blocks || [], v.pending || [])
    .filter((e) => e.note)
    .map((e) => ({ rule: e.rule, field: e.field, label: e.message, note: e.note, by: e.noteBy, byName: e.noteByName || e.noteBy, at: e.noteAt }));
}

/**
 * Validate an AFE aggregate.
 * @param {object} afe
 * @param {object} ctx { matrixRow, today, pot, originalIo, possibleDuplicates, locations }
 * @returns {{ok, blocks, warns, pending, byStep, sections, band, totalUsd, applies, notable}}
 *          `ok` means submittable: no blocks. Pending items do not block Continue but are
 *          listed at Send, because a fact we have not been given is not the requester's fault.
 */
function validate(afe, ctx) {
  const a = afe || {};
  const blocks = [], warns = [], pending = [];
  const push = (item) => {
    if (item.pending) pending.push(item);
    else if (item.severity === "warn") warns.push(item);
    else blocks.push(item);
  };

  fieldProblems(a).forEach(push);
  financialProblems(a).forEach(push);

  // A note the requester wrote against a flag travels WITH the flag, not in a list somewhere
  // else: "whatever is mentioned in that text box will be carried forward across the entire
  // approval chain, so everybody is aware" (Shashank to Imogen and Euan, Meeting #5 25:15).
  // Attaching it here means the approver screen, the envelope message, the printed Exceptions
  // block and Fixed Assets all get it without any of them going to look.
  const notes = notesByRule(a);
  for (const r of RULES) {
    let res;
    try { res = r.check(a, ctx || {}); } catch (e) { res = null; }
    if (!res) continue;
    const note = notes[r.id];
    push(Object.assign({ rule: r.id, step: r.step, severity: r.severity || "block" }, res,
      note ? { note: note.note, noteBy: note.by, noteByName: note.byName, noteAt: note.at } : {}));
  }

  const byStep = {};
  blocks.concat(pending, warns).forEach((e) => {
    const k = e.step || 0;
    byStep[k] = byStep[k] || { block: 0, warn: 0, pending: 0 };
    byStep[k][e.pending ? "pending" : (e.severity === "warn" ? "warn" : "block")] += 1;
  });

  const out = {
    ok: blocks.length === 0,
    sendable: blocks.length === 0 && pending.length === 0,
    blocks, warns, pending, byStep,
    // Which conditional questions this AFE is actually being asked. The wizard paints from
    // this rather than re-deciding in the browser, so a question can never be shown that the
    // server would not then require (or hidden while it still blocks Continue).
    applies: appliesFor(a),
    // Flags a person may write a justification against, so the screen knows where to offer the
    // box without carrying its own copy of which rules are soft.
    noteable: [].concat(warns, pending).filter((e) => e.rule && NOTEABLE_RULES.includes(e.rule))
      .map((e) => ({ rule: e.rule, field: e.field, message: e.message, note: e.note || null, data: e.data || null, fix: e.fix || null })),
    sections: conditionalSections(a),
    // Worth doing, deciding nothing — see `hints()`. Kept OUT of blocks, warns and pending, so it
    // never reaches the exceptions frozen at send, the printed form or a red flag.
    hints: hints(a),
    band: bandFor(a),
    totalUsd: total(a),
    capitalUsd: num(a, "money.capexUsd") + num(a, "money.cloudCapexUsd"),
    opexUsd: num(a, "money.opexUsd"),
  };
  out.exceptions = exceptions(out);
  return out;
}

module.exports = {
  FIELDS, FIELD_BY_ID, RULES, THRESHOLDS, PROJECT_TYPES, CONSTRUCTION_TYPES, TANGIBLE_TYPES, OTHER_POT,
  NOTEABLE_RULES, hints, hasCase,
  fieldProblem, fieldSpec, appliesFor, PREDICATE_REQUIRED,
  financialProblems, FINANCIALS_STEP,
  surplusCheckApplies, isSoftwareAfe, checkFlagNote, notesByRule, exceptions,
  sourcingApplies, sourcingOf, SOURCING_IDS,
  validate, conditionalSections, bandFor, total, lineTotal, quoteTotal, quotes,
  get, set, toNum, money, isDay,
};
