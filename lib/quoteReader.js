"use strict";
// Reading a quote, and what a person does with the reading (R170).
//
// `integrations/docintel.js` reads; this decides WHEN, keeps the record, and applies a person's
// decision. The rules it keeps are non-negotiable #1's:
//
//   · It reads only while the `quoteReading` flag is on, only a priced document (a vendor quote, a
//     SOW, a Acme quotation), and in the BACKGROUND: the upload is answered at once, the card
//     says "Reading…", and a read that fails or is refused says why and leaves the typed path
//     exactly where it was.
//   · What comes back is stored on the document as `reading` — a PROPOSAL — and changes nothing
//     else. Not the typed vendor, total or date, so no rule, no flag and no figure anyone downstream
//     sees moves because a model read something.
//   · A person USES it (the proposals become the typed fields, each one marked as read and confirmed
//     by them) or SETS IT ASIDE. Both are audited with the proposal itself, and a later change of
//     the figure is audited like any edit — that is the override, and it is on the record.
//   · Every figure carries its provenance (`doc.provenance`): typed by whom, or read at what
//     confidence and confirmed by whom. A number nobody confirmed cannot exist anywhere.

const features = require("./domain/features");
const refData = require("./domain/refData");
const afeRules = require("./domain/afeRules");
const audit = require("./audit");
const docintel = require("./integrations/docintel");

/** A proposal's name → the typed field it would fill. */
const FIELD_OF = { amount: "amountUsd", quoteDate: "quoteDate", vendor: "vendor" };
/** How long a read may be "reading" before it is treated as interrupted (a restart mid-read). */
const STALE_MS = 3 * 60 * 1000;
const nowIso = () => new Date().toISOString();
const who = (ctx) => ({ by: ctx.user.email, byName: (ctx.userRow && ctx.userRow.displayName) || ctx.user.displayName || ctx.user.email });

const enabled = (repos) => features.isOn(repos, "quoteReading");

/**
 * After the service says this app may not use it, every upload would fail the same way until
 * somebody grants the role — so the reader stops asking for ten minutes, and the card says the
 * quote was not read. Kept in memory on purpose: a restart, or a grant, is a reason to try again.
 */
const COOL_MS = 10 * 60 * 1000;
let cooling = null;                                  // { until, reason }
const coolingDown = () => (cooling && Date.now() < cooling.until ? cooling : null);
/** Mark a document as not read because the reader is resting, without an audit row per upload. */
function skip(doc) {
  const c = coolingDown();
  doc.reading = { status: "failed", startedAt: nowIso(), at: nowIso(), code: "not_authorised", reason: c ? c.reason : "the reader is not available", skipped: true };
}
const readable = (doc) => Boolean(doc) && refData.QUOTE_ROLES.includes(doc.role);

/** A read that started and never finished — the process restarted under it. Derived, never stored. */
function interrupted(reading, now) {
  return Boolean(reading) && reading.status === "reading" && (now || Date.now()) - Date.parse(reading.startedAt || 0) > STALE_MS;
}

/**
 * Mark a document as being read. The caller saves the AFE, then calls `readLater` — in that order,
 * so the background read always finds the mark it is meant to replace.
 */
function begin(doc, ctx) {
  doc.reading = { status: "reading", startedAt: nowIso(), askedBy: ctx.user.email };
  return doc.reading.startedAt;
}

/** Read it on the next turn of the event loop; the request that asked has already been answered. */
function readLater(repos, afeId, attachmentId, startedAt) {
  setImmediate(() => {
    read(repos, afeId, attachmentId, startedAt).catch((e) => {
      console.error(JSON.stringify({ level: "error", msg: "quote read failed", afeId, attachmentId, error: String(e && e.message || e) }));
    });
  });
}

/**
 * The read itself, and the record of it. Writes only if the document still carries the SAME mark —
 * a document removed, or read again since, is left to the newer request.
 */
async function read(repos, afeId, attachmentId, startedAt) {
  const bytes = await repos.attachmentStore.get(attachmentId);
  const out = bytes ? await docintel.readQuote(bytes) : { ok: false, code: "missing", reason: "the file is no longer in the store" };
  const afe = await repos.afes.get(afeId);
  const doc = afe && (afe.documents || []).find((d) => d.attachmentId === attachmentId);
  if (!doc || !doc.reading || doc.reading.status !== "reading" || doc.reading.startedAt !== startedAt) return null;
  const at = nowIso();
  doc.reading = out.ok
    ? { status: "read", startedAt, at, askedBy: doc.reading.askedBy, model: out.model, apiVersion: out.apiVersion,
      fields: out.fields, held: out.held, minConfidence: refData.DI_POLICY.minConfidence }
    : { status: "failed", startedAt, at, askedBy: doc.reading.askedBy, code: out.code, reason: out.reason };
  await repos.afes.update(afe.id, afe);
  if (!out.ok && out.code === "not_authorised") cooling = { until: Date.now() + COOL_MS, reason: out.reason };
  if (out.ok) cooling = null;
  // The proposal is on the record as it was made, before anybody decides anything about it.
  await audit.record(repos, {}, { entity: "afe", entityId: afe.id, type: out.ok ? "quote_read" : "quote_read_failed",
    payload: out.ok
      ? { attachmentId, filename: doc.filename, model: out.model, apiVersion: out.apiVersion, askedBy: doc.reading.askedBy,
        offered: summarise(out.fields), held: out.held, minConfidence: refData.DI_POLICY.minConfidence }
      : { attachmentId, filename: doc.filename, askedBy: doc.reading.askedBy, code: out.code, reason: out.reason } });
  return doc.reading;
}

/** The proposals without the page geometry — what the audit row and the history need. */
function summarise(fields) {
  const out = {};
  for (const [k, f] of Object.entries(fields || {})) {
    out[k] = Object.assign({ value: f.value, confidence: f.confidence }, f.currency ? { currency: f.currency } : {}, f.readAs ? { readAs: f.readAs } : {});
  }
  return out;
}

/**
 * A person's decision on a reading. `use` copies the proposals into the typed fields — each one
 * marked as read and confirmed by them — and `setAside` keeps the typed fields as they are. Either
 * way the reading stays on the document, so what was proposed is never lost.
 *
 * A proposal that cannot be used as it stands is SKIPPED and said: a total in another currency
 * (the AFE's quote total is in US dollars, and converting is the requester's), or a date that has
 * not happened yet.
 *
 * @returns {{ error } | { applied: {field: {from, to}}, skipped: Array<{field, why}> }}
 */
function decide(doc, ctx, use) {
  const r = doc && doc.reading;
  if (!r || r.status !== "read") return { error: "there is no reading on this document to decide on" };
  if (r.decision) return { error: `${r.decision.byName} already ${r.decision.outcome === "used" ? "used" : "set aside"} this reading` };
  const at = nowIso();
  const applied = {}, skipped = [];
  if (use) {
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    for (const [name, f] of Object.entries(r.fields || {})) {
      const field = FIELD_OF[name];
      if (!field) continue;
      if (name === "amount" && f.currency && String(f.currency).toUpperCase() !== "USD") {
        skipped.push({ field, why: `the total is in ${f.currency} — convert it to US dollars and type it` });
        continue;
      }
      if (name === "quoteDate" && (!afeRules.isDay(f.value) || f.value > tomorrow)) {
        skipped.push({ field, why: `${f.value} has not happened yet — check the date on the quote` });
        continue;
      }
      const from = doc[field] === undefined ? null : doc[field];
      doc[field] = f.value;
      doc.provenance = Object.assign({}, doc.provenance, {
        [field]: Object.assign({ source: "read", confidence: f.confidence, model: r.model, at }, who(ctx)),
      });
      applied[field] = { from, to: f.value };
    }
  }
  r.decision = Object.assign({ outcome: use ? "used" : "set_aside", at, applied, skipped }, who(ctx));
  return { applied, skipped };
}

/** A typed change of one of the read fields: provenance says typed, by whom. */
function typed(doc, field, ctx) {
  doc.provenance = Object.assign({}, doc.provenance, { [field]: Object.assign({ source: "typed", at: nowIso() }, who(ctx)) });
}

module.exports = { enabled, readable, begin, readLater, read, decide, typed, interrupted, summarise, FIELD_OF, STALE_MS, coolingDown, skip };
