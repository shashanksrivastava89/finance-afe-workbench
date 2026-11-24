"use strict";
// In-tool reminders (R54): who has been sitting on an AFE longer than the cadence allows.
// Pure — the clock comes in as an argument. DocuSign runs its own reminders on a live
// envelope; these cover the in-tool asks and the simulated path.

/**
 * @param {object} routing  an active routing
 * @param {string} nowIso   the clock
 * @param {number} days     REMINDER_DAYS (3) unless a test says otherwise
 * @returns recipients currently holding the envelope whose last nudge is older than `days`
 */
function dueRecipients(routing, nowIso, days) {
  const now = new Date(nowIso).getTime();
  const window = Math.max(0, Number(days) || 0) * 86400000;
  return ((routing && routing.recipients) || []).filter((r) => {
    if (r.status !== "sent") return false;
    const stamps = (r.remindedAt || []).concat(r.notifiedAt ? [r.notifiedAt] : []);
    if (!stamps.length) return true;
    const last = Math.max(...stamps.map((s) => new Date(s).getTime()));
    return now - last >= window;
  });
}

/** How long the current signer has had it, in whole days — for the queue's "waiting on" column. */
function daysWaiting(recipient, nowIso) {
  if (!recipient || !recipient.notifiedAt) return null;
  return Math.floor((new Date(nowIso).getTime() - new Date(recipient.notifiedAt).getTime()) / 86400000);
}

module.exports = { dueRecipients, daysWaiting };
