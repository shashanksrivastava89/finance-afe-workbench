"use strict";
// Microsoft Graph, app-only, scoped to the shared RTR_FA mailbox.
//
// Dormant until the app registration exists (docs/architecture.md §8): with no `GRAPH_*`
// settings the mail seam stays on `.eml` downloads, which is what UAT uses today. When the
// registration lands, this creates a DRAFT in the shared mailbox and hands back its id.
//
// No SDK — client-credentials over Node's own `fetch`, the same decision the DocuSign client
// made. Nothing here sends the red-flag digest: `notify.DRAFT_ONLY_KINDS` decides what may
// ever be sent, and this module only offers `createDraft` for that kind (R51).
const TOKEN_HOST = "https://login.microsoftonline.com";
const GRAPH = "https://graph.microsoft.com/v1.0";

let cachedToken = null;                      // { value, expiresAt }

function config() {
  return {
    tenantId: process.env.GRAPH_TENANT_ID || "",
    clientId: process.env.GRAPH_CLIENT_ID || "",
    clientSecret: process.env.GRAPH_CLIENT_SECRET || "",
    sender: process.env.GRAPH_SENDER_UPN || "",
  };
}
const configured = () => Object.values(config()).every(Boolean);

async function token() {
  const c = config();
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
  const body = new URLSearchParams({
    client_id: c.clientId, client_secret: c.clientSecret,
    scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials",
  });
  const res = await fetch(`${TOKEN_HOST}/${encodeURIComponent(c.tenantId)}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(),
  });
  if (!res.ok) throw new Error(`Graph token request failed (${res.status})`);
  const json = await res.json();
  cachedToken = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in || 3600) * 1000) };
  return cachedToken.value;
}

const recipients = (list) => (list || []).filter(Boolean).map((a) => ({ emailAddress: { address: String(typeof a === "string" ? a : a.email) } }));

/**
 * One Graph message shape for both doors, so a draft and a send are the same mail.
 *
 * Headers travel as `internetMessageHeaders`: the FA team's own workflow keys on `X-AFE-*`
 * rather than parsing the subject (refData.FA_HANDOFF), and a reply is traceable back to the
 * AFE. X- headers rather than a named extended property — the property set would put a GUID
 * in the source, and ADC allows none. Graph caps these at 5, so the row's own headers come
 * first and the marker only fills a spare slot.
 */
function messageBody(message, disposition) {
  const own = Object.entries(message.headers || {}).map(([name, value]) => ({ name, value: String(value) }));
  const marker = [{ name: "X-AFE-Workbench", value: disposition || "sent" }];
  if (message.afeId && !(message.headers || {})["X-AFE-Id"]) marker.push({ name: "X-AFE-Id", value: String(message.afeId) });
  const headers = own.concat(marker).slice(0, 5);
  return {
    subject: message.subject || "",
    body: { contentType: "Text", content: message.body || "" },
    toRecipients: recipients([message.to]),
    ccRecipients: recipients(message.cc),
    internetMessageHeaders: headers.length ? headers : undefined,
  };
}

/**
 * Create a draft in the shared mailbox. Returns { id, webLink } — the FA opens it in Outlook,
 * checks it and sends it themselves. This function never sends.
 */
async function createDraft(message) {
  if (!configured()) throw new Error("Graph is not configured — GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_SENDER_UPN are all required");
  const c = config();
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(c.sender)}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: JSON.stringify(messageBody(message, "draft")),
  });
  if (!res.ok) throw new Error(`Graph draft failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  const json = await res.json();
  return { id: json.id, webLink: json.webLink, mailbox: c.sender };
}

/**
 * Send from the shared mailbox.
 *
 * The counterpart to `createDraft`, and the reason both exist: some of what the tool produces
 * is correspondence a person must approve before it goes out (the red-flag digest, R51) and
 * the rest is routine traffic nobody should have to press send on — a signature request, the
 * hand-off to Fixed Assets, a reminder. `lib/notify.js` decides which is which by `kind`, and
 * `lib/jobs/drainOutbox.js` is the only caller: this function never chooses.
 *
 * `saveToSentItems` is on, so the shared mailbox keeps its own record of everything the tool
 * sent on its behalf — the audit trail in this repo and the mailbox's own agree.
 */
async function sendMail(message) {
  if (!configured()) throw new Error("Graph is not configured — GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET and GRAPH_SENDER_UPN are all required");
  const c = config();
  const res = await fetch(`${GRAPH}/users/${encodeURIComponent(c.sender)}/sendMail`, {
    method: "POST",
    headers: { authorization: `Bearer ${await token()}`, "content-type": "application/json" },
    body: JSON.stringify({ message: messageBody(message), saveToSentItems: true }),
  });
  if (!res.ok) throw new Error(`Graph sendMail failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  // sendMail answers 202 with no body; the mailbox's Sent Items is the receipt.
  return { sent: true, mailbox: c.sender };
}

module.exports = { configured, createDraft, sendMail, config: () => ({ sender: config().sender, configured: configured() }) };
