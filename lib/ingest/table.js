"use strict";
// A tolerant reader for what SAP actually drops on us.
//
// The exports are ALV downloads: UTF-16LE with a BOM as often as UTF-8, tab-separated as
// often as comma, quoted fields, Indian digit grouping (1,96,71,13,618.79), a blank cell
// for zero, trailing "*  Total" rows, and header names that differ per report variant.
// Everything here is defensive on purpose — a parser that throws on a stray line means an
// overnight extract silently does not land.
//
// Pure: bytes in, rows out. Nothing here touches storage.

/** Decode a Buffer, honouring a UTF-16 or UTF-8 byte-order mark. */
function decode(buf) {
  if (!Buffer.isBuffer(buf)) return String(buf || "");
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.slice(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.slice(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.slice(3).toString("utf8");
  // A UTF-16LE file without a BOM still shows as alternating NUL bytes.
  if (buf.length > 8 && buf[1] === 0 && buf[3] === 0 && buf[5] === 0) return buf.toString("utf16le");
  return buf.toString("utf8");
}

const DELIMS = ["\t", ";", ",", "|"];

/** Pick the delimiter that splits the header into the most fields. */
function sniffDelimiter(line) {
  let best = "\t", n = 0;
  for (const d of DELIMS) {
    const c = splitLine(line, d).length;
    if (c > n) { n = c; best = d; }
  }
  return best;
}

/** One line into fields, honouring "quoted, with the delimiter inside" and "" escapes. */
function splitLine(line, delim) {
  const out = [];
  let cur = "", inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i += 1; } else inQuotes = false; }
      else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === delim) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const clean = (s) => String(s === undefined || s === null ? "" : s).replace(/^"|"$/g, "").trim();
const key = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, "");

/** SAP amounts: "1,96,71,13,618.79", "(1.234,50)", "1.234,50-", blank for zero. */
function amount(tok) {
  let t = clean(tok);
  if (!t || t === "-" || t === "*") return 0;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
  if (/^-/.test(t)) { neg = true; t = t.slice(1); }
  t = t.replace(/[A-Z$€£\s]/gi, "");
  // European grouping: the last separator is the decimal one when it has 1–2 digits after it.
  const lastComma = t.lastIndexOf(","), lastDot = t.lastIndexOf(".");
  if (lastComma > lastDot && t.length - lastComma <= 3) t = t.replace(/\./g, "").replace(",", ".");
  else t = t.replace(/,/g, "");
  const n = Number(t);
  if (!Number.isFinite(n)) return 0;
  return Math.round((neg ? -n : n) * 100) / 100;
}

/** SAP dates: 04.09.2026 · 2026-09-04 · 09/04/2026 · 20260904. Returns yyyy-mm-dd or null. */
function date(tok) {
  const t = clean(tok);
  if (!t) return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[.\/](\d{1,2})[.\/](\d{4})$/.exec(t);
  if (m) {
    // dd.mm.yyyy is SAP's own; dd/mm/yyyy is ambiguous with mm/dd/yyyy — take the field that
    // cannot be a month as the day, otherwise trust the SAP order.
    const a = Number(m[1]), b = Number(m[2]);
    const dd = t.includes("/") && a <= 12 && b > 12 ? b : a;
    const mm = t.includes("/") && a <= 12 && b > 12 ? a : b;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return `${m[3]}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * Parse a delimited export into objects keyed by the aliases each extract declares.
 *
 * @param {Buffer|string} input
 * @param {object} spec { columns: { field: [aliases…] }, required: [fields] }
 * @returns {{rows, header, delimiter, skipped, unknownColumns, lines}}
 */
function parseTable(input, spec) {
  const text = decode(input);
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) return { rows: [], header: [], delimiter: null, skipped: 0, unknownColumns: [], lines: 0 };

  // ALV puts decoration ("---", "| Order |") above the header; the header is the first line
  // that matches enough declared aliases.
  const wanted = new Map();
  for (const [field, aliases] of Object.entries(spec.columns)) for (const a of aliases) wanted.set(key(a), field);
  let headerIndex = -1, delim = null, header = [], mapping = [];
  for (let i = 0; i < Math.min(lines.length, 20); i++) {
    const d = sniffDelimiter(lines[i]);
    const cells = splitLine(lines[i], d).map((c) => clean(c).replace(/^\|/, "").trim());
    const map = cells.map((c) => wanted.get(key(c)) || null);
    const hits = map.filter(Boolean).length;
    if (hits >= Math.min(2, Object.keys(spec.columns).length)) { headerIndex = i; delim = d; header = cells; mapping = map; break; }
  }
  if (headerIndex < 0) {
    return { rows: [], header: [], delimiter: null, skipped: lines.length, unknownColumns: [],
      lines: lines.length, error: "no header row recognised — expected columns like " + Object.keys(spec.columns).slice(0, 5).join(", ") };
  }
  const missing = (spec.required || []).filter((f) => !mapping.includes(f));
  if (missing.length) {
    return { rows: [], header, delimiter: delim, skipped: lines.length, unknownColumns: [], lines: lines.length,
      error: `the export is missing ${missing.join(", ")} — found ${header.filter(Boolean).join(", ").slice(0, 200)}` };
  }

  const rows = [];
  let skipped = 0;
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^[\s"|*+-]*$/.test(line)) { continue; }                    // ALV rules and blank rows
    if (/^\s*"?\*/.test(line)) { continue; }                        // "*  Total"
    const cells = splitLine(line, delim);
    const row = {};
    let any = false;
    for (let c = 0; c < mapping.length; c++) {
      if (!mapping[c]) continue;
      const v = clean((cells[c] || "").replace(/^\|/, ""));
      if (v) any = true;
      row[mapping[c]] = v;
    }
    if (!any) { skipped += 1; continue; }
    rows.push(row);
  }
  const unknownColumns = header.filter((h, i) => h && !mapping[i]);
  return { rows, header, delimiter: delim, skipped, unknownColumns, lines: lines.length, headerIndex };
}

module.exports = { parseTable, decode, splitLine, sniffDelimiter, amount, date, clean, key };
