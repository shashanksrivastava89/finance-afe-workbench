"use strict";
// SOX-2 follow-up flags — computed at read time, NEVER stored (they change with every
// data refresh; storing them would desynchronize the control from the data).
const { FLAG_RULES } = require("./refData");

function daysBetween(fromIso, to) {
  if (!fromIso) return null;
  const from = new Date(fromIso).getTime();
  if (Number.isNaN(from)) return null;
  return Math.floor((to.getTime() - from) / 86400000);
}

// item: tracker row · budgetRow: latest snapshot row for the IO (may be null)
function computeFlags(item, budgetRow, esdHistory, now) {
  now = now || new Date();
  const endingBalance = item.endingBalance || 0;

  let consumedPct = null;
  if (budgetRow && budgetRow.budget > 0) consumedPct = budgetRow.actual / budgetRow.budget;
  else if ((item.capexUsd || 0) > 0) consumedPct = endingBalance / item.capexUsd; // legacy tracker semantics

  const ageingDays = daysBetween(item.issueDate, now);

  const firm = (esdHistory || []).some(
    (h) => h.kind === "firm_commitment" && h.estimatedServiceDate && new Date(h.estimatedServiceDate) > now
  );

  const reasons = [];
  if (consumedPct !== null && consumedPct >= FLAG_RULES.consumedPct) reasons.push("consumed80");
  if (ageingDays !== null && ageingDays >= FLAG_RULES.ageingDays) reasons.push("aged180");
  if (endingBalance > FLAG_RULES.balanceUsd) reasons.push("over100k");

  const isOpen = (item.openClosed || "Open").toLowerCase() === "open"
    && (item.aucStatus || "").toLowerCase() !== "capitalized";

  return {
    consumedPct: consumedPct === null ? null : Math.round(consumedPct * 1000) / 1000,
    ageingDays,
    ageingBucket: ageingDays === null ? null : ageingDays >= 180 ? "180+" : ageingDays >= 90 ? "90–180" : "0–90",
    budgetBucket: consumedPct === null ? null : consumedPct >= FLAG_RULES.consumedPct ? "Above 80%" : "Below 80%",
    over100k: endingBalance > FLAG_RULES.balanceUsd,
    firmDateOnFile: firm,
    reasons,
    followUpNeeded: isOpen && reasons.length > 0 && !firm,
  };
}

module.exports = { computeFlags };
