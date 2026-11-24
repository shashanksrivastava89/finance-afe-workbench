"use strict";
// The mail seam. Today the tool never sends: it writes outbox rows (lib/notify.js) and can
// hand a person an `.eml` file that opens in Outlook as an editable, UNSENT draft
// (`X-Unsent: 1`). When the Graph app registration for the RTR_FA mailbox exists
// (docs/architecture.md §8), `mode()` becomes "graph" and drafts are created in that mailbox
// instead — still never sent by the tool for the red-flag digest (R51).
//
// No SDK: an .eml is text. Deterministic for the same input, so a re-download is the same
// file.
const MAIL_DOMAIN = require("../domain/refData").MAIL_DOMAIN;

const graph = require("./graphMail");

function mode() {
  return graph.configured() ? "graph" : "eml";
}

/**
 * Put a message where the person can pick it up. With Graph configured that is a DRAFT in the
 * shared mailbox; without it, the `.eml` the caller already has. Never a send: what may ever be
 * sent is decided by notify.DRAFT_ONLY_KINDS, and the red-flag digest is not in it (R51).
 */
async function draft(message) {
  if (!graph.configured()) return { mode: "eml", drafted: false };
  const out = await graph.createDraft(message);
  return { mode: "graph", drafted: true, messageId: out.id, webLink: out.webLink, mailbox: out.mailbox };
}

/**
 * Actually send — the routine traffic a person should never have to press send on: a
 * signature request while there is no DocuSign key, the hand-off to Fixed Assets, a reminder.
 *
 * Which rows reach here is `lib/notify.js`'s decision, not this module's: `sendable()` excludes
 * the draft-only kinds by construction. With no Graph registration this reports `sent: false`
 * and the row stays queued, visible in the Dev Mailbox — the tool never silently drops a mail
 * it could not send, and never pretends it sent one.
 */
async function send(message) {
  if (!graph.configured()) return { mode: "eml", sent: false, reason: "no Graph registration — the row stays in the outbox" };
  await graph.sendMail(message);
  return { mode: "graph", sent: true, mailbox: graph.config().sender };
}

const CRLF = "\r\n";

/** RFC 2047 encoded-word for a header value with anything outside printable ASCII. */
function headerValue(s) {
  const str = String(s || "");
  // eslint-disable-next-line no-control-regex
  if (!/[^\x20-\x7E]/.test(str)) return str;
  return "=?UTF-8?B?" + Buffer.from(str, "utf8").toString("base64") + "?=";
}

function address(email, name) {
  const e = String(email || "").trim();
  if (!e) return "";
  return name ? `${headerValue(name).replace(/[<>,"]/g, "")} <${e}>` : e;
}

/**
 * @param {object} m { from?, fromName?, to, toName?, cc?: [], subject, body, date?, unsent?: boolean, messageId? }
 * @returns {string} the .eml text
 */
function buildEml(m) {
  const lines = [];
  const from = m.from || process.env.MAIL_FROM || `rtr_fa@${MAIL_DOMAIN}`;
  lines.push("From: " + address(from, m.fromName || "Fixed Assets"));
  if (m.to) lines.push("To: " + address(m.to, m.toName));
  if (m.cc && m.cc.length) lines.push("Cc: " + m.cc.map((c) => address(typeof c === "string" ? c : c.email, typeof c === "string" ? null : c.name)).join(", "));
  lines.push("Subject: " + headerValue(m.subject || ""));
  if (m.date) lines.push("Date: " + new Date(m.date).toUTCString());
  if (m.messageId) lines.push("Message-ID: <" + m.messageId + ">");
  if (m.unsent !== false) lines.push("X-Unsent: 1");                   // Outlook opens it as a draft, not as received mail
  lines.push("X-AFE-Workbench: draft" + (m.afeId ? "; afe=" + m.afeId : ""));
  lines.push("MIME-Version: 1.0");
  lines.push("Content-Type: text/plain; charset=utf-8");
  lines.push("Content-Transfer-Encoding: 8bit");
  lines.push("");
  lines.push(String(m.body || "").replace(/\r?\n/g, CRLF));
  return lines.join(CRLF) + CRLF;
}

/** A safe filename for the draft. */
function emlFilename(subject) {
  const s = String(subject || "draft").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "draft";
  return s + ".eml";
}

module.exports = { mode, draft, send, buildEml, emlFilename, headerValue, graph };
