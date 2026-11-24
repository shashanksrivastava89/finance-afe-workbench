"use strict";
// DocuSign eSignature REST v2.1, spoken directly.
//
// No SDK: the whole conversation is four calls behind `fetch` (Node 22 has it) and a JWT
// signed with Node's own `crypto`. That keeps the runtime dependency list at three packages
// (CLAUDE.md) and keeps every byte we send visible in this file, which is what a security
// review wants to read.
//
// Nothing here is reachable until the DOCUSIGN_* App Service settings exist; `docusign.js`
// picks the simulation otherwise, and `/health` says which is running. No secret is ever
// logged, returned or stored — the access token lives in this process's memory and nowhere
// else, and the private key is read from the settings on each token refresh.
const crypto = require("crypto");
const envelopeSpec = require("./envelopeSpec");

const SCOPES = "signature impersonation";
const TOKEN_TTL_S = 3600;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

let cached = null;                                   // { token, expiresAt } — memory only

function setting(name, required) {
  const v = process.env[name];
  if (!v && required) throw new Error(`DocuSign is enabled but ${name} is not configured on the App Service.`);
  return v || null;
}
const oauthHost = () => setting("DOCUSIGN_OAUTH_HOST") || "account-d.docusign.com";
const accountId = () => setting("DOCUSIGN_ACCOUNT_ID", true);
const baseUri = () => String(setting("DOCUSIGN_BASE_URI", true)).replace(/\/+$/, "");
const apiRoot = () => `${baseUri()}/restapi/v2.1/accounts/${accountId()}`;

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The RSA private key, base64-encoded in the setting so a PEM survives an env var. */
function privateKey() {
  const raw = setting("DOCUSIGN_PRIVATE_KEY_B64", true);
  const pem = Buffer.from(raw, "base64").toString("utf8");
  if (!/BEGIN [A-Z ]*PRIVATE KEY/.test(pem)) {
    throw new Error("DOCUSIGN_PRIVATE_KEY_B64 does not decode to a PEM private key.");
  }
  return pem;
}

/**
 * OAuth 2.0 JWT grant (RS256). The service user must have granted consent once, by opening
 * the consent URL below; DocuSign returns `consent_required` until they have.
 */
async function accessToken(now) {
  const at = now || Date.now();
  if (cached && cached.expiresAt - REFRESH_MARGIN_MS > at) return cached.token;

  const iat = Math.floor(at / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: setting("DOCUSIGN_INTEGRATION_KEY", true),
    sub: setting("DOCUSIGN_USER_ID", true),
    aud: oauthHost(),
    iat, exp: iat + TOKEN_TTL_S, scope: SCOPES,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(privateKey()))}`;

  const res = await fetch(`https://${oauthHost()}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (body.error === "consent_required") {
      throw new Error(`DocuSign needs one-time consent for the service user. Open ${consentUrl()} while signed in as that user, then retry.`);
    }
    throw new Error(`DocuSign token request failed (${res.status}): ${body.error || "unknown error"}`);
  }
  cached = { token: body.access_token, expiresAt: at + (Number(body.expires_in || TOKEN_TTL_S) * 1000) };
  return cached.token;
}

/** The URL the service user opens once to grant impersonation. Carries no secret. */
function consentUrl() {
  const key = setting("DOCUSIGN_INTEGRATION_KEY", true);
  const redirect = setting("DOCUSIGN_CONSENT_REDIRECT") || `https://${oauthHost()}/`;
  return `https://${oauthHost()}/oauth/auth?response_type=code&scope=${encodeURIComponent(SCOPES)}` +
    `&client_id=${encodeURIComponent(key)}&redirect_uri=${encodeURIComponent(redirect)}`;
}

async function api(method, path, body, opts) {
  const o = opts || {};
  const res = await fetch(`${apiRoot()}${path}`, {
    method,
    headers: Object.assign({ authorization: `Bearer ${await accessToken()}` }, body ? { "content-type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let detail = text.slice(0, 300);
    try { const j = JSON.parse(text); detail = `${j.errorCode || ""} ${j.message || ""}`.trim() || detail; } catch { /* text as-is */ }
    throw new Error(`DocuSign ${method} ${path} failed (${res.status}): ${detail}`);
  }
  if (o.binary) return Buffer.from(await res.arrayBuffer());
  return res.json();
}

// ---- envelopes ---------------------------------------------------------------------------
/**
 * Create and send the envelope. Anchor tabs put each signer's Sign and Date Signed fields on
 * that person's own row of the generated form (R59) — document 1, always, because that is
 * the only document whose layout we control.
 */
async function createEnvelope({ afe, routing, documents, formHash, anchors, now }) {
  const at = now || new Date().toISOString();
  // One definition for both providers: lib/integrations/envelopeSpec.js decides the subject,
  // the message, the order, the tabs, the copies and the reminders. This turns it into the
  // REST shape and attaches the bytes.
  const spec = envelopeSpec.buildSpec({ afe, routing, documents, anchors, formHash });
  const payload = {
    emailSubject: spec.emailSubject,
    emailBlurb: spec.emailBlurb,
    status: "sent",
    documents: (documents || []).map((d, i) => ({
      documentId: String(i + 1),
      name: d.filename || d.name || `document ${i + 1}`,
      fileExtension: "pdf",
      documentBase64: Buffer.from(d.bytes).toString("base64"),
    })),
    recipients: {
      signers: spec.signers.map((r) => {
        const tabs = {};
        if (r.tabs) {
          const anchor = (str) => ({ anchorString: str, anchorUnits: "pixels", anchorXOffset: "2", anchorYOffset: "-4", anchorIgnoreIfNotPresent: "false", documentId: r.tabs.documentId });
          tabs.signHereTabs = [anchor(r.tabs.signHere)];
          tabs.dateSignedTabs = [anchor(r.tabs.dateSigned)];
        }
        return { email: r.email, name: r.name, recipientId: r.recipientId, routingOrder: String(r.routingOrder), tabs };
      }),
      carbonCopies: spec.carbonCopies.map((r) => ({ email: r.email, name: r.name, recipientId: r.recipientId, routingOrder: String(r.routingOrder) })),
    },
    notification: {
      useAccountDefaults: String(spec.notification.useAccountDefaults),
      reminders: { reminderEnabled: "true", reminderDelay: String(spec.notification.reminders.delayDays), reminderFrequency: String(spec.notification.reminders.frequencyDays) },
      expirations: { expireEnabled: "true", expireAfter: String(spec.notification.expirations.afterDays), expireWarn: String(spec.notification.expirations.warnDays) },
    },
    customFields: { textCustomFields: spec.customFields.map((f) => ({ name: f.name, value: f.value, show: String(f.show) })) },
  };

  const created = await api("POST", "/envelopes", payload);
  const remote = await api("GET", `/envelopes/${created.envelopeId}?include=recipients`);
  return toEnvelopeDocument({ afe, routing, documents, formHash, created, remote, at });
}

/** DocuSign's answer, in our envelope shape — the same shape the simulation produces. */
function toEnvelopeDocument({ afe, routing, documents, formHash, created, remote, at }) {
  const signers = routing.recipients.filter((r) => r.status === "pending" && r.role !== "cc").sort((a, b) => a.order - b.order);
  const copies = routing.recipients.filter((r) => r.role === "cc");
  const remoteSigners = ((remote && remote.recipients && remote.recipients.signers) || []);
  const remoteCopies = ((remote && remote.recipients && remote.recipients.carbonCopies) || []);

  const map = (ours, theirs, type) => ours.map((r, i) => {
    const t = theirs[i] || {};
    return {
      routingRecipientId: r.id, docusignRecipientId: String(t.recipientId || i + 1), routingOrder: r.order, type,
      name: t.name || r.name, email: t.email || r.email, status: normaliseStatus(t.status, i === 0 && type === "signer"),
      signedDateTime: t.signedDateTime || null,
      events: t.status ? [{ type: normaliseStatus(t.status, false), at }] : [],
    };
  });

  return {
    provider: "docusign",
    envelopeId: created.envelopeId,
    status: created.status || "sent",
    emailSubject: spec.emailSubject,
    emailBlurb: spec.emailBlurb,
    spec,
    formHash: formHash || null,
    documents: (documents || []).map((d, i) => ({
      docusignDocumentId: String(i + 1), attachmentId: d.attachmentId || null,
      name: d.filename || d.name || `document ${i + 1}`, role: d.role || null, sha256: d.sha256 || null,
    })),
    recipients: map(signers, remoteSigners, "signer").concat(map(copies, remoteCopies, "cc")),
    reminders: { delayDays: ENVELOPE_POLICY().reminderDelayDays, frequencyDays: ENVELOPE_POLICY().reminderFrequencyDays },
    sentAt: created.statusDateTime || at,
    completedAt: null, voidedAt: null, voidReason: null,
    completed: { combinedPdfAttachmentId: null, certificateAttachmentId: null, verification: [] },
  };
}

/** DocuSign's recipient statuses, folded onto ours. */
function normaliseStatus(status, isFirst) {
  switch (String(status || "").toLowerCase()) {
    case "completed": case "signed": return "completed";
    case "declined": return "declined";
    case "delivered": case "sent": return "sent";
    case "created": return isFirst ? "sent" : "created";
    default: return isFirst ? "sent" : "created";
  }
}

function ENVELOPE_POLICY() { return require("../domain/refData").ENVELOPE_POLICY; }
const subjectFor = envelopeSpec.subjectFor;

/** Current status of one envelope, with its recipients. */
async function fetchEnvelope(envelopeId) {
  return api("GET", `/envelopes/${envelopeId}?include=recipients`);
}

/**
 * Envelopes that changed since `fromDate` — one call for the whole account, which is how the
 * poll job stays inside DocuSign's rate limits rather than asking per envelope.
 */
async function listStatusChanges(fromDateIso) {
  return api("GET", `/envelopes?from_date=${encodeURIComponent(fromDateIso)}&include=recipients`);
}

// The envelope's documents with their signatures, WITHOUT the certificate: whether DocuSign
// appends it to the combined file is an account setting, and the certificate is fetched and
// stored on its own below. The issued AFE is built on this file (R156), so what it contains must
// not depend on how somebody configured the account.
async function fetchCombinedPdf(envelopeId) {
  return api("GET", `/envelopes/${envelopeId}/documents/combined?certificate=false`, null, { binary: true });
}
async function fetchCertificate(envelopeId) {
  return api("GET", `/envelopes/${envelopeId}/documents/certificate`, null, { binary: true });
}

async function voidEnvelope(envelope, reason, at) {
  await api("PUT", `/envelopes/${envelope.envelopeId}`, { status: "voided", voidedReason: String(reason || "voided").slice(0, 200) });
  envelope.status = "voided";
  envelope.voidedAt = at || new Date().toISOString();
  envelope.voidReason = reason || "voided";
  return envelope;
}

/** Merge what DocuSign reports into our envelope record. Returns what changed. */
function applyRemote(envelope, remote) {
  const changes = [];
  const signers = ((remote.recipients && remote.recipients.signers) || []).concat((remote.recipients && remote.recipients.carbonCopies) || []);
  for (const rec of envelope.recipients) {
    const t = signers.find((s) => String(s.recipientId) === String(rec.docusignRecipientId));
    if (!t) continue;
    const next = normaliseStatus(t.status, false);
    if (next !== rec.status) {
      changes.push({ routingRecipientId: rec.routingRecipientId, from: rec.status, to: next, name: rec.name,
        at: t.signedDateTime || t.statusDateTime || null, reason: t.declinedReason || null });
    }
    if (t.signedDateTime) rec.signedDateTime = t.signedDateTime;
  }
  const envStatus = String(remote.status || "").toLowerCase();
  return { changes, envelopeStatus: envStatus, completedAt: remote.completedDateTime || null };
}

module.exports = {
  createEnvelope, voidEnvelope, fetchEnvelope, listStatusChanges, fetchCombinedPdf, fetchCertificate,
  applyRemote, normaliseStatus, accessToken, consentUrl, subjectFor, toEnvelopeDocument,
};
