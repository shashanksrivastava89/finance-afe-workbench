"use strict";
// The project — one AFE once it has an internal order, and one page per order.
//
// Everything is joined at read time: the AFE, its orders, the latest active budget extract,
// the PO lines behind the figures, the AuC recon line when the quarterly review covers it,
// and how it got here from the audit trail. Nothing derived is stored, so a fresh extract
// changes every project page at once.
const rbac = require("../domain/rbac");
const afeRules = require("../domain/afeRules");
const ioRegistry = require("../domain/ioRegistry");
const { latestBudgetByIo, ioFigures, rollUp } = require("../domain/budget");
const { computeFlags } = require("../domain/flags");
const { timelineFor } = require("./timeline");
const { afeBrief, permissionsFor, sourcingOfAfe } = require("./afeView");
const { KIND_NAMES } = require("../ingest");
const snapshots = require("../ingest/snapshots");

const PROJECT_STATES = ["issued", "tracking", "capitalized", "closed"];

/**
 * One AFE's project.
 * @param {object} opts { light: true } skips the PO lines, the recon line and the timeline
 */
async function projectView(repos, afe, ctx, opts) {
  const o = opts || {};
  const ios = await repos.ios.all((i) => i.afeId === afe.id);
  ios.sort((a, b) => (a.kind === b.kind ? (a.lineSeq || 0) - (b.lineSeq || 0) : a.kind === "parent" ? -1 : 1));
  const { map, batch } = await latestBudgetByIo(repos);

  const poByIo = new Map();
  if (!o.light) {
    const active = await snapshots.activeFor(repos, "po_lines");
    if (active) {
      for (const line of await repos.poLines.all((p) => p.batchId === active.id)) {
        if (!poByIo.has(line.ioNumber)) poByIo.set(line.ioNumber, []);
        poByIo.get(line.ioNumber).push(line);
      }
      for (const lines of poByIo.values()) lines.sort((a, b) => String(b.docDate || "").localeCompare(String(a.docDate || "")));
    }
  }

  const rows = ios.map((io) => {
    const lines = poByIo.get(io.ioNumber) || [];
    return Object.assign({}, io, {
      figures: ioFigures(io, map.get(io.ioNumber) || null, lines),
      poLines: o.light ? [] : lines,
      moves: (io.budgetMoves || []).length,
    });
  });
  const approved = afeRules.total(afe);
  const view = {
    afe: Object.assign(afeBrief(afe), { location: afe.location, plant: afe.plant, companyCode: afe.companyCode,
      description: (afe.project && afe.project.description) || "", schedule: afe.schedule || {},
      budgetCategory: (afe.budget && afe.budget.budgetCategory) || null, afeCategory: (afe.budget && afe.budget.afeCategory) || null,
      orderType: (afe.fa && afe.fa.orderType) || null, issuedAt: (afe.fa && afe.fa.issuedAt) || null,
      steps: (afe.fa && afe.fa.steps) || {} }),
    state: afe.state,
    ios: rows,
    totals: rollUp(rows.map((r) => r.figures)),
    approvedUsd: approved,
    allocation: ioRegistry.allocation(afe, ios, approved),
    plan: ioRegistry.childPlan(afe, ios),
    moves: ioRegistry.moveHistory(ios),
    extract: batch ? { batchId: batch.id, asOfDate: batch.asOfDate, importedAt: batch.importedAt, rowCount: batch.rowCount } : null,
    permissions: permissionsFor(afe, ctx || {}, {}),
  };
  if (!o.light) {
    const numbers = new Set(ios.map((i) => i.ioNumber));
    const recon = (await repos.tracker.all((t) => numbers.has(t.ioNumber) || (afe.afeNo && t.ioNumber === afe.afeNo)));
    view.auc = recon.map((t) => Object.assign({
      id: t.id, ioNumber: t.ioNumber, aucNumber: t.aucNumber, aucStatus: t.aucStatus, openClosed: t.openClosed,
      endingBalance: t.endingBalance, issueDate: t.issueDate, reviewerName: t.reviewerName,
      esdHistory: t.esdHistory || [], comments: (t.comments || []).slice(-3),
    }, { flags: computeFlags(t, map.get(t.ioNumber) || null, t.esdHistory, new Date()) }));
    view.timeline = await timelineFor(repos, afe.id, { admin: rbac.isAdmin(ctx || {}) });
  }
  return view;
}

/** A row for the projects list: enough to choose one, nothing more. */
function projectRow(afe, ios, map) {
  const figures = ios.map((io) => ioFigures(io, map.get(io.ioNumber) || null, []));
  const totals = rollUp(figures);
  const parent = ios.find((i) => i.kind === "parent") || null;
  return Object.assign(afeBrief(afe), {
    ioNumber: parent ? parent.ioNumber : afe.afeNo || null,
    ios: ios.length,
    children: ios.filter((i) => i.kind === "child").length,
    orderType: (afe.fa && afe.fa.orderType) || null,
    issuedAt: (afe.fa && afe.fa.issuedAt) || null,
    budgetCategory: (afe.budget && afe.budget.budgetCategory) || null,
    totals,
    inExtract: figures.some((f) => f.inExtract),
    steps: (afe.fa && afe.fa.steps) || {},
  });
}

/** Everything this caller may see, grouped — aggregation first (design rule 1). */
async function projectsList(repos, ctx, query) {
  const q = query || {};
  const email = ctx && ctx.user ? ctx.user.email : null;
  const roles = (ctx && ctx.roles) || [];
  const privileged = roles.some((r) => ["fa_preparer", "fa_checker", "leadership", "admin", "coordinator"].includes(r));
  const mine = (a) => (a.requester && a.requester.email === email) || (a.preparer && a.preparer.email === email) ||
    (a.coordinator && a.coordinator.email === email) || (roles.includes("coordinator") && (ctx.coordinatorFor || []).includes(a.division));
  let afes = await repos.afes.all((a) => PROJECT_STATES.includes(a.state) && (privileged || mine(a)));
  if (q.division) afes = afes.filter((a) => a.division === q.division);
  if (q.mine === "1") afes = afes.filter(mine);
  // Acme inventory or an outside vendor (R152).
  if (q.sourcing) afes = afes.filter((a) => sourcingOfAfe(a) === q.sourcing);

  const { map, batch } = await latestBudgetByIo(repos);
  const allIos = await repos.ios.all();
  const byAfe = new Map();
  for (const io of allIos) {
    if (!byAfe.has(io.afeId)) byAfe.set(io.afeId, []);
    byAfe.get(io.afeId).push(io);
  }
  const rows = afes.map((a) => projectRow(a, byAfe.get(a.id) || [], map));
  rows.sort((a, b) => String(b.issuedAt || b.updatedAt).localeCompare(String(a.issuedAt || a.updatedAt)));

  const groups = { running: [], awaitingBudget: [], capitalized: [], closed: [] };
  for (const r of rows) {
    if (r.state === "closed") groups.closed.push(r);
    else if (r.state === "capitalized") groups.capitalized.push(r);
    else if (!r.steps.KO22_BUDGET) groups.awaitingBudget.push(r);
    else groups.running.push(r);
  }
  const totals = rollUp(rows.map((r) => r.totals));
  const counts = {};
  for (const k of Object.keys(groups)) counts[k] = groups[k].length;
  counts.projects = rows.length;
  counts.orders = rows.reduce((n, r) => n + r.ios, 0);
  return { counts, groups, totals, extract: batch ? { batchId: batch.id, asOfDate: batch.asOfDate, importedAt: batch.importedAt } : null,
    extracts: await snapshots.status(repos, KIND_NAMES) };
}

module.exports = { projectView, projectsList, projectRow, PROJECT_STATES, timelineFor };
