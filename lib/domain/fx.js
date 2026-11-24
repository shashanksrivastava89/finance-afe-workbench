"use strict";
// Local currency at Global Finance's month-end rate (R161). Pure: rows and AFEs in, plain values out.
//
// "Three-digit currency" (Aiden, Meeting #7); "we have this field" (Judithmelanie). USD STAYS THE
// APPROVED FIGURE — the bands, the chain, the budget and every fingerprint read dollars — and the
// local amounts are the dollars times Global Finance's rate, shown and printed, never typed as
// the source. The rate comes from the master (`fxRates`, one row per month and currency, every
// month kept), is picked up when the currency is picked, and does not refresh on its own: it
// moves only when somebody picks again, so an AFE never changes under the person who wrote it.
const { monthLabel } = require("../ingest/fxRates");

const USD = "USD";

/** The newest month the master holds, "2026-08", or null when there is none. */
function latestMonth(rows) {
  return (rows || []).reduce((m, r) => (r && r.month && r.month > m ? r.month : m), "") || null;
}

/** One month's rates (the newest when none is named), by code. */
function ratesFor(rows, month) {
  const m = month || latestMonth(rows);
  return (rows || []).filter((r) => r && r.month === m && r.active !== false && Number(r.localPerUsd) > 0)
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));
}

/** This month's rate for a code, or null. */
function lookup(rows, code, month) {
  const c = String(code || "").toUpperCase();
  return ratesFor(rows, month).find((r) => r.code === c) || null;
}

/** What an AFE carries once a currency is picked: the rate, its month and where it came from. */
function fxFrom(rate) {
  if (!rate) return null;
  const local = Number(rate.localPerUsd);
  return { localPerUsd: local, usdPerLocal: Number(rate.usdPerLocal) || 1 / local, month: rate.month, source: "global_finance" };
}

/**
 * What is FROZEN on the routing at send, beside the chain: null for a US-dollar AFE, the currency
 * and its rate otherwise. The form reads THIS, never the live AFE, so a signed page keeps
 * reproducing the rate it was signed with — and a routing sent before R161 has none, and is USD.
 */
function basisFx(afe) {
  const m = (afe && afe.money) || {};
  const code = String(m.currency || USD).toUpperCase();
  if (code === USD || !m.fx || !(Number(m.fx.localPerUsd) > 0)) return null;
  return { currency: code, localPerUsd: Number(m.fx.localPerUsd), month: m.fx.month || null, source: m.fx.source || "global_finance" };
}

/** Dollars in local currency, whole units as the form's own `#,##0` prints them. */
function toLocal(usd, fx) {
  const n = Number(usd);
  if (!fx || !Number.isFinite(n) || !n) return null;
  return Math.round(n * Number(fx.localPerUsd));
}

/** A rate as Global Finance writes it: up to six decimals, grouped. */
function rateText(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return v.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: v >= 100 ? 2 : 6 });
}

/** "1 USD = 1.286505 SGD · Global Finance, August 2026 month-end". */
function rateLine(fx) {
  if (!fx) return "";
  return `1 USD = ${rateText(fx.localPerUsd)} ${fx.currency}${fx.month ? ` · Global Finance, ${monthLabel(fx.month)} month-end` : ""}`;
}

module.exports = { USD, latestMonth, ratesFor, lookup, fxFrom, basisFx, toLocal, rateText, rateLine, monthLabel };
