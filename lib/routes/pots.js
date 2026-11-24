"use strict";
// Budget pots for the coordinator's dashboard (R53): the annual budget by division ×
// category × region, and what the AFEs have spoken for. Every figure is derived at read
// time from the AFEs — nothing on this screen is typed.
//
// Allotted, Actual and Commitment come from the internal orders and the latest active SAP
// budget extract, joined at read time: a fresh extract moves every figure on this screen at
// once, and an order that is not in the extract yet is counted as allotted but not spent.
const express = require("express");
const afeRules = require("../domain/afeRules");
const { latestBudgetByIo } = require("../domain/budget");
const rbac = require("../domain/rbac");

// "AFE created" = sent or beyond. Drafts, returned, withdrawn and rejected AFEs have not
// spoken for anything.
// The seeded amounts are round dummies (seed/budget-pots.json). A pot still holding one — a seeded
// id never edited since — is a placeholder; once a division loads or edits its own, it is not.
// The screen used to say "Figures are placeholders" whatever it was showing.
const SEEDED = new Set(((() => { try { return require("../../seed/budget-pots.json").pots; } catch { return []; } })()).map((p) => p.id));
const isPlaceholder = (p) => SEEDED.has(p.id) && (p.version || 1) === 1;

const CREATED_STATES = ["in_approval", "on_hold", "approved", "fa_review", "issued", "tracking", "capitalized", "closed"];
const ISSUED_STATES = ["issued", "tracking", "capitalized", "closed"];

module.exports = function potRoutes({ repos }) {
  const r = express.Router();

  r.get("/pots", async (req, res) => {
    const roles = req.ctx.roles || [];
    // Anyone may see which pots exist for a division — the wizard asks "which budget does this
    // come out of?" — but the amounts are the coordinator's, Fixed Assets' and leadership's.
    const seesAmounts = rbac.can(req.ctx, "pots.read");

    // WHOSE pots you may see (R128). Two things were wrong here and they pulled in opposite
    // directions.
    //
    // (1) Holding `coordinator` NARROWED you. The ternary pinned anyone with a `coordinatorFor`
    //     list to those divisions — even when they also held `leadership` or an FA role, which on
    //     their own see everything. So an account holding both saw strictly less than one holding
    //     only the wider role, with no precedence rule anywhere. That is why this screen showed
    //     CORP_IT and nothing else to the person who owns the whole portfolio.
    // (2) `?division=` overrode the pin with NO CHECK AT ALL. A coordinator for one division
    //     could read another division's amounts by typing the parameter. It was a read of
    //     business figures, not a leak of personal data, but it was still an authorisation gap
    //     sitting behind a screen that had no switcher — so nobody had found it.
    //
    // Now: a wide role may choose any division; a coordinator may choose among their own; and
    // asking for one outside your set is refused rather than quietly served.
    const wide = rbac.can(req.ctx, "pots.all");
    const mine = roles.includes("coordinator") ? (req.ctx.coordinatorFor || []) : [];
    const allowed = wide ? null : (mine.length ? mine : null);
    const asked = req.query.division ? String(req.query.division) : null;
    if (asked && allowed && !allowed.includes(asked)) {
      return res.status(403).json({ error: `not yours to see — you coordinate ${allowed.join(", ")}` });
    }
    const divisions = asked ? [asked] : allowed;
    if (!seesAmounts && !divisions) return res.status(403).json({ error: "say which division's pots you mean (?division=)" });
    const fy = req.query.fy ? Number(req.query.fy) : null;

    const pots = await repos.budgetPots.all((p) => (!divisions || divisions.includes(p.division)) && (!fy || p.fiscalYear === fy));
    if (!seesAmounts) {
      return res.json({ divisions, lite: true, pots: pots.map((p) => ({ id: p.id, division: p.division, fiscalYear: p.fiscalYear, budgetCategory: p.budgetCategory, region: p.region })) });
    }
    const everyDivision = Array.from(new Set((await repos.budgetPots.all()).map((p) => p.division))).filter(Boolean).sort();
    const allDivisions = wide ? everyDivision : (allowed || []).filter((d) => everyDivision.includes(d));
    const afes = await repos.afes.all((a) => a.budget && a.budget.potId && CREATED_STATES.includes(a.state));
    // The years THIS division actually has. Computed over every pot before, so the chips could
    // offer a year with nothing behind it once a second division loads its own.
    const inScope = await repos.budgetPots.all((p) => !divisions || divisions.includes(p.division));
    const years = Array.from(new Set(inScope.map((p) => p.fiscalYear))).sort();
    // What SAP reports against the orders these AFEs produced.
    const { map, batch } = await latestBudgetByIo(repos);
    const ios = await repos.ios.all();
    const iosByAfe = new Map();
    for (const io of ios) {
      if (!iosByAfe.has(io.afeId)) iosByAfe.set(io.afeId, []);
      iosByAfe.get(io.afeId).push(io);
    }
    const sapFor = (afe) => {
      const mineIos = iosByAfe.get(afe.id) || [];
      let actual = 0, commitment = 0, inExtract = false;
      for (const io of mineIos) {
        const row = map.get(io.ioNumber);
        if (!row) continue;
        inExtract = true;
        actual += Number(row.actual) || 0;
        commitment += Number(row.commitment) || 0;
      }
      return { actual, commitment, orders: mineIos.length, inExtract };
    };

    const rows = pots.map((p) => {
      const mine = afes.filter((a) => a.budget.potId === p.id);
      const createdUsd = mine.reduce((n, a) => n + afeRules.total(a), 0);
      const issued = mine.filter((a) => ISSUED_STATES.includes(a.state));
      const allottedUsd = issued.reduce((n, a) => n + afeRules.total(a), 0);
      const sap = issued.map(sapFor);
      const actualUsd = sap.reduce((n, s) => n + s.actual, 0);
      const commitmentUsd = sap.reduce((n, s) => n + s.commitment, 0);
      return {
        id: p.id, division: p.division, fiscalYear: p.fiscalYear, budgetCategory: p.budgetCategory, region: p.region,
        amountUsd: p.amountUsd, createdUsd, allottedUsd,
        actualUsd, commitmentUsd, orders: sap.reduce((n, s) => n + s.orders, 0),
        inExtract: sap.some((s) => s.inExtract),
        availableUsd: p.amountUsd - createdUsd,
        afes: mine.map((a) => ({ id: a.id, title: (a.project && a.project.title) || "(untitled)", state: a.state, totalUsd: afeRules.total(a),
          requester: a.requester || null, costCenter: a.costCenter || null,
          ioNumber: (iosByAfe.get(a.id) || []).filter((i) => i.kind === "parent").map((i) => i.ioNumber)[0] || a.afeNo || null })),
      };
    });

    // Aggregation first: the categories, then the regions under each.
    const byCategory = {};
    for (const row of rows) {
      const c = byCategory[row.budgetCategory] || (byCategory[row.budgetCategory] = { budgetCategory: row.budgetCategory, amountUsd: 0, createdUsd: 0, allottedUsd: 0, actualUsd: 0, commitmentUsd: 0, regions: [] });
      c.amountUsd += row.amountUsd; c.createdUsd += row.createdUsd; c.allottedUsd += row.allottedUsd;
      c.actualUsd += row.actualUsd; c.commitmentUsd += row.commitmentUsd; c.regions.push(row);
    }
    const categories = Object.values(byCategory).map((c) => Object.assign(c, { availableUsd: c.amountUsd - c.createdUsd }))
      .sort((a, b) => b.amountUsd - a.amountUsd);
    const totals = rows.reduce((t, x) => ({ amountUsd: t.amountUsd + x.amountUsd, createdUsd: t.createdUsd + x.createdUsd,
      allottedUsd: t.allottedUsd + x.allottedUsd, actualUsd: t.actualUsd + x.actualUsd, commitmentUsd: t.commitmentUsd + x.commitmentUsd }),
      { amountUsd: 0, createdUsd: 0, allottedUsd: 0, actualUsd: 0, commitmentUsd: 0 });
    res.json({
      divisions: divisions || Array.from(new Set(rows.map((x) => x.division))),
      // What this caller may switch to, which is not the same as what they are looking at.
      // `null` from `allDivisions` would mean "no choice"; a list means the screen draws a picker.
      canChoose: allDivisions.length > 1 ? allDivisions : [],
      fiscalYears: years, fiscalYear: fy,
      totals: Object.assign(totals, { availableUsd: totals.amountUsd - totals.createdUsd, afes: afes.filter((a) => pots.some((p) => p.id === a.budget.potId)).length }),
      categories,
      pots: rows,
      placeholders: pots.filter(isPlaceholder).length,
      extract: batch ? { batchId: batch.id, asOfDate: batch.asOfDate, importedAt: batch.importedAt } : null,
    });
  });

  return r;
};
