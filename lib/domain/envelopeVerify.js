"use strict";
// Did the people who signed match the chain we froze?
//
// Pure. Compares the envelope's recipients — whether DocuSign reported them or the
// simulation produced them — against the routing snapshot taken at send. This is the
// structural check the architecture promises (§8): the certificate PDF is kept as evidence,
// but the verdict comes from data, never from parsing a document.
//
// Anything other than `ok` becomes a red flag on Fixed Assets' screen in Stage 5.
const people = require("./people");

const SIGNING_ROLES = ["pending", "sent", "signed"];

/**
 * @param {object} routing   the frozen routing
 * @param {object} envelope  the envelope as the provider reports it
 * @returns {Array} one row per expected signer: {recipientId, name, level, st, note, signedAt}
 *   st: ok | miss | mismatch | declined | pending
 */
function verifyRecipients(routing, envelope) {
  const expected = ((routing && routing.recipients) || []).filter((r) => r.role !== "cc" && SIGNING_ROLES.includes(r.status));
  const actual = (envelope && envelope.recipients) || [];
  const rows = [];

  for (const want of expected) {
    const got = actual.find((a) => a.routingRecipientId === want.id);
    const base = { recipientId: want.id, name: want.name, level: want.level || null, role: want.role, order: want.order };
    if (!got) {
      rows.push(Object.assign(base, { st: "miss", note: `${want.name} is on the approved chain but not on the envelope.` }));
      continue;
    }
    const samePerson = people.samePerson({ name: want.name, email: want.email }, { name: got.name, email: got.email });
    if (!samePerson) {
      rows.push(Object.assign(base, { st: "mismatch", signedAt: signedAt(got),
        note: `The chain names ${want.name} (${want.email || "no mailbox"}); the envelope carries ${got.name} (${got.email || "no mailbox"}).` }));
      continue;
    }
    if (got.status === "declined") {
      rows.push(Object.assign(base, { st: "declined", note: `${want.name} declined.` }));
      continue;
    }
    if (got.status !== "completed") {
      rows.push(Object.assign(base, { st: "pending", note: `${want.name} has not signed yet (${got.status}).` }));
      continue;
    }
    rows.push(Object.assign(base, { st: "ok", signedAt: signedAt(got), email: got.email }));
  }

  // Someone on the envelope who was never on the chain is the serious case — it means the
  // envelope was corrected outside the tool.
  for (const got of actual.filter((a) => a.type === "signer")) {
    if (expected.some((w) => w.id === got.routingRecipientId)) continue;
    rows.push({ recipientId: got.routingRecipientId || null, name: got.name, level: null, role: "unknown", order: got.routingOrder,
      st: "mismatch", signedAt: signedAt(got), note: `${got.name} signed but is not on the approved chain.` });
  }
  return rows;
}

function signedAt(recipient) {
  const ev = (recipient.events || []).find((e) => e.type === "signed" || e.type === "completed");
  return recipient.signedDateTime || (ev ? ev.at : null);
}

/** True when every expected signature is present and belongs to the right person. */
function allVerified(rows) {
  return rows.length > 0 && rows.every((r) => r.st === "ok");
}

module.exports = { verifyRecipients, allVerified };
