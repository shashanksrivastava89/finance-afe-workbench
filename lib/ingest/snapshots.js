"use strict";
// The import discipline every SAP extract goes through.
//
// A scheduled job that half-lands is worse than one that does not land at all: every screen
// derives its numbers from "the latest ACTIVE snapshot", so a batch is only ever activated
// once all of its rows are written. The steps are always the same:
//
//   begin  → refuse a duplicate (same snapshotId, or same bytes for this kind), sanity-check
//            the row count against the batch it would replace, write a `loading` header
//   commit → insertMany the rows (batched — CLAUDE.md), activate, supersede the previous
//            active batch of the same kind, prune old ones
//   fail   → mark the header `failed` with the reason; nothing else changed
//
// Idempotency is by caller-supplied `snapshotId` AND by content hash, because Power Automate
// retries on a timeout it never saw the answer to.
const crypto = require("crypto");
const audit = require("../audit");

const KEEP_BATCHES = 3;                       // current + previous + one for comparison
const MIN_ROW_RATIO = 0.5;                    // a batch under half the previous one looks truncated

const nowIso = () => new Date().toISOString();
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

class IngestError extends Error {
  constructor(status, message, detail) { super(message); this.status = status; this.detail = detail || null; }
}

async function activeFor(repos, kind) {
  const rows = await repos.snapshots.all((s) => s.kind === kind && s.status === "active");
  rows.sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
  return rows[0] || null;
}

/**
 * @param {object} opts { kind, snapshotId?, filename, bytes, byEmail, asOfDate?, force? }
 * @returns {{snapshot, duplicateOf?}} — `duplicateOf` means nothing was written, by design
 */
async function begin(repos, ctx, opts) {
  const kind = String(opts.kind || "");
  const bytes = Buffer.isBuffer(opts.bytes) ? opts.bytes : Buffer.from(String(opts.bytes || ""), "utf8");
  if (!bytes.length) throw new IngestError(422, "the extract is empty");
  const hash = sha256(bytes);
  const id = String(opts.snapshotId || "").trim() || `${kind}-${nowIso().replace(/[^0-9]/g, "").slice(0, 14)}-${hash.slice(0, 8)}`;

  const byId = await repos.snapshots.get(id);
  if (byId && byId.status !== "failed") return { snapshot: byId, duplicateOf: "snapshotId" };
  // A batch that was REFUSED may be sent again under the same id once the reason is dealt with
  // (a truncated file re-exported, a forced retry). The refusal itself stays in the audit trail.
  if (byId) await repos.snapshots.remove(id);
  // Only a batch that actually LANDED counts as a duplicate. One that was refused (or never
  // finished) must not stop the same file being sent again once the reason is fixed.
  const byHash = await repos.snapshots.find((s) => s.kind === kind && s.sha256 === hash && ["active", "superseded", "pruned"].includes(s.status));
  if (byHash) return { snapshot: byHash, duplicateOf: "content" };

  const snapshot = await repos.snapshots.insert({
    id, kind, status: "loading", filename: opts.filename || null, sha256: hash, sizeBytes: bytes.length,
    asOfDate: opts.asOfDate || nowIso().slice(0, 10),
    importedByEmail: (ctx && ctx.user && ctx.user.email) || opts.byEmail || "system",
    importedAt: nowIso(), rowCount: null, previousId: (await activeFor(repos, kind) || {}).id || null,
    source: opts.source || "upload", notes: [],
  });
  return { snapshot };
}

/**
 * The row-count sanity check the architecture promises, as its own step so callers can force
 * past it.
 *
 * It asks the question twice, against two different baselines, because they fail differently:
 *
 *  - the PREVIOUS BATCH, when there is one that came from a real run of the same SAP job. The
 *    seeded baseline is exempt here: it is reference data shipped with the app, and the first
 *    real extract is legitimately a different size.
 *
 *  - what is ACTUALLY IN THE STORE, for the kinds that ask (`liveCount`, today the matrix
 *    alone). Its absence cost us the approver matrix: the matrix ships as 1,197 seeded rows
 *    with no snapshot behind them, so `previous` was null, the check was skipped entirely,
 *    and a 2-row test extract replaced all 1,197 without a murmur. The matrix is also the
 *    only kind whose import DELETES — a cost centre missing from the export has gone, in
 *    place, with no superseded batch to fall back to — which is why it is the kind that
 *    counts what it is about to overwrite, and why the batch-tagged kinds do not: their old
 *    batch is still there until it is pruned, and their seeded baseline is deliberately a
 *    partial one that a real extract will dwarf.
 *
 * Bigger is never refused; only a collapse is. `force: true` overrides, and the refusal and the
 * override are both in the audit trail.
 */
async function sanity(repos, snapshot, rowCount, force, liveCount) {
  const previous = snapshot.previousId ? await repos.snapshots.get(snapshot.previousId) : null;
  if (!rowCount) throw new IngestError(422, "the extract parsed to zero rows — nothing was changed");

  const comparable = previous && !previous.seededBaseline && previous.rowCount ? previous.rowCount : 0;
  const live = Number(liveCount) > 0 ? Number(liveCount) : 0;
  const baseline = Math.max(comparable, live);
  if (baseline && rowCount < baseline * MIN_ROW_RATIO && !force) {
    const against = live >= comparable
      ? `the ${live} ${snapshot.kind} rows the tool is holding`
      : `the ${comparable} in the batch this replaces (${previous.id})`;
    throw new IngestError(409,
      `${rowCount} rows is less than half of ${against} — it looks truncated. Send force: true if it is really this small.`,
      { rowCount, previousRowCount: comparable || null, liveRowCount: live || null, previousId: previous ? previous.id : null });
  }
  return previous;
}

/**
 * Write the rows and activate. `apply(rows)` does the collection-specific work and returns a
 * summary; it runs BEFORE activation, so a failure leaves the batch `loading` and the previous
 * one active.
 */
async function commit(repos, ctx, snapshot, rows, apply, opts) {
  const o = opts || {};
  let previous;
  try {
    previous = await sanity(repos, snapshot, rows.length, o.force, o.liveCount);
  } catch (e) {
    // A refused batch is closed out, not left half-open: `loading` for ever would block the
    // same file being sent again after someone looks at it.
    await fail(repos, ctx, snapshot, e.message);
    throw e;
  }
  let summary;
  try {
    summary = (await apply(rows)) || {};
  } catch (e) {
    await fail(repos, ctx, snapshot, e.message);
    throw e instanceof IngestError ? e : new IngestError(500, `the extract could not be stored: ${e.message}`);
  }
  const at = nowIso();
  await repos.snapshots.update(snapshot.id, { status: "active", rowCount: rows.length, activatedAt: at, summary });
  if (previous && previous.id !== snapshot.id) {
    await repos.snapshots.update(previous.id, { status: "superseded", supersededAt: at, supersededById: snapshot.id });
  }
  const pruned = await prune(repos, snapshot.kind, o.rowCollection);
  await audit.record(repos, ctx, { entity: "snapshot", entityId: snapshot.id, type: "extract_imported",
    payload: { kind: snapshot.kind, filename: snapshot.filename, rows: rows.length, sha256: snapshot.sha256,
      previousId: previous ? previous.id : null, prunedBatches: pruned, summary } });
  return Object.assign(await repos.snapshots.get(snapshot.id), { previous: previous ? { id: previous.id, rowCount: previous.rowCount } : null });
}

async function fail(repos, ctx, snapshot, reason) {
  await repos.snapshots.update(snapshot.id, { status: "failed", failedAt: nowIso(), error: String(reason).slice(0, 400) });
  await audit.record(repos, ctx, { entity: "snapshot", entityId: snapshot.id, type: "extract_failed",
    payload: { kind: snapshot.kind, reason: String(reason).slice(0, 400) } });
}

/** Keep the newest few batches per kind; drop the rows of the rest so storage does not grow forever. */
async function prune(repos, kind, rowCollection) {
  const all = await repos.snapshots.all((s) => s.kind === kind && s.status !== "failed");
  all.sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
  const drop = all.slice(KEEP_BATCHES);
  for (const s of drop) {
    if (rowCollection && repos[rowCollection]) {
      for (const row of await repos[rowCollection].all((r) => r.batchId === s.id)) await repos[rowCollection].remove(row.id);
    }
    await repos.snapshots.update(s.id, { status: "pruned", prunedAt: nowIso(), rowsRemoved: true });
  }
  return drop.map((s) => s.id);
}

/** What `/health` and the admin screen show: one line per kind, and whether it is stale. */
async function status(repos, kinds, staleDays) {
  const out = [];
  const limit = (staleDays || 8) * 86400000;
  for (const kind of kinds) {
    const active = await activeFor(repos, kind);
    const ageMs = active ? Date.now() - new Date(active.importedAt).getTime() : null;
    out.push({
      kind,
      batchId: active ? active.id : null,
      importedAt: active ? active.importedAt : null,
      asOfDate: active ? active.asOfDate : null,
      rowCount: active ? active.rowCount : null,
      ageDays: ageMs === null ? null : Math.floor(ageMs / 86400000),
      stale: ageMs === null ? true : ageMs > limit,
      source: active ? active.source : null,
    });
  }
  return out;
}

module.exports = { begin, commit, fail, sanity, prune, status, activeFor, IngestError, sha256, KEEP_BATCHES, MIN_ROW_RATIO };
