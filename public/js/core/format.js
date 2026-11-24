// Formatting — money, dates, names. Every number on screen comes through here so the whole app
// agrees on how a dollar looks.

export function money(n, opts) {
  const o = opts || {};
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  if (o.compact) return moneyCompact(v);
  const abs = Math.abs(v);
  const s = "$" + abs.toLocaleString("en-US", { minimumFractionDigits: o.cents ? 2 : 0, maximumFractionDigits: o.cents ? 2 : 0 });
  return v < 0 ? "-" + s : s;
}

export function moneyCompact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  let s;
  if (abs >= 1e6) s = "$" + (abs / 1e6).toFixed(abs >= 1e7 ? 1 : 2).replace(/\.?0+$/, "") + "M";
  else if (abs >= 1e3) s = "$" + Math.round(abs / 1e3).toLocaleString("en-US") + "K";
  else s = "$" + Math.round(abs).toLocaleString("en-US");
  return v < 0 ? "-" + s : s;
}

/** Parse what a person types into a money field: "215,000", "$215k", "1.2m". */
export function parseMoney(text) {
  const s = String(text || "").trim().toLowerCase().replace(/[$,\s]/g, "");
  if (!s) return null;
  const m = /^(-?\d+(?:\.\d+)?)([km])?$/.exec(s);
  if (!m) { const n = Number(s.replace(/[^0-9.-]/g, "")); return Number.isFinite(n) ? n : null; }
  let n = Number(m[1]);
  if (m[2] === "k") n *= 1e3;
  if (m[2] === "m") n *= 1e6;
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function date(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function dateShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "just now", "2 hours", "3 days" — how long something has been waiting. */
export function ago(iso, now) {
  if (!iso) return "";
  const ms = (now ? new Date(now) : new Date()).getTime() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return mins + (mins === 1 ? " minute" : " minutes");
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + (hrs === 1 ? " hour" : " hours");
  const days = Math.floor(hrs / 24);
  if (days < 14) return days + (days === 1 ? " day" : " days");
  // It used to stop at weeks, so a year-old AuC line read "57 weeks ago" — a number nobody can
  // hold. The recon population is aged in MONTHS (the workbook's rule is six), so months are the
  // unit the readers of this tool actually think in.
  if (days < 60) { const weeks = Math.floor(days / 7); return weeks + " weeks"; }
  const months = Math.round(days / 30.44);
  if (months < 24) return months + (months === 1 ? " month" : " months");
  const years = Math.floor(days / 365.25);
  const rem = Math.round((days - years * 365.25) / 30.44);
  return years + (years === 1 ? " year" : " years") + (rem >= 1 ? " " + rem + "m" : "");
}

/**
 * The exact moment, for the hover behind a fuzzy one.
 *
 * Every timestamp in the product was a duration and nothing else — "3 days ago" with no way to
 * recover when, exactly. For a control (who signed, when the budget was posted) that is not
 * enough: the audit answer is a date and a time. Local, because the reader is in Kolkata and the
 * store is in UTC.
 */
export function exact(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const day = String(d.getDate()).padStart(2, "0");
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  return `${day} ${mon} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * "15 Oct, 21:04" — the moment on the clock, the year only when it is not this one. A history
 * where every row says "19 hours ago" does not say what came first, or when (2026-10-16).
 */
export function clockTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getMonth()];
  const year = d.getFullYear() === new Date().getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${mon}${year}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "just now" or "2 days ago" — `ago()` with the word, minus the "just now ago" slip. */
export function since(iso, now) {
  const a = ago(iso, now);
  return !a || a === "just now" ? a : a + " ago";
}

export function initials(name) {
  // Bracketed text is not part of a name, and neither is punctuation: "Fixed Assets (RTR_FA)" was
  // drawn as "F(" on the coordinator's chain.
  const parts = String(name || "").replace(/\([^)]*\)/g, " ").replace(/[^\p{L}\s-]/gu, " ").trim().split(/[\s-]+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function pct(n, of) {
  if (!of) return null;
  return Math.round((Number(n) / Number(of)) * 100);
}

/**
 * How far the quotes go, as a sentence with the amounts in it.
 *
 * Every screen said "Test Vendor covers 80%": a percentage with nothing behind it, which on an
 * inventory AFE read "Acme covers 83%" — a funding split, not a quote. Two approvers asked
 * "why the mismatch" in one afternoon (15 Oct). The amounts ARE the answer, so they are said.
 */
export function coverage(quoteUsd, totalUsd) {
  const q = Number(quoteUsd) || 0, t = Number(totalUsd) || 0;
  if (!t || !q) return { pct: null, gapUsd: null, text: q ? `Quotes ${money(q)}` : "No quote total yet" };
  const p = pct(q, t), gap = Math.round((t - q) * 100) / 100;
  const text = gap > 0 ? `Quotes ${money(q)} of ${money(t)} (${p}%) — ${money(gap)} not quoted`
    : gap < 0 ? `Quotes ${money(q)} — ${money(-gap)} more than the ${money(t)} asked for` : `Quotes cover all ${money(t)}`;
  return { pct: p, gapUsd: gap, text };
}

export const plural = (n, one, many) => (n === 1 ? one : (many || one + "s"));

/** ISO date (yyyy-mm-dd) for a date input, from a Date or ISO string. */
export function isoDay(d) {
  const x = d instanceof Date ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? "" : x.toISOString().slice(0, 10);
}

export const STATE_LABEL = {
  draft: "Draft", submitted: "With the coordinator", in_approval: "In approval", on_hold: "On hold — question asked",
  approved: "Approved", fa_review: "With Fixed Assets", issued: "Issued", tracking: "Tracking", capitalized: "Capitalized",
  closed: "Closed", returned: "Sent back", rejected: "Declined", withdrawn: "Withdrawn",
};
export const stateLabel = (s) => STATE_LABEL[s] || s;
