"use strict";
// The DocuSign seam. Everything the lifecycle needs from the signing platform goes through
// here, and here alone decides whether that is DocuSign eSignature (behind the DOCUSIGN_*
// App Service settings) or the in-tool simulation. `/health` reports the mode; nothing
// reports a secret.
//
// Segregation of duties is enforced a SECOND time here, on the frozen routing, immediately
// before any envelope is created (CLAUDE.md non-negotiable 4). The chain builder already
// excluded the parties; this guard is what makes a bug or a hand-edited routing unable to
// slip one back in.
//
// Signing itself is deliberately asymmetric. A simulated envelope is signed in the tool. A
// live one is signed in DocuSign and only ever *reflected* here — by the poll job, under a
// system context. There is no code path by which a person's click marks a live envelope
// signed.
const sim = require("./docusignSim");
const envelopeState = require("./envelopeState");
const people = require("../domain/people");

function mode() {
  return process.env.DOCUSIGN_INTEGRATION_KEY ? "live" : "simulated";
}
const isSimulated = (envelope) => !envelope || envelope.provider === "simulated";

function live() {
  return require("./docusignLive");
}

/** Throws when a party to the AFE is still a signer on the routing about to be sent. */
function assertSegregation(afe, routing) {
  const parties = [];
  const add = (p, reason) => { if (p && (p.email || p.name)) parties.push({ name: p.name || null, email: p.email || null, reason }); };
  add(afe.requester, "requester");
  add(afe.preparer, "preparer");
  add(afe.coordinator, "coordinator");
  for (const p of (routing.sod && routing.sod.parties) || []) add(p, p.reason);
  const offenders = (routing.recipients || [])
    .filter((r) => r.role !== "cc" && ["pending", "sent"].includes(r.status))
    .map((r) => ({ r, p: parties.find((p) => people.samePerson(r, p)) }))
    .filter((x) => x.p);
  if (offenders.length) {
    const who = offenders.map((x) => `${x.r.name} (${x.p.reason})`).join(", ");
    throw new Error(`Segregation of duties: ${who} cannot sign an AFE they are party to. Envelope not created.`);
  }
}

/**
 * @param {object} args { afe, routing, documents: [{bytes, filename, role, sha256, attachmentId}], formHash, anchors, now }
 */
async function createEnvelope(args) {
  assertSegregation(args.afe, args.routing);
  return mode() === "live" ? live().createEnvelope(args) : sim.createEnvelope(args);
}

async function voidEnvelope(envelope, reason, at) {
  const when = at || new Date().toISOString();
  if (isSimulated(envelope)) return envelopeState.voidEnvelope(envelope, reason, when);
  try {
    return await live().voidEnvelope(envelope, reason, when);
  } catch (e) {
    // The envelope must still close in the tool: a DocuSign outage cannot leave an AFE
    // stuck mid-round. The failure is recorded on the envelope for Fixed Assets to see.
    envelopeState.voidEnvelope(envelope, reason, when);
    envelope.voidError = e.message;
    return envelope;
  }
}

/**
 * Record a signature.
 * @param {object} opts { fromProvider: true } — only the poll job, under a system context,
 *   may pass this, and it is the only way a live envelope moves.
 */
function recordSigned(envelope, routingRecipientId, at, opts) {
  const when = at || new Date().toISOString();
  if (isSimulated(envelope) || (opts && opts.fromProvider)) return envelopeState.recordSigned(envelope, routingRecipientId, when);
  throw new Error("This AFE is signed in DocuSign — open the email from DocuSign to sign; the tool records it automatically.");
}

function recordDeclined(envelope, routingRecipientId, reason, at, opts) {
  const when = at || new Date().toISOString();
  if (isSimulated(envelope) || (opts && opts.fromProvider)) return envelopeState.recordDeclined(envelope, routingRecipientId, reason, when);
  throw new Error("This AFE is declined in DocuSign — use the Decline option there; the tool records it automatically.");
}

/** The completed set: the signed document and the certificate, as bytes to store. */
async function fetchCompletedDocuments(envelope) {
  if (isSimulated(envelope)) return null;                 // the simulation generates its own
  const [combined, certificate] = await Promise.all([
    live().fetchCombinedPdf(envelope.envelopeId),
    live().fetchCertificate(envelope.envelopeId),
  ]);
  return { combined, certificate };
}

module.exports = {
  mode, isSimulated, assertSegregation, createEnvelope, voidEnvelope,
  recordSigned, recordDeclined, fetchCompletedDocuments,
  live,                                                   // for the poll job; throws unless configured
};
