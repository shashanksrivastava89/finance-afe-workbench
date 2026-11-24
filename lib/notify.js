"use strict";
// Transactional outbox. Nothing is sent from here: a row is written, and a channel drains
// it later (`.eml` download today, a Microsoft Graph draft or send once the app
// registration exists — see docs/architecture.md §8).
//
// `kind` matters: rows of kind "red_flag_digest" are DRAFT-ONLY by policy (R51 — "it
// should not send… we can verify the red flag again and then finally we can send"), and
// no code path may mark them sent.

const DRAFT_ONLY_KINDS = ["red_flag_digest"];

/**
 * A link somebody can actually click from their inbox.
 *
 * "There are the person who did not log in into the app... there should be some pop-up through
 * email... so that they can click on the link and they can respond" (Judithmelanie, Meeting #5 55:31).
 * Every notification body and the DocuSign envelope message go through here, so a path becomes
 * an absolute URL wherever `PUBLIC_URL` is set and stays a plain path where it is not — a
 * half-written link is worse than a path, because a path at least reads as an instruction.
 *
 * Set it per environment (App Service settings); never hard-code a host, and never guess one
 * from a request, which is how a phishable link gets built.
 */
function link(path) {
  const base = String(process.env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  const p = String(path || "");
  if (!base) return p;
  return p.startsWith("/") ? base + p : `${base}/${p}`;
}

/**
 * @param {object} repos
 * @param {object} msg { recipientEmail, recipientName?, afeId?, kind, subject, body, cc?, attachments?, headers? }
 */
async function enqueue(repos, msg) {
  const to = String(msg.recipientEmail || "").trim().toLowerCase();
  // Matrix names without a resolved mailbox: skip rather than guess. The gap is visible
  // in the outbox and on the routing screen, where a human supplies the address.
  if (!to) return null;
  const kind = msg.kind || "notice";
  return repos.notifications.insert({
    recipientEmail: to,
    recipientName: msg.recipientName || null,
    cc: (msg.cc || []).map((e) => String(e).toLowerCase()),
    afeId: msg.afeId || null,
    kind,
    channel: msg.channel || "outbox",
    status: DRAFT_ONLY_KINDS.includes(kind) ? "drafted" : "queued",
    subject: msg.subject || "",
    body: msg.body || "",
    attachments: msg.attachments || [],
    // Internet message headers for the channel that eventually sends this. A mailbox rule or
    // a Power Automate flow can key on a header rather than parsing a subject line.
    headers: msg.headers || null,
    meta: msg.meta || null,                       // e.g. the flag ids a red-flag digest covered
    createdAt: new Date().toISOString(),
    readAt: null,
    sentAt: null,
  });
}

/** Rows a channel may actually send. Draft-only kinds are excluded by construction. */
async function sendable(repos) {
  return repos.notifications.all(
    (n) => n.status === "queued" && !DRAFT_ONLY_KINDS.includes(n.kind) && !n.sentAt
  );
}

async function markSent(repos, id, ref) {
  const row = await repos.notifications.get(id);
  if (!row) return null;
  if (DRAFT_ONLY_KINDS.includes(row.kind)) throw new Error(`${row.kind} is draft-only and must not be sent`);
  return repos.notifications.update(id, { status: "sent", sentAt: new Date().toISOString(), sendRef: ref || null });
}

module.exports = { enqueue, sendable, markSent, link, DRAFT_ONLY_KINDS };
