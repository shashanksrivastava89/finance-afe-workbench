"use strict";
// Per-IO figures from the latest SAP extract. Nothing here is stored on the AFE or the
// tracker: the numbers are joined at read time from the newest *active* budget snapshot,
// so a fresh extract changes every screen at once and a half-loaded import never shows.

/**
 * The newest active budget snapshot as a Map keyed by IO number.
 * @returns {{map: Map<string, object>, batch: object|null}}
 */
async function latestBudgetByIo(repos) {
  const batches = await repos.snapshots.all((s) => !s.kind || s.kind === "io_budget");
  const usable = batches.filter((b) => !b.status || b.status === "active");
  if (!usable.length) return { map: new Map(), batch: null };
  usable.sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
  const latest = usable[0];
  const map = new Map();
  for (const row of await repos.budgetRows.all((r) => r.batchId === latest.id)) map.set(row.ioNumber, row);
  return { map, batch: latest };
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);

/**
 * One internal order as the project page shows it: what SAP holds plus what we allocated.
 * `row` is a budget-extract row (may be missing — a freshly issued IO is not in the
 * extract until the next run, which the UI says rather than showing zeros as fact).
 */
function ioFigures(io, row, poLines) {
  const lines = poLines || [];
  const committed = row ? num(row.commitment) : lines.reduce((t, l) => t + num(l.stillToInvoiceUsd), 0);
  const actual = row ? num(row.actual) : lines.reduce((t, l) => t + num(l.invoicedUsd), 0);
  const budget = row ? num(row.budget) : num(io.allocatedBudgetUsd);
  const available = row && row.available != null ? num(row.available) : budget - committed - actual;
  return {
    ioNumber: io.ioNumber || null,
    kind: io.kind || "parent",
    country: io.country || "",
    site: io.site || "",
    budgetUsd: budget,
    actualUsd: actual,
    commitmentUsd: committed,
    allottedUsd: row ? num(row.allotted) : num(io.allocatedBudgetUsd),
    availableUsd: available,
    consumedPct: budget ? (actual + committed) / budget : null,
    inExtract: Boolean(row),
    poCount: lines.length,
  };
}

/** Parent + children rolled up. */
function rollUp(figures) {
  const t = { budgetUsd: 0, actualUsd: 0, commitmentUsd: 0, allottedUsd: 0, availableUsd: 0 };
  for (const f of figures) {
    t.budgetUsd += f.budgetUsd; t.actualUsd += f.actualUsd; t.commitmentUsd += f.commitmentUsd;
    t.allottedUsd += f.allottedUsd; t.availableUsd += f.availableUsd;
  }
  t.consumedPct = t.budgetUsd ? (t.actualUsd + t.commitmentUsd) / t.budgetUsd : null;
  return t;
}

module.exports = { latestBudgetByIo, ioFigures, rollUp };
