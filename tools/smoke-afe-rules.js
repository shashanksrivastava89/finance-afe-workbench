"use strict";
// Validation at source, offline: the rules the wizard enforces before an AFE can be sent.
// Fixtures are the two real AFEs we hold — the Larson fibre case (small, single site) and
// the APAC hardware refresh (multi-country, 215,000 USD, screenshots 13:20-16:47).
//
//   node tools/smoke-afe-rules.js
const rules = require("../lib/domain/afeRules");
const cloudTree = require("../lib/domain/cloudTree");

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + detail : "")); }
};
const ids = (list) => list.map((e) => e.rule || e.field).join(",");
const has = (list, id) => list.some((e) => e.rule === id || e.field === id);

// The Larson fibre case, as the requester would enter it.
function larson() {
  return {
    id: "afe-t1", state: "draft", kind: "original", createdAt: "2026-09-01T00:00:00.000Z",
    requester: { email: "savannah@example.com", name: "Savannah Evoy" },
    preparer: { email: "savannah@example.com", name: "Savannah Evoy" },
    division: "Selling", region: "NLAM", costCenter: "10713",
    location: "USA_Site A_Site 6",
    project: {
      title: "GCO Americas QX700 Fiber Case", projectType: "Other",
      description: "GCO Americas Field Sales will purchase a customized shipping fibre case for the QX700 demo instrument.",
      justification: "The QX700 demo instrument travels between field sites and two units were damaged in transit this year.",
      surplusChecked: "Yes", buyVsLease: "No", assistAsset: "No",
    },
    schedule: { startDate: "2026-09-24", finishDate: "2026-10-24", fiscalYear: 2026 },
    money: { classification: "capex", lines: [], capexUsd: 7914.97, opexUsd: 0, cloudCapexUsd: 0, laborUsd: 0 },
    cloud: {},
    budget: { budgeted: "Yes", potId: null, unbudgetedReason: "" },
    documents: [{ attachmentId: "att-1", role: "quote", filename: "Larson_Quote_QX700.pdf", vendor: "Larson Packing Company", amountUsd: 7914.97 }],
    waivers: [],
  };
}

// The APAC PC hardware refresh: one AFE, seven country lines, 215,000 USD.
function apac() {
  const a = larson();
  a.id = "afe-t2";
  a.requester = { email: "aiden-mulqueeny_crilly@example.com", name: "Aiden-Mulqueeny Crilly" };
  a.preparer = { email: "aiden-mulqueeny_crilly@example.com", name: "Aiden-Mulqueeny Crilly" };
  a.division = "IT"; a.region = "APAC"; a.costCenter = "30145";
  a.location = "SGP_Singapore_Site 5";
  a.project.title = "PC Hardware Lifecycle Replacement APAC";
  a.project.projectType = "Office Equip/Furniture";
  a.project.description = "The hardware refresh project will be used to stock inventory in APAC for FY 2026.";
  a.schedule = { startDate: "2026-09-01", finishDate: "2026-12-30", fiscalYear: 2026 };
  a.money = {
    classification: "capex", capexUsd: 215000, opexUsd: 0, cloudCapexUsd: 0, laborUsd: 0,
    lines: [
      { site: "South Korea", country: "KR", amountUsd: 30000 },
      { site: "Japan", country: "JP", amountUsd: 30000 },
      { site: "Singapore MFG", country: "SG", amountUsd: 30000 },
      { site: "Singapore DC", country: "SG", amountUsd: 20000 },
      { site: "Singapore GCO", country: "SG", amountUsd: 49000 },
      { site: "Australia", country: "AU", amountUsd: 20000 },
      { site: "India", country: "IN", amountUsd: 36000 },
    ],
  };
  a.documents = [{ attachmentId: "att-2", role: "quote", filename: "APAC_HW_estimate.pdf", vendor: "Multiple", amountUsd: 215000 }];
  return a;
}

const activeCc = { costCenter: "10713", status: "Active" };
const ctx = (extra) => Object.assign({ matrixRow: activeCc, today: "2026-09-01" }, extra || {});

console.log("1. the two real AFEs, as entered");
let r = rules.validate(larson(), ctx());
check("the Larson fibre case is submittable", r.ok, ids(r.blocks));
check("nothing is pending once the quote total is typed", r.pending.length === 0, ids(r.pending));
check("band is $0 – $25,000 → M1 only", r.band.label === "$0 – $25,000" && r.band.levels.join() === "M1", JSON.stringify(r.band));

r = rules.validate(apac(), ctx({ matrixRow: { costCenter: "30145", status: "Active" } }));
check("the APAC hardware refresh is submittable", r.ok, ids(r.blocks));
check("its seven country lines add up to the total", r.totalUsd === 215000 && !has(r.blocks, "lines_sum_to_total"), String(r.totalUsd));
check("band moves to $100,001 – $300,000 → M1+A3+A2+A1", r.band.label === "$100,001 – $300,000", JSON.stringify(r.band));

console.log("2. what Fixed Assets used to catch by hand (R50)");
let a = larson();
a.project.title = "GCO Americas Field Sales QX700 Fiber Case";   // 41 characters
r = rules.validate(a, ctx());
check("a title over 40 characters is blocked (SAP keeps 40)", has(r.blocks, "project.title"), ids(r.blocks));

a = larson(); a.costCenter = null; a.location = null; a.schedule.startDate = null; a.project.description = "";
r = rules.validate(a, ctx({ matrixRow: null }));
check("cost centre, location, start date and description are all mandatory",
  ["costCenter", "location", "schedule.startDate", "project.description"].every((f) => has(r.blocks, f)), ids(r.blocks));

a = larson(); a.schedule.finishDate = "2026-09-01";
r = rules.validate(a, ctx());
check("a finish date before the start date is blocked", has(r.blocks, "finish_after_start"), ids(r.blocks));

a = larson(); a.schedule.startDate = "2026-08-01"; a.schedule.finishDate = "2026-08-30";
r = rules.validate(a, ctx());
check("a start date in the past warns, never blocks", has(r.warns, "start_not_past") && r.ok, ids(r.warns));

a = larson(); a.schedule.finishDate = "2028-01-01";
r = rules.validate(a, ctx());
check("a multi-year span warns (one AFE per year)", has(r.warns, "single_year_span") && r.ok, ids(r.warns));

// R67, Meeting #5: "Don't block them. Give them a red flag only." (Imogen, 22:44.) Coverage is
// a fact for the approver to weigh, so it warns, stays submittable, and carries its own
// arithmetic rather than a verdict.
a = larson(); a.documents[0].amountUsd = 3000;
r = rules.validate(a, ctx());
check("a quote covering 38% warns and does not block",
  has(r.warns, "quote_covers_estimate") && !has(r.blocks, "quote_covers_estimate") && r.ok,
  ids(r.blocks) + " | " + ids(r.warns));
check("the coverage flag shows the arithmetic, not just a verdict",
  /1 quote · \$3,000 = 38% of the \$[\d,]+ estimate/.test(
    (r.warns.find((e) => e.rule === "quote_covers_estimate") || {}).message || ""),
  JSON.stringify((r.warns.find((e) => e.rule === "quote_covers_estimate") || {}).message));
check("a soft flag is offered for a justification", r.noteable.some((n) => n.rule === "quote_covers_estimate"),
  JSON.stringify(r.noteable.map((n) => n.rule)));

// R69: the note rides WITH the flag, so every approver sees the reason beside the exception.
a = larson(); a.documents[0].amountUsd = 3000;
a.flagNotes = [{ ruleId: "quote_covers_estimate", note: "Single-source switch; installation quoted separately.",
  by: "aiden-mulqueeny_crilly@example.com", at: "2026-09-14T09:00:00Z" }];
r = rules.validate(a, ctx());
check("a justification attaches to the flag it explains",
  (r.warns.find((e) => e.rule === "quote_covers_estimate") || {}).note === "Single-source switch; installation quoted separately.",
  JSON.stringify(r.warns.find((e) => e.rule === "quote_covers_estimate")));
check("and surfaces as an exception for the form and the approver screen",
  r.exceptions.length === 1 && r.exceptions[0].rule === "quote_covers_estimate" && r.exceptions[0].by === "aiden-mulqueeny_crilly@example.com",
  JSON.stringify(r.exceptions));
check("a note cannot be attached to a rule that blocks — those are fixed, not explained",
  rules.checkFlagNote("quote_present", "we will get one later").length === 1,
  JSON.stringify(rules.checkFlagNote("quote_present", "x")));

// R63: CapEx and OpEx live on one AFE; only the CAPITAL nature is exclusive.
a = larson(); a.money.classification = "capex"; a.money.capexUsd = 8000; a.money.opexUsd = 2500;
r = rules.validate(a, ctx());
check("CapEx and OpEx together are fine, and both count toward the band",
  !has(r.blocks, "classification_exclusive") && rules.total(a) === 10500 && r.capitalUsd === 8000 && r.opexUsd === 2500,
  ids(r.blocks) + " | total " + rules.total(a));
a = larson(); a.money.classification = "capex"; a.money.capexUsd = 8000; a.money.cloudCapexUsd = 1000;
check("CapEx and Cloud CapEx together are still refused",
  has(rules.validate(a, ctx()).blocks, "classification_exclusive"), ids(rules.validate(a, ctx()).blocks));
// R158: an AFE is capital. "Anything above 2500 should be capex… OPEX, we don't use AFE form at
// all, unless it is part of the existing project" (Aiden, Meeting #7).
a = larson(); a.money.classification = "none"; a.money.capexUsd = null; a.money.cloudCapexUsd = null; a.money.opexUsd = 4000;
check("OpEx on its own is not an AFE, while one is being written (R158)",
  has(rules.validate(a, ctx()).blocks, "capital_threshold") && !has(rules.validate(a, ctx()).blocks, "classification_exclusive"),
  ids(rules.validate(a, ctx()).blocks));
a.sentAt = "2026-09-01T00:00:00.000Z";
check("…but an AFE SENT that way before the rule existed meets nothing new at Fixed Assets",
  !has(rules.validate(a, ctx()).blocks, "capital_threshold") && !has(rules.validate(a, ctx()).blocks, "classification_exclusive")
    && !has(rules.validate(a, ctx()).blocks, "amount_present"), ids(rules.validate(a, ctx()).blocks));
a = larson(); a.money.capexUsd = 2500;
check("$2,500 of capital is an expense: blocked, and the block says what to do instead",
  has(rules.validate(a, ctx()).blocks, "capital_threshold")
    && /purchase requisition/.test(rules.validate(a, ctx()).blocks.find((b) => b.rule === "capital_threshold").message),
  ids(rules.validate(a, ctx()).blocks));
a = larson(); a.money.capexUsd = 2501;
check("$2,501 is an AFE", !has(rules.validate(a, ctx()).blocks, "capital_threshold"), ids(rules.validate(a, ctx()).blocks));
a = larson(); a.money.capexUsd = 2000; a.money.opexUsd = 50000;
check("OpEx does not lift the capital over it", has(rules.validate(a, ctx()).blocks, "capital_threshold"), ids(rules.validate(a, ctx()).blocks));
a = larson(); a.money.classification = "cloud_capex"; a.money.capexUsd = 0; a.money.cloudCapexUsd = 1800;
check("Cloud CapEx is capital too, and the block names its own field",
  (rules.validate(a, ctx()).blocks.find((b) => b.rule === "capital_threshold") || {}).field === "money.cloudCapexUsd",
  JSON.stringify(rules.validate(a, ctx()).blocks.filter((b) => b.rule === "capital_threshold")));
a = larson(); a.money = { classification: "capex", lines: [], capexUsd: null, cloudCapexUsd: null, opexUsd: null, laborUsd: null };
check("an AFE asking for nothing is blocked", has(rules.validate(a, ctx()).blocks, "amount_present"),
  ids(rules.validate(a, ctx()).blocks));

// R65: a site outside the master warns — a new building exists before a master is updated.
a = larson(); a.location = "IND_Gurugram_Somewhere New";
r = rules.validate(a, Object.assign(ctx(), { locations: ["SGP_Singapore_ICON @IBP", "USA_Site A_1000 Main Campus"] }));
check("a location outside the list warns and does not block",
  has(r.warns, "location_in_list") && !has(r.blocks, "location_in_list"), ids(r.warns));
a = larson(); a.location = "SGP_Singapore_ICON @IBP";
check("a location from the list is silent",
  !has(rules.validate(a, Object.assign(ctx(), { locations: ["SGP_Singapore_ICON @IBP"] })).warns, "location_in_list"), "");

a = larson(); a.documents = [];
r = rules.validate(a, ctx());
check("no quote at all is blocked", has(r.blocks, "quote_present"), ids(r.blocks));

a = larson(); a.budget.budgeted = "No"; a.budget.unbudgetedReason = "";
r = rules.validate(a, ctx());
check("an unbudgeted AFE must say why", has(r.blocks, "unbudgeted_reason"), ids(r.blocks));

console.log("3. classification is explicit and exclusive (R49)");
a = larson(); a.money.cloudCapexUsd = 1200;
r = rules.validate(a, ctx());
check("CapEx and Cloud CapEx together are blocked", has(r.blocks, "classification_exclusive"), ids(r.blocks));

a = larson(); a.money.classification = null;
r = rules.validate(a, ctx());
check("the classification must be declared", has(r.blocks, "money.classification"), ids(r.blocks));

a = larson(); a.money.classification = "cloud_capex"; a.money.capexUsd = 0; a.money.cloudCapexUsd = 7914.97;
a.project.projectType = "Automation";
r = rules.validate(a, ctx());
check("declaring Cloud CapEx without answering the questions is pending, not a failure",
  has(r.pending, "cloud_tree_consistent") && r.ok, ids(r.pending));

a.cloud = { q1Software: "Yes", q2ExternallyHosted: "Yes", q3Subscription: "Subscription", q4CanChangeHost: "No" };
r = rules.validate(a, ctx());
check("the full Cloud CapEx path agrees with the declaration", r.ok && r.pending.length === 0, ids(r.blocks) + " | " + ids(r.pending));
check("externally hosted software raises the FP&A review",
  r.sections.some((s) => s.id === "cloud_questionnaire" && s.fpaReviewRequired), JSON.stringify(r.sections));

a.cloud.q4CanChangeHost = "Yes";     // Acme can re-host → regular CapEx
r = rules.validate(a, ctx());
check("a re-hostable subscription is regular CapEx, so the declaration is challenged",
  has(r.blocks, "cloud_tree_consistent"), ids(r.blocks));

console.log("4. the Cloud CapEx tree matches the printed decision tree");
check("no software → not applicable", cloudTree.evaluate({ q1Software: "No" }).outcome === "not_applicable");
check("hosted by Acme → regular CapEx", cloudTree.evaluate({ q1Software: "Yes", q2ExternallyHosted: "No" }).outcome === "regular_capex");
check("perpetual licence → regular CapEx",
  cloudTree.evaluate({ q1Software: "Yes", q2ExternallyHosted: "Yes", q3Subscription: "Perpetual" }).outcome === "regular_capex");
check("subscription that cannot move host → Cloud CapEx",
  cloudTree.evaluate({ q1Software: "Yes", q2ExternallyHosted: "Yes", q3Subscription: "Subscription", q4CanChangeHost: "No" }).outcome === "cloud_capex");
check("an unanswered tree asks the next question, it does not guess",
  cloudTree.evaluate({ q1Software: "Yes" }).nextQuestion.id === "q2ExternallyHosted");

console.log("5. facts the tool has not been given are pending, not failures");
r = rules.validate(larson(), ctx({ matrixRow: null }));
check("an unknown cost centre is pending (matrix lookup), not an error",
  has(r.pending, "cost_center_active") && r.ok, ids(r.pending) + " | " + ids(r.blocks));
check("pending stops Send but not Continue", r.ok === true && r.sendable === false);

a = larson(); a.documents[0].amountUsd = null;
r = rules.validate(a, ctx());
check("a quote with no total asks for it, rather than failing", has(r.pending, "quote_covers_estimate") && r.ok, ids(r.pending));

a = larson(); a.kind = "supplemental"; a.supplementalOf = { ioNumber: "313403", approvedTotalUsd: 240000 };
r = rules.validate(a, ctx());
check("a supplemental whose original is not in the tool is pending", has(r.pending, "supplemental_original_exists"), ids(r.pending));
check("the supplemental band is the cumulative total", r.band.totalUsd === 240000 + 7914.97, JSON.stringify(r.band));

a = larson(); a.kind = "supplemental"; a.supplementalOf = { ioNumber: "" };
r = rules.validate(a, ctx());
check("a supplemental with no original IO is blocked", has(r.blocks, "supplemental_needs_original"), ids(r.blocks));

console.log("6. errors point back to a wizard step");
a = larson(); a.project.title = ""; a.documents = []; a.schedule.finishDate = "2020-01-01";
r = rules.validate(a, ctx());
check("every block carries the step that owns it", r.blocks.every((e) => e.step >= 1 && e.step <= 6), JSON.stringify(r.blocks.map((e) => [e.field, e.step])));
check("the step summary counts blocks per step", r.byStep[1] && r.byStep[1].block >= 1 && r.byStep[6] && r.byStep[6].block >= 1, JSON.stringify(r.byStep));

console.log("6b. a budget that is not one of the pots, and what a pot has left (R167)");
const potWarn = (v, id) => v.warns.find((e) => e.rule === id);
a = larson();
r = rules.validate(a, ctx());
check("budgeted with no pot asks which budget", (potWarn(r, "budget_pot_when_budgeted") || {}).field === "budget.potId", ids(r.warns));
a.budget.potId = rules.OTHER_POT;
r = rules.validate(a, ctx());
check("\"Other\" with nothing typed asks again, on the line itself",
  (potWarn(r, "budget_pot_when_budgeted") || {}).field === "budget.otherBudget", ids(r.warns));
a.budget.otherBudget = "GCO Americas demo-fleet budget";
r = rules.validate(a, ctx());
check("\"Other\" in words answers it", !potWarn(r, "budget_pot_when_budgeted"), ids(r.warns));
a.budget.potId = null;
r = rules.validate(a, ctx());
check("so does the line alone, on a division with no pots", !potWarn(r, "budget_pot_when_budgeted"), ids(r.warns));
a.budget.potId = rules.OTHER_POT;
r = rules.validate(a, ctx({ pot: { id: "pot-x", remainingUsd: 10 } }));
check("\"Other\" is never measured against a pot", !potWarn(r, "budget_pot_available"), ids(r.warns));
a.budget.potId = "pot-x";
r = rules.validate(a, ctx({ pot: { id: "pot-x", remainingUsd: 5000.4 } }));
const over = potWarn(r, "budget_pot_available");
check("a pot that is short says so with no figure in the words, and carries the figure as data",
  over && !/\d/.test(over.message) && over.data && over.data.remainingUsd === 5000.4, JSON.stringify(over));
r = rules.validate(a, ctx({ pot: { id: "pot-x", remainingUsd: 9000 } }));
check("and says nothing when it fits", !potWarn(r, "budget_pot_available"), ids(r.warns));
check("the line is the requester's, one line long",
  rules.FIELD_BY_ID["budget.otherBudget"] && rules.FIELD_BY_ID["budget.otherBudget"].max === 120
    && rules.fieldProblem(rules.FIELD_BY_ID["budget.otherBudget"], "x".repeat(121), {}) !== null);
console.log("6c. a quote has a shelf life, measured to the day it was sent (R169)");
const recent = (v) => v.warns.find((e) => e.rule === "quote_recent");
a = larson();                                              // today is 2026-09-01 in ctx()
r = rules.validate(a, ctx());
check("an undated quote is asked for its date while the AFE is a draft",
  /What date is Larson Packing Company's quote\?/.test((recent(r) || {}).message || ""), ids(r.warns));
a.documents[0].quoteDate = "2026-06-04";                   // 89 days before
check("89 days old is fine", !recent(rules.validate(a, ctx())));
a.documents[0].quoteDate = "2026-06-02";                   // 91 days before
r = rules.validate(a, ctx());
check("91 days old is flagged, with the age and what to do",
  recent(r) && /is 91 days old —/.test(recent(r).message) && recent(r).data.ageDays === 91 && recent(r).field === "documents",
  JSON.stringify(recent(r)));
check("it is a warning a requester can explain, never a block",
  !has(r.blocks, "quote_recent") && rules.NOTEABLE_RULES.includes("quote_recent"));
a.sentAt = "2026-06-30T09:00:00.000Z";
check("an AFE does not age into the flag after it is sent — 28 days at sending is fine, whatever today is",
  !recent(rules.validate(a, ctx({ today: "2027-01-01" }))));
a.documents[0].quoteDate = "2026-02-01";
r = rules.validate(a, ctx());
check("and an old one is measured to the send date too", recent(r) && /was 149 days old when this was sent/.test(recent(r).message), JSON.stringify(recent(r)));
a.documents[0].quoteDate = null;
check("an undated quote on an AFE already sent asks nothing — nobody can answer it now", !recent(rules.validate(a, ctx())));
check("a date is a real calendar day", rules.isDay("2026-02-28") && !rules.isDay("2026-02-30") && !rules.isDay("28/02/2026") && !rules.isDay(""));

console.log("6e. a warning that names other AFEs carries them, so the screen can offer them");
{
  const v = rules.validate(larson(), ctx({ possibleDuplicates: [{ id: "afe-0007", title: "Claude Subscriptions for AI for everyone", state: "in_approval", totalUsd: 200000 }] }));
  const dup = v.warns.find((e) => e.rule === "duplicate_open_request");
  check("the duplicate warning lists the AFE it looks like — id, title and where it is",
    dup && dup.severity === "warn" && dup.data && dup.data.matches.length === 1 && dup.data.matches[0].id === "afe-0007" && dup.data.matches[0].state === "in_approval",
    JSON.stringify(dup));
  const fld = rules.FIELDS.find((f) => f.id === "project.buyVsLease");
  check("a question's message uses the words the screen asks it in", /reviewed with Procurement\?$/.test(fld.label), fld.label);
}

console.log("6d. a capital AFE with no financial case is a HINT, and decides nothing (KT walkthrough, 2026-10-15)");
a = larson();
r = rules.validate(a, ctx());
const hint = (v) => (v.hints || []).find((h) => h.id === "financial_case_missing");
check("no case on a capital AFE is said, with the way to start one",
  hint(r) && hint(r).step === 8 && hint(r).fix && hint(r).fix.step === 8, JSON.stringify(r.hints));
check("…and it is not a block, a warning, a fact to come, or an exception printed on the form",
  ![].concat(r.blocks, r.warns, r.pending).some((e) => /financial_case/.test(e.rule || "") || e.field === "financials")
    && !(r.exceptions || []).some((e) => /financial_case/.test(e.rule || "")), JSON.stringify(r.exceptions));
a.financials = { startYear: 2026, capexRows: [], opexRows: [], cloudRows: [], benefitRows: [], costCentreRows: [],
  assets: [{ description: "Fibre case", costUsd: 7914.97, lifeYears: 5, inServiceDate: "2026-10-24" }] };
check("a case with an asset in it says nothing", !hint(rules.validate(a, ctx())));
a.financials = null; a.sentAt = "2026-09-20T09:00:00.000Z";
check("an AFE already sent gains nothing, whatever it lacks", !hint(rules.validate(a, ctx())));
check("while nobody has set Q31's value, no rule REQUIRES a case", !rules.validate(Object.assign(larson(), { financials: null }), ctx()).blocks.some((e) => e.rule === "financial_case_required"));


// ---------------------------------------------------------------------------------------------
// 7. The browser's copy of the field check agrees with this one, sentence for sentence (R105).
//
// `public/js/core/fieldCheck.js` runs on every keystroke so a person is told about their own
// field without a round trip. It is a second EVALUATOR, never a second rule set — the rows it
// evaluates come from `fieldSpec()`. This is what stops the two from drifting: every field,
// every kind of wrong value, both implementations, identical text or the suite fails.
async function crossCheck() {
  console.log("7. the browser's field check says exactly what the server says");
  const client = await import("../public/js/core/fieldCheck.js");
  const spec = rules.fieldSpec();

  // Every predicate `required` must know how the browser asks its question, or the browser
  // silently stops asking it.
  const predicates = rules.FIELDS.filter((f) => typeof f.required === "function").map((f) => f.id);
  const unregistered = predicates.filter((id) => !rules.PREDICATE_REQUIRED[id]);
  check("every conditional field tells the browser which answer decides it",
    unregistered.length === 0, unregistered.join(", "));

  // Every field the wizard can type into is in the spec the browser receives.
  const typed = rules.FIELDS.filter((f) => !["derived", "list"].includes(f.type)).map((f) => f.id);
  const missing = typed.filter((id) => !spec.some((f) => f.id === id));
  check("every typed field reaches the browser", missing.length === 0, missing.join(", "));

  // A value of each kind per field: empty, something valid, and the ways it can be wrong.
  const samples = (f) => {
    const out = [null, "", undefined];
    if (f.type === "text") {
      out.push("x", "  ", "a".repeat((f.max || 30) + 5), "a".repeat(Math.max(1, (f.min || 5) - 1)), "abc-123", "12345", "999");
    } else if (f.type === "money" || f.type === "int") {
      out.push(0, -1, 1999, 2026, 4200.5, "4,200", "not a number", "12abc");
    } else if (f.type === "enum") {
      out.push.apply(out, (f.options || []).slice(0, 3));
      out.push("Maybe", "yes", 7);
    } else if (f.type === "date") {
      out.push("2026-09-20", "2026-13-45", "tomorrow");
    }
    return out;
  };

  let compared = 0;
  const disagreements = [];
  for (const f of rules.FIELDS) {
    const shipped = spec.find((x) => x.id === f.id);
    if (!shipped) continue;
    for (const applies of [{ surplusCheck: true }, { surplusCheck: false }]) {
      for (const value of samples(f)) {
        // The server evaluates the row it holds; the browser evaluates the JSON it was sent.
        const mine = rules.fieldProblem(shipped, value, applies, {});
        const theirs = client.fieldProblem(shipped, value, applies);
        compared += 1;
        const a = mine ? mine.message : null;
        const b = theirs ? theirs.message : null;
        if (a !== b) disagreements.push(f.id + " = " + JSON.stringify(value) + ": server " + JSON.stringify(a) + " vs browser " + JSON.stringify(b));
      }
    }
  }
  check("both evaluators agree on all " + compared + " values", disagreements.length === 0, disagreements.slice(0, 3).join(" | "));

  // And the whole-AFE path still routes through the same function.
  let a = larson(); a.project.title = "x".repeat(60);
  let r = rules.validate(a, ctx());
  const block = (r.blocks || []).find((e) => e.field === "project.title");
  const direct = client.fieldProblem(spec.find((x) => x.id === "project.title"), a.project.title, r.applies);
  check("a too-long title reads the same from validate() and from the browser",
    Boolean(block) && Boolean(direct) && block.message === direct.message,
    JSON.stringify([block && block.message, direct && direct.message]));

  // The conditional question is asked by both, or by neither, on the same AFE.
  a = larson(); a.project.projectType = "New Equipment"; a.project.surplusChecked = null;
  r = rules.validate(a, ctx());
  const surplus = spec.find((x) => x.id === "project.surplusChecked");
  check("the 925 surplus question applies on a tangible AFE, in the browser too",
    r.applies.surplusCheck === true && client.fieldProblem(surplus, null, r.applies) !== null);
  // "Other" stays tangible on purpose, so the type that does NOT ask is an intangible one.
  a.project.projectType = "Compliance";
  r = rules.validate(a, ctx());
  check("and is not asked when it does not apply",
    r.applies.surplusCheck === false && client.fieldProblem(surplus, null, r.applies) === null);

  // A pattern arrives as source + flags and still behaves like a RegExp.
  const cc = spec.find((x) => x.id === "costCenter");
  check("the cost-centre pattern survives the trip to the browser",
    client.fieldProblem(cc, "30145", {}) === null && client.fieldProblem(cc, "3O145", {}) !== null);

  // The spec is JSON — a RegExp or a function in it would not survive `res.json`.
  check("the shipped spec is plain JSON", JSON.parse(JSON.stringify(spec)).length === spec.length
    && !spec.some((f) => f.pattern instanceof RegExp || typeof f.required === "function"));
}

crossCheck().then(() => {
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}, (e) => { console.error(e); process.exit(1); });
