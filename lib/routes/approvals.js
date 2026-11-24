"use strict";
// The approver's side: what is waiting for me, the decision context (R55), and the four
// things a recipient can do — sign (simulated envelopes only), ask, send back, decline.
// Every state change goes through stateMachine.applyTransition.
const express = require("express");
const stateMachine = require("../domain/stateMachine");
const reminders = require("../domain/reminders");
const people = require("../domain/people");
const { afeView, afeBrief } = require("../views/afeView");
const { decisionView } = require("../views/decisionView");

const ACTIONS = { sign: "recipient_signed", question: "question", "send-back": "send_back", decline: "decline" };

module.exports = function approvalRoutes({ repos }) {
  const r = express.Router();

  // ---- my inbox: to sign · on hold (my question is out) · signed · copies ----------------------
  r.get("/approvals/mine", async (req, res) => {
    const routings = await repos.routings.all((x) => ["active", "completed"].includes(x.status));
    const now = new Date().toISOString();
    const out = { toSign: [], onHold: [], signed: [], copies: [] };
    for (const rt of routings) {
      const mine = rt.recipients.filter((rec) => people.userMatches(req.ctx, rec));
      if (!mine.length) continue;
      const afe = await repos.afes.get(rt.afeId);
      if (!afe) continue;
      const envelope = afe.envelopeId ? await repos.envelopes.get(afe.envelopeId) : null;
      const brief = afeBrief(afe);
      for (const rec of mine) {
        const item = {
          afe: brief,
          recipient: { id: rec.id, role: rec.role, level: rec.level, group: rec.group, status: rec.status, order: rec.order,
            since: rec.notifiedAt, days: reminders.daysWaiting(rec, now), signedAt: rec.signedAt, why: rec.why },
          provider: envelope ? envelope.provider : null,
          simulated: !envelope || envelope.provider === "simulated",
        };
        if (rec.role === "cc") { if (rt.status === "completed") out.copies.push(item); continue; }
        if (rec.status === "sent" && afe.state === "in_approval") out.toSign.push(item);
        else if (rec.status === "sent" && afe.state === "on_hold") out.onHold.push(item);
        else if (rec.status === "signed") out.signed.push(item);
      }
    }
    out.toSign.sort((a, b) => String(a.recipient.since).localeCompare(String(b.recipient.since)));
    out.onHold.sort((a, b) => String(a.recipient.since).localeCompare(String(b.recipient.since)));
    out.signed.sort((a, b) => String(b.recipient.signedAt).localeCompare(String(a.recipient.signedAt)));
    out.signed = out.signed.slice(0, 50);
    out.copies = out.copies.slice(0, 50);
    res.json({ counts: { toSign: out.toSign.length, onHold: out.onHold.length, signed: out.signed.length, copies: out.copies.length }, ...out });
  });

  // ---- the decision context -------------------------------------------------------------------
  r.get("/afes/:id/decision", async (req, res) => {
    const afe = await repos.afes.get(req.params.id);
    if (!afe) return res.status(404).json({ error: "no such AFE" });
    const v = await afeView(repos, afe, req.ctx);
    if (!v.permissions.canView) return res.status(403).json({ error: "this AFE is not routed to you" });
    res.json(await decisionView(repos, afe, req.ctx));
  });

  // ---- act as a recipient ---------------------------------------------------------------------
  r.post("/afes/:id/recipients/:rid/:action(sign|question|send-back|decline)", async (req, res) => {
    const afe = await repos.afes.get(req.params.id);
    if (!afe) return res.status(404).json({ error: "no such AFE" });
    const routing = afe.routingId ? await repos.routings.get(afe.routingId) : null;
    const rec = routing ? routing.recipients.find((x) => x.id === req.params.rid) : null;
    if (!rec) return res.status(404).json({ error: `no recipient ${req.params.rid} on this AFE's chain` });
    if (!people.userMatches(req.ctx, rec)) return res.status(403).json({ error: `${rec.name}'s step is not yours to act on` });
    const payload = Object.assign({}, req.body || {}, { recipientId: rec.id });
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, ACTIONS[req.params.action], payload);
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.json({ note: result.note, decision: await decisionView(repos, afe, req.ctx) });
  });

  return r;
};
