"use strict";
// The financial case: NPV, IRR, payback and ROI, computed the way Acme's own spreadsheet
// computes them (R94, R97).
//
// This is not a plausible financial model — it is THE model, lifted formula for formula from
// the ` Financials (NPV, ROI & PB)` sheet of the Global AFE Template so the figures a person
// sees here are the figures they would have got in Excel. Its arithmetic, in the sheet's own
// order and with the sheet's own row numbers named so the two can be compared:
//
//   row 16/29/35  total CapEx, OpEx and Cloud CapEx per year
//   row 37        TOTAL CASH OUTFLOWS = CapEx + OpEx + Cloud
//   row 46        recurring costs and benefits
//   row 48        net cash flow before taxes   = benefits − outflows
//   row 97-106    depreciation per asset per year, half-year convention (below)
//   row 107       total depreciation
//   row 50        net taxable income           = benefits − OpEx − depreciation
//   row 51        income taxes                 = taxable × 23 %
//   row 53        NET CASH FLOW                = net before taxes − taxes
//   row 54        accumulated net cash flow
//   row 57        NPV per year                 = net cash flow / (1 + r)^i, i from 0
//   row 62        NPV, 10 years                = the sum of those
//   row 63        ROI %                        = NPV / total outflows
//   row 58-59     payback in years (see `payback` below — the sheet's own trick)
//   row 60-61     IRR over the whole series
//
// THE TEMPLATE AS SHIPPED CANNOT PRODUCE AN ANSWER, and that is why this module exists rather
// than a nicer-looking one. Its Asset Acquisition block has ten rows; the blank sheet fills the
// first and leaves nine with a cost of 0 and no life, and `Annl Depr` is `=B70/C70`. Nine
// divisions of zero by nothing give nine `#DIV/0!`, which poison the depreciation total, the
// taxable income, the tax, the net cash flow, the accumulated row, every NPV column and the
// payback fraction. `NPV : 10 years` is `=IFERROR(SUM(B57:L57),0)` and `ROI %` is
// `=IFERROR(B62/…,0)`, so the sheet does not show an error — **it reports NPV 0 and ROI 0 %**.
// Checked against the blank template on 2026-09-21: every headline figure reads zero.
//
// So: an asset with a cost and no life is REFUSED at entry rather than divided by nothing
// (R97), and an asset with no cost is not a row at all. `#DIV/0!` and `Jan-00` cannot be
// printed by this code, because neither is ever computed.
//
// Pure, like the rest of `lib/domain`: plain objects in, plain objects out, no clock.

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/** The template's year header: a start year, then +1 across the sheet (row 2). */
function years(startYear, count) {
  const out = [];
  for (let i = 0; i < count; i++) out.push(startYear + i);
  return out;
}

/** One row's amounts, padded or clipped to the number of years the policy prints. */
function amounts(row, count) {
  const a = (row && row.amounts) || [];
  const out = [];
  for (let i = 0; i < count; i++) out.push(num(a[i]));
  return out;
}

/** Add up a list of rows column by column (rows 16, 29, 35, 46). */
function totalRows(rows, count) {
  const out = new Array(count).fill(0);
  for (const row of rows || []) {
    const a = amounts(row, count);
    for (let i = 0; i < count; i++) out[i] += a[i];
  }
  return out;
}

/**
 * When an asset stops being depreciated: the same month and day, `lifeYears` later. The sheet
 * says `=DATE(YEAR(D70)+C70, MONTH(D70), DAY(D70))`, and when D70 is blank that is year 1900,
 * which is where the `Jan-00` down the EOL column of a real signed AFE comes from.
 */
function endOfLife(inServiceDate, lifeYears) {
  const d = new Date(inServiceDate + "T00:00:00Z");
  if (Number.isNaN(d.getTime())) return null;
  const out = new Date(Date.UTC(d.getUTCFullYear() + lifeYears, d.getUTCMonth(), d.getUTCDate()));
  return out.toISOString().slice(0, 10);
}

/**
 * One asset's depreciation across the years — the template's half-year convention (row 97):
 *
 *   IF(year = YEAR(inService) OR year = YEAR(EOL))  →  annual / 2
 *   IF(year < YEAR(inService) OR year > YEAR(EOL))  →  0
 *   otherwise                                        →  annual
 *
 * So the year it goes in and the year it comes out each carry half a year's charge, which is
 * how the total comes back to the asset's cost.
 */
function depreciationFor(asset, yearList) {
  const cost = num(asset.costUsd);
  const life = num(asset.lifeYears);
  if (!(life > 0)) return yearList.map(() => 0);        // refused at entry; never divided here
  const annual = cost / life;
  const inService = String(asset.inServiceDate || "").slice(0, 10);
  const eol = endOfLife(inService, life);
  if (!inService || !eol) return yearList.map(() => 0);
  const startY = Number(inService.slice(0, 4));
  const endY = Number(eol.slice(0, 4));
  return yearList.map((y) => {
    if (y === startY || y === endY) return annual * 0.5;
    if (y < startY || y > endY) return 0;
    return annual;
  });
}

/**
 * Payback in years: the whole years still under water, plus the fraction of the year it crosses.
 *
 * THIS DIVERGES FROM THE SPREADSHEET BY DESIGN, and it is the one place in this module that
 * does. The sheet computes, for every year after the first,
 *
 *     row 58:  IF(accumulated < 0, 0, ABS(previous accumulated / this year's cash flow))
 *     row 59:  COUNTIF(row 58, 0) + SUMIFS(row 58, ">0", "<1")
 *
 * — whole years under water, plus every fraction between 0 and 1. The intent is plain and it is
 * what this function does. But the year AFTER the crossing also produces a fraction under 1,
 * and it is exactly the remainder of the crossing year's: if the crossing year contributes
 * `|acc[n-1]| / cf[n]`, the next contributes `acc[n] / cf[n+1]`, and when the cash flow is level
 * those two sum to exactly 1. So the sheet adds a whole extra year.
 *
 * Worked, from the Line 5 filler case in `smoke-financials`: accumulated crosses at index 3 with
 * 0.675 of that year needed, and index 4 contributes 0.325. The sheet reports 3.0 years. The
 * project actually pays back in 2.7. A payback overstated by a year makes an investment look
 * worse than it is, which is the wrong direction for a number people compare projects on.
 *
 * `paybackAsTemplate` below reproduces the sheet's literal answer so the difference can always
 * be shown rather than argued about. Raised for Jarrod and Judithmelanie: this changes a figure that
 * appears on the form.
 */
function payback(accumulated, netCashFlow) {
  let whole = 0;
  for (let i = 1; i < accumulated.length; i++) {
    if (accumulated[i] < 0) { whole += 1; continue; }
    const cf = netCashFlow[i];
    const f = cf ? Math.abs(accumulated[i - 1] / cf) : 0;
    return round2(whole + (f > 0 && f < 1 ? f : 0));      // the first crossing, and stop
  }
  return round2(whole);                                    // never crossed: the whole span
}

/** What the spreadsheet itself would print (rows 58-59), so the divergence above is showable. */
function paybackAsTemplate(accumulated, netCashFlow) {
  let whole = 0;
  let fraction = 0;
  for (let i = 1; i < accumulated.length; i++) {
    if (accumulated[i] < 0) { whole += 1; continue; }
    const cf = netCashFlow[i];
    if (!cf) continue;
    const f = Math.abs(accumulated[i - 1] / cf);
    if (f > 0 && f < 1) fraction += f;
  }
  return round2(whole + fraction);
}

/**
 * IRR by bisection rather than Excel's Newton iteration.
 *
 * Excel's `IRR(values, 0.12)` walks from a guess and gives up after twenty steps with #NUM!;
 * bisection over a bracketed range always converges or says plainly that it cannot. `null`
 * means there is no rate that makes this series worth nothing — which is the honest answer for
 * a project with no benefits in it, and the sheet's own `IFERROR(…, 0)` reports that as 0 %.
 */
function irr(flows) {
  const npvAt = (rate) => flows.reduce((sum, cf, i) => sum + cf / Math.pow(1 + rate, i), 0);
  const hasSignChange = flows.some((f) => f > 0) && flows.some((f) => f < 0);
  if (!hasSignChange) return null;
  let lo = -0.9999;
  let hi = 10;
  let flo = npvAt(lo);
  let fhi = npvAt(hi);
  if (flo * fhi > 0) return null;                        // not bracketed: no rate in range
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const f = npvAt(mid);
    if (Math.abs(f) < 1e-7) return mid;
    if (flo * f <= 0) { hi = mid; fhi = f; } else { lo = mid; flo = f; }
  }
  return (lo + hi) / 2;
}

/**
 * The whole case.
 *
 * @param {object} input
 *   startYear     the first column (the template's B2)
 *   capexRows     [{ description, amounts: [] }]
 *   opexRows      the same
 *   cloudRows     the same
 *   benefitRows   recurring costs and benefits, positive for a benefit
 *   assets        [{ description, costUsd, lifeYears, inServiceDate, assetClass, assetLife }]
 *   policy        { years, discountRate, taxRate } — refData.FINANCIALS
 * @returns everything the two printed pages and the wizard summary need.
 */
function compute(input) {
  const i = input || {};
  const policy = i.policy || { years: 11, discountRate: 0.1, taxRate: 0.23 };
  const count = policy.years || 11;
  const rate = policy.discountRate === undefined ? 0.1 : policy.discountRate;
  const tax = policy.taxRate === undefined ? 0.23 : policy.taxRate;
  // No clock (R162): the domain is pure, and a case's first year is the AFE's own. `fromAfe`
  // always supplies one; a bare call without it starts at the first asset's year in service.
  const startYear = Number(i.startYear) || firstServiceYear(i.assets) || 0;
  const yearList = years(startYear, count);

  const capex = totalRows(i.capexRows, count);
  const opex = totalRows(i.opexRows, count);
  const cloud = totalRows(i.cloudRows, count);
  const benefits = totalRows(i.benefitRows, count);
  const outflows = yearList.map((_, n) => capex[n] + opex[n] + cloud[n]);

  // Only assets that can actually be depreciated. One with a cost and no life is refused by
  // `problems()` before it gets here; one with neither is simply not an asset.
  const assets = (i.assets || []).filter((a) => a && (num(a.costUsd) > 0 || num(a.lifeYears) > 0));
  const perAsset = assets.map((a) => ({
    description: a.description || "",
    costUsd: num(a.costUsd),
    lifeYears: num(a.lifeYears) || null,
    inServiceDate: String(a.inServiceDate || "").slice(0, 10) || null,
    endOfLife: num(a.lifeYears) > 0 ? endOfLife(String(a.inServiceDate || "").slice(0, 10), num(a.lifeYears)) : null,
    annualDepreciation: num(a.lifeYears) > 0 ? round2(num(a.costUsd) / num(a.lifeYears)) : null,
    assetClass: a.assetClass || null,
    assetLife: a.assetLife || null,
    byYear: depreciationFor(a, yearList).map(round2),
  }));
  const depreciation = yearList.map((_, n) => perAsset.reduce((s, a) => s + a.byYear[n], 0));

  const netBeforeTax = yearList.map((_, n) => benefits[n] - outflows[n]);
  const taxableIncome = yearList.map((_, n) => benefits[n] - opex[n] - depreciation[n]);
  const taxes = taxableIncome.map((t) => t * tax);
  const netCashFlow = yearList.map((_, n) => netBeforeTax[n] - taxes[n]);

  const accumulated = [];
  for (let n = 0; n < count; n++) accumulated.push((n ? accumulated[n - 1] : 0) + netCashFlow[n]);

  const npvByYear = netCashFlow.map((cf, n) => cf / Math.pow(1 + rate, n));
  const npv = npvByYear.reduce((a, b) => a + b, 0);
  const totalOutflows = outflows.reduce((a, b) => a + b, 0);

  return {
    years: yearList,
    policy: { years: count, discountRate: rate, taxRate: tax },
    capex: capex.map(round2),
    opex: opex.map(round2),
    cloud: cloud.map(round2),
    outflows: outflows.map(round2),
    benefits: benefits.map(round2),
    assets: perAsset,
    depreciation: depreciation.map(round2),
    netBeforeTax: netBeforeTax.map(round2),
    taxableIncome: taxableIncome.map(round2),
    taxes: taxes.map(round2),
    netCashFlow: netCashFlow.map(round2),
    accumulated: accumulated.map(round2),
    npvByYear: npvByYear.map(round2),
    totals: {
      capex: round2(capex.reduce((a, b) => a + b, 0)),
      opex: round2(opex.reduce((a, b) => a + b, 0)),
      cloud: round2(cloud.reduce((a, b) => a + b, 0)),
      outflows: round2(totalOutflows),
      benefits: round2(benefits.reduce((a, b) => a + b, 0)),
      depreciation: round2(depreciation.reduce((a, b) => a + b, 0)),
    },
    npv: round2(npv),
    // ROI is NPV over what went out, which is the sheet's own definition and is NOT the ratio
    // most people mean by ROI. It is labelled the way the form labels it.
    roiPct: totalOutflows ? round2((npv / totalOutflows) * 100) : 0,
    payback: payback(accumulated, netCashFlow),
    paybackAsTemplate: paybackAsTemplate(accumulated, netCashFlow),
    paybackWithin: accumulated[count - 1] >= 0,
    irr: (() => { const r = irr(netCashFlow); return r === null ? null : round2(r * 100); })(),
  };
}

/**
 * What is wrong with the case as entered — the same shape as `afeRules`' field problems, so the
 * wizard can print them the way it prints everything else.
 *
 * The one that matters is `asset_life_missing`. A cost with no life is what puts `#DIV/0!` down
 * the Annl Depr column and `Jan-00` down the EOL column of a real, fully signed AFE, and it is
 * refused here rather than printed.
 */
function problems(financials) {
  const f = financials || {};
  const out = [];
  const assets = f.assets || [];
  assets.forEach((a, n) => {
    const cost = num(a.costUsd);
    const life = num(a.lifeYears);
    const where = a.description ? `"${a.description}"` : `asset ${n + 1}`;
    if (cost > 0 && !(life > 0)) {
      out.push({ field: `financials.assets.${n}.lifeYears`, rule: "asset_life_missing", severity: "block",
        message: `Pick an asset life for ${where}. Depreciation is the cost divided by it.` });
    }
    if (cost > 0 && !a.inServiceDate) {
      out.push({ field: `financials.assets.${n}.inServiceDate`, rule: "asset_in_service_missing", severity: "block",
        message: `Set a date in service for ${where}. It decides which years the depreciation falls in.` });
    }
    if (life > 0 && cost <= 0) {
      out.push({ field: `financials.assets.${n}.costUsd`, rule: "asset_cost_missing", severity: "warn",
        message: `${where} has a life but no cost, so it depreciates nothing.` });
    }
  });
  return out;
}

/** Is there anything in this case at all? An empty grid is not a case, it is an empty grid. */
function isEmpty(financials) {
  const f = financials || {};
  const any = (rows) => (rows || []).some((r) => (r.amounts || []).some((a) => num(a) !== 0));
  return !any(f.capexRows) && !any(f.opexRows) && !any(f.cloudRows) && !any(f.benefitRows)
    && !(f.assets || []).some((a) => num(a.costUsd) > 0);
}

/**
 * The case for one AFE, or null when there is nothing in it: an empty grid is not a case with
 * zeroes in it.
 *
 * The ONE mapping from the grid the AFE stores to `compute`'s input. The screen, the printed pages
 * and the resubmission check (R148) all read it, and they must agree: an NPV that is computed
 * three ways is three chances for the figure on the form to differ from the figure an approver
 * decided on. The policy is passed in so this module stays free of anything but arithmetic.
 */
/** The year of an ISO date, or null. */
const yearOf = (d) => { const y = Number(String(d || "").slice(0, 4)); return y > 1900 ? y : null; };
function firstServiceYear(assets) {
  for (const a of assets || []) { const y = yearOf(a && a.inServiceDate); if (y) return y; }
  return null;
}

/**
 * The year an AFE's case starts in when none was stored (R162): the AFE's own start date, then its
 * fiscal year, its finish date and the day it was raised. Signed AFE 313453 runs 2026 … 2036 with
 * the capital in the first column. Every value is ON the AFE — nothing reads a clock.
 */
function caseYear(afe) {
  const s = (afe && afe.schedule) || {};
  return yearOf(s.startDate) || Number(s.fiscalYear) || yearOf(s.finishDate) || yearOf(afe && afe.createdAt) || null;
}

function fromAfe(afe, policy) {
  const f = (afe && afe.financials) || null;
  if (!f || isEmpty(f)) return null;
  return compute({
    startYear: f.startYear || caseYear(afe),
    capexRows: f.capexRows, opexRows: f.opexRows, cloudRows: f.cloudRows,
    benefitRows: f.benefitRows, assets: f.assets,
    policy,
  });
}

module.exports = { compute, fromAfe, caseYear, problems, isEmpty, endOfLife, payback, paybackAsTemplate, irr, depreciationFor };
