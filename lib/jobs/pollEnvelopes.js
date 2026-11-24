"use strict";
// Ask DocuSign what has happened, and put it through the same front door as everything else.
//
// This job is the ONLY way a live envelope moves. It never writes state itself: for each
// change DocuSign reports it calls `applyTransition(..., "recipient_signed" | "decline")`
// under a **system context**, so the signature is guarded, audited and notified exactly as an
// in-tool one is. That is what keeps one lifecycle mutator honest (CLAUDE.md).
//
// `listStatusChanges` is one account-wide call per tick rather than one per envelope, which
// is how we stay inside DocuSign's rate limits; the envelope is then re-read individually
// only when the account-level list says it changed.
const docusign = require("../integrations/docusign");
const audit = require("../audit");

// The system actor. It holds the `system` role and nothing else — enough to reflect a
// provider event, not enough to be mistaken for a person.
const SYSTEM_CTX = {
  realUser: { email: "system", displayName: "DocuSign poll" },
  user: { email: "system", displayName: "DocuSign poll" },
  userRow: { email: "system", displayName: "DocuSign poll", matrixNames: [], roles: ["system"] },
  roles: ["system"], coordinatorFor: [], actingAs: null, realRoles: ["system"],
};

const OPEN = ["sent", "delivered", "created"];
const LOOKBACK_HOURS = 36;

/**
 * @param {object} repos
 * @param {object} opts { now?, sinceIso? }
 */
async function run(repos, opts) {
  const o = opts || {};
  if (docusign.mode() !== "live") return { mode: "simulated", checked: 0, applied: 0, note: "no DOCUSIGN_INTEGRATION_KEY — nothing to poll" };

  const open = await repos.envelopes.all((e) => e.provider !== "simulated" && OPEN.includes(String(e.status).toLowerCase()));
  if (!open.length) return { mode: "live", checked: 0, applied: 0 };

  const now = o.now || new Date().toISOString();
  const since = o.sinceIso || new Date(Date.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString();
  const live = docusign.live();

  // One call for the account; then only the envelopes it says changed are re-read.
  let changedIds = null;
  try {
    const list = await live.listStatusChanges(since);
    changedIds = new Set((list.envelopes || []).map((e) => e.envelopeId));
  } catch (e) {
    await audit.record(repos, SYSTEM_CTX, { entity: "job", entityId: "pollEnvelopes", type: "poll_failed", payload: { reason: e.message } });
    return { mode: "live", checked: 0, applied: 0, error: e.message };
  }

  const { applyTransition } = require("../domain/stateMachine");
  let checked = 0, applied = 0;
  const details = [];

  for (const envelope of open) {
    // An envelope whose round a send-back PAUSED is left alone until the AFE is resubmitted
    // (R148). DocuSign keeps it, and anything it reports meanwhile, a signature or a decline, is
    // applied once the AFE is back in approval, in order. Reading it now would mark the change as
    // seen on the envelope and then have the transition refuse it, which loses it for good.
    const round = envelope.routingId ? await repos.routings.get(envelope.routingId) : null;
    if (round && round.status === "returned") { details.push({ envelopeId: envelope.envelopeId, action: "paused" }); continue; }
    // `reconcile` is set when a paused round resumes: whatever DocuSign did in the meantime may be
    // older than the look-back, and has to be read anyway.
    if (changedIds && !changedIds.has(envelope.envelopeId) && !envelope.reconcile) continue;
    checked += 1;
    let remote;
    try { remote = await live.fetchEnvelope(envelope.envelopeId); }
    catch (e) { details.push({ envelopeId: envelope.envelopeId, error: e.message }); continue; }

    const afe = await repos.afes.get(envelope.afeId);
    if (!afe) continue;
    const { changes } = live.applyRemote(envelope, remote);
    envelope.reconcile = false;
    await repos.envelopes.update(envelope.id, envelope);

    // Apply in routing order, so a burst of signatures lands in the order they were given.
    for (const change of changes.sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")))) {
      if (change.to === "completed") {
        const res = await applyTransition(repos, SYSTEM_CTX, afe, "recipient_signed",
          { recipientId: change.routingRecipientId, signedAt: change.at || now, comment: null });
        details.push({ envelopeId: envelope.envelopeId, name: change.name, action: "signed", ok: res.ok, error: res.error || null });
        if (res.ok) applied += 1;
      } else if (change.to === "declined") {
        const res = await applyTransition(repos, SYSTEM_CTX, afe, "decline",
          { recipientId: change.routingRecipientId, reason: change.reason || "declined in DocuSign" });
        details.push({ envelopeId: envelope.envelopeId, name: change.name, action: "declined", ok: res.ok, error: res.error || null });
        if (res.ok) applied += 1;
      }
    }

    // An envelope voided or expired in DocuSign leaves the AFE stranded otherwise.
    const remoteStatus = String(remote.status || "").toLowerCase();
    if (["voided", "declined"].includes(remoteStatus) && !["voided", "declined"].includes(String(envelope.status).toLowerCase())) {
      envelope.status = remoteStatus;
      envelope.voidedAt = remote.voidedDateTime || now;
      envelope.voidReason = remote.voidedReason || `${remoteStatus} in DocuSign`;
      await repos.envelopes.update(envelope.id, envelope);
      await audit.record(repos, SYSTEM_CTX, { entity: "envelope", entityId: envelope.id, afeId: afe.id, type: "envelope_voided_remotely",
        payload: { envelopeId: envelope.envelopeId, status: remoteStatus, reason: envelope.voidReason } });
      details.push({ envelopeId: envelope.envelopeId, action: remoteStatus });
    }
  }

  return { mode: "live", since, checked, applied, details };
}

module.exports = { run, SYSTEM_CTX };
