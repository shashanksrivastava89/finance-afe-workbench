"use strict";
// The channel that empties the transactional outbox.
//
// `lib/notify.js` writes rows and decides which kinds may ever be sent; this job is the only
// thing that sends them, and it is deliberately dull: take what `sendable()` offers, hand each
// row to the mail seam, mark what went. Nothing here judges a row's contents — a red-flag
// digest never reaches this code because `sendable()` filters it out, not because this job
// remembered to check.
//
// With no Graph registration the seam reports `sent: false` and every row stays queued. That
// is the working state today: the queue IS the Dev Mailbox (`lib/routes/mailbox.js`), so the
// mail the tool would have sent is readable in full instead of disappearing into a log.
//
// A row that fails is left queued with the reason recorded and its attempt counted, so the next
// tick retries it; after MAX_ATTEMPTS it is parked as `failed` rather than retried for ever
// against a mailbox that is never going to accept it.
const notify = require("../notify");
const mail = require("../integrations/mail");
const audit = require("../audit");

const MAX_ATTEMPTS = 5;
const BATCH = 25;

// The system actor, as the other jobs spell it: enough to sign an audit row, not enough to be
// mistaken for a person.
const SYSTEM_CTX = {
  realUser: { email: "system", displayName: "Outbox" },
  user: { email: "system", displayName: "Outbox" },
  userRow: { email: "system", displayName: "Outbox", matrixNames: [], roles: ["system"] },
  roles: ["system"], coordinatorFor: [], actingAs: null, realRoles: ["system"],
};

async function run(repos, opts) {
  const o = opts || {};
  const ctx = o.ctx || SYSTEM_CTX;
  const limit = Number(o.limit) || BATCH;
  const rows = (await notify.sendable(repos)).slice(0, limit);
  const out = { considered: rows.length, sent: 0, held: 0, failed: 0, mode: mail.mode(), results: [] };

  for (const row of rows) {
    const attempts = Number(row.sendAttempts || 0) + 1;
    try {
      const res = await mail.send({
        to: row.recipientEmail, cc: row.cc || [], subject: row.subject, body: row.body,
        headers: row.headers || null, afeId: row.afeId || null,
      });
      if (!res.sent) {
        // Not an error: there is no mailbox to send from yet. Leave the row exactly as it is,
        // without counting an attempt against it — nothing was tried.
        out.held += 1;
        continue;
      }
      await notify.markSent(repos, row.id, res.mailbox || res.mode);
      out.sent += 1;
      out.results.push({ id: row.id, kind: row.kind, to: row.recipientEmail, sent: true });
    } catch (e) {
      const message = String(e && e.message ? e.message : e).slice(0, 300);
      const done = attempts >= MAX_ATTEMPTS;
      await repos.notifications.update(row.id, {
        sendAttempts: attempts, lastError: message, lastAttemptAt: new Date().toISOString(),
        status: done ? "failed" : row.status,
      });
      out.failed += 1;
      out.results.push({ id: row.id, kind: row.kind, to: row.recipientEmail, sent: false, error: message, attempts, parked: done });
      if (done) {
        await audit.record(repos, ctx, { entity: "notification", entityId: row.id, afeId: row.afeId || null,
          type: "mail_send_failed", payload: { kind: row.kind, to: row.recipientEmail, attempts, error: message } });
      }
    }
  }
  if (out.sent) {
    await audit.record(repos, ctx, { entity: "notification", entityId: "outbox", type: "mail_drained",
      payload: { sent: out.sent, failed: out.failed, mode: out.mode } });
  }
  return out;
}

module.exports = { run, MAX_ATTEMPTS, SYSTEM_CTX };
