"use strict";
// Boot hydration from committed seed/*.json + demo reset.
//
// What is seeded is REFERENCE data only: people, routing rules, budget pots, the
// name->mailbox directory, the SAP approver matrix, the AuC recon lines and a budget
// baseline. AFEs are not seeded — they are created through the wizard, which is the
// point of the rebuild.
const fs = require("fs");
const path = require("path");

const SEED_DIR = path.join(__dirname, "..", "seed");

function readSeed(name) {
  return JSON.parse(fs.readFileSync(path.join(SEED_DIR, name), "utf8"));
}

async function hydrate(repos) {
  const users = readSeed("users.json").users;
  await repos.users.insertMany(users);

  const rules = readSeed("org-rules.json").rules;
  await repos.orgRules.insertMany(rules.map((r) => Object.assign({ retiredAt: null }, r)));

  const pots = readSeed("budget-pots.json").pots;
  await repos.budgetPots.insertMany(pots);

  const dir = readSeed("directory.json").entries;
  await repos.directory.insertMany(dir);

  // Master data the business maintains from here on (lib/mdm). Seeded so a fresh environment is
  // usable on the first boot; changed afterwards in Admin, in the UI or by Excel import, where
  // every change is versioned. The seed is the baseline, never the authority.
  const locations = readSeed("locations.json").locations;
  await repos.locations.insertMany(locations);

  const reference = readSeed("reference-lists.json").entries;
  await repos.referenceLists.insertMany(reference);

  // The two SAP designations the form's Asset Acquisition block asks for (R96). The life band
  // carries the number of YEARS with it, because a cost divided by a label is nothing.
  const assetClasses = readSeed("asset-classes.json").entries;
  await repos.assetClasses.insertMany(assetClasses);
  const assetLives = readSeed("asset-lives.json").entries;
  await repos.assetLives.insertMany(assetLives);

  // SAP approver matrix — one row per cost centre (ids are `mxr-<costCenter>`, so the
  // 2,561 report rows collapse to the unique cost centres the report covers).
  const matrix = readSeed("approver-matrix.json");
  repos.meta.matrixBatch = {
    batchId: matrix.batchId, filename: matrix.filename,
    reportDate: matrix.reportDate, importedAt: matrix.importedAt, rowCount: matrix.rows.length,
  };
  await repos.matrix.insertMany(matrix.rows.map((r) => Object.assign({ id: `mxr-${r.costCenter}` }, r)));

  // AuC recon lines — the quarterly review population (kept from v0.2, unchanged).
  const tracker = readSeed("tracker.json").items;
  await repos.tracker.insertMany(tracker);

  // Per-IO budget baseline, as one extract snapshot.
  const budget = readSeed("sap-budget-baseline.json");
  await repos.snapshots.insert({
    id: budget.batchId, kind: "io_budget", status: "active", filename: budget.filename,
    asOfDate: budget.asOfDate, importedByEmail: budget.importedByEmail, importedAt: budget.importedAt,
    rowCount: budget.rows.length, seededBaseline: true,
  });
  await repos.budgetRows.insertMany(budget.rows.map((r) => Object.assign({ batchId: budget.batchId }, r)));

  repos.meta.seedInfo = {
    seededAt: new Date().toISOString(),
    users: users.length,
    orgRules: rules.length,
    budgetPots: pots.length,
    directory: dir.length,
    matrixRows: await repos.matrix.count(),
    trackerItems: tracker.length,
    budgetRows: budget.rows.length,
    locations: locations.length,
    referenceValues: reference.length,
  };
  return repos.meta.seedInfo;
}

// Everything `hydrate` writes. A reset clears these and seeds them again, so a collection that
// is seeded but not listed here is seeded ON TOP of itself every time — which is how the asset
// masters reached 210 rows of 35 before this line was corrected.
const SEEDED_COLLECTIONS = [
  "users", "orgRules", "budgetPots", "directory", "matrix", "tracker", "snapshots", "budgetRows",
  "locations", "referenceLists", "assetClasses", "assetLives",
];
const WORKING_COLLECTIONS = [
  "afes", "routings", "envelopes", "ios", "ioMaster", "poLines",
  "notifications", "attachmentsMeta", "auditEvents", "jobs",
  // Master history and feature flags reset with everything else: a reset puts the environment
  // back to the seed, and a version trail describing edits that no longer exist would be a lie.
  "masterVersions", "settings", "proposals",
  // Global Finance's rates arrive by upload and are not seeded (R161), so a reset empties them.
  "fxRates",
];

async function reset(repos) {
  for (const key of SEEDED_COLLECTIONS.concat(WORKING_COLLECTIONS)) await repos[key].clear();
  await repos.attachmentStore.clear();
  // Reseeding writes thousands of rows. On a persistent store it must use the same
  // suspend-then-batch-flush discipline as boot: the per-row fire-and-forget path cannot
  // keep up, and a process that stops mid-flush leaves the database holding a partial
  // reseed that the next boot then restores as if it were complete.
  if (repos.persistent) {
    const { suspendPersistence, flushPersistence } = require("./repos");
    suspendPersistence(repos);
    const info = await hydrate(repos);
    await flushPersistence(repos);
    return info;
  }
  return hydrate(repos);
}

/**
 * Changes to stored documents that a restore has to make, because the code that reads them has
 * moved on. Each one is idempotent and narrow; a migration that cannot be run twice has no place
 * on a boot path that runs on every restart.
 */
async function migrate(repos) {
  const applied = {};

  // v0.5: `classification` became the CAPITAL nature, with OpEx standing beside it rather than
  // being one of its values (Meeting #5 — CapEx and OpEx on one AFE). An AFE stored as
  // "opex_only" already has its amount in money.opexUsd, so it only needs the new word.
  const opexOnly = await repos.afes.all((a) => a.money && a.money.classification === "opex_only");
  for (const afe of opexOnly) {
    await repos.afes.update(afe.id, { money: Object.assign({}, afe.money, { classification: "none" }) });
  }
  if (opexOnly.length) applied.classificationNone = opexOnly.length;

  if (Object.keys(applied).length) console.log("Migrations applied on restore:", applied);
  return applied;
}

/**
 * Counts and reference metadata when the rows came from Postgres rather than the seed files.
 * The matrix batch header is static reference data read from the committed seed either way;
 * only the row counts are taken from what is actually loaded.
 */
async function hydrateMeta(repos) {
  const matrix = readSeed("approver-matrix.json");
  repos.meta.matrixBatch = {
    batchId: matrix.batchId, filename: matrix.filename,
    reportDate: matrix.reportDate, importedAt: matrix.importedAt, rowCount: matrix.rows.length,
  };
  await migrate(repos);

  // Master data added after a database was first created will not be in it. Seed what is
  // missing rather than leaving the tool without a location list — an empty master is not a
  // deliberate state, it is a database that predates the feature.
  if (!(await repos.locations.count())) {
    await repos.locations.insertMany(readSeed("locations.json").locations);
    console.log("Seeded the location master into an older database.");
  }
  if (!(await repos.referenceLists.count())) {
    await repos.referenceLists.insertMany(readSeed("reference-lists.json").entries);
    console.log("Seeded the reference lists into an older database.");
  }
  if (!(await repos.assetClasses.count())) {
    await repos.assetClasses.insertMany(readSeed("asset-classes.json").entries);
    console.log("Seeded the asset classes into an older database.");
  }
  if (!(await repos.assetLives.count())) {
    await repos.assetLives.insertMany(readSeed("asset-lives.json").entries);
    console.log("Seeded the asset lives into an older database.");
  }
  // Routing rules are different: the collection is never EMPTY, it just falls behind. UAT was
  // found on 2026-09-21 holding rules 0001-0004 — the four it was created with — while the seed
  // had gained the $1M technical accounting review, the LSD coordinator and BOTH Fixed Assets
  // issue approvers. Nobody would have noticed until Judithmelanie tried to approve an issue and the
  // tool told him no approver was configured. So this back-fills BY ID.
  // It can only ever add a rule this database has never held: retiring one in Admin sets
  // `active: false` and keeps the row, so a rule somebody took out deliberately is still there
  // and is left exactly as they left it.
  {
    const seeded = readSeed("org-rules.json").rules || [];
    const have = new Set((await repos.orgRules.all()).map((r) => r.id));
    const missing = seeded.filter((r) => !have.has(r.id));
    if (missing.length) {
      await repos.orgRules.insertMany(missing);
      console.log(`Seeded ${missing.length} routing rule(s) added since this database was created: ${missing.map((r) => r.id).join(", ")}.`);
    }
  }
  // Budget pots are the same shape of collection and the same trap. UAT holds the 15 CORP_IT
  // pots it was created with; the seed gained MFG, Facilities and LSG_R&D on 2026-09-22 so the
  // division switcher (R128) has somewhere to go. An "is it empty?" back-fill would have shipped
  // the switcher to an environment with exactly one division in it — the feature present and
  // provably doing nothing, which is worse than not shipping it.
  //
  // BY ID, for the same reason as the rules: a division loads its own real figures over the
  // dummy amounts, and a back-fill that touched an existing row would overwrite them.
  {
    const seeded = readSeed("budget-pots.json").pots || [];
    const have = new Set((await repos.budgetPots.all()).map((p) => p.id));
    const missing = seeded.filter((p) => !have.has(p.id));
    if (missing.length) {
      await repos.budgetPots.insertMany(missing);
      const divisions = Array.from(new Set(missing.map((p) => p.division)));
      console.log(`Seeded ${missing.length} budget pot(s) added since this database was created (${divisions.join(", ")}).`);
    }
  }
  repos.meta.seedInfo = {
    restoredAt: new Date().toISOString(),
    source: "postgres",
    users: await repos.users.count(),
    orgRules: await repos.orgRules.count(),
    budgetPots: await repos.budgetPots.count(),
    directory: await repos.directory.count(),
    matrixRows: await repos.matrix.count(),
    trackerItems: await repos.tracker.count(),
    budgetRows: await repos.budgetRows.count(),
    locations: await repos.locations.count(),
    referenceValues: await repos.referenceLists.count(),
    assetClasses: await repos.assetClasses.count(),
    assetLives: await repos.assetLives.count(),
    afes: await repos.afes.count(),
  };
  return repos.meta.seedInfo;
}

module.exports = { hydrate, reset, hydrateMeta, migrate, SEEDED_COLLECTIONS, WORKING_COLLECTIONS };
