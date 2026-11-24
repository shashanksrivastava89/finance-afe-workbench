"use strict";
const express = require("express");
const { computeFlags } = require("../domain/flags");
const { latestBudgetByIo } = require("../domain/budget");
const audit = require("../audit");
const rbac = require("../domain/rbac");
const { mayAnswerFor } = require("../domain/aucReview");
const { sourcingOfAfe } = require("../views/afeView");

/**
 * What a recon line says about the AFE behind it, if the tool issued its order. Pure, so the join
 * is checked without a recon line the seed cannot have: a recon line only ever carries an order
 * the tool issued once SAP has reported it, and an order number SAP already held for something
 * else is refused at record-io (`ioRegistry.sapConflict`).
 *
 * What the AFE says the money is FOR (R165) — "management wants to see what the AuC is about"
 * (Imogen, Meeting #7). The recon line's own description is the order's SAP name, 40 characters
 * typed at KO01; the AFE's title and description are what the approvers read. Where the equipment
 * came from (R152) is known the same way. A line that predates the tool has no AFE to say either,
 * and stays blank until the AuC-to-AFE mapping exists.
 */
function afeFacts(line, afeById, afeOfIo) {
  const afe = (line.afeId && afeById.get(line.afeId)) || afeOfIo.get(String(line.ioNumber)) || null;
  return {
    sourcing: afe ? sourcingOfAfe(afe) : null, afeId: line.afeId || (afe ? afe.id : null),
    afeTitle: afe ? (afe.project && afe.project.title) || null : null,
    afeDescription: afe ? (afe.project && afe.project.description) || null : null,
  };
}

module.exports = function trackerRoutes({ repos }) {
  const r = express.Router();

  async function decorated() {
    const { map, batch } = await latestBudgetByIo(repos);
    const now = new Date();
    const afeOfIo = new Map();
    const afes = new Map((await repos.afes.all()).map((a) => [a.id, a]));
    for (const io of await repos.ios.all()) if (afes.has(io.afeId)) afeOfIo.set(String(io.ioNumber), afes.get(io.afeId));
    const items = [];
    for (const t of await repos.tracker.all()) {
      const budget = map.get(t.ioNumber) || null;
      items.push(Object.assign({}, t, { flags: computeFlags(t, budget, t.esdHistory, now), budget }, afeFacts(t, afes, afeOfIo)));
    }
    return { items, batch };
  }

  // 528 lines with balances and reviewers: Fixed Assets' and leadership's, as the section is.
  // The route used to answer anybody signed in, while only the top bar knew who it was for.
  const mayRead = (req) => rbac.can(req.ctx, "tracker.read");
  const refuse = (res) => res.status(403).json({ error: "The AuC tracker is Fixed Assets' and leadership's." });

  r.get("/tracker", async (req, res) => {
    if (!mayRead(req)) return refuse(res);
    let { items, batch } = await decorated();
    if (req.query.companyCode) items = items.filter((i) => i.companyCode === req.query.companyCode);
    if (req.query.status === "open") items = items.filter((i) => (i.openClosed || "").toLowerCase() === "open");
    if (req.query.flag === "1") items = items.filter((i) => i.flags.followUpNeeded);
    if (req.query.flag && req.query.flag !== "1") items = items.filter((i) => i.flags.reasons.includes(req.query.flag));
    if (req.query.sourcing) items = items.filter((i) => i.sourcing === req.query.sourcing);
    items.sort((a, b) => (b.endingBalance || 0) - (a.endingBalance || 0));
    res.json({ asOf: batch ? batch.asOfDate : null, count: items.length, items });
  });

  function sendCsv(res, items) {
    const cols = ["companyCode", "ioNumber", "ioDescription", "contactPersonName", "division", "costCenter",
      "glAccount", "aucNumber", "aucStatus", "capexUsd", "endingBalance", "commitment", "openAfeAmount", "issueDate", "sourcing"];
    const esc = (v) => `"${String(v === null || v === undefined ? "" : v).replace(/"/g, '""')}"`;
    // The AFE's own words go LAST (R165), so every column anybody already reads by position stays
    // where it was.
    const lines = [cols.concat(["consumedPct", "ageingDays", "flags", "afeTitle", "afeDescription"]).join(",")];
    for (const i of items) {
      lines.push(cols.map((c) => esc(i[c])).concat([i.flags.consumedPct, i.flags.ageingDays, esc(i.flags.reasons.join("|")),
        esc(i.afeTitle), esc(i.afeDescription)]).join(","));
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="auc-tracker.csv"');
    res.send(lines.join("\r\n"));
  }

  r.get("/tracker/export.csv", async (req, res) => {
    if (!mayRead(req)) return refuse(res);
    sendCsv(res, (await decorated()).items);
  });

  // The lines the screen is SHOWING, in its order. The CSV button exported all 528 while a
  // division, a search or a bucket was on, so the file and the screen disagreed about what was
  // asked for. The filtering stays in one place (the screen); this takes its answer, by id.
  r.post("/tracker/export.csv", async (req, res) => {
    if (!mayRead(req)) return refuse(res);
    const ids = Array.isArray((req.body || {}).ids) ? req.body.ids.map(String) : null;
    if (!ids) return res.status(400).json({ error: "Say which lines: ids is a list." });
    const byId = new Map((await decorated()).items.map((i) => [String(i.id), i]));
    sendCsv(res, ids.map((id) => byId.get(id)).filter(Boolean));
  });

  r.post("/tracker/:id/comments", async (req, res) => {
    const t = await repos.tracker.get(req.params.id);
    if (!t) return res.status(404).json({ error: "tracker item not found" });
    if (!mayAnswerFor(req.ctx, t)) return res.status(403).json({ error: "Fixed Assets, or the line's own reviewer, write on a recon line." });
    if (!req.body || !req.body.body) return res.status(422).json({ error: "comment body required" });
    t.comments.push({
      kind: req.body.kind === "reviewer_note" ? "reviewer_note" : "preparer_note",
      body: String(req.body.body), authorEmail: req.ctx.user.email,
      authorName: req.ctx.userRow.displayName, createdAt: new Date().toISOString(),
    });
    await repos.tracker.update(t.id, t);
    // Every comment is on the record, not only those on a line the tool issued.
    const afe = t.afeId ? await repos.afes.get(t.afeId) : null;
    await audit.record(repos, req.ctx, { entity: "tracker", entityId: t.id, afeId: afe ? afe.id : null,
      type: "tracker_comment", payload: { ioNumber: t.ioNumber } });
    res.status(201).json(t.comments[t.comments.length - 1]);
  });

  r.post("/tracker/:id/esd", async (req, res) => {
    const t = await repos.tracker.get(req.params.id);
    if (!t) return res.status(404).json({ error: "tracker item not found" });
    if (!mayAnswerFor(req.ctx, t)) return res.status(403).json({ error: "Fixed Assets, or the line's own reviewer, record its in-service date." });
    const b = req.body || {};
    if (!b.estimatedServiceDate) return res.status(422).json({ error: "estimatedServiceDate required" });
    t.esdHistory.push({
      estimatedServiceDate: b.estimatedServiceDate,
      kind: b.kind === "firm_commitment" ? "firm_commitment" : "reforecast",
      note: b.note || "", enteredByEmail: req.ctx.user.email, enteredAt: new Date().toISOString(),
    });
    await repos.tracker.update(t.id, t);
    await audit.record(repos, req.ctx, { entity: "tracker", entityId: t.id, afeId: t.afeId || null, type: "tracker_esd",
      payload: { ioNumber: t.ioNumber, estimatedServiceDate: b.estimatedServiceDate, kind: t.esdHistory[t.esdHistory.length - 1].kind } });
    res.status(201).json(t.esdHistory[t.esdHistory.length - 1]);
  });

  return r;
};

module.exports.afeFacts = afeFacts;
