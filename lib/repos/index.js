"use strict";
// THE storage swap point.
//   no DATABASE_URL  -> in-memory collections hydrated from seed/*.json (the PoC default)
//   DATABASE_URL set -> the same collections, write-through to Postgres (lib/repos/pgStore.js)
// Call sites are identical either way; nothing above this file knows which is running.
const { collection } = require("./collection");
const { createPool, pgCollection, pgAttachmentStore, ensureSchema } = require("./pgStore");

function createAttachmentStore() {
  // In-memory bytes for the no-database path (App Service storage is not durable).
  const MAX_TOTAL = 50 * 1024 * 1024;
  let bytes = new Map();
  let total = 0;
  return {
    async put(storageKey, buffer) {
      if (total + buffer.length > MAX_TOTAL) throw new Error("attachment store is full (PoC in-memory cap)");
      bytes.set(storageKey, buffer);
      total += buffer.length;
    },
    async get(storageKey) {
      return bytes.get(storageKey) || null;
    },
    async clear() {
      bytes = new Map();
      total = 0;
    },
  };
}

// v0.4 collections (docs/v0.4-blueprint.md §4.1). The v0.2 case model — `cases`,
// `documents`, `mailMessages` — is gone with the FA-first intake path.
const COLLECTIONS = [
  ["users", "usr"],
  ["afes", "afe"],             // the AFE aggregate, fields grouped by wizard step
  ["routings", "rtg"],         // frozen approval snapshot per round (SOX evidence)
  ["envelopes", "env"],        // DocuSign (or simulated) envelope + recipient events
  ["ios", "io"],               // internal orders: parent + children per country/site
  ["orgRules", "rule"],        // pre-approvers, overrides, additional signers, CC, coordinators
  ["budgetPots", "pot"],       // annual budget by division x category x region
  ["directory", "dir"],        // approver name -> mailbox, learned and confirmed
  ["matrix", "mxr"],           // SAP approver matrix, one row per cost centre (latest batch)
  ["snapshots", "imp"],        // extract batch headers (matrix / io_budget / io_master / po_lines)
  ["budgetRows", "bgr"],       // per-IO budget/actual/commitment rows, batch-tagged
  ["ioMaster", "iom"],         // SAP internal-order master rows
  ["poLines", "pol"],          // purchase-order lines per IO
  ["tracker", "trk"],          // AuC recon lines (quarterly review, kept from v0.2)
  ["notifications", "ntf"],    // the outbox
  ["attachmentsMeta", "att"],
  ["auditEvents", "aud"],      // the single append-only audit model
  ["jobs", "job"],             // scheduler leases + last-run state
  // v0.5. Master data the business maintains (lib/mdm) — WE are the system of record for
  // these, unlike the SAP-fed collections above, so they are edited in the UI and by Excel
  // import, and every change leaves a version behind.
  ["locations", "loc"],        // the AFE template's own site list; prints on the form
  ["referenceLists", "ref"],   // project types, order types, regions — the drop-downs
  ["assetClasses", "acl"],     // SAP asset classes, from the template's DataVal sheet (R96)
  ["assetLives", "alv"],       // asset life bands, each with the YEARS it depreciates over
  ["fxRates", "fx"],           // Global Finance's month-end rates to the dollar, every month (R161)
  ["masterVersions", "mv"],    // one frozen copy of a master per change, for restore
  ["settings", "set"],         // feature flags and the reminder ladder, by document id
  ["proposals", "prp"],        // what a model suggested; a person accepts before anything happens
];

function createRepos(kind) {
  if (kind && kind !== "memory") throw new Error(`repo kind not implemented yet: ${kind}`);
  const repos = { meta: { matrixBatch: null, seedInfo: null }, persistent: false };
  for (const [name, prefix] of COLLECTIONS) repos[name] = collection(prefix);
  repos.attachmentStore = createAttachmentStore();
  return repos;
}

/**
 * Postgres-backed repos. Returns { repos, loaded } — `loaded` is true when the
 * database already held data, which tells the caller to skip seeding.
 */
async function createPersistentRepos(databaseUrl) {
  const pool = createPool(databaseUrl);
  // Only on a database without the tables: a role that may read and write but not create could
  // not run the DDL at all, even as IF NOT EXISTS (Part B).
  await ensureSchema(pool);

  const repos = { meta: { matrixBatch: null, seedInfo: null }, persistent: true, pool: pool };
  for (const [name, prefix] of COLLECTIONS) repos[name] = pgCollection(prefix, pool, name);
  repos.attachmentStore = pgAttachmentStore(pool);

  const res = await pool.query("SELECT collection, doc FROM documents");
  const byCollection = new Map();
  for (const row of res.rows) {
    if (!byCollection.has(row.collection)) byCollection.set(row.collection, []);
    byCollection.get(row.collection).push(row.doc);
  }
  for (const [name] of COLLECTIONS) {
    const docs = byCollection.get(name) || [];
    if (docs.length) await repos[name]._load(docs);
  }
  // `meta` is derived state, not a collection — rebuild it from what we loaded rather
  // than storing a second copy that could drift.
  const anyMatrix = await repos.matrix.count();
  const loaded = res.rows.length > 0 && anyMatrix > 0;
  return { repos, loaded, pool };
}

/** Suppress per-row writes while seeding. */
function suspendPersistence(repos) {
  for (const [name] of COLLECTIONS) if (repos[name]._suspend) repos[name]._suspend();
}
/** Write every seeded collection to Postgres in batches. Returns rows written. */
async function flushPersistence(repos) {
  let n = 0;
  for (const [name] of COLLECTIONS) if (repos[name]._flush) n += await repos[name]._flush();
  return n;
}

module.exports = { createRepos, createPersistentRepos, suspendPersistence, flushPersistence };
