"use strict";
// Does what the tool believes still match what SAP reports?
//
// Pure, derived at read time. The tool never writes to SAP, so the two can drift in ordinary
// ways — an order keyed against the wrong cost centre, a budget loaded at a different figure,
// an extract that stopped arriving. Each of those is a question for a person, so this returns
// findings, never corrections.
//
// The thresholds are the ones already agreed: capitalization is allowed to 105 % of budget
// (refData.CAPITALIZATION_TOLERANCE) and an extract older than eight days is stale
// (docs/architecture.md §4.3).
const { CAPITALIZATION_TOLERANCE } = require("./refData");
const afeRules = require("./afeRules");

const STALE_DAYS = 8;
const GRACE_DAYS = 3;                    // an order keyed today is not in last night's extract
const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");
const days = (from, to) => (from ? Math.floor((new Date(to).getTime() - new Date(from).getTime()) / 86400000) : null);

/**
 * @param {object} input { afes, ios, budgetMap: Map, masterMap: Map, extracts: [{kind, stale, ageDays, batchId}], now }
 * @returns {{findings, counts, checkedAt}}
 */
function reconcile(input) {
  const now = input.now || new Date().toISOString();
  const afes = input.afes || [];
  const ios = input.ios || [];
  const budget = input.budgetMap || new Map();
  const master = input.masterMap || new Map();
  const findings = [];
  const add = (f) => findings.push(Object.assign({ severity: "note" }, f));

  // (a) the extracts themselves
  for (const x of input.extracts || []) {
    if (!x.batchId) {
      add({ code: "extract_missing", severity: "review", kind: x.kind,
        title: `No ${x.kind.replace(/_/g, " ")} extract has ever been loaded`,
        detail: "Until it arrives, the figures on the project pages are what the tool allocated, not what SAP holds." });
    } else if (x.stale) {
      add({ code: "extract_stale", severity: "review", kind: x.kind, batchId: x.batchId,
        title: `The ${x.kind.replace(/_/g, " ")} extract is ${x.ageDays} days old`,
        detail: `Loaded ${x.importedAt ? x.importedAt.slice(0, 10) : "?"}. Anything older than ${STALE_DAYS} days is treated as stale — check the scheduled transfer.` });
    }
  }

  const byAfe = new Map();
  for (const io of ios) {
    if (!byAfe.has(io.afeId)) byAfe.set(io.afeId, []);
    byAfe.get(io.afeId).push(io);
  }

  // (b) per issued AFE
  for (const afe of afes) {
    if (!["issued", "tracking", "capitalized"].includes(afe.state)) continue;
    const mine = byAfe.get(afe.id) || [];
    const approved = afeRules.total(afe);
    const title = (afe.project && afe.project.title) || afe.id;
    if (!mine.length) {
      add({ code: "issued_without_io", severity: "review", afeId: afe.id, title: `“${title}” is issued but has no internal order recorded`,
        detail: "Fixed Assets records the order number as part of issuing; this one is missing." });
      continue;
    }
    const age = days(afe.fa && afe.fa.issuedAt, now);
    for (const io of mine) {
      if (!master.has(io.ioNumber) && master.size && age !== null && age > GRACE_DAYS) {
        add({ code: "io_not_in_master", severity: "review", afeId: afe.id, ioNumber: io.ioNumber,
          title: `Order ${io.ioNumber} is not in the SAP order master`,
          detail: `Recorded here ${age} days ago on “${title}”. Either the number was mistyped or the order was never saved in SAP.` });
        continue;
      }
      const m = master.get(io.ioNumber);
      if (m && io.costCenter && m.costCenter && String(m.costCenter) !== String(io.costCenter)) {
        add({ code: "cost_centre_differs", severity: "review", afeId: afe.id, ioNumber: io.ioNumber,
          title: `Order ${io.ioNumber} sits on cost centre ${m.costCenter} in SAP, not ${io.costCenter}`,
          detail: `The AFE was approved on ${io.costCenter}'s chain. A different cost centre means a different set of approvers.` });
      }
      if (m && io.orderType && m.orderType && m.orderType !== io.orderType) {
        add({ code: "order_type_differs", afeId: afe.id, ioNumber: io.ioNumber,
          title: `Order ${io.ioNumber} is ${m.orderType} in SAP; the AFE recorded ${io.orderType}`,
          detail: "One of the two is wrong — the order type decides how the spend settles." });
      }
      const b = budget.get(io.ioNumber);
      if (b && approved > 0 && io.kind === "parent") {
        const total = mine.reduce((n, x) => n + (budget.get(x.ioNumber) ? budget.get(x.ioNumber).budget : 0), 0);
        if (total > approved * CAPITALIZATION_TOLERANCE) {
          add({ code: "budget_over_approved", severity: "review", afeId: afe.id, ioNumber: io.ioNumber,
            title: `SAP holds ${money(total)} of budget against ${money(approved)} approved on “${title}”`,
            detail: `That is over the ${Math.round(CAPITALIZATION_TOLERANCE * 100)} % tolerance. A supplemental AFE is needed before the asset can be capitalized.` });
        }
      }
      if (!b && budget.size && age !== null && age > GRACE_DAYS) {
        add({ code: "io_not_in_budget", afeId: afe.id, ioNumber: io.ioNumber,
          title: `Order ${io.ioNumber} carries no budget in the extract`,
          detail: `Recorded ${age} days ago. KO22 loads the budget after KO01 — check it was posted.` });
      }
    }
    const lines = ((afe.money && afe.money.lines) || []).filter((l) => l && l.amountUsd);
    const kids = mine.filter((i) => i.kind === "child").length;
    if (lines.length > 1 && kids < lines.length) {
      add({ code: "lines_without_io", afeId: afe.id,
        title: `“${title}” has ${lines.length} cost lines and ${kids} child ${kids === 1 ? "order" : "orders"}`,
        detail: "Country spend cannot be reported separately until each line has its own order. Add them from the project page." });
    }
    const allocated = mine.reduce((n, i) => n + (Number(i.allocatedBudgetUsd) || 0), 0);
    if (approved > 0 && Math.abs(allocated - approved) >= 1) {
      add({ code: allocated > approved ? "over_allocated" : "under_allocated", afeId: afe.id,
        title: `${money(allocated)} is allocated across the orders on “${title}”, against ${money(approved)} approved`,
        detail: allocated > approved ? "Budget moves keep the total constant, so this means an order was created with its own figure." : "Some of the approved amount is not on any order yet." });
    }
  }

  // (c) SAP knows an order the tool does not — informational, and expected for anything issued
  // before the tool existed.
  let orphans = 0;
  const known = new Set(ios.map((i) => i.ioNumber));
  for (const io of budget.keys()) if (!known.has(io)) orphans += 1;

  const counts = { total: findings.length, review: findings.filter((f) => f.severity === "review").length,
    notes: findings.filter((f) => f.severity !== "review").length, orphanOrders: orphans };
  return { findings, counts, checkedAt: now, staleDays: STALE_DAYS };
}

module.exports = { reconcile, STALE_DAYS, GRACE_DAYS };
