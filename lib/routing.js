"use strict";
// Routing glue: gathers what the pure chain builder needs from the repos, and owns the
// one stateful part of R60 — learning a confirmed mailbox into the directory.
const chainBuilder = require("./domain/chainBuilder");
const people = require("./domain/people");
const audit = require("./audit");
const { MAIL_DOMAIN } = require("./domain/refData");

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** The round the next send would open: 1, or one more than the round already sent. */
function nextRound(afe) {
  return afe.routingId ? (afe.round || 1) + 1 : 1;
}

async function inputs(repos, afe) {
  const cc = afe.costCenter ? String(afe.costCenter) : null;
  const matrixRow = cc ? await repos.matrix.find((m) => m.costCenter === cc) : null;
  const orgRules = await repos.orgRules.all((r) => r.active !== false && !r.retiredAt);
  const users = await repos.users.all((u) => u.active !== false);
  const directory = await repos.directory.all();
  return {
    afe, matrixRow, orgRules, users, directory,
    matrixBatchId: repos.meta && repos.meta.matrixBatch ? repos.meta.matrixBatch.batchId : null,
    round: nextRound(afe),
  };
}

/** The chain as it stands right now — derived, never stored (CLAUDE.md: derived at read time). */
async function preview(repos, afe) {
  return chainBuilder.buildRouting(await inputs(repos, afe));
}

/**
 * The coordinator confirms a guessed mailbox or types a missing one. Each confirmation is
 * pinned to this AFE (`routingEdits.emails`) AND learned into the directory, so the next
 * AFE naming the same person starts from a confirmed address. Every learning is audited.
 * @param {Array<{recipientId?, name?, email?}>} confirmations — no `email` means "the guess is right"
 */
async function confirmEmails(repos, ctx, afe, confirmations) {
  const before = await preview(repos, afe);
  const at = new Date().toISOString();
  const learned = [];
  afe.routingEdits = afe.routingEdits || {};
  afe.routingEdits.emails = afe.routingEdits.emails || {};

  for (const c of confirmations || []) {
    const rec = c.recipientId
      ? before.recipients.find((x) => x.id === c.recipientId)
      : before.recipients.find((x) => x.name && people.normName(x.name) === people.normName(c.name));
    if (!rec) throw new HttpError(404, `No one called ${c.name || c.recipientId} is on this chain.`);
    const given = people.normEmail(c.email);
    const email = given || people.normEmail(rec.email);
    if (!email) throw new HttpError(422, `${rec.name} has no address yet — type one.`);
    if (!people.isCompanyMailbox(email)) throw new HttpError(422, `${email} is not a ${MAIL_DOMAIN} mailbox — every approver is a Acme employee.`);
    const typed = Boolean(given) && given !== people.normEmail(rec.email);
    const key = people.normName(rec.name);
    afe.routingEdits.emails[key] = { email, source: typed ? "typed" : "confirmed", byEmail: ctx.user.email, at, recipientId: rec.id, name: rec.name };

    const entry = await repos.directory.find((d) => people.normName(d.matrixName) === key || people.normName(d.displayName) === key);
    const was = entry ? entry.email : null;
    const saved = entry
      ? await repos.directory.update(entry.id, { email, source: "confirmed", confirmedByEmail: ctx.user.email, confirmedAt: at, learnedFromAfeId: afe.id })
      : await repos.directory.insert({ matrixName: rec.name, displayName: rec.name, email, source: "confirmed",
        confirmedByEmail: ctx.user.email, confirmedAt: at, learnedFromAfeId: afe.id, note: "learned when the coordinator confirmed it on an AFE" });
    await audit.record(repos, ctx, { entity: "directory", entityId: saved.id, afeId: afe.id, type: "directory_learned",
      payload: { name: rec.name, from: was, to: email, how: typed ? "typed" : "confirmed" } });
    learned.push({ recipientId: rec.id, name: rec.name, email, source: typed ? "typed" : "confirmed" });
  }

  afe.updatedAt = at;
  await repos.afes.update(afe.id, afe);
  await audit.record(repos, ctx, { entity: "afe", entityId: afe.id, type: "emails_confirmed", payload: { learned } });
  return { learned, routing: await preview(repos, afe) };
}

module.exports = { inputs, preview, nextRound, confirmEmails, HttpError };
