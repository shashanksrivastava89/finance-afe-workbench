"use strict";
// In-process jobs. Each job is a plain async function (repos, opts) → result, registered by
// name; the last run of each is kept in the `jobs` collection so /health and Admin can show
// it. Three ways to run one: the interval (SCHEDULER_ENABLED=1), a machine tick
// (POST /api/jobs/tick with JOBS_SECRET — for a Logic App or Power Automate timer once the
// App Service is not "Always On"), or an admin pressing the button (POST /api/admin/jobs/:name).
//
// A lease in the `jobs` row keeps two instances from running the same job at once; with the
// write-through store that is approximate, which is fine for reminders (worst case: one
// duplicate nudge) and is noted for Phase 1.
const JOBS = {
  reminders: require("./jobs/reminders").run,
  // Asks DocuSign what has happened and puts it through applyTransition. A no-op while the
  // envelopes are simulated, so it is safe to tick in UAT before any account exists.
  pollEnvelopes: require("./jobs/pollEnvelopes").run,
  // Empties the transactional outbox through the mail seam. A no-op while there is no Graph
  // registration — the rows stay queued and readable in the Dev Mailbox — so this is safe to
  // tick in UAT today and becomes the send path the day the registration lands.
  drainOutbox: require("./jobs/drainOutbox").run,
};
// Run at boot and from Admin, never on the tick: what the warm-up leaves stays warm until the
// process ends, so repeating it every ten minutes would spend the CPU it exists to save. These
// fill THIS process's memory, so they take no lease — two instances must each warm their own, and
// a lease left behind by a restart mid-run would otherwise skip the next boot's warm-up.
const ON_DEMAND = {
  warmUp: require("./jobs/warmUp").run,
};
const TICK_MS = 10 * 60 * 1000;
const LEASE_MS = 5 * 60 * 1000;

const nowIso = () => new Date().toISOString();
let interval = null;
let lastTickAt = null;

class JobError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function run(repos, name, opts) {
  const job = JOBS[name] || ON_DEMAND[name];
  if (!job) throw new JobError(404, `no job called ${name}; jobs: ${Object.keys(JOBS).concat(Object.keys(ON_DEMAND)).join(", ")}`);
  const leased = Boolean(JOBS[name]);
  const id = `job-${name}`;
  const startedAt = nowIso();
  const existing = await repos.jobs.get(id);
  if (leased && existing && existing.leaseUntil && new Date(existing.leaseUntil).getTime() > Date.now()) {
    throw new JobError(409, `${name} is already running (lease until ${existing.leaseUntil})`);
  }
  const leaseUntil = leased ? new Date(Date.now() + LEASE_MS).toISOString() : null;
  if (existing) await repos.jobs.update(id, { leaseUntil, lastStartedAt: startedAt });
  else await repos.jobs.insert({ id, name, leaseUntil, lastStartedAt: startedAt, runs: 0 });
  let result, error = null;
  try {
    result = await job(repos, opts || {});
  } catch (e) {
    error = e.message;
  }
  const finishedAt = nowIso();
  const row = await repos.jobs.get(id);
  await repos.jobs.update(id, {
    leaseUntil: null, lastRunAt: finishedAt, lastResult: error ? null : result, lastError: error,
    runs: ((row && row.runs) || 0) + 1,
  });
  if (error) throw new JobError(500, `${name} failed: ${error}`);
  return { name, startedAt, finishedAt, result };
}

/** Run every job once — what the interval and the machine tick both do. */
async function tick(repos) {
  lastTickAt = nowIso();
  const out = [];
  for (const name of Object.keys(JOBS)) {
    try { out.push(await run(repos, name, {})); }
    catch (e) { out.push({ name, error: e.message }); }
  }
  return out;
}

function start(repos) {
  if (process.env.SCHEDULER_ENABLED !== "1" || interval) return false;
  interval = setInterval(() => { tick(repos).catch((e) => console.error("[scheduler]", e.message)); }, TICK_MS);
  if (interval.unref) interval.unref();
  return true;
}

function status() {
  return {
    mode: process.env.SCHEDULER_ENABLED === "1" ? "interval" : (process.env.JOBS_SECRET ? "tick" : "manual"),
    jobs: Object.keys(JOBS),
    onDemand: Object.keys(ON_DEMAND),
    lastTickAt,
  };
}

module.exports = { run, tick, start, status, JOBS, ON_DEMAND, JobError };
