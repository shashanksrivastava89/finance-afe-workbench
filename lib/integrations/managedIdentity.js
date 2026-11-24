"use strict";
// A token for an Azure service, from this app's own identity — no key, no secret, no SDK.
//
// App Service gives a system-assigned managed identity a local token endpoint and tells the
// process where it is through two settings it writes itself: IDENTITY_ENDPOINT and IDENTITY_HEADER
// (the second is a per-container secret that proves the caller is inside the container). Asking it
// for a resource returns a bearer token for that resource, signed by Entra, for as long as the
// identity holds a role there. That is the whole of the mechanism, so it is done here with Node's
// own `fetch` rather than an identity SDK — the ADC rules forbid an authentication library, and
// this is not one: nobody signs in here, the PLATFORM vouches for the app.
//
// Shared by everything that reaches an Azure service as the app: the quote reader (docintel.js) and
// the database once it signs in with Entra ID instead of a password (Part B of the 2026-10-14 plan).
// Which resource a token is for is the CALLER's to say; nothing here names one.
//
// Tokens are remembered per resource until five minutes before they expire, and callers that ask at
// the same moment share one request: a quote read and a database connection opening together must
// not race two identical requests to the endpoint.
//
// Locally there is no identity: `available()` says so, and `getToken` refuses with a reason rather
// than inventing one. Tests point IDENTITY_ENDPOINT at a stand-in.

const API_VERSION = "2019-08-01";
const EARLY_MS = 5 * 60 * 1000;          // refresh this long before the token says it expires
const TIMEOUT_MS = 10 * 1000;

const cache = new Map();                  // resource -> { token, expiresAt }
const inflight = new Map();               // resource -> Promise<string>

/** Is there an identity to ask? Both settings exist only inside an App Service with one. */
function available() {
  return Boolean(process.env.IDENTITY_ENDPOINT && process.env.IDENTITY_HEADER);
}

/**
 * A bearer token for `resource` (e.g. the Entra audience of the service being called).
 *
 * @param {string} resource
 * @returns {Promise<string>}
 * @throws  an Error with `code` "no_identity" | "unreachable" | "token_refused", and the endpoint's
 *          own words where it gave any — never the header, which is a secret.
 */
async function getToken(resource) {
  if (!resource) throw Object.assign(new Error("which resource is the token for?"), { code: "no_resource" });
  const hit = cache.get(resource);
  if (hit && hit.expiresAt - EARLY_MS > Date.now()) return hit.token;
  if (inflight.has(resource)) return inflight.get(resource);
  if (!available()) {
    throw Object.assign(new Error("this app has no managed identity here (IDENTITY_ENDPOINT is not set)"), { code: "no_identity" });
  }
  const ask = (async () => {
    const url = `${process.env.IDENTITY_ENDPOINT}?resource=${encodeURIComponent(resource)}&api-version=${API_VERSION}`;
    let res;
    try {
      res = await fetch(url, { headers: { "X-IDENTITY-HEADER": process.env.IDENTITY_HEADER }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw Object.assign(new Error(`the identity endpoint did not answer: ${String(e.message || e).slice(0, 120)}`), { code: "unreachable" });
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      const said = String(body.error_description || body.message || body.error || "").slice(0, 200);
      throw Object.assign(new Error(`the identity endpoint refused a token (${res.status})${said ? `: ${said}` : ""}`),
        { code: "token_refused", status: res.status });
    }
    // `expires_on` is seconds since the epoch, sent as a string. A token with no expiry is used
    // for an hour, which is what Entra issues by default.
    const expiresAt = Number(body.expires_on) > 0 ? Number(body.expires_on) * 1000 : Date.now() + 60 * 60 * 1000;
    cache.set(resource, { token: body.access_token, expiresAt });
    return body.access_token;
  })();
  inflight.set(resource, ask);
  try { return await ask; } finally { inflight.delete(resource); }
}

/** Forget every token — for a test, or after a role change that should take effect at once. */
function reset() { cache.clear(); inflight.clear(); }

module.exports = { available, getToken, reset, API_VERSION };
