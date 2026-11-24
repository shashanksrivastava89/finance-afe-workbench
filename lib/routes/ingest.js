"use strict";
// The SAP extracts arriving.
//
// Two doors, one pipeline. A scheduled transfer (Power Automate or a file drop) POSTs to
// `/api/ingest/:kind` with `x-ingest-secret` and NO user identity — ADC excludes that path
// from Easy Auth, so the secret is the whole of the authentication and is compared in
// constant time. A person uploads the same file in Admin through `/api/admin/ingest/:kind`,
// which is behind SSO and the admin role. Both end up in lib/ingest/snapshots.js.
//
// Nothing here parses SAP itself: the kinds are data in lib/ingest/index.js.
const express = require("express");
const crypto = require("crypto");
const { KINDS, KIND_NAMES } = require("../ingest");
const snapshots = require("../ingest/snapshots");

const MAX_BYTES = 25 * 1024 * 1024;

function bodyBytes(req) {
  const b = req.body || {};
  if (b.contentBase64) {
    let buf;
    try { buf = Buffer.from(String(b.contentBase64), "base64"); } catch { return { error: "contentBase64 is not valid base64" }; }
    return { bytes: buf };
  }
  if (typeof b.content === "string") return { bytes: Buffer.from(b.content, "utf8") };
  if (Buffer.isBuffer(req.body)) return { bytes: req.body };
  return { error: "send the extract as contentBase64 (or content, for plain text)" };
}

/**
 * The shared handler. `ctx` is the request context for an admin upload, or a system context
 * for the machine door — either way every write is audited with who or what did it.
 */
async function receive(repos, ctx, params) {
  const kind = String(params.kind || "");
  const def = KINDS[kind];
  if (!def) return { status: 404, body: { error: `no such extract: ${kind}. Known kinds: ${KIND_NAMES.join(", ")}` } };
  const { bytes, error } = params;
  if (error) return { status: 422, body: { error } };
  if (!bytes || !bytes.length) return { status: 422, body: { error: "the extract is empty" } };
  if (bytes.length > MAX_BYTES) return { status: 413, body: { error: `${(bytes.length / 1048576).toFixed(1)} MB — the limit is 25 MB` } };

  // WHAT WOULD CHANGE, before anything does (2026-10-16). A person replacing a live SAP extract
  // used to pick a file and have it applied at once — the matrix one deletes cost centres missing
  // from the file — with weaker safeguards than master data, which always shows its diff first.
  // Nothing is written here: no batch, no audit row, no rows.
  if (params.preview) {
    const parsed = def.parse(bytes);
    if (parsed.error || !parsed.rows.length) return { status: 422, body: { error: parsed.error || "no rows were recognised in that file", header: parsed.header || [] } };
    const out = { kind, rows: parsed.rows.length, skipped: parsed.skipped || 0, unknownColumns: parsed.unknownColumns || [] };
    if (kind === "matrix") {
      const now = new Set((await repos.matrix.all()).map((m) => String(m.costCenter)));
      const next = new Set(parsed.rows.map((r) => String(r.costCenter)));
      Object.assign(out, { liveCount: now.size, costCentres: next.size,
        added: [...next].filter((c) => !now.has(c)).length, removed: [...now].filter((c) => !next.has(c)).length });
    } else {
      const active = await snapshots.activeFor(repos, kind);
      Object.assign(out, { liveCount: active ? active.rowCount || 0 : 0, replaces: active ? active.id : null });
    }
    return { status: 200, body: { preview: out } };
  }

  let started;
  try {
    started = await snapshots.begin(repos, ctx, { kind, snapshotId: params.snapshotId, filename: params.filename,
      bytes, asOfDate: params.asOfDate, source: params.source });
  } catch (e) {
    return { status: e.status || 500, body: { error: e.message, detail: e.detail || null } };
  }
  if (started.duplicateOf) {
    // Power Automate retries a POST it never saw the answer to. Say so plainly and change nothing.
    return { status: 200, body: { ok: true, duplicate: started.duplicateOf, snapshot: started.snapshot,
      note: `already imported as ${started.snapshot.id} (${started.duplicateOf === "content" ? "same bytes" : "same snapshotId"}) — nothing was changed` } };
  }

  const parsed = def.parse(bytes);
  if (parsed.error || !parsed.rows.length) {
    await snapshots.fail(repos, ctx, started.snapshot, parsed.error || "no rows recognised");
    return { status: 422, body: { error: parsed.error || "no rows were recognised in that file", header: parsed.header || [], snapshotId: started.snapshot.id } };
  }
  try {
    const snapshot = await snapshots.commit(repos, ctx, started.snapshot, parsed.rows,
      (rows) => def.apply(repos, started.snapshot, rows),
      { force: params.force, rowCollection: def.collection, liveCount: def.liveCount ? await def.liveCount(repos) : 0 });
    if (def.afterApply) def.afterApply(repos, snapshot, snapshot.summary || {});
    return { status: 201, body: { ok: true, snapshot, parsed: { rows: parsed.rows.length, skipped: parsed.skipped,
      delimiter: parsed.delimiter, unknownColumns: parsed.unknownColumns } } };
  } catch (e) {
    return { status: e.status || 500, body: { error: e.message, detail: e.detail || null, snapshotId: started.snapshot.id } };
  }
}

/** The machine door: no SSO, a shared secret, its own router mounted before withContext. */
module.exports = function ingestRoutes({ repos }) {
  const r = express.Router();
  const SYSTEM_CTX = { realUser: { email: "system" }, user: { email: "system" }, userRow: { displayName: "SAP extract" }, roles: ["system"], actingAs: null };

  r.post("/ingest/:kind", async (req, res) => {
    const secret = process.env.INGEST_SECRET || "";
    if (!secret) return res.status(503).json({ error: "extract ingestion is off — INGEST_SECRET is not configured" });
    const given = String(req.headers["x-ingest-secret"] || "");
    const ok = given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
    if (!ok) return res.status(401).json({ error: "bad ingest secret" });
    const b = req.body || {};
    const out = await receive(repos, SYSTEM_CTX, Object.assign({ kind: req.params.kind, snapshotId: b.snapshotId,
      filename: b.filename, asOfDate: b.asOfDate, force: b.force === true, source: "scheduled" }, bodyBytes(req)));
    res.status(out.status).json(out.body);
  });

  return r;
};

module.exports.receive = receive;
module.exports.bodyBytes = bodyBytes;
