"use strict";
// Admin › Features, and the reminder ladder that lives in the same settings document.
//
// Mounted onto the admin router, so it inherits the admin guard.
//
// A flag is a small thing with a large blast radius, so every answer here says more than on/off:
// what the capability actually does, what it still needs before it can work, what happens
// instead while it is off, and — when the environment has locked it — that no one can turn it on
// here whatever they click. An administrator should never have to ask someone what a switch does.
const express = require("express");
const features = require("../domain/features");
const { REMINDER_LADDER } = require("../domain/refData");
const audit = require("../audit");

const REMINDERS_ID = "reminders";

/** The ladder in force: what Admin saved, or the shipped default. */
async function ladder(repos) {
  const doc = await repos.settings.get(REMINDERS_ID);
  return (doc && doc.ladder) || REMINDER_LADDER;
}

function cleanLadder(body) {
  const b = body || {};
  const steps = Array.isArray(b.steps) ? b.steps : null;
  if (!steps || !steps.length) throw new Error("a ladder needs at least one step");
  if (steps.length > 6) throw new Error("six steps is plenty — more is noise, not follow-up");
  const out = [];
  let last = 0;
  for (let i = 0; i < steps.length; i += 1) {
    const s = steps[i] || {};
    const afterDays = Number(s.afterDays);
    if (!Number.isFinite(afterDays) || afterDays < 1 || afterDays > 90) {
      throw new Error(`step ${i + 1}: "after days" must be between 1 and 90`);
    }
    if (afterDays <= last) throw new Error(`step ${i + 1}: each step has to wait longer than the one before it`);
    last = afterDays;
    const cc = s.cc === "coordinator" || s.cc === "requester" ? s.cc : null;
    const every = s.every === undefined || s.every === null || s.every === "" ? null : Number(s.every);
    if (every !== null && (!Number.isFinite(every) || every < 1 || every > 30)) {
      throw new Error(`step ${i + 1}: "repeat every" must be between 1 and 30 days`);
    }
    out.push({ afterDays, cc, every, label: String(s.label || "").slice(0, 60) || `Reminder ${i + 1}` });
  }
  const multiplier = Number(b.slowMultiplier === undefined ? REMINDER_LADDER.slowMultiplier : b.slowMultiplier);
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 5) {
    throw new Error("the senior-approver multiplier must be between 1 and 5");
  }
  const slowLevels = Array.isArray(b.slowLevels) ? b.slowLevels.map((x) => String(x).trim().toUpperCase()).filter(Boolean)
    : REMINDER_LADDER.slowLevels;
  return { steps: out, slowLevels, slowMultiplier: multiplier };
}

module.exports = function adminFeatureRoutes({ repos, router }) {
  const r = router || express.Router();

  // Who changed a flag, by name: the setting keeps the mailbox, and a mailbox is not a person.
  async function named(list) {
    const users = await repos.users.all();
    const nameOf = (email) => { const u = users.find((x) => String(x.email || "").toLowerCase() === String(email || "").toLowerCase()); return u ? u.displayName : String(email || "").split("@")[0].replace(/[._]/g, " "); };
    return list.map((f) => (f.changedBy ? Object.assign({}, f, { changedByName: nameOf(f.changedBy) }) : f));
  }

  r.get("/admin/features", async (req, res) => {
    try {
      // The reader's last failure, said where the switch is — it used to be said only in a
      // requester's history. A success after it clears it.
      const reads = (await repos.auditEvents.all((e) => e.type === "quote_read" || e.type === "quote_read_failed"))
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      const lastRead = reads[0] || null;
      const list = (await features.all(repos)).map((f) => (f.name === "quoteReading" && lastRead && lastRead.type === "quote_read_failed"
        ? Object.assign({}, f, { lastError: { at: lastRead.createdAt, reason: (lastRead.payload || {}).reason || null, code: (lastRead.payload || {}).code || null } })
        : f));
      res.json({
        features: await named(list),
        locked: features.lockedNames(),
        // Said once, here, so the screen does not have to explain it in prose: a flag is only
        // ever about what is OFFERED. Turning one off never invalidates anything already stored.
        note: "Every feature below has a deterministic path behind it that stays in the product. "
          + "Turning one off is always safe — it changes what the tool offers next, never what it "
          + "has already recorded.",
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.put("/admin/features/:name", async (req, res) => {
    const name = req.params.name;
    const on = Boolean(req.body && req.body.on);
    try {
      const before = await features.isOn(repos, name);
      const state = await features.set(repos, req.ctx, name, on);
      if (before !== on) {
        await audit.record(repos, req.ctx, {
          entity: "settings", entityId: "features", type: on ? "feature_enabled" : "feature_disabled",
          payload: { feature: name, was: before, now: on },
        });
      }
      res.json({ name, state, features: await named(await features.all(repos)) });
    } catch (e) { res.status(409).json({ error: e.message }); }
  });

  // ---- the reminder ladder ---------------------------------------------------------------------

  r.get("/admin/settings/reminders", async (req, res) => {
    try {
      res.json({
        ladder: await ladder(repos),
        default: REMINDER_LADDER,
        help: "Days are counted from the moment the chain reached that person. A step with "
          + "\"repeat every\" keeps nudging at that interval until they act. Senior approvers wait "
          + "the multiplier times longer before the first reminder.",
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  r.put("/admin/settings/reminders", async (req, res) => {
    try {
      const next = cleanLadder(req.body);
      const doc = await repos.settings.get(REMINDERS_ID);
      if (doc) await repos.settings.update(REMINDERS_ID, { ladder: next });
      else await repos.settings.insert({ id: REMINDERS_ID, ladder: next });
      await audit.record(repos, req.ctx, {
        entity: "settings", entityId: "reminders", type: "reminder_ladder_changed",
        payload: { steps: next.steps, slowMultiplier: next.slowMultiplier },
      });
      res.json({ ladder: next });
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  return r;
};

module.exports.ladder = ladder;
module.exports.REMINDERS_ID = REMINDERS_ID;
