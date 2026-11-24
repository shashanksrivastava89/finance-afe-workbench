"use strict";
// Who is who — the one place names and mailboxes are compared.
//
// The SAP matrix carries NAMES ONLY, the form spells them differently from the matrix
// ("Kai Lun Ong" / "Kailun Ong"), and a signer is authorised by the mailbox
// DocuSign delivered to. So: a mailbox is the identity when both sides have one; a
// normalised name (letters only, accents stripped) is the fallback. Pure functions.
const { MAIL_DOMAIN } = require("./refData");

function normName(name) {
  return String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase().replace(/[^a-z]/g, "");
}

function normEmail(email) {
  const s = String(email || "").trim().toLowerCase();
  return s || null;
}

/** A stable key for "the same person": the mailbox when known, otherwise the name. */
function personKey(p) {
  return normEmail(p && p.email) || (p && p.name ? "name:" + normName(p.name) : null);
}

/** Same person? Mailboxes decide when both are known; otherwise the normalised names. */
function samePerson(a, b) {
  const ea = normEmail(a && a.email), eb = normEmail(b && b.email);
  if (ea && eb) return ea === eb;
  const na = normName(a && a.name), nb = normName(b && b.name);
  return Boolean(na) && na === nb;
}

/**
 * First_Last@example.com — the pattern every observed Acme mailbox follows
 * (udarsh_atwal, lekha_rogerson, syed-imran_pasha). Multi-part given names run together:
 * the matrix's "Kai Lun Ong" signed the APAC form as "Kailun Ong". It is a GUESS
 * and is always flagged as one; the coordinator confirms before an envelope exists (R60).
 */
function guessEmail(name) {
  const tokens = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;
  const clean = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  const given = clean(tokens.slice(0, -1).join(""));
  const surname = clean(tokens[tokens.length - 1]);
  if (!given || !surname) return null;
  return `${given}_${surname}@${MAIL_DOMAIN}`;
}

/**
 * The inverse of `guessEmail`, for the one case where a person arrives with no display name:
 * `aiden-mulqueeny_crilly@example.com` → "Aiden-Mulqueeny Crilly". A guess, and a poor one for the
 * multi-part given names `guessEmail` runs together, so it is only ever a placeholder until
 * SSO sends the real claim or an administrator corrects it.
 */
function nameFromEmail(email) {
  const local = String(email || "").split("@")[0];
  if (!local) return String(email || "");
  return local.split("_").filter(Boolean)
    .map((part) => part.split("-").map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join("-"))
    .join(" ") || local;
}

function isCompanyMailbox(email) {
  const e = normEmail(email);
  return Boolean(e) && /^[a-z0-9._'-]+@/.test(e) && e.endsWith("@" + MAIL_DOMAIN);
}

/**
 * Does the signed-in user (request context) match this recipient? The mailbox is the
 * identity. `users.matrixNames` is the admin-curated fallback for a recipient whose
 * mailbox is not yet known; the SSO display name is deliberately NOT used — two
 * employees can share a name, and a name must never unlock someone else's signature.
 */
function userMatches(ctx, person) {
  if (!ctx || !ctx.user || !person) return false;
  const mine = normEmail(ctx.user.email);
  if (person.email && mine && normEmail(person.email) === mine) return true;
  const n = normName(person.name);
  if (!n) return false;
  const curated = (ctx.userRow && ctx.userRow.matrixNames) || [];
  return curated.some((x) => normName(x) === n);
}

module.exports = { normName, normEmail, personKey, samePerson, guessEmail, nameFromEmail, isCompanyMailbox, userMatches };
