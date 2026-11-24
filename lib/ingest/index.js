"use strict";
// The four SAP extracts, as data.
//
// Each kind declares the columns it can recognise (SAP's own header names, plus the variants
// the ALV variants produce), how a parsed line becomes a stored row, and what applying a
// batch does. Adding a fifth extract is a new entry here, not a new code path.
//
// Every kind goes through lib/ingest/snapshots.js: idempotent by id and by content hash,
// row-count sanity against the batch it replaces, rows written before the batch is activated.
const { parseTable, amount, date, clean } = require("./table");
const { parseBudgetExport } = require("./alv");
const people = require("../domain/people");
const { LEVEL_LADDER } = require("../domain/refData");

const LEVELS = LEVEL_LADDER.filter((l) => l !== "BOARD");

// ---- approver matrix ---------------------------------------------------------------------------
const matrixSpec = {
  columns: Object.assign({
    costCenter: ["Cost Center", "Cost Centre", "CostCenter", "Kostl", "CCtr", "Cost Ctr"],
    description: ["Description", "Name", "Cost Center Name", "Text"],
    plant: ["Plant", "Werks", "Werk"],
    status: ["Status", "Active", "Lock"],
  }, LEVELS.reduce((acc, l) => Object.assign(acc, { ["level" + l]: [l, "Level " + l, l + " Approver", l + " Name"] }), {})),
  required: ["costCenter"],
};

function matrixRows(rows) {
  const out = [];
  for (const r of rows) {
    const cc = clean(r.costCenter).replace(/^0+(?=\d)/, "");
    if (!/^\d{3,10}$/.test(cc)) continue;
    const levels = {};
    for (const l of LEVELS) {
      const name = clean(r["level" + l]);
      if (name) levels[l] = { name };
    }
    out.push({ costCenter: cc, description: clean(r.description), plant: clean(r.plant) || null,
      status: clean(r.status) || "Active", levels });
  }
  return out;
}

/**
 * The matrix is a full snapshot, not a delta: a cost centre missing from the export has gone.
 * Applied as a diff so the change list is available for free — that list is what turns into a
 * red flag on an AFE already signed against the old row (R46).
 */
async function applyMatrix(repos, rows) {
  const seen = new Set();
  const changed = [];
  let added = 0, updated = 0, unchanged = 0;
  // The SAP report has one row per cost centre × plant; collapse on the cost centre, first plant wins.
  const byCc = new Map();
  for (const r of rows) if (!byCc.has(r.costCenter)) byCc.set(r.costCenter, r);

  for (const [cc, row] of byCc) {
    seen.add(cc);
    const id = `mxr-${cc}`;
    const before = await repos.matrix.get(id);
    if (!before) {
      await repos.matrix.insert(Object.assign({ id }, row));
      added += 1;
      continue;
    }
    const diffs = [];
    for (const l of LEVELS) {
      const was = before.levels && before.levels[l] ? before.levels[l].name : "";
      const now = row.levels[l] ? row.levels[l].name : "";
      if (people.normName(was) !== people.normName(now)) diffs.push({ level: l, was, now });
    }
    const same = !diffs.length && before.description === row.description && before.plant === row.plant && before.status === row.status;
    if (same) { unchanged += 1; continue; }
    await repos.matrix.update(id, row);
    updated += 1;
    if (diffs.length) changed.push({ costCenter: cc, levels: diffs });
  }
  const removed = [];
  for (const row of await repos.matrix.all()) {
    if (seen.has(row.costCenter)) continue;
    removed.push(row.costCenter);
    await repos.matrix.remove(row.id);
  }
  return { costCentres: byCc.size, added, updated, unchanged, removed: removed.length, removedCostCentres: removed.slice(0, 50), changed };
}

// ---- per-IO budget -----------------------------------------------------------------------------
const budgetSpec = {
  columns: {
    ioNumber: ["Order", "Internal Order", "IO", "Order Number", "Aufnr"],
    description: ["Description", "Order Description", "Text", "Short Text"],
    budget: ["Budget", "Original Budget", "Current Budget"],
    actual: ["Actual", "Actual Costs", "Actuals"],
    commitment: ["Commitment", "Commitments", "Open Commitment"],
    allotted: ["Allotted", "Assigned", "Assigned Funds"],
    available: ["Available", "Available Budget", "Residual"],
  },
  required: ["ioNumber"],
};

function budgetRows(parsed) {
  const out = [];
  for (const r of parsed) {
    // The ALV puts the number and the description in one cell: "313403 Autolabe 390S".
    const raw = clean(r.ioNumber);
    const m = /^(\d{6,10})\b\s*(.*)$/.exec(raw);
    if (!m) continue;
    const budget = amount(r.budget), actual = amount(r.actual), commitment = amount(r.commitment);
    const allotted = r.allotted !== undefined ? amount(r.allotted) : actual + commitment;
    out.push({
      ioNumber: m[1],
      description: clean(r.description) || m[2] || "",
      budget, actual, commitment, allotted,
      available: r.available !== undefined ? amount(r.available) : budget - allotted,
    });
  }
  return out;
}

// ---- IO master (KOK5) --------------------------------------------------------------------------
const ioMasterSpec = {
  columns: {
    ioNumber: ["Order", "Internal Order", "Order Number", "Aufnr", "IO"],
    description: ["Description", "Short Text", "Order Description", "Text"],
    orderType: ["Order Type", "Type", "Auart"],
    companyCode: ["Company Code", "CoCd", "Bukrs"],
    costCenter: ["Responsible Cost Center", "Cost Center", "Resp. CCtr", "Kostl"],
    requestingCostCenter: ["Requesting Cost Center", "Requesting CCtr"],
    plant: ["Plant", "Werks"],
    profitCenter: ["Profit Center", "Prctr"],
    personResponsible: ["Person Responsible", "Responsible", "Applicant"],
    parentReference: ["External Order Number", "Reference Order", "Parent Order", "Superior Order", "AFE"],
    createdOn: ["Created On", "Creation Date", "Erdat"],
    workStart: ["Work Start", "Start Date"],
    workEnd: ["End of Work", "Finish Date", "End Date"],
    systemStatus: ["System Status", "Status", "Stat"],
    currency: ["Currency", "Object Currency", "Waers"],
  },
  required: ["ioNumber"],
};

function ioMasterRows(parsed) {
  const out = [];
  for (const r of parsed) {
    const io = /^(\d{6,10})$/.exec(clean(r.ioNumber).replace(/\s.*$/, ""));
    if (!io) continue;
    out.push({
      ioNumber: io[1], description: clean(r.description), orderType: clean(r.orderType) || null,
      companyCode: clean(r.companyCode) || null, costCenter: clean(r.costCenter).replace(/^0+(?=\d)/, "") || null,
      requestingCostCenter: clean(r.requestingCostCenter) || null, plant: clean(r.plant) || null,
      profitCenter: clean(r.profitCenter) || null, personResponsible: clean(r.personResponsible) || null,
      parentReference: clean(r.parentReference) || null,
      createdOn: date(r.createdOn), workStart: date(r.workStart), workEnd: date(r.workEnd),
      systemStatus: clean(r.systemStatus) || null, currency: clean(r.currency) || "USD",
    });
  }
  return out;
}

// ---- PO lines (ME2K / KOB1) ---------------------------------------------------------------------
const poLineSpec = {
  columns: {
    ioNumber: ["Order", "Internal Order", "Account Assignment", "Aufnr", "IO"],
    poNumber: ["Purchasing Document", "PO", "PO Number", "Document Number", "Ebeln"],
    item: ["Item", "PO Item", "Ebelp"],
    vendor: ["Vendor", "Supplier", "Vendor Name", "Name of Vendor"],
    description: ["Short Text", "Material Description", "Description", "Text"],
    orderedUsd: ["Order Value", "Net Order Value", "PO Value", "Ordered"],
    invoicedUsd: ["Invoiced", "Invoice Value", "Actual", "Invoiced Amount"],
    stillToInvoiceUsd: ["Still to be Invoiced", "Still to Deliver", "Open Value", "Commitment"],
    docDate: ["Document Date", "PO Date", "Posting Date", "Bedat"],
    currency: ["Currency", "Waers"],
  },
  required: ["ioNumber", "poNumber"],
};

function poLineRows(parsed) {
  const out = [];
  for (const r of parsed) {
    const io = /^(\d{6,10})$/.exec(clean(r.ioNumber).replace(/\s.*$/, ""));
    const po = clean(r.poNumber).replace(/\s.*$/, "");
    if (!io || !po) continue;
    const ordered = amount(r.orderedUsd), invoiced = amount(r.invoicedUsd);
    out.push({
      ioNumber: io[1], poNumber: po, item: clean(r.item) || null,
      vendor: clean(r.vendor) || null, description: clean(r.description) || "",
      orderedUsd: ordered, invoicedUsd: invoiced,
      stillToInvoiceUsd: r.stillToInvoiceUsd !== undefined ? amount(r.stillToInvoiceUsd) : Math.max(0, ordered - invoiced),
      docDate: date(r.docDate), currency: clean(r.currency) || "USD",
    });
  }
  return out;
}

// ---- the registry --------------------------------------------------------------------------------
async function replaceRows(repos, collection, batchId, rows) {
  await repos[collection].insertMany(rows.map((r) => Object.assign({ batchId }, r)));
  return { rows: rows.length };
}

const KINDS = {
  matrix: {
    label: "SAP approver matrix",
    collection: null,                                   // upserted in place, not batch-tagged
    // The matrix is the one kind whose import DESTROYS rows: a cost centre missing from the
    // export has gone (`applyMatrix`), in place, with no batch tag and nothing to roll back
    // to. So it is also the one kind that counts what it is about to overwrite and refuses a
    // file that would collapse it. The seeded matrix is not a partial baseline like the
    // others — it is the whole SAP export, 1,197 cost centres — so its size is a fair
    // expectation for the first real extract, and comparing against it refuses nothing
    // legitimate.
    liveCount: (repos) => repos.matrix.count(),
    parse: (bytes) => { const p = parseTable(bytes, matrixSpec); return Object.assign({}, p, { rows: p.error ? [] : matrixRows(p.rows) }); },
    apply: (repos, snapshot, rows) => applyMatrix(repos, rows),
    afterApply: (repos, snapshot, summary) => {
      repos.meta.matrixBatch = { batchId: snapshot.id, filename: snapshot.filename, reportDate: snapshot.asOfDate,
        importedAt: snapshot.importedAt, rowCount: summary.costCentres, changedCostCentres: (summary.changed || []).length };
    },
  },
  io_budget: {
    label: "per-IO budget / actual / commitment",
    collection: "budgetRows",
    parse: (bytes) => {
      const p = parseTable(bytes, budgetSpec);
      if (!p.error && p.rows.length) return Object.assign({}, p, { rows: budgetRows(p.rows) });
      // The "Budget Details" ALV has no header we recognise — fall back to the positional reader.
      const alv = parseBudgetExport(require("./table").decode(bytes));
      if (alv.rows.length) return { rows: alv.rows, header: ["(ALV Budget Details, positional)"], delimiter: "\t", skipped: alv.skipped, unknownColumns: [], lines: alv.rows.length + alv.skipped };
      return p;
    },
    apply: (repos, snapshot, rows) => replaceRows(repos, "budgetRows", snapshot.id, rows),
  },
  io_master: {
    label: "internal-order master (KOK5)",
    collection: "ioMaster",
    parse: (bytes) => { const p = parseTable(bytes, ioMasterSpec); return Object.assign({}, p, { rows: p.error ? [] : ioMasterRows(p.rows) }); },
    apply: (repos, snapshot, rows) => replaceRows(repos, "ioMaster", snapshot.id, rows),
  },
  po_lines: {
    label: "purchase-order lines (ME2K / KOB1)",
    collection: "poLines",
    parse: (bytes) => { const p = parseTable(bytes, poLineSpec); return Object.assign({}, p, { rows: p.error ? [] : poLineRows(p.rows) }); },
    apply: (repos, snapshot, rows) => replaceRows(repos, "poLines", snapshot.id, rows),
  },
};

const KIND_NAMES = Object.keys(KINDS);

module.exports = { KINDS, KIND_NAMES, matrixRows, budgetRows, ioMasterRows, poLineRows, applyMatrix, LEVELS };
