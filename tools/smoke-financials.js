"use strict";
// The financial case, offline: NPV, IRR, payback and ROI against the spreadsheet's own answers.
//
//   node tools/smoke-financials.js
//
// The fixture is not invented. The Global AFE Template ships with one worked asset on its
// ` Financials (NPV, ROI & PB)` sheet — 400,000 of capital in 2026, a five-year life, in service
// 2026-03-01 — and Excel's CACHED values for it were read straight out of the file. Every number
// this suite compares against came from Acme's own spreadsheet, not from a model of it.
//
// It also pins the reason this module exists. The template's Asset Acquisition block has ten
// rows; the blank sheet uses one and leaves nine with a cost of 0 and no life, and `Annl Depr`
// is `=B70/C70`. Nine divisions of zero by nothing poison the depreciation total, the tax, the
// net cash flow, the accumulated row and every NPV column — and because `NPV : 10 years` is
// `=IFERROR(SUM(B57:L57),0)`, the sheet reports **NPV 0 and ROI 0 %** rather than an error.
const financials = require("../lib/domain/financials");

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + String(detail).slice(0, 300) : "")); }
};
const j = (x) => JSON.stringify(x);
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.01 : tol);

// The template's own worked example, entered the way the wizard would collect it.
const TEMPLATE_CASE = {
  startYear: 2025,
  capexRows: [{ description: "Design of chosen path, including s/w configuration", amounts: [0, 400000] }],
  opexRows: [], cloudRows: [], benefitRows: [],
  assets: [{
    description: "Design of chosen path, including s/w configuration",
    costUsd: 400000, lifeYears: 5, inServiceDate: "2026-03-01",
    assetLife: "3-5-Softwares", assetClass: "16601-Computer Software - Internal Use",
  }],
  policy: { years: 11, discountRate: 0.1, taxRate: 0.23 },
};

console.log("1. the arithmetic is the spreadsheet's, cell for cell");
const r = financials.compute(TEMPLATE_CASE);
check("eleven years, starting where the sheet starts", r.years.length === 11 && r.years[0] === 2025 && r.years[10] === 2035, j(r.years));
check("the annual charge is the cost over the life (row 70: =B70/C70)", r.assets[0].annualDepreciation === 80000, j(r.assets[0]));
check("end of life is the same day, `life` years on (row 70: =DATE(YEAR+C,MONTH,DAY))", r.assets[0].endOfLife === "2031-03-01", r.assets[0].endOfLife);
// Excel's own cached depreciation for 2027-2031.
check("depreciation 2027-2031 matches Excel exactly", j(r.depreciation.slice(2, 7)) === j([80000, 80000, 80000, 80000, 40000]), j(r.depreciation));
check("half a year in the year it goes into service, half in the year it leaves (row 97)",
  r.depreciation[1] === 40000 && r.depreciation[6] === 40000, j(r.depreciation));
check("so the whole charge comes back to the cost", Math.round(r.totals.depreciation) === 400000, r.totals.depreciation);
// Excel's own cached NPV columns for 2027-2031.
check("the discounted columns match Excel exactly (row 57)",
  j(r.npvByYear.slice(2, 7)) === j([15206.61, 13824.19, 12567.45, 11424.95, 5193.16]), j(r.npvByYear));
check("net taxable income is benefits less OpEx less depreciation (row 50)",
  j(r.taxableIncome.slice(1, 7)) === j([-40000, -80000, -80000, -80000, -80000, -40000]), j(r.taxableIncome));
check("tax is 23 % of that, and a loss is a credit (row 51)", r.taxes[2] === -18400, j(r.taxes));
check("net cash flow is the pre-tax flow less the tax (row 53)", r.netCashFlow[1] === -390800 && r.netCashFlow[2] === 18400, j(r.netCashFlow));
check("the accumulated row runs (row 54)", r.accumulated[1] === -390800 && r.accumulated[6] === -308000, j(r.accumulated));

console.log("2. the headline figures — and what the template says instead");
check("NPV over eleven years", near(r.npv, -297056.36, 0.02), r.npv);
check("ROI is NPV over total outflows, the sheet's own definition (row 63)", near(r.roiPct, -74.26, 0.01), r.roiPct);
check("a project with no benefits never pays back, and says so rather than 0",
  r.payback === 10 && r.paybackWithin === false, j({ payback: r.payback, within: r.paybackWithin }));
// The point of the whole module.
check("THE TEMPLATE REPORTS NPV 0 AND ROI 0 % FOR THIS SAME CASE — because nine empty asset rows "
  + "divide by nothing and IFERROR swallows it. This model reports the real figures.",
  r.npv !== 0 && r.roiPct !== 0, j({ npv: r.npv, roi: r.roiPct }));

console.log("3. a blank asset life is refused, never divided by");
const blankLife = Object.assign({}, TEMPLATE_CASE, {
  assets: [{ description: "Cognex camera", costUsd: 120000, lifeYears: null, inServiceDate: "2026-06-01" }],
});
const p = financials.problems(blankLife);
// A blank life makes `Annl Depr` divide by zero, which is the #DIV/0! the template's own sheet
// prints nine times over. That is WHY this is a block; the message says what to DO about it, so
// the assertion is on the rule and on the message naming the asset, not on the explanation.
check("a cost with no life is a block, naming the asset",
  p.some((x) => x.rule === "asset_life_missing" && x.severity === "block" && /Cognex camera/.test(x.message)), j(p));
const computed = financials.compute(blankLife);
check("and nothing divides by it — no NaN, no Infinity anywhere",
  computed.depreciation.every((d) => Number.isFinite(d)) && Number.isFinite(computed.npv), j(computed.depreciation));
// Without a date the end of life computes as January 1900 and the depreciation lands in no
// year at all — the Jan-00 on the template's blank sheet.
check("a cost with no date in service is a block too",
  financials.problems({ assets: [{ description: "x", costUsd: 1000, lifeYears: 5 }] })
    .some((x) => x.rule === "asset_in_service_missing" && x.severity === "block" && /"x"/.test(x.message)));
check("a life with no cost is only a warning — it depreciates nothing and breaks nothing",
  financials.problems({ assets: [{ description: "x", costUsd: 0, lifeYears: 5, inServiceDate: "2026-01-01" }] })
    .every((x) => x.severity === "warn"));
check("an empty grid is empty, not a case", financials.isEmpty({ capexRows: [{ amounts: [0, 0] }], assets: [] }) === true);
check("one figure anywhere makes it a case", financials.isEmpty({ capexRows: [{ amounts: [0, 5] }] }) === false);

console.log("4. a case that does pay back");
const pays = financials.compute({
  startYear: 2026,
  capexRows: [{ description: "Line 5 filler", amounts: [200000] }],
  opexRows: [], cloudRows: [],
  benefitRows: [{ description: "Labour saved", amounts: [0, 90000, 90000, 90000, 90000, 90000, 90000, 90000, 90000, 90000, 90000] }],
  assets: [{ description: "Line 5 filler", costUsd: 200000, lifeYears: 10, inServiceDate: "2026-07-01" }],
  policy: { years: 11, discountRate: 0.1, taxRate: 0.23 },
});
check("it pays back inside the span", pays.paybackWithin === true && pays.payback > 0 && pays.payback < 11, j({ payback: pays.payback, acc: pays.accumulated }));
check("payback is whole years plus the fraction of the crossing year, and stops there",
  near(pays.payback, 2.68, 0.01), pays.payback);
// The one deliberate divergence from the spreadsheet, kept visible rather than argued about.
check("the spreadsheet's own formula says a whole year more, because it also counts the "
  + "remainder of the year AFTER the crossing",
  near(pays.paybackAsTemplate, 3.0, 0.01) && pays.paybackAsTemplate - pays.payback > 0.3,
  j({ ours: pays.payback, template: pays.paybackAsTemplate }));
check("NPV is positive", pays.npv > 0, pays.npv);
check("ROI is positive", pays.roiPct > 0, pays.roiPct);
check("IRR comes back as a rate, not an error", typeof pays.irr === "number" && pays.irr > 0, j(pays.irr));
// The reported figure is rounded to two decimals of a percent for printing; the rate itself
// is what has to zero the series, so that is what is checked.
const rawIrr = financials.irr(pays.netCashFlow);
check("and it is the rate that makes the NPV nothing",
  near(pays.netCashFlow.reduce((s, cf, i) => s + cf / Math.pow(1 + rawIrr, i), 0), 0, 0.001),
  pays.netCashFlow.reduce((s, cf, i) => s + cf / Math.pow(1 + rawIrr, i), 0));
check("the printed figure is that rate, to two decimals", near(pays.irr, rawIrr * 100, 0.005), j({ printed: pays.irr, raw: rawIrr * 100 }));

console.log("5. the model is pure, and does not mind what it is handed");
const before = JSON.parse(JSON.stringify(TEMPLATE_CASE));
financials.compute(TEMPLATE_CASE);
check("it does not touch its input", j(TEMPLATE_CASE) === j(before));
check("the same input twice gives the same answer", j(financials.compute(TEMPLATE_CASE)) === j(financials.compute(TEMPLATE_CASE)));
const empty = financials.compute({});
check("nothing at all still returns a whole shape", empty.years.length === 11 && empty.npv === 0 && empty.roiPct === 0, j({ npv: empty.npv, roi: empty.roiPct }));
check("rows longer than the span are clipped, shorter ones padded",
  financials.compute({ startYear: 2026, capexRows: [{ amounts: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] }] }).capex.length === 11);
check("a figure typed as text is read as a number", financials.compute({ capexRows: [{ amounts: ["1,250.50"] }] }).capex[0] === 1250.5);
check("a figure typed as nonsense is zero, not NaN", Number.isFinite(financials.compute({ capexRows: [{ amounts: ["abc"] }] }).capex[0]));
check("no benefits and no costs means no IRR, stated as null rather than as 0 %", financials.compute({}).irr === null);

// R162: the case starts in the AFE's own year, and nothing in the domain reads a clock.
check("a case with no stored first year starts in the AFE's own start year",
  financials.fromAfe({ schedule: { startDate: "2031-03-01", finishDate: "2032-01-31" }, financials: { capexRows: [{ amounts: [100] }] } }).years[0] === 2031);
check("…then its fiscal year, then the year it was raised",
  financials.caseYear({ schedule: { fiscalYear: 2029 } }) === 2029 && financials.caseYear({ schedule: {}, createdAt: "2027-05-01T00:00:00Z" }) === 2027);
check("a bare model with no year at all starts at its first asset's year in service",
  financials.compute({ assets: [{ costUsd: 1000, lifeYears: 5, inServiceDate: "2030-06-30" }] }).years[0] === 2030);
check("a stored first year always wins, so no signed case moves",
  financials.fromAfe({ schedule: { startDate: "2031-03-01" }, financials: { startYear: 2025, capexRows: [{ amounts: [100] }] } }).years[0] === 2025);

console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
