"use strict";
// THE QUOTE READER (R68, R170) — and one of the two files in this codebase allowed to hold a client
// for an AI service (non-negotiable #1; smoke-boot and preflight both fail the build on one anywhere
// else).
//
// What it may do, and nothing more:
//   · READ a vendor quote a person already has in front of them — the requester attached it;
//   · return what it read as PROPOSALS, each carrying the service's own confidence, and only those
//     at or above DI_POLICY.minConfidence: below that a field is not offered at all, and the record
//     says which fields were held back and at what confidence;
//   · decide nothing. A proposal fills no field and passes no rule until a person presses "Use
//     these" (lib/quoteReader.js), and the proposal, that decision and any later change of the
//     figure are each a row of the audit trail. The typed path it sits beside stays in the product
//     and stays correct, so switching the flag off loses nothing.
//
// It runs only while the `quoteReading` flag is on (lib/domain/features.js): shipped off, turned on
// by an administrator in Admin › Features, and forbidden per environment by FEATURES_LOCKED. UAT
// was unlocked on 2026-10-14 by Shashank's decision, ahead of the security review, which is still
// requested; production stays locked until the review signs it off (CLAUDE.md, non-negotiable #1).
//
// Azure AI Document Intelligence, REST v4.0 (api-version 2024-11-30), model `prebuilt-invoice`: a
// quote is laid out like an invoice — a vendor, a date, a total — and the prebuilt model reads all
// three without anybody training anything. No SDK: global `fetch`, and a bearer token from the app's
// own managed identity, so there is no key to keep anywhere. The endpoint is DI_ENDPOINT, set in App
// Service; the bytes go to that resource and nowhere else (docs/architecture.md §16 — it is in West
// US). The service keeps neither the document nor the result once it has been collected.

const managedIdentity = require("./managedIdentity");
const { DI_POLICY } = require("../domain/refData");

const API_VERSION = "2024-11-30";
const MODEL = "prebuilt-invoice";
// The Entra audience every Azure AI service accepts a token for.
const AUDIENCE = "https://cognitiveservices.azure.com";
const SUBMIT_TIMEOUT_MS = 30 * 1000;
const POLL_TIMEOUT_MS = 15 * 1000;
const READ_DEADLINE_MS = 90 * 1000;

const endpoint = () => String(process.env.DI_ENDPOINT || "").trim().replace(/\/+$/, "");
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** Can a read be attempted here at all? Whether one SHOULD be is the flag's question, asked by the caller. */
function status() {
  if (!endpoint()) return { ready: false, why: "DI_ENDPOINT is not set" };
  if (!managedIdentity.available()) return { ready: false, why: "this app has no managed identity here" };
  return { ready: true, model: MODEL, apiVersion: API_VERSION };
}

/**
 * What the model read, as proposals — the pure half, so it can be tested on a stored result.
 *
 * The total is the invoice model's InvoiceTotal, else AmountDue, else SubTotal; which one it was is
 * recorded beside the figure, because "the subtotal before tax" is a different claim from "the
 * total". Each proposal keeps where on the page it was read (`where`), so a person can be shown the
 * box rather than asked to trust the number (design rule 5).
 *
 * @returns {{ fields: { amount?, quoteDate?, vendor? }, held: Array<{field, confidence}>, docConfidence }}
 */
function proposalsFrom(analyzeResult, policy) {
  const min = (policy || DI_POLICY).minConfidence;
  const result = analyzeResult || {};
  const doc = (result.documents || [])[0] || null;
  const f = (doc && doc.fields) || {};
  const pages = result.pages || [];
  const whereOf = (field) => {
    const region = ((field && field.boundingRegions) || [])[0];
    if (!region || !Array.isArray(region.polygon) || region.polygon.length < 8) return null;
    const page = pages.find((p) => p.pageNumber === region.pageNumber) || {};
    return { page: region.pageNumber, polygon: region.polygon.slice(0, 8).map(Number),
      unit: page.unit || null, width: Number(page.width) || null, height: Number(page.height) || null };
  };
  const totalKey = ["InvoiceTotal", "AmountDue", "SubTotal"].find((k) => f[k] && f[k].valueCurrency && Number.isFinite(Number(f[k].valueCurrency.amount)));
  const candidates = {
    amount: totalKey ? {
      value: Math.round(Number(f[totalKey].valueCurrency.amount) * 100) / 100,
      currency: f[totalKey].valueCurrency.currencyCode || null,
      readAs: { InvoiceTotal: "the total", AmountDue: "the amount due", SubTotal: "the subtotal" }[totalKey],
      confidence: f[totalKey].confidence, where: whereOf(f[totalKey]),
    } : null,
    quoteDate: f.InvoiceDate && /^\d{4}-\d{2}-\d{2}$/.test(String(f.InvoiceDate.valueDate || ""))
      ? { value: f.InvoiceDate.valueDate, confidence: f.InvoiceDate.confidence, where: whereOf(f.InvoiceDate) } : null,
    vendor: f.VendorName && String(f.VendorName.valueString || f.VendorName.content || "").trim()
      ? { value: String(f.VendorName.valueString || f.VendorName.content).trim().replace(/\s+/g, " ").slice(0, 80),
        confidence: f.VendorName.confidence, where: whereOf(f.VendorName) } : null,
  };
  const fields = {}, held = [];
  for (const [name, c] of Object.entries(candidates)) {
    if (!c) continue;
    const conf = Number(c.confidence);
    if (Number.isFinite(conf) && conf >= min) fields[name] = Object.assign({}, c, { confidence: Math.round(conf * 1000) / 1000 });
    else held.push({ field: name, confidence: Number.isFinite(conf) ? Math.round(conf * 1000) / 1000 : null });
  }
  return { fields, held, docConfidence: doc && Number.isFinite(Number(doc.confidence)) ? Number(doc.confidence) : null };
}

/**
 * Read one quote. Never throws: every outcome is a result a screen can say out loud.
 *
 * @param {Buffer} bytes     the file as attached — a PDF, a PNG or a JPEG
 * @returns {Promise<{ ok: true, model, apiVersion, fields, held, docConfidence }
 *                  | { ok: false, code, reason }>}
 */
async function readQuote(bytes) {
  const st = status();
  if (!st.ready) return { ok: false, code: "not_configured", reason: st.why };
  let token;
  try { token = await managedIdentity.getToken(AUDIENCE); }
  catch (e) { return { ok: false, code: e.code || "no_token", reason: e.message }; }

  const base = endpoint();
  let res;
  try {
    res = await fetch(`${base}/documentintelligence/documentModels/${MODEL}:analyze?api-version=${API_VERSION}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ base64Source: Buffer.from(bytes).toString("base64") }),
      signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, code: "unreachable", reason: `the reader did not answer: ${String(e.message || e).slice(0, 120)}` };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, code: "not_authorised",
      reason: "this app is not allowed to use the reader yet — its identity needs the Cognitive Services User role on the resource" };
  }
  if (res.status !== 202) {
    const said = await res.text().catch(() => "");
    return { ok: false, code: "refused", reason: `the reader refused the file (${res.status}) ${said.slice(0, 160)}`.trim() };
  }
  // Follow the operation only on the reader's own host: the bearer token goes with every poll.
  const op = res.headers.get("operation-location") || "";
  let opUrl;
  try { opUrl = new URL(op); } catch { opUrl = null; }
  if (!opUrl || opUrl.origin !== new URL(base).origin) {
    return { ok: false, code: "refused", reason: "the reader answered with nowhere to collect the result" };
  }

  const deadline = Date.now() + READ_DEADLINE_MS;
  let wait = retryAfter(res);
  for (;;) {
    await pause(wait);
    let poll, body;
    try {
      poll = await fetch(opUrl.href, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
      body = await poll.json();
    } catch (e) {
      return { ok: false, code: "unreachable", reason: `the reader stopped answering: ${String(e.message || e).slice(0, 120)}` };
    }
    if (body.status === "succeeded") {
      return Object.assign({ ok: true, model: MODEL, apiVersion: API_VERSION }, proposalsFrom(body.analyzeResult));
    }
    if (body.status === "failed" || body.status === "canceled") {
      return { ok: false, code: "failed", reason: String((body.error && body.error.message) || "the reader could not read this file").slice(0, 200) };
    }
    if (Date.now() > deadline) return { ok: false, code: "timeout", reason: "the reader took more than a minute and a half" };
    wait = retryAfter(poll);
  }
}

/** The service says how long to wait; a second when it does not, and never more than five. */
function retryAfter(res) {
  const s = Number(res && res.headers && res.headers.get("retry-after"));
  return Number.isFinite(s) && s >= 0 ? Math.min(s, 5) * 1000 : 1000;
}

module.exports = { status, readQuote, proposalsFrom, MODEL, API_VERSION, AUDIENCE };
