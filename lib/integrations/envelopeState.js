"use strict";
// The envelope document's own state machine — pure, and shared by both providers.
//
// Our envelope record mirrors DocuSign's vocabulary (created → sent → completed | declined)
// and its sequential routing, so the same three functions serve the simulated envelope (where
// the tool decides) and the live one (where DocuSign has already decided and the poll job is
// reflecting it). One implementation means the two paths cannot drift apart.

/**
 * Mark a recipient signed and hand the envelope to the next one.
 * @returns {{envelope, next}} `next` is the recipient now holding it, null when complete
 */
function recordSigned(envelope, routingRecipientId, at) {
  const rec = envelope.recipients.find((r) => r.routingRecipientId === routingRecipientId);
  if (!rec) throw new Error(`recipient ${routingRecipientId} is not on envelope ${envelope.envelopeId}`);
  if (rec.status === "completed") throw new Error(`${rec.name} has already signed`);
  if (rec.status !== "sent") throw new Error(`${rec.name} does not hold the envelope (status ${rec.status})`);
  rec.status = "completed";
  rec.events.push({ type: "signed", at }, { type: "completed", at });

  const next = envelope.recipients
    .filter((r) => r.type === "signer" && r.status === "created")
    .sort((a, b) => a.routingOrder - b.routingOrder)[0] || null;
  if (next) {
    next.status = "sent";
    next.events.push({ type: "sent", at });
    return { envelope, next };
  }
  envelope.status = "completed";
  envelope.completedAt = at;
  for (const c of envelope.recipients.filter((r) => r.type === "cc")) {
    c.status = "completed";
    c.events.push({ type: "sent", at }, { type: "completed", at });
  }
  return { envelope, next: null };
}

function recordDeclined(envelope, routingRecipientId, reason, at) {
  const rec = envelope.recipients.find((r) => r.routingRecipientId === routingRecipientId);
  if (!rec) throw new Error(`recipient ${routingRecipientId} is not on envelope ${envelope.envelopeId}`);
  rec.status = "declined";
  rec.events.push({ type: "declined", at, reason: reason || null });
  envelope.status = "declined";
  envelope.voidedAt = at;
  envelope.voidReason = `declined by ${rec.name}: ${reason || "no reason given"}`;
  return envelope;
}

function voidEnvelope(envelope, reason, at) {
  if (["completed", "voided"].includes(envelope.status)) return envelope;
  envelope.status = "voided";
  envelope.voidedAt = at;
  envelope.voidReason = reason || "voided";
  return envelope;
}

/** Who holds a live envelope right now. */
function holder(envelope) {
  return (envelope.recipients || []).find((r) => r.type === "signer" && r.status === "sent") || null;
}

module.exports = { recordSigned, recordDeclined, voidEnvelope, holder };
