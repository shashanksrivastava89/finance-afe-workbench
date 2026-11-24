"use strict";
// S7 — the AUC quarterly review. Read-time derivation over the tracker: nothing about
// the review population is stored, because it changes with every budget refresh and a
// stored copy would desynchronize the control from the data it controls.
const express = require("express");
const aucReview = require("../domain/aucReview");
const { latestBudgetByIo } = require("../domain/budget");
const rbac = require("../domain/rbac");
const audit = require("../audit");

module.exports = function aucReviewRoutes({ repos }) {
  const r = express.Router();

  async function review(period) {
    const { map } = await latestBudgetByIo(repos);
    return aucReview.buildReview(await repos.tracker.all(), map, { period });
  }

  /** The last four quarters, so the screen can look back without anyone typing a period. */
  function recentPeriods(current) {
    const out = [];
    const end = aucReview.periodEnd(current) || new Date();
    for (let i = 0; i < 4; i++) {
      const d = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - i * 3, 1));
      const p = aucReview.periodOf(d);
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  // The whole review for a period: population, exclusions, reason counts, division packs, and
  // for each pack whether it has gone out and whether the reviewer has answered — derived from
  // the notes on the lines, never stored a second time.
  // Who may read the review. It lists every open AuC line with its balance and reviewer, so it
  // is Fixed Assets' and leadership's (`tracker.read`) — and the portfolio's, which draws its
  // "why hasn't it capitalized" from the same population (`portfolio.read`, coordinators too).
  // It was open to anybody signed in, and everybody signed in is a requester.
  const mayRead = (req) => rbac.can(req.ctx, "tracker.read") || rbac.can(req.ctx, "portfolio.read");

  r.get("/auc-review", async (req, res) => {
    if (!mayRead(req)) return res.status(403).json({ error: "The AuC review is Fixed Assets' and leadership's." });
    const out = await review(req.query.period);
    const byId = new Map((await repos.tracker.all()).map((t) => [t.id, t]));
    const withRows = (pack) => Object.assign({}, pack, { lines: pack.lines.map((l) => byId.get(l.id) || l) });
    for (const div of out.divisions) {
      for (const pack of div.packs) pack.status = aucReview.packStatus(withRows(pack), out.period);
    }
    out.periods = recentPeriods(out.period);
    res.json(out);
  });

  // One reviewer's confirmation pack, drafted deterministically.
  r.get("/auc-review/packs/:division/:reviewer", async (req, res) => {
    if (!rbac.can(req.ctx, "tracker.read")) return res.status(403).json({ error: "A review pack is Fixed Assets' to draft." });
    const out = await review(req.query.period);
    const div = out.divisions.find((d) => d.division === req.params.division);
    if (!div) return res.status(404).json({ error: "no lines for that division this period" });
    const pack = div.packs.find((p) => p.reviewerName === req.params.reviewer);
    if (!pack) return res.status(404).json({ error: "no lines for that reviewer this period" });
    res.json({
      draft: aucReview.buildPack(div.division, pack, out.period),
      csv: aucReview.packCsv(Object.assign({ division: div.division }, pack), out.period),
      lineCount: pack.lineCount,
      // The lines the pack covers, so the screen can show what the email claims and open
      // any one of them: a reply is recorded against a line, not against the pack.
      lines: pack.lines.map((l) => ({
        id: l.id, ioNumber: l.ioNumber, ioDescription: l.ioDescription, aucNumber: l.aucNumber,
        endingBalance: l.endingBalance, consumedPct: l.consumedPct, ageingDays: l.ageingDays,
        estimatedServiceDate: l.estimatedServiceDate || null, answeredAt: l.answeredAt || null,
      })),
    });
  });

  // Record that a pack went out. This is the entry the recon file keeps by hand today
  // ("05/14/2026 - AUC File Sent for Quarterly Control..."), written to every line in
  // the pack so the next quarter can see what was already chased.
  r.post("/auc-review/packs/sent", async (req, res) => {
    // Running the review is Fixed Assets' (`aucreview.run`). Recording a pack as sent was open to
    // anybody signed in, and it is the entry next quarter reads to see what was already chased.
    if (!rbac.can(req.ctx, "aucreview.run")) return res.status(403).json({ error: "Only Fixed Assets record a review pack as sent." });
    const b = req.body || {};
    if (!Array.isArray(b.ioNumbers) || !b.ioNumbers.length) {
      return res.status(422).json({ error: "ioNumbers is required" });
    }
    const period = b.period || aucReview.periodOf(new Date());
    const stamp = new Date().toISOString().slice(0, 10);
    const who = req.ctx.userRow.displayName;
    let touched = 0;
    for (const item of await repos.tracker.all()) {
      if (b.ioNumbers.indexOf(item.ioNumber) < 0) continue;
      item.comments = item.comments || [];
      item.comments.push({
        kind: "preparer_note",
        body: stamp + " - " + period + " AUC review pack sent to " +
          (b.reviewerName || "the responsible reviewer") + (b.simulated ? " (simulated)" : ""),
        authorEmail: req.ctx.user.email, authorName: who, createdAt: stamp,
      });
      await repos.tracker.update(item.id, item);
      touched += 1;
    }
    await audit.record(repos, req.ctx, { entity: "auc_review", entityId: period, type: "auc_pack_sent",
      payload: { period, reviewerName: b.reviewerName || null, ioNumbers: b.ioNumbers, lines: touched, simulated: Boolean(b.simulated) } });
    res.json({ ok: true, lines: touched, period });
  });

  // A reviewer's answer, recorded against one line: a comment in the file's own dated
  // format, and — when they give one — a new estimated service date. Both are evidence,
  // so neither overwrites what was there before.
  r.post("/auc-review/lines/:id/reply", async (req, res) => {
    const item = await repos.tracker.get(req.params.id);
    if (!item) return res.status(404).json({ error: "tracker line not found" });
    // A committed date takes the line out of the review, so this is a control, not a note.
    if (!aucReview.mayAnswerFor(req.ctx, item)) {
      return res.status(403).json({ error: `Fixed Assets record the answer${item.reviewerName ? `, or ${item.reviewerName} gives it` : ""}.` });
    }
    const b = req.body || {};
    if (!b.comment && !b.estimatedServiceDate) {
      return res.status(422).json({ error: "a comment or an estimated service date is required" });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    if (b.comment) {
      item.comments = item.comments || [];
      item.comments.push({
        kind: "reviewer_note",
        body: stamp + " - " + (b.reviewerName || "Reviewer") + " - " + b.comment,
        authorEmail: req.ctx.user.email, authorName: req.ctx.userRow.displayName, createdAt: stamp,
      });
    }
    if (b.estimatedServiceDate) {
      item.esdHistory = item.esdHistory || [];
      item.esdHistory.push({
        estimatedServiceDate: b.estimatedServiceDate,
        // A date the reviewer has actually committed to is what rule 4 excludes on.
        kind: b.firm ? "firm_commitment" : "reforecast",
        note: "confirmed in the " + (b.period || aucReview.periodOf(new Date())) + " AUC review",
        enteredByEmail: req.ctx.user.email, enteredAt: stamp,
      });
    }
    await repos.tracker.update(item.id, item);
    await audit.record(repos, req.ctx, { entity: "tracker", entityId: item.id, afeId: item.afeId || null, type: "auc_reply_recorded",
      payload: { ioNumber: item.ioNumber, reviewerName: b.reviewerName || item.reviewerName || null,
        estimatedServiceDate: b.estimatedServiceDate || null, firm: Boolean(b.firm), comment: b.comment || null } });
    res.json({ ok: true, line: item.id });
  });

  return r;
};
