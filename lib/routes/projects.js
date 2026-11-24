"use strict";
// Projects — an AFE after it has an internal order, and one page per order.
//
// Read-only except for the two things Fixed Assets does here: giving a cost line its own
// child order, and moving budget between the orders on one AFE. Both go through
// stateMachine.applyTransition; every figure on every screen is joined at read time from the
// latest active SAP extract (lib/views/projectView.js).
const express = require("express");
const stateMachine = require("../domain/stateMachine");
const ioRegistry = require("../domain/ioRegistry");
const afeRules = require("../domain/afeRules");
const { reconcile } = require("../domain/reconcile");
const { projectView, projectsList, PROJECT_STATES } = require("../views/projectView");
const { afeView, sourcingOfAfe } = require("../views/afeView");
const { latestBudgetByIo, ioFigures } = require("../domain/budget");
const { computeFlags } = require("../domain/flags");
const reconNotes = require("../domain/reconNotes");
const aucReview = require("../domain/aucReview");
const snapshots = require("../ingest/snapshots");
const { KIND_NAMES } = require("../ingest");
const rbac = require("../domain/rbac");

// Aiden's own column order (the "AFE Balances" workbook, one row per internal order).
const CSV_COLUMNS = [
  "AFE name", "Order", "CC", "Function", "Sub-Function", "Cost Center Owner", "Functional lead",
  "Country", "Region", "Created", "Fiscal Year", "AFE Category", "Budget Category",
  "Reduction", "Budget", "Actual", "Commitment", "Allotted", "Available", "KOB1 actuals",
  // Appended, so Aiden's own order is untouched (R152).
  "Sourcing",
];

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const money2 = (n) => (typeof n === "number" && isFinite(n) ? (Math.round(n * 100) / 100).toFixed(2) : "");

module.exports = function projectRoutes({ repos }) {
  const r = express.Router();

  const load = async (req, res) => {
    const afe = await repos.afes.get(req.params.afeId);
    if (!afe) { res.status(404).json({ error: "no such AFE" }); return null; }
    return afe;
  };
  const canSee = async (afe, req) => (await afeView(repos, afe, req.ctx)).permissions.canView;
  const isFa = (req) => rbac.can(req.ctx, "fa.process");

  async function gather(req) {
    const afes = await repos.afes.all();
    const ios = await repos.ios.all();
    const { map } = await latestBudgetByIo(repos);
    const masterBatch = await snapshots.activeFor(repos, "io_master");
    const masterMap = new Map();
    if (masterBatch) for (const m of await repos.ioMaster.all((x) => x.batchId === masterBatch.id)) masterMap.set(m.ioNumber, m);
    return { afes, ios, budgetMap: map, masterMap, extracts: await snapshots.status(repos, KIND_NAMES) };
  }

  // ---- the list: aggregation first -----------------------------------------------------------
  r.get("/projects", async (req, res) => {
    res.json(await projectsList(repos, req.ctx, req.query));
  });

  // ---- does the tool still agree with SAP? ----------------------------------------------------
  r.get("/projects/reconcile", async (req, res) => {
    if (!rbac.can(req.ctx, "projects.read")) {
      return res.status(403).json({ error: "the reconciliation is for Fixed Assets, coordinators and leadership" });
    }
    const g = await gather(req);
    res.json(Object.assign(reconcile(g), { extracts: g.extracts }));
  });

  // ---- the tracker, in the column order the division already uses ------------------------------
  // One row per internal order, plus a row for an AFE that has none yet — "No IO" is a state
  // Aiden's workbook already carries, and so is "Non-SAP".
  r.get("/projects/export.csv", async (req, res) => {
    const { afes, ios, budgetMap, masterMap } = await gather(req);
    const roles = req.ctx.roles || [];
    const privileged = rbac.can(req.ctx, "projects.read");
    const email = req.ctx.user.email;
    const mine = (a) => (a.requester && a.requester.email === email) || (a.preparer && a.preparer.email === email) ||
      (roles.includes("coordinator") && (req.ctx.coordinatorFor || []).includes(a.division));
    const wanted = afes.filter((a) => PROJECT_STATES.includes(a.state) && (privileged || mine(a)))
      .filter((a) => !req.query.division || a.division === req.query.division)
      .filter((a) => !req.query.fy || String((a.schedule && a.schedule.fiscalYear) || "") === String(req.query.fy))
      .filter((a) => !req.query.sourcing || sourcingOfAfe(a) === req.query.sourcing);
    wanted.sort((a, b) => String(a.afeNo || "").localeCompare(String(b.afeNo || "")));

    const poBatch = await snapshots.activeFor(repos, "po_lines");
    const poByIo = new Map();
    if (poBatch) for (const p of await repos.poLines.all((x) => x.batchId === poBatch.id)) {
      if (!poByIo.has(p.ioNumber)) poByIo.set(p.ioNumber, []);
      poByIo.get(p.ioNumber).push(p);
    }
    const matrixCache = new Map();
    const ownerOf = async (cc) => {
      if (!cc) return "";
      if (!matrixCache.has(cc)) {
        const row = await repos.matrix.find((m) => m.costCenter === String(cc));
        matrixCache.set(cc, row && row.levels && row.levels.M1 ? row.levels.M1.name : "");
      }
      return matrixCache.get(cc);
    };

    const lines = [CSV_COLUMNS.join(",")];
    for (const afe of wanted) {
      const mineIos = ios.filter((i) => i.afeId === afe.id);
      const owner = await ownerOf(afe.costCenter);
      const rows = mineIos.length ? mineIos : [null];
      for (const io of rows) {
        const b = io ? budgetMap.get(io.ioNumber) || null : null;
        const po = io ? poByIo.get(io.ioNumber) || [] : [];
        const f = io ? ioFigures(io, b, po) : null;
        const m = io ? masterMap.get(io.ioNumber) || null : null;
        const reduction = io ? (io.budgetMoves || []).filter((x) => x.deltaUsd < 0).reduce((n, x) => n + Math.abs(x.deltaUsd), 0) : 0;
        lines.push([
          (afe.project && afe.project.title) || "",
          io ? io.ioNumber : (afe.nonSap ? "Non-SAP" : "No IO"),
          afe.costCenter || "",
          (m && m.function) || "",
          (m && m.subFunction) || "",
          owner,
          (afe.requester && afe.requester.name) || "",
          io ? io.country || "" : "",
          afe.region || "",
          (io && io.issuedAt ? io.issuedAt : (afe.fa && afe.fa.issuedAt) || afe.createdAt || "").slice(0, 10),
          (afe.schedule && afe.schedule.fiscalYear) || "",
          (afe.budget && afe.budget.afeCategory) || "",
          (afe.budget && afe.budget.budgetCategory) || "",
          reduction ? money2(reduction) : "",
          f ? money2(f.budgetUsd) : money2(afeRules.total(afe)),
          f ? money2(f.actualUsd) : "",
          f ? money2(f.commitmentUsd) : "",
          f ? money2(f.allottedUsd) : "",
          f ? money2(f.availableUsd) : "",
          money2(po.reduce((n, p) => n + (Number(p.invoicedUsd) || 0), 0)),
          { internal: "Acme inventory", vendor: "Vendor" }[sourcingOfAfe(afe)] || "",
        ].map(csvCell).join(","));
      }
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="afe-projects-${new Date().toISOString().slice(0, 10)}.csv"`);
    // A BOM so Excel opens it as UTF-8 rather than guessing; CRLF for the same reason.
    res.send("﻿" + lines.join("\r\n") + "\r\n");
  });

  // ---- one project ------------------------------------------------------------------------------
  r.get("/projects/:afeId", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!(await canSee(afe, req))) return res.status(403).json({ error: "not yours to view" });
    const view = await projectView(repos, afe, req.ctx);
    const g = await gather(req);
    const all = reconcile({ afes: [afe], ios: g.ios.filter((i) => i.afeId === afe.id), budgetMap: g.budgetMap, masterMap: g.masterMap, extracts: g.extracts });
    res.json(Object.assign(view, { findings: all.findings, extracts: g.extracts }));
  });

  // ---- a cost line gets its own order -------------------------------------------------------------
  r.post("/projects/:afeId/ios", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "add_child_io", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.status(201).json(Object.assign({ note: result.note }, await projectView(repos, afe, req.ctx)));
  });

  // ---- budget moves between the orders on one AFE ---------------------------------------------------
  r.post("/projects/:afeId/budget-moves", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "move_budget", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.status(201).json(Object.assign({ note: result.note }, await projectView(repos, afe, req.ctx)));
  });

  // ---- one internal order --------------------------------------------------------------------------
  // Both worlds meet here: an order this tool issued (its AFE, its PO lines, its moves) and a
  // legacy order that only the AuC recon file knows about.
  r.get("/io/:ioNumber", async (req, res) => {
    const number = String(req.params.ioNumber);
    const io = await repos.ios.find((x) => x.ioNumber === number);
    const afe = io ? await repos.afes.get(io.afeId) : await repos.afes.find((a) => a.afeNo === number);
    const reconRows = await repos.tracker.all((t) => t.ioNumber === number);
    if (!io && !afe && !reconRows.length) return res.status(404).json({ error: `no internal order ${number} in the tool or the AuC recon` });

    const roles = req.ctx.roles || [];
    const privileged = roles.some((x) => ["fa_preparer", "fa_checker", "leadership", "admin", "coordinator"].includes(x));
    if (afe) {
      if (!(await canSee(afe, req))) return res.status(403).json({ error: "not yours to view" });
    } else if (!privileged) {
      return res.status(403).json({ error: "that order predates the workbench — Fixed Assets and leadership can see it" });
    }

    const { map } = await latestBudgetByIo(repos);
    const poBatch = await snapshots.activeFor(repos, "po_lines");
    const poLines = poBatch ? await repos.poLines.all((p) => p.batchId === poBatch.id && p.ioNumber === number) : [];
    poLines.sort((a, b) => String(b.docDate || "").localeCompare(String(a.docDate || "")));
    const masterBatch = await snapshots.activeFor(repos, "io_master");
    const master = masterBatch ? await repos.ioMaster.find((m) => m.batchId === masterBatch.id && m.ioNumber === number) : null;

    const project = afe ? await projectView(repos, afe, req.ctx) : null;
    const row = io ? { ...io } : null;
    res.json({
      ioNumber: number,
      io: row,
      figures: io ? ioFigures(io, map.get(number) || null, poLines) : (map.get(number) ? ioFigures({ ioNumber: number, kind: "parent" }, map.get(number), poLines) : null),
      poLines,
      master,
      project,
      // Which quarter "in this quarter's review" means. It was a chip that named no period, so
      // it aged silently: read in October it still said "this quarter" about July's population.
      // `aucReview.periodOf` is the domain's own naming and is what the review screen uses, so
      // the two can never say different things about the same line.
      reviewPeriod: aucReview.periodOf(new Date()),
      // The follow-up history, split back into the entries it is made of (R126). Derived here,
      // never stored, so a re-import needs no migration.
      auc: reconRows.map((t) => Object.assign({}, t, {
        flags: computeFlags(t, map.get(t.ioNumber) || null, t.esdHistory, new Date()),
        thread: reconNotes.threadFor(t.comments),
        // Whether THIS viewer may record the reviewer's answer — the server's rule, so the button
        // is offered exactly where the route accepts it (it was shown to everybody).
        canReply: aucReview.mayAnswerFor(req.ctx, t),
      })),
      moves: io ? ioRegistry.moveHistory([io]) : [],
    });
  });

  return r;
};

module.exports.CSV_COLUMNS = CSV_COLUMNS;
