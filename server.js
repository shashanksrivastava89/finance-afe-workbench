"use strict";
// AFE to Fixed Asset (AUC) Automation — Acme ADC pattern.
// Entrypoint MUST stay server.js at the repo root. See CLAUDE.md for the platform
// rules this file must never violate, and docs/architecture.md for what it fronts.
const express = require("express");
const path = require("path");
const crypto = require("crypto");

const { createRepos, createPersistentRepos, suspendPersistence, flushPersistence } = require("./lib/repos");
const store = require("./lib/store");
const refData = require("./lib/domain/refData");
const afeRules = require("./lib/domain/afeRules");
const { previewChain } = require("./lib/domain/chainBuilder");
const docusign = require("./lib/integrations/docusign");
const scheduler = require("./lib/scheduler");
const people = require("./lib/domain/people");
const rbac = require("./lib/domain/rbac");
const coordination = require("./lib/domain/coordination");
const fx = require("./lib/domain/fx");

// Two switches, both off unless the environment turns them on, because both are ways of
// being someone you are not and neither may ever be the default in a deployed environment.
//
//   DEMO_MODE=1          the admin-only "view as" tool (lib/routes/admin.js act-as)
//   UNAUTHENTICATED_AS   the identity to assume when the platform sent no SSO header
//
// `UNAUTHENTICATED_AS` exists for one reason: an App Service that has not yet been put behind
// Easy Auth would otherwise 401 every visitor. Whoever sets it is choosing to run the site
// open, so it is spelt out in the setting's own name, it is reported by /health, and the
// identity it names gets NO roles beyond the base one — an unauthenticated visitor can raise
// an AFE and see their own, and nothing else. Never point it at a privileged mailbox.
const DEMO_MODE = process.env.DEMO_MODE === "1";
const UNAUTHENTICATED_AS = (process.env.UNAUTHENTICATED_AS || "").trim().toLowerCase();

// ---- ADC-mandated identity helpers (verbatim — do not edit) -----------------
function currentUser(req) {
  const name = req.headers["x-ms-client-principal-name"];
  if (!name) return null;
  let claims = [];
  const encoded = req.headers["x-ms-client-principal"];
  if (encoded) {
    try {
      claims = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).claims || [];
    } catch { /* malformed header - treat as no claims */ }
  }
  const claim = (t) => (claims.find((c) => c.typ === t) || {}).val || "";
  return { email: name, displayName: claim("name") || name };
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    return res.status(401).json({ error: "Sign-in required.", loginUrl: "/.auth/login/aad" });
  }
  req.user = user;
  next();
}
// -----------------------------------------------------------------------------

const app = express();

/**
 * Gzip, on Node's own zlib — no fifth dependency (CLAUDE.md).
 *
 * The tracker ships 842 KB of JSON and the matrix 119 KB. Uncompressed that is seconds on a
 * connection from India, for text that gzips to under a tenth of the size. Small bodies are
 * left alone: below the threshold the compression costs more than the bytes it saves.
 *
 * It wraps `res.end`/`res.write` rather than piping, so routes that already stream bytes
 * (the PDFs, the .eml) are untouched — those are compressed formats already and re-compressing
 * them wastes CPU for nothing.
 */
const zlib = require("zlib");
const GZIP_MIN_BYTES = 1024;
const GZIP_TYPES = /^(application\/json|text\/|application\/javascript|image\/svg)/;
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(req.headers["accept-encoding"] || "")) return next();
  const send = res.send.bind(res);
  res.send = (body) => {
    const type = String(res.getHeader("Content-Type") || "");
    const buf = Buffer.isBuffer(body) ? body
      : typeof body === "string" ? Buffer.from(body, "utf8") : null;
    if (!buf || buf.length < GZIP_MIN_BYTES || !GZIP_TYPES.test(type) || res.getHeader("Content-Encoding")) {
      return send(body);
    }
    const gz = zlib.gzipSync(buf);
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    res.removeHeader("Content-Length");
    return send(gz);
  };
  next();
});

// A document rides in JSON as base64, which is four thirds of the file, so a 25 MB facilities pack
// is a 33.4 MB body — and one 25 MB limit for every body refused anything over ~18.7 MB with a
// bare 413 (2026-10-16). The upload route gets room for the largest file its own check allows
// (refData.ATTACHMENT_LIMITS.perFileBytes, 25 MB) and decides the FILE's size itself; every other
// body keeps the smaller limit. Parsed once: the general parser skips a body already read.
app.post("/api/afes/:id/documents", express.json({ limit: "36mb" }));
app.use(express.json({ limit: "25mb" }));

const repos = createRepos("memory");
const actAsMap = new Map(); // realEmail -> actingAsEmail (demo device)

let seedInfo = null;
let seedError = null;
// Boot is async (a Postgres restore takes a second or two) but App Service starts routing
// the moment we listen. Requests await this rather than seeing a half-loaded store.
let readyResolve;
const ready = new Promise((r) => { readyResolve = r; });
const WARM_UP_DELAY_MS = 5000;

/**
 * The person behind the request, as a stored row.
 *
 * The portal is for everyone: an employee who has never been heard of signs in and is a
 * requester, immediately, with no one to ask. So the first time we see a mailbox we write the
 * row rather than inventing one per request — otherwise an administrator could never see who
 * is using the tool, and could never promote anybody, because the people list would only ever
 * contain the eleven the seed shipped with. `roles: []` means exactly the base role
 * (`rbac.BASE_ROLE`); everything above that is granted by an administrator, deliberately.
 *
 * The display name is refreshed from the SSO claim when the platform sends a better one than
 * the mailbox we guessed the name from.
 */
async function resolveUser(real) {
  const email = real.email.toLowerCase();
  const existing = await repos.users.find((u) => u.email === email);
  if (existing) {
    if (real.displayName && real.displayName !== email && existing.displayName !== real.displayName
        && existing.provisioned) {
      return repos.users.update(existing.id, { displayName: real.displayName });
    }
    return existing;
  }
  return repos.users.insert({
    email,
    displayName: real.displayName && real.displayName !== email ? real.displayName : people.nameFromEmail(email),
    title: null, roles: [], matrixNames: [], coordinatorFor: [],
    active: true, provisioned: true, firstSeenAt: new Date().toISOString(),
  });
}

/** What the store actually holds right now — the numbers /health reports. */
async function liveCounts() {
  const of = async (name) => (repos[name] ? repos[name].count() : 0);
  const [users, orgRules, budgetPots, directory, matrixRows, trackerItems, budgetRows, afes,
    locations, referenceValues] = await Promise.all([
    of("users"), of("orgRules"), of("budgetPots"), of("directory"),
    of("matrix"), of("tracker"), of("budgetRows"), of("afes"),
    of("locations"), of("referenceLists"),
  ]);
  return { users, orgRules, budgetPots, directory, matrixRows, trackerItems, budgetRows,
    locations, referenceValues, afes };
}

/** "none", or the AI capability that is switched on and whether it can run here (R170). */
async function aiStatus() {
  if (!(await require("./lib/domain/features").isOn(repos, "quoteReading"))) return "none";
  const reader = require("./lib/integrations/docintel").status();
  return reader.ready ? "quote-reading" : `quote-reading switched on, not ready: ${reader.why}`;
}

/** Is a signature actually waiting on this person? Earns Approvals without the role (R45/R60). */
async function hasPendingSignature(ctx) {
  const routings = await repos.routings.all((r) => r.status !== "superseded");
  return routings.some((r) => (r.recipients || []).some(
    (rec) => rec.status === "pending" && people.userMatches(ctx, rec)));
}

/**
 * The numbers on the top bar, counted here rather than fetched.
 *
 * The chrome used to get these by calling `/coordinator/queue`, `/approvals/mine`, `/fa/queue`
 * and `/mailbox` — four awaited round trips on every page load, two of them the most expensive
 * endpoints in the app, to render four small integers. From India that was the best part of a
 * second before a screen could settle (R92).
 *
 * So they are counted directly from the collections instead: no projection, no validation, no
 * routing preview, no PDF. The definitions are the ones those endpoints use, and the suites
 * assert the two agree — a badge that drifts from the screen it points at is worse than no badge.
 */
async function badgeCounts(ctx) {
  const out = { prepare: null, approvals: null, fa: null, mailbox: null };
  const sections = new Set(rbac.sections(ctx, { hasPendingSignature: false }).map((s) => s.key));
  const wants = (key) => sections.has(key);

  if (rbac.can(ctx, "afe.coordinate")) {
    const divisions = ctx.coordinatorFor || [];
    const isAdmin = rbac.isAdmin(ctx);
    // What is this person's to review — the rule the queue and the Send button use (R157). A
    // coordinator's OWN AFE belongs to the assigned coordinator's badge, not theirs.
    const mine = (a) => coordination.coordinates(ctx, a) || (isAdmin && !divisions.length);
    out.prepare = await repos.afes.count((a) => mine(a) && ["submitted", "returned"].includes(a.state)) || null;
  }

  // Approvals is the one that also decides whether the section appears at all, so it is counted
  // whether or not the role is held: a matrix names people who are not users here.
  const routings = await repos.routings.all((r) => ["active", "completed"].includes(r.status));
  let toSign = 0;
  let pending = false;
  for (const rt of routings) {
    for (const rec of rt.recipients || []) {
      if (rec.role === "cc" || !people.userMatches(ctx, rec)) continue;
      if (rec.status === "pending") pending = true;
      if (rec.status !== "sent") continue;
      const afe = await repos.afes.get(rt.afeId);
      if (afe && afe.state === "in_approval") toSign += 1;
      if (afe && ["in_approval", "on_hold"].includes(afe.state)) pending = true;
    }
  }
  out.approvals = toSign || null;

  if (wants("fa") || rbac.can(ctx, "fa.process")) {
    out.fa = await repos.afes.count((a) => ["approved", "fa_review"].includes(a.state)) || null;
  }
  if (rbac.can(ctx, "mailbox.read")) {
    // What needs a PERSON: a message that failed to send. It counted every queued message — 190
    // on UAT, none of which anybody could act on while there is no mail connection (2026-10-16).
    out.mailbox = await repos.notifications.count((n) => n.status === "failed") || null;
  }
  return { counts: out, hasPendingSignature: pending };
}

// Effective-identity middleware: Easy Auth first, the open-site fallback second.
// The verbatim helpers above stay the single source of platform identity.
/**
 * "View as" per BROWSER while the site is open (R171).
 *
 * With no SSO header every visitor is `UNAUTHENTICATED_AS` — one person — so "view as" keyed by
 * that mailbox moved EVERYBODY at once: in the UAT review of 2026-10-14 one tester's switch made
 * another's send-back land as Aiden's, with the reason "Approve". While the site is open, each
 * browser therefore carries its own random id (HttpOnly, SameSite) and "view as" is keyed by it.
 * A client that carries no cookie — a script, a smoke suite — keeps the mailbox key exactly as
 * before, and with Easy Auth in front nothing here applies: the key is the person's own mailbox.
 */
const VIEWER_COOKIE = "afe_viewer";
const viewerOf = (req) => {
  const m = /(?:^|;\s*)afe_viewer=([a-f0-9]{32})(?:;|$)/.exec(String(req.headers.cookie || ""));
  return m ? m[1] : null;
};
function issueViewer(req, res) {
  if (!UNAUTHENTICATED_AS || viewerOf(req) || currentUser(req)) return;
  const secure = req.secure || /^https/i.test(String(req.headers["x-forwarded-proto"] || ""));
  res.append("Set-Cookie", `${VIEWER_COOKIE}=${crypto.randomBytes(16).toString("hex")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? "; Secure" : ""}`);
}

async function withContext(req, res, next) {
  await ready;
  let real = currentUser(req);
  const open = !real && Boolean(UNAUTHENTICATED_AS);
  if (open) real = { email: UNAUTHENTICATED_AS, displayName: "Signed out" };
  if (!real) return res.status(401).json({ error: "Sign-in required.", loginUrl: "/.auth/login/aad" });

  const realRow = await resolveUser(real);
  // ONE spelling of the mailbox. The platform sends the header as the directory holds it —
  // `Shashank_Srivastava@example.com` — and "view as" is WRITTEN under the lower-cased address
  // (`req.ctx.realUser.email`, below). Read by the header as sent, it missed: the same person was
  // viewing as someone else in one tab and as themselves in the next, decided by nothing but the
  // capital letters in their address (found on UAT, 2026-09-25).
  const realEmail = String(real.email).toLowerCase();
  const viewer = open ? viewerOf(req) : null;
  const viewKey = viewer ? `browser:${viewer}` : realEmail;
  const actAsEmail = actAsMap.get(viewKey);
  let effRow = realRow;
  if (actAsEmail) {
    const target = await repos.users.find((u) => u.email === actAsEmail && u.active);
    if (target) effRow = target;
  }
  req.ctx = {
    realUser: { email: realEmail, displayName: real.displayName },
    realRoles: realRow.roles || [],
    user: { email: effRow.email, displayName: effRow.displayName },
    userRow: effRow,
    roles: effRow.roles || [],
    coordinatorFor: effRow.coordinatorFor || [],
    actingAs: actAsEmail && effRow.email === actAsEmail ? { email: effRow.email, displayName: effRow.displayName } : null,
    viewKey,
  };
  next();
}

// ---- platform endpoints ------------------------------------------------------
// One request says whether every seam is live or standing in — use it to pre-flight a
// demo. It reports modes, never secrets. There is no AI service to report (R62).
app.get("/health", async (req, res) => {
  if (seedError) return res.status(503).json({ status: "seed-failed", error: String(seedError) });
  if (!seedInfo) return res.status(503).json({ status: "starting" });
  res.json({
    status: "ok",
    storage: repos.persistent ? "postgres" : "in-memory",
    // How the app signs in to that database: "password", or "entra" — a token from the app's own
    // identity, no password anywhere (Part B). Null with no database.
    storageAuth: repos.persistent ? require("./lib/repos/pgStore").authMode() : null,
    demoMode: DEMO_MODE,
    // "sso" once the platform fronts us with Easy Auth; "open" says, in one word, that the
    // site is serving anybody who reaches it as the fallback identity.
    auth: UNAUTHENTICATED_AS ? "open" : "sso",
    // Counted now, not remembered from boot. `store.reset()` and every extract move these, and
    // a health endpoint reporting what was true at startup is worse than one reporting nothing:
    // it reads as current. The load record — when, and from where — is what boot contributes.
    seed: Object.assign({}, seedInfo, await liveCounts()),
    integrations: {
      docusign: docusign.mode(),
      mail: require("./lib/integrations/mail").mode() === "graph" ? "graph" : "eml-download",
      scheduler: scheduler.status().mode,
      sapExtracts: process.env.INGEST_SECRET ? "endpoint-open" : "upload-only",
      // Which AI capabilities are live right now — a flag that is on AND a reader that can reach
      // its service — and, when one is on but cannot run, why not (R170).
      ai: await aiStatus(),
    },
    extracts: await require("./lib/ingest/snapshots").status(repos, require("./lib/ingest").KIND_NAMES),
  });
});

// Who the caller is and, more usefully, what the server will let them do. `capabilities` and
// `sections` are computed by lib/domain/rbac.js — the same table the route guards consult — so
// the top bar cannot offer a section the API would refuse, and no copy of the rules lives in
// the browser to drift from this one.
app.get("/api/me", withContext, async (req, res) => {
  const unread = await repos.notifications.count(
    (n) => n.recipientEmail === req.ctx.user.email && !n.readAt
  );
  // One pass over the routings answers both questions the top bar asks: may this person see
  // Approvals at all, and what are the four badge numbers.
  const badges = await badgeCounts(req.ctx);
  const opts = { hasPendingSignature: badges.hasPendingSignature };
  res.json({
    signedIn: true,
    email: req.ctx.user.email,
    displayName: req.ctx.userRow.displayName,
    title: req.ctx.userRow.title || null,
    roles: [...rbac.rolesOf(req.ctx)],
    capabilities: [...rbac.capabilities(req.ctx, opts)],
    sections: rbac.sections(req.ctx, opts),
    coordinatorFor: req.ctx.coordinatorFor,
    badges: badges.counts,
    realEmail: req.ctx.realUser.email,
    actingAs: req.ctx.actingAs,
    isAdmin: rbac.isAdmin(req.ctx),
    demoMode: DEMO_MODE,
    authenticated: Boolean(currentUser(req)),
    unreadNotifications: unread,
    logoutUrl: "/.auth/logout",
  });
});

/**
 * The location master, for the wizard's typeahead.
 *
 * 150 rows, cached in the browser for the session — the same shape as `/matrix/all`, and for
 * the same reason: a typeahead that round-trips on every keystroke is a typeahead nobody uses.
 * Only the active ones: a site somebody retired should stop being offered without breaking the
 * AFEs that already name it.
 */
app.get("/api/locations", withContext, async (req, res) => {
  const rows = await repos.locations.all((l) => l.active !== false);
  rows.sort((a, b) => String(a.code).localeCompare(String(b.code)));
  res.json(rows.map((l) => ({ code: l.code, country: l.country || "", city: l.city || "" })));
});

app.get("/api/refdata", withContext, async (req, res) => {
  // The drop-downs are master data now, not constants: the business edits them in Admin and a
  // change takes effect on the next load. `refData` keeps only what is genuinely code — bands,
  // thresholds, the Cloud CapEx tree.
  const refRows = await repos.referenceLists.all((x) => x.active !== false);
  const listOf = (name) => refRows.filter((x) => x.list === name)
    .sort((a, b) => (a.sortOrder || 999) - (b.sortOrder || 999) || String(a.value).localeCompare(String(b.value)))
    .map((x) => x.value);
  const projectTypes = listOf("project_type");
  const regions = listOf("region");
  // The two SAP designations the Asset Acquisition block asks for (R96). Master data, so a
  // change in Admin reaches the wizard on the next load rather than on the next deploy.
  const sortMaster = (rows) => rows.slice().sort((a, b) =>
    (a.sortOrder || 999) - (b.sortOrder || 999) || String(a.value).localeCompare(String(b.value)));
  const assetClasses = sortMaster(await repos.assetClasses.all((x) => x.active !== false));
  const assetLives = sortMaster(await repos.assetLives.all((x) => x.active !== false));
  // The newest month of Global Finance's rates (R161): what a currency picked today is priced at.
  const fxRows = await repos.fxRates.all();
  const fxMonth = fx.latestMonth(fxRows);
  res.json({
    bands: refData.BANDS.map((b) => ({ label: b.label, levels: b.levels, maxUsd: b.maxUsd === Infinity ? null : b.maxUsd })),
    levelTitles: refData.LEVEL_TITLES,
    // The journey, so the wizard and every send-back picker read one list (R118).
    wizardSteps: refData.WIZARD_STEPS,
    // Who wrote a line in the conversation (R149), in the same words the mail uses.
    threadSides: refData.THREAD_SIDES,
    // What may be attached in support of the request, which of it is priced, and where the
    // equipment comes from (R150): one list the screens read rather than type out.
    supportingRoles: refData.SUPPORTING_ROLES,
    // So a file over the limit is refused in the browser, in words, before it is read and sent.
    attachmentLimits: refData.ATTACHMENT_LIMITS,
    quoteRoles: refData.QUOTE_ROLES,
    sourcing: refData.SOURCING,
    companyCodes: refData.COMPANY_CODES,
    classifications: refData.CLASSIFICATIONS,
    cloudTree: refData.CLOUD_TREE,
    orderTypes: refData.ORDER_TYPES,
    quoteCoverageMin: refData.QUOTE_COVERAGE_MIN,
    controllershipThresholdUsd: refData.CONTROLLERSHIP_THRESHOLD_USD,
    currency: refData.CURRENCY,
    fx: fxMonth ? { month: fxMonth, monthLabel: fx.monthLabel(fxMonth),
      // The dollar is on their sheet at 1 to itself; it is the approval's own currency, not a choice here.
      rates: fx.ratesFor(fxRows, fxMonth).filter((r) => r.code !== fx.USD)
        .map((r) => ({ code: r.code, name: r.name || r.code, localPerUsd: r.localPerUsd })) } : null,
    flagRules: refData.FLAG_RULES,
    levelLadder: refData.LEVEL_LADDER,
    states: refData.STATES,
    projectTypes: projectTypes.length ? projectTypes : afeRules.PROJECT_TYPES,
    constructionTypes: afeRules.CONSTRUCTION_TYPES,
    regions: regions.length ? regions : ["NLAM", "EMEA", "APAC", "Global"],
    // The field table itself, so the browser can answer a keystroke without asking (R105).
    // It is the same rows the server validates against, projected — not a second rule set.
    fields: afeRules.fieldSpec(),
    financials: refData.FINANCIALS,
    assetClasses: assetClasses.map((x) => ({ value: x.value, code: x.code || null, label: x.label || x.value })),
    // `years` travels with the band, because the wizard fills the asset's life from it the
    // moment one is chosen and the depreciation is that number, never the label.
    assetLives: assetLives.map((x) => ({ value: x.value, years: x.years, openRange: Boolean(x.openRange), label: x.label || x.value })),
    titleMaxChars: afeRules.THRESHOLDS.titleMaxChars,
    descriptionMinChars: afeRules.THRESHOLDS.descriptionMinChars,
    reminderDays: Number(process.env.REMINDER_DAYS || refData.REMINDER_DAYS),
    mailDomain: refData.MAIL_DOMAIN,
    confirmedEmailSources: refData.CONFIRMED_EMAIL_SOURCES,
    matrixBatch: repos.meta.matrixBatch,
  });
});

// ---- machine endpoints (no SSO — ADC excludes these paths from Easy Auth) --------------
// A timer (Logic App / Power Automate) ticks the jobs when the plan is not Always On. The
// secret is compared in constant time; without JOBS_SECRET configured the endpoint is off.
app.post("/api/jobs/tick", async (req, res) => {
  await ready;
  const secret = process.env.JOBS_SECRET || "";
  if (!secret) return res.status(503).json({ error: "scheduled ticks are off — JOBS_SECRET is not configured" });
  const given = String(req.headers["x-jobs-secret"] || "");
  const ok = given.length === secret.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
  if (!ok) return res.status(401).json({ error: "bad tick secret" });
  res.json({ tickedAt: new Date().toISOString(), jobs: await scheduler.tick(repos) });
});

// Cost-centre typeahead. `/matrix/all` is the browser's one-time cache for the wizard
// (~1,200 rows, ETag-revalidated) — the wizard must not round-trip on every keystroke.
// SAP extracts arrive here with a shared secret and no user identity (ADC excludes the path
// from Easy Auth). Mounted before withContext for that reason.
app.use("/api", require("./lib/routes/ingest")({ repos }));

app.get("/api/matrix/all", withContext, async (req, res) => {
  const rows = await repos.matrix.all();
  res.json(rows.map((m) => ({ costCenter: m.costCenter, description: m.description, plant: m.plant, status: m.status })));
});

app.get("/api/matrix", withContext, async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  if (!q) return res.json([]);
  const hits = await repos.matrix.all(
    (m) => m.costCenter.startsWith(q) || m.description.toLowerCase().includes(q)
  );
  res.json(hits.slice(0, 20).map((m) => ({
    costCenter: m.costCenter, description: m.description, plant: m.plant, status: m.status,
  })));
});

app.get("/api/matrix/:costCenter", withContext, async (req, res) => {
  const row = await repos.matrix.find((m) => m.costCenter === req.params.costCenter);
  if (!row) return res.status(404).json({ error: `cost center ${req.params.costCenter} not in the approver matrix` });
  const tpc = Number(req.query.tpc || 0);
  res.json({
    costCenter: row.costCenter, description: row.description, plant: row.plant, status: row.status,
    levels: row.levels,
    chainPreview: tpc > 0 ? previewChain(row, tpc) : null,
  });
});

// ---- feature routes ------------------------------------------------------------
// The AUC review, tracker and leadership screens are restyled in Stage 7 (docs/v0.4-blueprint.md §8).
const views = require("./lib/views/afeView");
// Express 4 drops a rejected promise on the floor and Node then exits. See lib/asyncRoutes.js.
const { catchAsync } = require("./lib/asyncRoutes");
const deps = {
  repos, actAsMap, DEMO_MODE,
  afeView: (afe, ctx, opts) => views.afeView(repos, afe, ctx, opts),
};
app.use("/api", withContext, catchAsync(require("./lib/routes/afes")(deps)));        // wizard + coordinator edits
app.use("/api", withContext, catchAsync(require("./lib/routes/routing")(deps)));     // chain, send, coordinator queue
app.use("/api", withContext, catchAsync(require("./lib/routes/approvals")(deps)));   // approver inbox + decisions
app.use("/api", withContext, catchAsync(require("./lib/routes/pots")(deps)));        // budget pots (R53)
app.use("/api", withContext, catchAsync(require("./lib/routes/fa")(deps)));          // Fixed Assets: judge, red flags, KO01, record IOs
app.use("/api", withContext, catchAsync(require("./lib/routes/projects")(deps)));    // projects, per-IO figures, budget moves, the CSV
app.use("/api", withContext, catchAsync(require("./lib/routes/leadership")(deps)));  // the portfolio, read-only
app.use("/api", withContext, catchAsync(require("./lib/routes/tracker")(deps)));
app.use("/api", withContext, catchAsync(require("./lib/routes/aucReview")(deps)));   // AUC quarterly review
app.use("/api", withContext, catchAsync(require("./lib/routes/notifications")(deps)));
app.use("/api", withContext, catchAsync(require("./lib/routes/mailbox")(deps)));       // the Dev Mailbox: the outbox, read as mail
app.use("/api", withContext, catchAsync(require("./lib/routes/admin")(deps)));

// An unknown /api path must read as a missing endpoint, not as the SPA shell: returning
// index.html with a 200 turned every typo into a silent parse error.
app.use("/api", (req, res) => res.status(404).json({ error: `no such endpoint: ${req.method} ${req.originalUrl}` }));

// The frontend is 32 ES modules, a stylesheet and the design tokens, and none of it changes
// between two clicks — so the browser should keep them. But it must still ASK.
//
// `no-cache` is not `no-store`: the browser keeps the bytes and sends `If-None-Match`, and an
// unchanged file comes back as a ~100-byte 304 with no body. That is the whole saving, without
// the failure a `max-age` buys with it. **Nothing here carries a content hash in its URL**, so
// a `max-age` means a deploy cannot reach anyone until it expires — and worse, expiries are
// staggered, so a person ends up running some modules from the new deploy and some from the
// old one. That is not a stale screen, it is a screen built from two incompatible halves.
// This was `max-age=1h` for one day (2026-09-18 to 2026-09-20) and is the reason a fix to
// `wizard.js` did not reach a reloaded tab.
//
// If the modules ever DO get hashed names, long-cache them here and revisit this comment.
/**
 * Static text assets, gzipped (R136).
 *
 * The gzip middleware above wraps `res.send`, and `express.static` does not use it """ + EM + """ it streams
 * through `sendFile`. So every API response was compressed and NOT ONE static file was: measured
 * against UAT, `app.css` went over the wire at 114,346 bytes with no `Content-Encoding` at all,
 * for a stylesheet that gzips to 27 KB. Across the 42 text assets that is **622 KB raw against
 * 201 KB gzipped** """ + EM + """ 421 KB of every cold load, on a link from India to a B1 instance.
 *
 * It sits BEFORE `express.static` and falls through to it for anything it does not handle, so
 * images, fonts and PDFs keep streaming as they did. The compressed bytes are cached by mtime:
 * the files cannot change while the process runs, and re-gzipping 600 KB per request would
 * spend more CPU than the bytes are worth.
 *
 * **`Cache-Control: no-cache` is preserved deliberately.** The modules have unhashed names, and
 * long-caching them is what shipped a screen built from two incompatible halves on 2026-09-18.
 * This makes the bytes smaller; it does not make them staler.
 */
const fs = require("fs");
const STATIC_TEXT = /\.(css|js|mjs|svg|json|map)$/;
const STATIC_MIME = {
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
};
const PUBLIC_DIR = path.join(__dirname, "public");
const staticGz = new Map();                       // absolute path -> { mtimeMs, etag, body }
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (!STATIC_TEXT.test(req.path)) return next();
  if (!/\bgzip\b/.test(req.headers["accept-encoding"] || "")) return next();

  let rel;
  try { rel = decodeURIComponent(req.path); } catch { return next(); }
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  // Never outside public/, whatever the path contained.
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return next();

  let st;
  try { st = fs.statSync(file); } catch { return next(); }
  if (!st.isFile()) return next();

  let hit = staticGz.get(file);
  if (!hit || hit.mtimeMs !== st.mtimeMs) {
    try { hit = { mtimeMs: st.mtimeMs, body: zlib.gzipSync(fs.readFileSync(file)) }; }
    catch { return next(); }
    hit.etag = `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}-gz"`;
    staticGz.set(file, hit);
  }

  res.setHeader("Content-Type", STATIC_MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
  res.setHeader("Content-Encoding", "gzip");
  res.setHeader("Vary", "Accept-Encoding");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("ETag", hit.etag);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (req.headers["if-none-match"] === hit.etag) return res.status(304).end();
  if (req.method === "HEAD") return res.end();
  return res.end(hit.body);
});

// The shell is the first thing a browser asks for, so the browser's "view as" id (R171) is issued
// with it — before any API call, so not even the first one is answered as somebody else.
app.get(["/", "/index.html"], (req, res, next) => { issueViewer(req, res); next(); });
app.use(express.static(path.join(__dirname, "public"), {
  etag: true,
  maxAge: 0,
  setHeaders(res) {
    res.setHeader("Cache-Control", "no-cache");
  },
}));
// Path routing: any non-API, non-file path is a screen, so serve the shell and let the
// router resolve it. Paths with a dot are asset requests — a missing one is a 404, not
// an HTML page with the wrong MIME type.
app.get("*", (req, res, next) => {
  if (path.basename(req.path).includes(".")) return next();
  issueViewer(req, res);
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  // A body the parser refused is the sender's to fix, and says so in words: an oversized upload
  // used to arrive as "Something went wrong", which reads as the tool being broken.
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "That is too large to send. Each attachment can be up to 25 MB — save a smaller copy, or split it." });
  }
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "The request could not be read." });
  console.error(err);
  res.status(500).json({ error: "Something went wrong. The details are in the server log." });
});

// The backstop. `catchAsync` covers the routes; a scheduled job or a timer can still reject
// where nobody is awaiting it, and Node's default for that is to exit. A tool whose whole job
// is to hold an approval chain should not disappear because one background write failed — it
// should say so loudly and carry on serving.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection — the process is staying up deliberately:", reason);
});

// Boot: attach Postgres when DATABASE_URL is configured, then hydrate only if the
// database is empty. Without DATABASE_URL this is exactly the in-memory behaviour.
(async () => {
  if (process.env.DATABASE_URL) {
    try {
      const { repos: pg, loaded } = await createPersistentRepos(process.env.DATABASE_URL);
      // Swap the collections onto the SAME object every route already closed over.
      for (const k of Object.keys(pg)) repos[k] = pg[k];
      console.log(loaded ? "Postgres attached — existing data loaded" : "Postgres attached — empty, seeding");
      if (loaded) {
        seedInfo = await store.hydrateMeta(repos);
        console.log("Restored from Postgres:", seedInfo);
        return;
      }
    } catch (e) {
      // A database that will not connect must not take the app down: fall back to
      // memory and say so loudly, rather than serving 500s.
      console.error("POSTGRES UNAVAILABLE — falling back to in-memory:", e.message);
    }
  }
  if (repos.persistent) suspendPersistence(repos);
  seedInfo = await store.hydrate(repos);
  console.log("Seed hydrated:", seedInfo);
  if (repos.persistent) {
    const n = await flushPersistence(repos);
    console.log(`Seed written to Postgres: ${n} rows`);
  }
})()
  .catch((e) => { seedError = e; console.error("SEED FAILED:", e); })
  .finally(() => {
    readyResolve();
    if (scheduler.start(repos)) console.log("Scheduler: interval ticks on");
    // Warm the AFEs Fixed Assets opens — the form-hash check and the signed file — in the
    // background, so the first person to open one after a deploy does not wait for it
    // (`lib/jobs/warmUp.js`). A few seconds after ready, so the platform's own probe and the first
    // page are answered first; one AFE at a time, so nothing waits behind the whole set.
    if (!seedError) {
      setTimeout(() => {
        scheduler.run(repos, "warmUp", { log: (line) => console.log(line) })
          .then(({ result: w }) => console.log(`Warm-up: ${w.afes} AFEs in ${w.ms} ms — ${w.checked} form-hash checks, ${w.documents} signed files read${w.failed ? `, ${w.failed} skipped` : ""}`))
          .catch((e) => console.error("Warm-up did not finish:", e.message));
      }, WARM_UP_DELAY_MS).unref();
    }
  });

app.listen(process.env.PORT || 8080, "0.0.0.0");
console.log(`AFE Workbench listening on ${process.env.PORT || 8080} (demoMode=${DEMO_MODE})`);
