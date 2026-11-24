"use strict";
// The Dev Mailbox: everything the tool has put in the outbox, readable as mail.
//
// While there is no Graph registration the tool cannot send, and a queue nobody can look at is
// indistinguishable from a tool that silently does nothing. So the outbox is a screen: every
// message with its real recipients, subject, headers and body — the same fields
// `lib/jobs/drainOutbox.js` will hand to Graph, so what is read here today is what will land
// in an inbox tomorrow, not a paraphrase of it.
//
// This is a mail SINK, not a mail server. A separate SMTP catcher (MailPit and friends) would
// mean a second container to run beside the app, an SMTP client in the dependency list, and a
// copy of each message that the tool's own audit trail knows nothing about; the queue is
// already the record, so the screen reads the record.
//
// Two doors, because the two audiences are different:
//   GET /mailbox      everything the tool has produced — needs `mailbox.read`, an administrator's
//   GET /mailbox/:id  one message with its body — yours, or anyone's if you may read the mailbox
const express = require("express");
const rbac = require("../domain/rbac");
const notify = require("../notify");
const mail = require("../integrations/mail");

// Every kind the tool enqueues, in plain words. A kind with no entry here falls back to its
// own name rather than disappearing, so a new one is legible the day it is added and merely
// untidy until someone writes its label.
const KIND_LABELS = {
  approval_needed: "Signature request",
  reminder: "Reminder — still waiting for a signature",
  question: "Question from an approver",
  answer: "Answer to an approver's question",
  send_back: "Sent back to the requester",
  sent_back: "Sent back to the requester",
  decline: "Declined",
  declined: "Declined",
  withdrawn: "Withdrawn",
  copy_completed: "Completed set — copy for the record",
  afe_submitted: "Submitted to the coordinator",
  afe_resubmitted: "Resubmitted after changes",
  afe_approved: "Approved — hand-off to Fixed Assets",
  afe_approved_owner: "Approved — your AFE (an older mail, now part of the hand-off)",
  afe_issued: "Internal order issued",
  afe_issued_pack: "Issued AFE sent to the requester",
  afe_capitalized: "Capitalized",
  child_io_added: "Child order added",
  budget_moved: "Budget moved between orders",
  close_review: "AuC review — close request",
  reviewer_note: "AuC review — note to a reviewer",
  preparer_note: "Note to the preparer",
  red_flag_digest: "Red-flag digest (draft only)",
  fa_issue_approval_wanted: "Waiting for approval to issue",
  approval_resumed: "Back for signature",
  comment: "Comment",
  ask: "Question",
  ask_answered: "Answered",
  afe_issue_approved: "Approved to issue",
  notice: "Notice",
};

/** The row as mail: what a reader needs, and nothing the screen would have to decode. */
function asMessage(n, opts) {
  const o = opts || {};
  return {
    id: n.id,
    kind: n.kind,
    kindLabel: KIND_LABELS[n.kind] || n.kind,
    status: n.status,
    draftOnly: notify.DRAFT_ONLY_KINDS.includes(n.kind),
    to: n.recipientEmail,
    toName: n.recipientName || null,
    cc: n.cc || [],
    subject: n.subject || "",
    body: o.withBody ? (n.body || "") : undefined,
    headers: n.headers || null,
    attachments: (n.attachments || []).map((a) => ({ filename: a.filename, role: a.role || null })),
    afeId: n.afeId || null,
    createdAt: n.createdAt,
    sentAt: n.sentAt || null,
    readAt: n.readAt || null,
    sendAttempts: n.sendAttempts || 0,
    lastError: n.lastError || null,
  };
}

module.exports = function mailboxRoutes({ repos }) {
  const r = express.Router();

  const summarise = (rows) => ({
    total: rows.length,
    queued: rows.filter((n) => n.status === "queued").length,
    sent: rows.filter((n) => n.status === "sent").length,
    drafted: rows.filter((n) => n.status === "drafted").length,
    failed: rows.filter((n) => n.status === "failed").length,
  });

  // What the whole tool has produced. Administrators only: these are other people's messages.
  r.get("/mailbox", async (req, res) => {
    if (!rbac.can(req.ctx, "mailbox.read")) return res.status(403).json({ error: "the mailbox is an administrator's view" });
    const all = await repos.notifications.all();
    all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    const counts = summarise(all);
    const wanted = all
      .filter((n) => !req.query.kind || n.kind === req.query.kind)
      .filter((n) => !req.query.status || n.status === req.query.status)
      .filter((n) => !req.query.afeId || n.afeId === req.query.afeId);
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    res.json({
      // Said plainly at the top of the screen: whether anything can actually leave the building.
      delivery: {
        mode: mail.mode(),
        canSend: mail.mode() === "graph",
        mailbox: mail.graph.config().sender || null,
        explanation: mail.mode() === "graph"
          ? "Waiting mail is sent from the shared mailbox every few minutes."
          : "No Graph registration yet, so nothing is sent. Every message waits here, in full, exactly as it will be sent.",
      },
      counts,
      kinds: [...new Set(all.map((n) => n.kind))].sort().map((k) => ({ kind: k, label: KIND_LABELS[k] || k, count: all.filter((n) => n.kind === k).length })),
      messages: wanted.slice(0, limit).map((n) => asMessage(n)),
      shown: Math.min(wanted.length, limit),
      matching: wanted.length,
    });
  });

  // One message, with its body. Yours, or anybody's if you may read the mailbox.
  r.get("/mailbox/:id", async (req, res) => {
    const n = await repos.notifications.get(req.params.id);
    if (!n) return res.status(404).json({ error: "no such message" });
    const mine = n.recipientEmail === req.ctx.user.email.toLowerCase()
      || (n.cc || []).includes(req.ctx.user.email.toLowerCase());
    if (!mine && !rbac.can(req.ctx, "mailbox.read")) return res.status(403).json({ error: "not your message" });
    res.json(asMessage(n, { withBody: true }));
  });

  return r;
};
