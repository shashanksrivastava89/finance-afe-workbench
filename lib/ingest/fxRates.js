"use strict";
// Global Finance's monthly FX workbook, read the way it arrives (R161).
//
// The rates are Global Finance's, never typed. Their file on the Global Finance site ("Monthly FX
// Rates/2026", `8fx2026.xlsm`) carries every currency's month-end rate to the US dollar TWICE — as
// RATE and as REVERSE — for the current month and the one before, under a title that names the
// month ("For The Month of August 2026"). This reads that layout as it stands, so the Fixed Assets
// team uploads the file they already receive rather than retyping it into a template of ours.
//
// WHICH WAY A RATE RUNS IS DECIDED FROM THE NUMBERS, NOT ASSUMED. The same box on two signed AFEs
// runs opposite ways: the V7 form of AFE 313453 prints 1.286505 (Singapore dollars per US dollar —
// $20,020 is SGD 25,756), the older Rev 6 form of AFE 313398 prints 0.01113 (US dollars per rupee).
// A currency whose unit is worth far less than a dollar — the rupee, the yen, the won — is more
// than 1 per US dollar in any month, so whichever of the two columns carries more than 1 for them
// is "local per USD". Where none of them is on the sheet, the column that is above 1 for most
// currencies decides, because most currencies are worth less than a dollar. The result says which
// rule decided and on what figure, so the person importing sees it before anything is saved.
//
// Pure: sheets in (`lib/xlsx/workbook.read`'s shape), plain objects out.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Currencies worth far less than a US dollar in any month on record: always above 1 per USD. */
const WEAK = ["INR", "JPY", "KRW", "IDR", "VND", "CNY", "PHP", "THB", "TWD", "HKD", "MYR", "SGD", "MXN", "BRL", "ZAR", "SEK", "NOK", "DKK", "RUB", "TRY"];

const cell = (v) => String(v === null || v === undefined ? "" : v).trim();
const num = (v) => {
  const s = cell(v).replace(/[,\s]/g, "");
  if (!s || !/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** "For The Month of August 2026" (or any "<Month> <YYYY>") -> "2026-08". */
function monthIn(text) {
  const m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b[\s,-]*(\d{4})\b/i.exec(cell(text));
  if (!m) return null;
  return `${m[2]}-${String(MONTHS.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0")}`;
}

/** "2026-08" -> "August 2026". */
function monthLabel(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(cell(month));
  if (!m) return cell(month);
  const name = MONTHS[Number(m[2]) - 1] || "";
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${m[1]}`;
}

/** "(August)", "August", "Aug" — a month named without its year -> 1..12, or null. */
function bareMonth(text) {
  const t = cell(text).replace(/[()[\].]/g, "").trim().toLowerCase();
  if (!/^[a-z]+$/.test(t) || t.length < 3) return null;
  const i = MONTHS.findIndex((m) => m === t || (t.length >= 3 && m.startsWith(t)));
  return i >= 0 ? i + 1 : null;
}

/**
 * The header row, and every RATE / REVERSE pair on it — the current month's and the one before.
 *
 * A pair is labelled by what the sheet writes above it, within three rows: a "<Month> <YYYY>";
 * a month on its own — Global Finance's own file writes "(August)" over the current pair and
 * "(July)" over the prior one, with the year only in the title; or "CURRENT MONTH-END" /
 * "PRIOR MONTH-END" over each. A bare month is placed in a year once the title's month is known.
 */
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 40); r += 1) {
    const cells = (rows[r] || []).map((c) => cell(c).toLowerCase());
    const pairs = [];
    cells.forEach((c, i) => {
      if (c !== "rate") return;
      const rev = cells.findIndex((x, j) => j > i && x === "reverse");
      if (rev >= 0 && !pairs.some((p) => p.reverse === rev)) pairs.push({ rate: i, reverse: rev });
    });
    if (!pairs.length) continue;
    for (const p of pairs) {
      for (let up = r - 1; up >= Math.max(0, r - 3); up -= 1) {
        for (const c of [p.rate, p.reverse, p.rate - 1]) {
          const v = c >= 0 ? (rows[up] || [])[c] : null;
          if (!p.month && monthIn(v)) p.month = monthIn(v);
          else if (!p.month && !p.bare && bareMonth(v)) p.bare = bareMonth(v);
          if (/\bcurrent\b/i.test(cell(v))) p.current = true;
          if (/\b(prior|previous|last)\b/i.test(cell(v))) p.prior = true;
        }
      }
    }
    return { row: r, pairs };
  }
  return null;
}

/** Decimal places a figure was written to, from its shortest form: 0.00004 has five. */
function decimals(n) {
  const s = String(n);
  const e = /e-(\d+)$/i.exec(s);
  const frac = (s.split(/e/i)[0].split(".")[1] || "").length;
  return e ? Number(e[1]) + frac : frac;
}

/**
 * Do a RATE and a REVERSE describe one rate? Their product is 1 — to within what rounding each
 * figure to the places it was written to can move it. Global Finance round the small side of a
 * weak currency (a dong is 0.00004 of a dollar), which is 1.6 % off exactly, and that is rounding,
 * not a mistake; 1.29 against 0.5 is a mistake at any precision.
 */
function sameRate(rate, reverse) {
  const slack = rate * 0.5 * 10 ** -decimals(reverse) + reverse * 0.5 * 10 ** -decimals(rate);
  return Math.abs(rate * reverse - 1) <= Math.max(0.01, slack * 1.01);
}

/** One currency listed for several countries is one rate, and the list says so. */
function namesText(names) {
  const list = names.filter(Boolean);
  return list.length > 3 ? `${list.slice(0, 3).join(", ")} and ${list.length - 3} more` : list.join(", ");
}

/**
 * @param {Array<{name, rows}>} sheets
 * @returns {{ month, sheet, rows: [{code, name, localPerUsd, usdPerLocal}], direction, decidedBy, problems: [] }}
 * @throws Error with `.status = 422` when the workbook is not Global Finance's layout
 */
function fromWorkbook(sheets) {
  const fail = (message) => Object.assign(new Error(message), { status: 422 });
  let found = null;
  for (const s of sheets || []) {
    const h = findHeader(s.rows || []);
    if (h) { found = { sheet: s, h }; break; }
  }
  if (!found) throw fail("This is not Global Finance's FX workbook: no sheet has a RATE and a REVERSE column.");
  const { sheet } = found;
  const rows = sheet.rows;

  // The month: the title above the header, the first "<Month> <YYYY>" found there.
  let month = null;
  for (let r = 0; r <= found.h.row && !month; r += 1) for (const c of rows[r] || []) { month = monthIn(c); if (month) break; }
  if (!month) throw fail("The workbook does not say which month its rates are for — the title should read like \"For The Month of August 2026\".");
  // A month named without its year belongs to the title's year, or the year before when it comes
  // later in the calendar: a January sheet's prior pair is "(December)", of the year before.
  const [ty, tm] = month.split("-").map(Number);
  for (const p of found.h.pairs) {
    if (!p.month && p.bare) p.month = `${p.bare <= tm ? ty : ty - 1}-${String(p.bare).padStart(2, "0")}`;
  }
  // The current month's pair: the one labelled with the title's month, else the one the sheet
  // calls current, else the first.
  const pairs = found.h.pairs;
  const pair = pairs.find((p) => p.month === month) || pairs.find((p) => p.current && !p.prior) || pairs[0];
  const h = { row: found.h.row, rate: pair.rate, reverse: pair.reverse };
  const pairNote = pairs.length > 1
    ? (pair.month === month ? `the ${monthLabel(month)} columns, of ${pairs.length} on the sheet`
      : pair.current ? `the CURRENT MONTH-END columns, of ${pairs.length} on the sheet`
        : `the first of ${pairs.length} RATE / REVERSE pairs, as none is labelled with a month`)
    : null;

  // The code is the column that holds three-letter codes, the name the text column beside it.
  const body = rows.slice(h.row + 1);
  const width = Math.max(...body.map((r) => (r || []).length), 0);
  const figures = new Set(found.h.pairs.flatMap((p) => [p.rate, p.reverse]));
  let codeCol = -1, best = 0;
  for (let c = 0; c < width; c += 1) {
    if (figures.has(c)) continue;
    const hits = body.filter((r) => /^[A-Z]{3}$/.test(cell((r || [])[c]))).length;
    if (hits > best) { best = hits; codeCol = c; }
  }
  if (codeCol < 0) throw fail("No column of three-letter currency codes was found under the RATE / REVERSE header.");
  let nameCol = -1, bestName = 0;
  for (const c of [codeCol + 1, codeCol - 1, codeCol + 2]) {
    if (c < 0 || figures.has(c)) continue;
    const hits = body.filter((r) => cell((r || [])[c]) && num((r || [])[c]) === null).length;
    if (hits > bestName) { bestName = hits; nameCol = c; }
  }

  // Global Finance list the rates BY COUNTRY: the euro appears once for every country that uses
  // it, the dollar for every dollar country. Refusing a code seen twice refused their whole file.
  // A code listed again at the same rate is the same rate, and the countries are kept as its name;
  // listed again at a DIFFERENT rate is a contradiction, and that is refused, naming both rows.
  //
  // A row with no figure for this month — a country they list and do not price — is left out and
  // said so, rather than refusing every other currency on the sheet: the currency is simply not
  // offered until a month that prices it. Only a figure that is there and wrong stops the import.
  const problems = [];
  const skipped = [];
  const read = [];
  const byCode = new Map();
  body.forEach((r, i) => {
    const code = cell((r || [])[codeCol]).toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return;
    const rate = num((r || [])[h.rate]), reverse = num((r || [])[h.reverse]);
    const line = h.row + 2 + i;                                  // the sheet's own row number
    const name = nameCol >= 0 ? cell((r || [])[nameCol]) : "";
    const has = (n) => n !== null && n !== 0;
    if (!has(rate) && !has(reverse)) { skipped.push({ line, code, name, reason: "no rate for this month" }); return; }
    if (!has(rate) || !has(reverse)) { skipped.push({ line, code, name, reason: `a ${has(rate) ? "RATE" : "REVERSE"} and no ${has(rate) ? "REVERSE" : "RATE"}` }); return; }
    if (!(rate > 0) || !(reverse > 0)) { problems.push({ line, code, problem: "RATE and REVERSE must both be numbers above zero" }); return; }
    // Two views of one rate: their product is 1. A row where it is not was mistyped somewhere.
    if (!sameRate(rate, reverse)) { problems.push({ line, code, problem: `RATE ${rate} and REVERSE ${reverse} do not describe the same rate` }); return; }
    const first = byCode.get(code);
    if (first) {
      const close = (a, b) => Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-6;
      if (close(first.rate, rate) && close(first.reverse, reverse)) { first.names.push(name); return; }
      problems.push({ line, code, problem: `${code} is ${rate} here${name ? ` (${name})` : ""} and ${first.rate} on row ${first.line}${first.names[0] ? ` (${first.names[0]})` : ""}` });
      return;
    }
    const row = { line, code, names: [name], rate, reverse };
    byCode.set(code, row);
    read.push(row);
  });
  if (!read.length) throw fail("No currency rows were found under the RATE / REVERSE header.");

  // Which column is local-per-USD, decided from the figures (see the header comment).
  const weak = read.filter((x) => WEAK.includes(x.code) && Math.abs(Math.log10(x.rate)) > 0.05);
  let direction, decidedBy;
  if (weak.length) {
    const up = weak.filter((x) => x.rate > 1).length;
    direction = up * 2 >= weak.length ? "rate" : "reverse";
    const e = weak.find((x) => x.code === "INR") || weak[0];
    const local = direction === "rate" ? e.rate : e.reverse;
    decidedBy = `${e.code} is worth less than a dollar, and it is ${local} per USD in the ${direction.toUpperCase()} column`;
  } else {
    const up = read.filter((x) => x.rate > 1).length;
    direction = up * 2 >= read.length ? "rate" : "reverse";
    decidedBy = `most currencies are worth less than a dollar, and the ${direction.toUpperCase()} column is above 1 for ${direction === "rate" ? up : read.length - up} of ${read.length}`;
  }
  const usd = read.find((x) => x.code === "USD");
  if (usd && Math.abs(usd.rate - 1) > 1e-6) problems.push({ line: usd.line, code: "USD", problem: "the US dollar is not 1 to itself" });

  return {
    month, monthLabel: monthLabel(month), sheet: sheet.name, direction, decidedBy, pairNote,
    rows: read.map((x) => ({
      line: x.line, code: x.code, name: namesText(x.names), countries: x.names.filter(Boolean).length,
      localPerUsd: direction === "rate" ? x.rate : x.reverse,
      usdPerLocal: direction === "rate" ? x.reverse : x.rate,
    })),
    skipped,
    problems,
  };
}

module.exports = { fromWorkbook, monthIn, monthLabel, bareMonth, sameRate, WEAK };
