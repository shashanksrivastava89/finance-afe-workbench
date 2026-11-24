"use strict";
// Stand-in for DocuSign eSignature while no integration key is configured.
//
// Same shape as the live client so the state machine cannot tell them apart; every envelope
// it makes carries `provider: "simulated"` and the UI badges it. Signing happens in the
// tool: the current recipient presses Sign, and the state machine records the event here
// exactly as the poll job would for a real envelope.
//
// The recipient state changes themselves live in `envelopeState.js`, shared with the live
// path — the difference between the two providers is who decides a signature happened, not
// what happens to the envelope afterwards.
const { ENVELOPE_POLICY } = require("../domain/refData");
const envelopeState = require("./envelopeState");
const envelopeSpec = require("./envelopeSpec");

const subjectFor = envelopeSpec.subjectFor;

function createEnvelope({ afe, routing, documents, formHash, anchors, now }) {
  // The same definition the live client would be created with, kept on the envelope so the
  // whole set-up can be read before an integration key exists.
  const spec = envelopeSpec.buildSpec({ afe, routing, documents, anchors, formHash });
  const at = now || new Date().toISOString();
  const signers = routing.recipients.filter((r) => r.status === "pending" && r.role !== "cc").sort((a, b) => a.order - b.order);
  const copies = routing.recipients.filter((r) => r.role === "cc");
  const recipients = signers.map((r, i) => ({
    routingRecipientId: r.id, docusignRecipientId: String(i + 1), routingOrder: r.order, type: "signer",
    name: r.name, email: r.email, status: i === 0 ? "sent" : "created",
    signedDateTime: null,
    events: i === 0 ? [{ type: "sent", at }] : [],
  })).concat(copies.map((r, j) => ({
    routingRecipientId: r.id, docusignRecipientId: String(signers.length + j + 1), routingOrder: r.order, type: "cc",
    name: r.name, email: r.email, status: "created", signedDateTime: null, events: [],
  })));
  return {
    provider: "simulated",
    envelopeId: `SIM-${afe.id}-R${routing.round || 1}`,
    status: "sent",
    emailSubject: spec.emailSubject,
    emailBlurb: spec.emailBlurb,
    spec,
    formHash: formHash || null,
    documents: (documents || []).map((d, i) => ({
      docusignDocumentId: String(i + 1), attachmentId: d.attachmentId || null, name: d.filename || d.name || `document ${i + 1}`,
      role: d.role || null, sha256: d.sha256 || null,
    })),
    recipients,
    reminders: { delayDays: ENVELOPE_POLICY.reminderDelayDays, frequencyDays: ENVELOPE_POLICY.reminderFrequencyDays },
    sentAt: at, completedAt: null, voidedAt: null, voidReason: null,
    completed: { combinedPdfAttachmentId: null, certificateAttachmentId: null, verification: [] },
  };
}

module.exports = {
  createEnvelope, subjectFor,
  recordSigned: envelopeState.recordSigned,
  recordDeclined: envelopeState.recordDeclined,
  voidEnvelope: envelopeState.voidEnvelope,
};
