"use strict";
// The reminders job (R54): nudge whoever has held an in-approval AFE longer than the
// cadence. One outbox row per nudge, the stamp on the recipient, one audit event — and a
// second run the same day does nothing, because due-ness is derived from the stamps.
const notify = require("../notify");
const audit = require("../audit");
const reminders = require("../domain/reminders");
const { REMINDER_DAYS } = require("../domain/refData");

const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");

/**
 * @param {object} repos
 * @param {object} opts { olderThanDays?, now? } — a manual run may shorten the window
 */
async function run(repos, opts) {
  const o = opts || {};
  const days = o.olderThanDays !== undefined && o.olderThanDays !== null
    ? Number(o.olderThanDays)
    : Number(process.env.REMINDER_DAYS || REMINDER_DAYS);
  const now = o.now || new Date().toISOString();
  const active = await repos.routings.all((r) => r.status === "active");
  let checked = 0, reminded = 0;
  const details = [];
  for (const routing of active) {
    const afe = await repos.afes.get(routing.afeId);
    if (!afe || afe.state !== "in_approval") continue;
    // A LIVE envelope is reminded by DocuSign on the envelope's own schedule (envelopeSpec), so a
    // reminder from here would be the second one that day (R164).
    const envelope = afe.envelopeId ? await repos.envelopes.get(afe.envelopeId) : null;
    if (envelope && envelope.provider && envelope.provider !== "simulated") continue;
    checked += 1;
    const total = ((afe.money && afe.money.capexUsd) || 0) + ((afe.money && afe.money.opexUsd) || 0) + ((afe.money && afe.money.cloudCapexUsd) || 0);
    let touched = false;
    for (const rec of reminders.dueRecipients(routing, now, days)) {
      if (!rec.email) continue;
      const title = (afe.project && afe.project.title) || "(untitled AFE)";
      const waiting = reminders.daysWaiting(rec, now);
      await notify.enqueue(repos, {
        recipientEmail: rec.email, recipientName: rec.name, afeId: afe.id, kind: "reminder",
        subject: `Reminder: ${title} is waiting for your signature`,
        body: `"${title}" · ${money(total)} · cost centre ${afe.costCenter || "?"}\n` +
          `It has been with you ${waiting === null ? "for a while" : waiting + " day" + (waiting === 1 ? "" : "s")}. ` +
          `Open ${notify.link(`/approve/${afe.id}`)} to sign, ask a question or send it back.`,
      });
      rec.remindedAt = (rec.remindedAt || []).concat([now]);
      touched = true;
      reminded += 1;
      details.push({ afeId: afe.id, recipientId: rec.id, name: rec.name, reminders: rec.remindedAt.length });
      await audit.record(repos, null, { entity: "afe", entityId: afe.id, type: "reminder_sent",
        payload: { recipientId: rec.id, name: rec.name, email: rec.email, olderThanDays: days } });
    }
    if (touched) await repos.routings.update(routing.id, { recipients: routing.recipients });
  }
  return { olderThanDays: days, checked, reminded, details };
}

module.exports = { run };
