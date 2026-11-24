"use strict";
// Tolerant parser for the SAP ALV per-IO budget export ("Budget Details" format):
// tab-separated, quoted fields, Indian digit grouping (1,96,71,13,618.79), a
// header row, blank cells for zero, and a trailing "*  Total" row.
function parseAmount(tok) {
  if (tok === undefined || tok === null) return 0;
  const t = String(tok).trim().replace(/^"|"$/g, "").replace(/,/g, "");
  if (t === "" || t === "-") return 0;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

const IO_RE = /^\s*"?\s{0,4}(\d{6,10})\s+(.*)$/;

function parseBudgetExport(text) {
  const rows = [];
  let skipped = 0;
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("*")) continue;
    const parts = line.split("\t");
    if (parts.length < 6) { skipped += 1; continue; }
    const m = IO_RE.exec(parts[0]);
    if (!m) { skipped += 1; continue; }
    rows.push({
      ioNumber: m[1],
      description: m[2].trim().replace(/^"|"$/g, ""),
      budget: parseAmount(parts[1]),
      actual: parseAmount(parts[2]),
      commitment: parseAmount(parts[3]),
      allotted: parseAmount(parts[4]),
      available: parseAmount(parts[5]),
    });
  }
  return { rows, skipped };
}

module.exports = { parseBudgetExport };
