"use strict";
// Stage 0 gate: the app boots on the v0.4 collections, seeds only reference data, keeps
// the platform rules, and carries no AI service anywhere.
//
//   node tools/smoke-boot.js            (starts nothing — needs a server on :8080)
//   SMOKE_BASE=http://127.0.0.1:8080 node tools/smoke-boot.js
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
const ROOT = path.join(__dirname, "..");
let failures = 0;

const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + detail : "")); }
};

/** Headers and status, for the checks that are about the transport rather than the body. */
async function raw(p, headers) {
  const res = await fetch(BASE + p, { headers: headers || {} });
  await res.arrayBuffer();
  const h = {};
  res.headers.forEach((v, k) => { h[k.toLowerCase()] = v; });
  return { status: res.status, headers: h };
}

async function get(p) {
  const res = await fetch(BASE + p);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

function walk(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

(async () => {
  console.log("1. the service is up and seeded with reference data only");
  // Another suite may have learned mailboxes or created AFEs on this server — start from the seed.
  const reset = await fetch(BASE + "/api/admin/reset", { method: "POST" });
  check("the store resets to the seed", reset.status === 200, `status=${reset.status}`);
  const h = await get("/health");
  check("GET /health is 200 ok", h.status === 200 && h.body.status === "ok", JSON.stringify(h.body).slice(0, 160));
  const seed = (h.body && h.body.seed) || {};
  check("the approver matrix is loaded", seed.matrixRows > 1000, `matrixRows=${seed.matrixRows}`);
  check("AuC recon lines are loaded", seed.trackerItems > 100, `trackerItems=${seed.trackerItems}`);
  check("people, routing rules, budget pots and the directory are seeded",
    seed.users >= 8 && seed.orgRules >= 4 && seed.budgetPots >= 8 && seed.directory >= 5,
    JSON.stringify({ users: seed.users, orgRules: seed.orgRules, pots: seed.budgetPots, dir: seed.directory }));
  check("no AFEs are seeded — they are created through the wizard", !seed.afes, `afes=${seed.afes}`);

  console.log("2. no AI service is configured or referenced");
  check("/health reports ai: none", h.body.integrations && h.body.integrations.ai === "none",
    JSON.stringify(h.body.integrations));
  check("DocuSign stands in until a key is supplied",
    h.body.integrations && ["simulated", "live"].includes(h.body.integrations.docusign),
    JSON.stringify(h.body.integrations));
  const sourceFiles = walk(path.join(ROOT, "lib"), [])
    .concat(walk(path.join(ROOT, "seed"), []))
    .concat([path.join(ROOT, "server.js")]);
  // The blanket ban became a boundary on 2026-09-14 (Meeting #5 follow-up). AI is allowed for
  // the genuinely probabilistic work — reading a vendor quote, reading a reply — and only
  // there: behind a flag that ships off, as a proposal a person confirms, inside a named seam.
  // So the grep no longer asks "is the word here?" but the two questions that actually matter.
  //
  // 1. Is an AI client anywhere it has no business being? Only these files may hold one; a call
  //    to a model from a rule, a route or the state machine would put an unreviewable, variable
  //    answer inside a control, which is the thing the September review was protecting against.
  const AI_SEAM = ["lib/integrations/docintel.js", "lib/integrations/agent.js"];
  // 2. Is it describing itself? Feature flags and business config name these services in prose
  //    so an administrator knows what a switch does. Prose is not a call.
  const AI_DESCRIBES = ["lib/domain/features.js", "lib/domain/refData.js"];
  const aiHits = [];
  for (const f of sourceFiles) {
    const rel = path.relative(ROOT, f).replace(/\\/g, "/");
    if (AI_SEAM.includes(rel) || AI_DESCRIBES.includes(rel)) continue;
    const t = fs.readFileSync(f, "utf8");
    if (/\bDI_ENDPOINT|DI_KEY|AOAI_|aiClient|docIntelligence|prebuilt-layout|openai/i.test(t)) aiHits.push(rel);
  }
  check("no AI client outside its own seam — rules, routes and the state machine hold none",
    aiHits.length === 0, aiHits.join(", "));

  const features = require(path.join(ROOT, "lib/domain/features.js"));
  const flagNames = features.FLAG_NAMES;
  check("every AI capability is a feature flag, and every flag ships off",
    flagNames.includes("quoteReading") && flagNames.includes("agentic"), flagNames.join(", "));
  const health2 = await get("/health");
  check("/health says which AI capabilities are actually live, and none is by default",
    health2.body.integrations && health2.body.integrations.ai === "none",
    JSON.stringify(health2.body.integrations));

  // The environment lock, offline. UAT relies on it: the Document Intelligence resource exists
  // from 2026-09-17 and `FEATURES_LOCKED=quoteReading,agentic` is what keeps the switch off until
  // the security review has seen the design. A lock that quietly stopped working would look
  // exactly like a lock that was working, so it is tested rather than trusted.
  const { createRepos } = require(path.join(ROOT, "lib/repos"));
  const lockRepos = createRepos();
  const ctx = { user: { email: "shashank_srivastava@example.com" } };
  const wasLocked = process.env.FEATURES_LOCKED;
  try {
    delete process.env.FEATURES_LOCKED;
    await features.set(lockRepos, ctx, "quoteReading", true);
    check("a flag an administrator turns on is on when the environment allows it",
      (await features.isOn(lockRepos, "quoteReading")) === true);

    process.env.FEATURES_LOCKED = "quoteReading, agentic";
    check("the environment lock overrides the stored setting without erasing it",
      (await features.isOn(lockRepos, "quoteReading")) === false);
    const listed = await features.all(lockRepos);
    const q = listed.find((f) => f.name === "quoteReading");
    check("the screen can still say it was requested, and that the environment forbids it",
      q.on === false && q.locked === true && q.requested === true && q.changedBy === ctx.user.email,
      JSON.stringify({ on: q.on, locked: q.locked, requested: q.requested }));
    let refused = null;
    try { await features.set(lockRepos, ctx, "quoteReading", true); } catch (e) { refused = e.message; }
    check("turning a locked flag on is refused with the reason",
      refused !== null && /FEATURES_LOCKED/.test(refused), refused);
    check("an unlocked flag is unaffected by the lock on another",
      (await features.isOn(lockRepos, "sapPrefill")) === false
      && listed.find((f) => f.name === "sapPrefill").locked === false);

    delete process.env.FEATURES_LOCKED;
    check("lifting the lock restores what the administrator had chosen — nothing was lost",
      (await features.isOn(lockRepos, "quoteReading")) === true);
  } finally {
    if (wasLocked === undefined) delete process.env.FEATURES_LOCKED;
    else process.env.FEATURES_LOCKED = wasLocked;
  }

  console.log("3. ADC platform rules still hold");
  const guidHits = [];
  const hostHits = [];
  for (const f of sourceFiles) {
    const t = fs.readFileSync(f, "utf8");
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(t)) guidHits.push(path.relative(ROOT, f));
    if (/localhost|127\.0\.0\.1/.test(t)) hostHits.push(path.relative(ROOT, f));
  }
  check("no GUIDs in lib, seed or server.js", guidHits.length === 0, guidHits.join(", "));
  check("no localhost URLs in lib, seed or server.js", hostHits.length === 0, hostHits.join(", "));
  // Seeded people are real Acme identities. A stand-in mailbox in a committed seed is the
  // same class of mistake as a GUID: it looks like configuration and it is not.
  const fakeHits = [];
  for (const f of sourceFiles.concat(walk(path.join(ROOT, "tools"), []), walk(path.join(ROOT, "public", "js"), []))) {
    const t = fs.readFileSync(f, "utf8");
    for (const m of t.matchAll(/[\w.+-]+@([\w-]+\.)+[a-z]{2,}/gi)) {
      const at = m[0].toLowerCase();
      if (/@(demo\.local|example\.(org|net)|test\.|localhost|contoso\.com|acme\.)/.test(at)) fakeHits.push(`${path.relative(ROOT, f)}: ${m[0]}`);
    }
  }
  check("no placeholder identities anywhere — every seeded person is a real Acme mailbox", fakeHits.length === 0, fakeHits.slice(0, 4).join(" · "));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const deps = Object.keys(pkg.dependencies || {});
  check("runtime dependencies are the approved set", deps.every((d) => ["express", "pg", "pdf-lib", "@pdf-lib/fontkit"].includes(d)), deps.join(", "));
  check("server.js is the entrypoint", pkg.main === "server.js" && /node server\.js/.test(pkg.scripts.start));
  const serverSrc = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  check("the identity helpers are intact", /x-ms-client-principal/.test(serverSrc) && /function requireUser/.test(serverSrc));
  check("the listener is unchanged", /app\.listen\(process\.env\.PORT \|\| 8080, "0\.0\.0\.0"\)/.test(serverSrc));

  console.log("4. routing and the API surface behave");
  const missing = await get("/api/does-not-exist");
  check("an unknown /api path is a JSON 404, not the SPA shell",
    missing.status === 404 && missing.body && typeof missing.body === "object" && missing.body.error,
    `status=${missing.status}`);
  const shell = await fetch(BASE + "/requests");
  const shellText = await shell.text();
  check("a screen path serves the app shell", shell.status === 200 && /<title>AFE Workbench<\/title>/.test(shellText));
  const asset = await fetch(BASE + "/js/does-not-exist.js");
  check("a missing asset is a 404, not HTML", asset.status === 404, `status=${asset.status}`);

  const me = await get("/api/me");
  check("GET /api/me identifies the caller", me.status === 200 && me.body.signedIn === true, JSON.stringify(me.body).slice(0, 120));

  // "View as" belongs to the PERSON, however the platform capitalises their address. It was
  // stored under the lower-cased mailbox and read back by the header as sent, so Easy Auth's
  // `Shashank_Srivastava@example.com` never found what the same person had set (UAT, 2026-09-25).
  {
    const as = (spelling) => ({ "x-ms-client-principal-name": spelling, "content-type": "application/json" });
    const meAs = async (spelling) => (await (await fetch(BASE + "/api/me", { headers: as(spelling) })).json()).actingAs;
    const start = await fetch(BASE + "/api/admin/act-as", { method: "POST", headers: as("Shashank_Srivastava@example.com"),
      body: JSON.stringify({ email: "judithmelanie_ware@example.com" }) });
    const seen = [await meAs("Shashank_Srivastava@example.com"), await meAs("shashank_srivastava@example.com"), await meAs("SHASHANK_SRIVASTAVA@example.com")];
    check("viewing as someone holds whichever way the platform capitalises the address",
      start.status === 200 && seen.every((x) => x && x.email === "judithmelanie_ware@example.com"), JSON.stringify({ start: start.status, seen }));
    await fetch(BASE + "/api/admin/act-as", { method: "DELETE", headers: as("shashank_srivastava@example.com") });
    check("and stopping it in one spelling stops it in all of them", !(await meAs("Shashank_Srivastava@example.com")));
  }

  // While the site is OPEN, "view as" belongs to a BROWSER (R171). Everyone is the same signed-in
  // person then, so one tester's switch moved every other tester — in the UAT review of
  // 2026-10-14 a send-back landed as Aiden's, with the reason "Approve". A client with no cookie
  // (this suite, a script) keeps the mailbox key it always had.
  if ((await get("/health")).body.auth === "open") {
    const shellRes = await fetch(BASE + "/requests");
    const issued = shellRes.headers.get("set-cookie") || "";
    check("the page shell gives each browser its own view-as id, HttpOnly and SameSite",
      /afe_viewer=[a-f0-9]{32}/.test(issued) && /HttpOnly/i.test(issued) && /SameSite=Lax/i.test(issued), issued);
    const A = `afe_viewer=${"a".repeat(32)}`, B = `afe_viewer=${"b".repeat(32)}`;
    const hdr = (c) => ({ cookie: c, "content-type": "application/json" });
    const viewAs = (c, email) => fetch(BASE + "/api/admin/act-as", { method: "POST", headers: hdr(c), body: JSON.stringify({ email }) });
    const seenBy = async (c) => (((await (await fetch(BASE + "/api/me", { headers: c ? { cookie: c } : {} })).json()).actingAs) || {}).email || null;
    await viewAs(A, "judithmelanie_ware@example.com");
    await viewAs(B, "aiden-mulqueeny_crilly@example.com");
    const seen = [await seenBy(A), await seenBy(B), await seenBy(null)];
    check("two browsers view as two people at once, and a client with no cookie is neither",
      seen[0] === "judithmelanie_ware@example.com" && seen[1] === "aiden-mulqueeny_crilly@example.com" && seen[2] === null, JSON.stringify(seen));
    await fetch(BASE + "/api/admin/act-as", { method: "DELETE", headers: hdr(A) });
    check("and stopping in one browser leaves the other as it was",
      (await seenBy(A)) === null && (await seenBy(B)) === "aiden-mulqueeny_crilly@example.com");
    await fetch(BASE + "/api/admin/act-as", { method: "DELETE", headers: hdr(B) });
  }
  const ref = await get("/api/refdata");
  check("reference data carries the classifications and the cloud tree",
    ref.status === 200 && ref.body.classifications.length === 3 && ref.body.cloudTree.length === 4,
    JSON.stringify(Object.keys(ref.body || {})));
  const all = await get("/api/matrix/all");
  check("the cost-centre list is cacheable in one request", all.status === 200 && all.body.length > 1000, `rows=${(all.body || []).length}`);
  const one = await get("/api/matrix/30145");
  check("a real IT cost centre resolves with its approver levels",
    one.status === 200 && one.body.levels && one.body.levels.M1 && one.body.levels.M1.name,
    JSON.stringify(one.body).slice(0, 120));

  console.log("5. the new collections are addressable");
  const rules = await get("/api/admin/org-rules");
  check("org rules are readable and carry the IT override and pre-approver",
    rules.status === 200 && rules.body.some((x) => x.kind === "override") && rules.body.some((x) => x.kind === "pre_approver"),
    JSON.stringify((rules.body || []).map((x) => x.kind)));
  const dir = await get("/api/admin/directory");
  check("the directory distinguishes confirmed, guessed and unresolved mailboxes",
    dir.status === 200 && ["confirmed", "guessed", "unresolved"].every((s) => dir.body.some((e) => e.source === s)),
    JSON.stringify((dir.body || []).map((e) => e.source)));
  const pots = await get("/api/admin/budget-pots");
  check("budget pots are readable", pots.status === 200 && pots.body.length >= 8, `pots=${(pots.body || []).length}`);
  const audit = await get("/api/admin/audit");
  check("the audit collection is addressable", audit.status === 200 && Array.isArray(audit.body));

  // ---------------------------------------------------------------------------------------
  // A route that throws must be a 500, not a restart.
  //
  // Express 4 does not route a rejected promise to its error handler; Node then reports an
  // unhandled rejection and, since Node 15, exits. Every route here is async, so without this
  // one failed await takes the whole site down. It is a control, so it is tested.
  console.log("6. the site survives a route that throws");
  {
    const express = require(path.join(ROOT, "node_modules/express"));
    const { catchAsync } = require(path.join(ROOT, "lib/asyncRoutes"));
    const r = express.Router();
    r.get("/a", async () => { throw new Error("the database said no"); });
    r.get("/b", () => { throw new Error("thrown before any await"); });
    r.get("/c", async (req, res) => { res.served = true; });
    r.get("/d", async (req, res, next) => { next(); });
    catchAsync(r);
    const run = async (i) => {
      let caught = null;
      let nexted = false;
      const res = {};
      await r.stack[i].route.stack[0].handle({}, res, (e) => { if (e) caught = e; else nexted = true; });
      return { caught: caught && caught.message, served: Boolean(res.served), nexted };
    };
    const a = await run(0), b = await run(1), c = await run(2), d = await run(3);
    check("a rejected promise reaches next(err) instead of killing the process", a.caught === "the database said no", JSON.stringify(a));
    check("so does a synchronous throw", b.caught === "thrown before any await", JSON.stringify(b));
    check("a handler that works is untouched", c.served === true && !c.caught, JSON.stringify(c));
    check("and next() still means next()", d.nexted === true && !d.caught, JSON.stringify(d));
    const before = r.stack[0].route.stack[0].handle;
    catchAsync(r);
    check("wrapping twice does not double-wrap", r.stack[0].route.stack[0].handle === before);

    // Counting literal substrings rather than matching a pattern: the thing being checked is
    // that a line looks exactly like the others, and a regex over source is its own trap.
    const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
    const count = (needle) => server.split(needle).length - 1;
    const mounted = count('app.use("/api", withContext, ');
    const wrapped = count('app.use("/api", withContext, catchAsync(require');
    check("every feature router is wrapped (" + wrapped + " of " + mounted + ")",
      wrapped === mounted && wrapped >= 10, wrapped + "/" + mounted);
    check("and there is a backstop for a rejection no route owns",
      count('process.on("unhandledRejection"') === 1);
  }

  // ---------------------------------------------------------------------------------------
  // The boot styles have to be the stylesheet's own values.
  //
  // index.html carries a few rules inline so the page ground and the top bar exist before
  // app.css lands. They are a COPY, and a copy drifts: the page was still painted in the mint
  // R106 retired, and the bar was reserved at 60px against a real 48px, so every cold load
  // flashed the old colour and then jumped. Worse, `#top` is an ID selector, so it outranks
  // `.top` permanently -- a wrong height there is not a flash, it is the height, at every
  // width. Nothing in the product would ever notice, so this does.
  // ---------------------------------------------------------------------------------------
  // Every routing rule in the seed reached the store.
  //
  // UAT was found on 2026-09-21 holding the four rules it was created with, while the seed had
  // since gained the $1M technical accounting review, the LSD coordinator and BOTH Fixed Assets
  // issue approvers — because the back-fill only ran on an EMPTY collection, and this one is
  // never empty, it just falls behind. Nobody would have noticed until Judithmelanie tried to approve
  // an issue and was told no approver is configured. A rule that exists in the seed and not in
  // the store is a control that is silently off.
  console.log("7. the routing rules the business configured are all here");
  {
    // The same back-fill discipline as the routing rules, for the same reason: a collection that
    // is never empty falls behind silently. The pots gained three divisions on 2026-09-22 and the
    // division switcher is worth nothing without them.
    const seeded = JSON.parse(fs.readFileSync(path.join(ROOT, "seed/budget-pots.json"), "utf8")).pots || [];
    const divisions = Array.from(new Set(seeded.map((p) => p.division)));
    check(`the seed carries pots for more than one division (${divisions.join(", ")})`, divisions.length > 1, divisions.join(","));
    const served = await get("/api/pots");
    const live = (served.body && served.body.canChoose) || [];
    check(`and every one of them reached the store (${live.length})`,
      divisions.every((d) => live.includes(d)), JSON.stringify({ seeded: divisions, live }));
    const store = fs.readFileSync(path.join(ROOT, "lib/store.js"), "utf8");
    check("budget pots back-fill BY ID, not by 'is it empty?'", /budgetPots\.all\(\)\)\.map\(\(p\) => p\.id\)/.test(store));
  }
  {
    const seeded = JSON.parse(fs.readFileSync(path.join(ROOT, "seed/org-rules.json"), "utf8")).rules || [];
    const res = await get("/api/admin/org-rules");
    const live = Array.isArray(res.body) ? res.body : (res.body && res.body.rules) || [];
    const have = new Set(live.map((r) => r.id));
    const missing = seeded.filter((r) => !have.has(r.id)).map((r) => r.id);
    check(`every seeded routing rule is in the store (${seeded.length})`, missing.length === 0, "missing " + missing.join(", "));
    const ofKind = (k) => live.filter((r) => r.kind === k && r.active !== false);
    check("somebody can approve the creation of an internal order", ofKind("fa_issue_approver").length >= 2,
      JSON.stringify(ofKind("fa_issue_approver").map((r) => r.person && r.person.name)));
    check("and above $1M there is exactly ONE technical accounting review, naming two people",
      ofKind("controllership").length === 1 && (ofKind("controllership")[0].alternates || []).length === 1,
      JSON.stringify(ofKind("controllership").map((r) => [r.person && r.person.name, (r.alternates || []).map((a) => a.name)])));
  }

  // ---------------------------------------------------------------------------------------
  // The journey has one definition, and every screen reads it.
  //
  // The send-back picker's list of steps was a LITERAL, copied by hand into three screens. When
  // Cloud CapEx and the Financials step joined the wizard, all three went on offering the five
  // that existed before them — so there was no way to send an AFE back to the financial case it
  // was wrong about, on any of the three screens that can send one back. It is `refData
  // .WIZARD_STEPS` now and `/api/refdata` carries it; the wizard keeps its own copy because the
  // numbers are its URLs, so this is what stops the two drifting again.
  console.log("8. the requester's journey has one definition");
  {
    const wizard = fs.readFileSync(path.join(ROOT, "public/js/screens/requester/wizard.js"), "utf8");
    const labels = /const STEP_LABELS = \{([^}]*)\}/.exec(wizard);
    const order = /const STEP_ORDER = \[([^\]]*)\]/.exec(wizard);
    check("the wizard still declares its steps", Boolean(labels && order));
    const inWizard = new Map((labels ? labels[1] : "").split(",").map((p) => {
      const m = /(\d+)\s*:\s*"([^"]+)"/.exec(p);
      return m ? [Number(m[1]), m[2]] : null;
    }).filter(Boolean));
    const wizardOrder = (order ? order[1] : "").split(",").map((x) => Number(x.trim())).filter(Number.isFinite);

    const served = await get("/api/refdata");
    const steps = (served.body && served.body.wizardSteps) || [];
    check(`/api/refdata carries the journey (${steps.length} steps)`, steps.length >= 7, JSON.stringify(steps.map((x) => x.n)));
    const wrongLabel = steps.filter((x) => inWizard.get(x.n) !== x.label);
    check("every shared step has the wizard's own label",
      wrongLabel.length === 0, JSON.stringify(wrongLabel.map((x) => [x.n, x.label, inWizard.get(x.n)])));
    // The order of the shared list IS the journey, minus Review — so it has to be a prefix-wise
    // match against the wizard's, which carries Review at the end.
    const sharedOrder = steps.map((x) => x.n).join(",");
    const expected = wizardOrder.filter((n) => n !== 7).join(",");
    check("and the same order (" + sharedOrder + ")", sharedOrder === expected, sharedOrder + " vs " + expected);
    check("Review is not offered as somewhere to reopen at", !steps.some((x) => x.n === 7));
    const picker = fs.readFileSync(path.join(ROOT, "public/js/components/parts.js"), "utf8");
    check("there is one picker, and the screens use it", /export function reopenPicker/.test(picker));
    for (const rel of ["public/js/screens/approver/decision.js", "public/js/screens/coordinator/coordinate.js", "public/js/screens/fa/judge.js"]) {
      const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
      check(`${rel.split("/").pop()} builds it from refdata, not from a literal`,
        /reopenPicker\(/.test(src) && !/\["3", "How much"\]/.test(src));
    }
  }

  // ---------------------------------------------------------------------------------------
  // A stepper segment is not a link to the page it is on.
  //
  // Five of Fixed Assets' six steps were `<a href>` to `/fa/:id/issue` while standing on
  // `/fa/:id/issue`: the click did nothing, and "at Done you cannot go back to any step except
  // Judgment" is what that is from the other side. They name SECTIONS of that page, so they
  // carry `jump` and the stepper scrolls to them. Nothing in the product would ever notice a
  // relapse — a dead link renders exactly like a live one — so it is checked here.
  {
    console.log("6c. a step goes somewhere");
    const src = fs.readFileSync(path.join(ROOT, "public/js/screens/fa/issue.js"), "utf8");
    const list = (src.match(/\{ n: \d+, label: "[^"]+"[^}]*\}/g) || []);
    // The whole run to Close (2026-10-16): it stopped at "Done" after KO22.
    check("the Fixed Assets stepper has its eight steps, judgment to close", list.length === 8, String(list.length));
    check("and not one of them is a link to the screen it is drawn on",
      !list.some((x) => /href:/.test(x) && /\/issue`/.test(x)),
      list.filter((x) => /href:/.test(x) && /\/issue`/.test(x)).join(" | "));
    check("the seven that name a section of this page carry a jump",
      list.filter((x) => /jump: /.test(x)).length === 7,
      list.filter((x) => /jump: /.test(x)).length + " with a jump");
    for (const key of ["approval", "ko01", "record", "orders", "runsheet", "pack", "end"]) {
      check(`  and there is a section keyed "${key}" to jump to`,
        new RegExp(`(data-key="${key}"|key: "${key}")`).test(src));
    }
    const parts = fs.readFileSync(path.join(ROOT, "public/js/components/parts.js"), "utf8");
    check("the stepper renders a jump as a button, which pushes no history entry",
      /data-step-jump=/.test(parts) && /<button type="button" class="seg/.test(parts));
  }

  // ---------------------------------------------------------------------------------------
  // ONE document per AFE (R156).
  //
  // "Many of the PDF versions for the same AFE, mostly missing the appended documents." The
  // screens pointed at three different files: `packet.pdf` (attachments, no signatures),
  // `form.pdf?stamped=1` (signatures, no attachments — and that is what Fixed Assets judged on)
  // and the real signed set, reachable only from a list. `document.pdf` resolves the one
  // document for the stage; `form.pdf` stays for the hash and for `verify` and is machine-only.
  // Nothing in the product would notice a relapse — a link to the bare form renders fine.
  {
    console.log("6d. one document per AFE");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith(".js") ? [path.join(d, e.name)] : [])));
    const screens = walk(path.join(ROOT, "public/js"));
    const offenders = screens.filter((f) => /form\.pdf/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    check("no screen links the form on its own — they all ask for the document",
      offenders.length === 0, offenders.join(", "));
    const routing = fs.readFileSync(path.join(ROOT, "lib/routes/routing.js"), "utf8");
    const docs = fs.readFileSync(path.join(ROOT, "lib/envelopeDocs.js"), "utf8");
    // Which file it serves is behaviour, and is checked as behaviour: stage by stage in
    // smoke-envelope, and on a returned AFE that resumes or goes round again in smoke-routing (R148).
    // The rule lives beside the documents it chooses between, so the boot warm-up reads the same one.
    check("`document.pdf` exists and asks which round's file is THE document",
      /\/afes\/:id\/document\.pdf/.test(routing) && /envelopeDocs\.storedDocument\(/.test(routing) && /function storedDocument\(/.test(docs));
    check("the simulated signed set is the PACKET stamped, not the form on its own",
      /assemblePacket\(repos, afe, routing, \{ stamped: true \}\)/.test(docs)
        && /combinedBytes = built\.packetBytes/.test(docs));
  }

  // ---------------------------------------------------------------------------------------
  // Markup is never escaped into text (2026-09-28).
  //
  // `html` keeps a nested `html` value as markup and escapes everything else. A helper that
  // returns markup — `when()`, `tag()`, `icon()` — interpolated into a PLAIN template literal is
  // turned into a string there, and the `html` around it then escapes that string: the judge
  // screen's first tile read "Read by Judithmelanie Ware <time datetime=…>just now</time>", which
  // Fixed Assets reported as "a script appears". Nothing in the product notices — the page
  // renders, just wrongly — so the screens are lexed for it.
  {
    console.log("6e. markup is never escaped into text");
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith(".js") ? [path.join(d, e.name)] : [])));
    const files = walk(path.join(ROOT, "public/js"));
    // Which functions return markup: a body whose `return` is an html template, or an arrow that is one.
    const markupFns = new Set(["html", "icon"]);
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/g)) if (/return\s+html`/.test(m[2])) markupFns.add(m[1]);
      for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*\([^)]*\)\s*=>\s*\n?\s*html`/g)) markupFns.add(m[1]);
    }
    const offenders = [];
    for (const f of files) {
      const s = fs.readFileSync(f, "utf8");
      let i = 0, lastSig = "", lastWord = "";
      const line = (k) => s.slice(0, k).split("\n").length;
      const str = (q) => { i++; while (i < s.length && s[i] !== q) { if (s[i] === "\\") i++; i++; } i++; };
      const regex = () => {
        i++; let cls = false;
        while (i < s.length && s[i] !== "\n") { const c = s[i]; if (c === "\\") { i += 2; continue; } if (c === "[") cls = true; else if (c === "]") cls = false; else if (c === "/" && !cls) break; i++; }
        i++; while (/[a-z]/i.test(s[i] || "")) i++;
      };
      const template = (tagged) => {
        i++;
        while (i < s.length) {
          const c = s[i];
          if (c === "\\") { i += 2; continue; }
          if (c === "`") { i++; return; }
          if (c === "$" && s[i + 1] === "{") {
            i += 2; const at = i; code(true);
            const expr = s.slice(at, i - 1);
            const calls = Array.from(expr.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)).map((x) => x[1]).filter((n) => markupFns.has(n));
            if (!tagged && (calls.length || /html`/.test(expr))) offenders.push(`${path.relative(ROOT, f)}:${line(at)} ${expr.trim().slice(0, 60)}`);
            continue;
          }
          i++;
        }
      };
      const code = (inExpr) => {
        let depth = 0;
        while (i < s.length) {
          const c = s[i];
          if (c === "/" && s[i + 1] === "/") { while (i < s.length && s[i] !== "\n") i++; continue; }
          if (c === "/" && s[i + 1] === "*") { i = s.indexOf("*/", i + 2) + 2; continue; }
          if (c === '"' || c === "'") { str(c); lastSig = "a"; continue; }
          if (c === "`") { template(/html\s*$/.test(s.slice(Math.max(0, i - 8), i))); lastSig = "a"; continue; }
          if (c === "/") {
            if (lastSig === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /^(return|typeof|case|in|of)$/.test(lastWord)) { regex(); lastSig = "a"; continue; }
            i++; lastSig = "/"; continue;
          }
          if (inExpr && c === "{") depth++;
          if (inExpr && c === "}") { if (depth === 0) { i++; return; } depth--; }
          if (/[A-Za-z_$]/.test(c)) { const st = i; while (/[\w$]/.test(s[i] || "")) i++; lastWord = s.slice(st, i); lastSig = "a"; continue; }
          if (!/\s/.test(c)) { lastSig = c; lastWord = ""; }
          i++;
        }
      };
      code(false);
    }
    check(`no markup helper is interpolated into a plain template string (${markupFns.size} helpers known)`,
      offenders.length === 0 && markupFns.has("when") && markupFns.has("tag"), offenders.join(" · "));
  }

  // A sheet's answer is `{ value, data }`, WHATEVER was pressed — Cancel, Esc and a click outside
  // included. Admin › Features tested the object itself (`if (!ok) return`), so "Not yet" turned
  // the feature ON (found 2026-10-16). Every result of `await sheet(` must be read by its value.
  {
    console.log("6f. a sheet's answer is read by its value, never by its existence");
    // Where the `sheet(` call closes: strings and template text skipped, `${…}` followed.
    const callEnd = (src, open) => {
      let depth = 0; const stack = [];
      for (let i = open; i < src.length; i++) {
        const c = src[i], top = stack[stack.length - 1];
        if (top === "tpl") {
          if (c === "\\") { i++; continue; }
          if (c === "`") stack.pop();
          else if (c === "$" && src[i + 1] === "{") { stack.push("expr"); i++; }
          continue;
        }
        if (c === '"' || c === "'") { const q = c; i++; while (i < src.length && src[i] !== q) { if (src[i] === "\\") i++; i++; } continue; }
        if (c === "`") { stack.push("tpl"); continue; }
        if (c === "{") { if (stack.length) stack.push("{"); continue; }
        if (c === "}") { if (stack.length) stack.pop(); continue; }
        if (c === "(") depth++;
        if (c === ")" && --depth === 0) return i;
      }
      return -1;
    };
    const offenders = [];
    for (const f of walk(path.join(ROOT, "public", "js"), []).filter((p) => p.endsWith(".js"))) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*await\s+sheet\(/g)) {
        const name = m[1];
        const end = callEnd(src, m.index + m[0].length - 1);
        // What reads the answer, in the lines after the call. Never read at all is fine (a sheet
        // that only shows something); read without `.value` is the bug.
        let tail = end < 0 ? "" : src.slice(end + 1, end + 1 + 900);
        const fnEnd = tail.indexOf("\n}\n");                  // stop at the end of the enclosing function
        if (fnEnd >= 0) tail = tail.slice(0, fnEnd);
        const uses = tail.match(new RegExp(`\\b${name}\\b(?!\\s*=)(\\.\\w+)?`, "g")) || [];
        if (uses.length && !uses.some((u) => u === `${name}.value`)) offenders.push(`${path.relative(ROOT, f)}: ${name}`);
      }
    }
    check("every `await sheet(` result is tested by its .value", offenders.length === 0, offenders.join(" · "));
  }

  // A requirement or question id is how the builders keep track; it is not something a screen
  // says. "(Q47: next higher level)" was in every stand-in's explanation on the coordinate page,
  // "(before R164)" on the mailbox, "(PRD Q25)" on the order type (found 2026-10-16). Checked over
  // the text a person can read — string literals and template text, comments and HTML comments
  // excluded — in everything that builds a screen or a message.
  {
    console.log("6g. no requirement id in what a screen or a message says");
    const { literals } = require("./lex-literals.js");
    const offenders = [];
    for (const dir of ["lib/domain", "lib/routes", "lib/views", "public/js"]) {
      for (const f of walk(path.join(ROOT, dir), []).filter((p) => p.endsWith(".js"))) {
        for (const l of literals(fs.readFileSync(f, "utf8"))) {
          const text = l.text.replace(/<!--[\s\S]*?-->/g, "");
          if (/\b(R\d{2,3}|Q\d{2})\b/.test(text)) offenders.push(`${path.relative(ROOT, f)}:${l.line} ${text.trim().slice(0, 60)}`);
        }
      }
    }
    check("no R## or Q## inside a string a person could read", offenders.length === 0, offenders.slice(0, 5).join(" · "));
  }

  // ---------------------------------------------------------------------------------------
  // The history covers the whole lifecycle.
  //
  // `timelineFor` was a private function inside `projectView` with a hand-kept label map that
  // covered ELEVEN of the sixteen transitions — question, answer, send_back, decline, withdraw,
  // fa_approve_issue, fa_issue_pack, capitalize and close all happened and left no line on any
  // screen. A hand-kept list of the lifecycle's own events is exactly the copy that goes stale
  // silently, which is the lesson R118 paid for, so it is checked rather than trusted.
  console.log("9. every lifecycle event reaches the history");
  {
    const { TIMELINE, MILESTONES, milestonesFrom } = require(path.join(ROOT, "lib/views/timeline.js"));
    const sm = fs.readFileSync(path.join(ROOT, "lib/domain/stateMachine.js"), "utf8");
    const transitions = (sm.match(/^  ([a-z_]+): \{$/gm) || []).map((l) => l.trim().replace(/:.*/, ""));
    check(`the state machine declares its transitions (${transitions.length})`, transitions.length >= 16, transitions.join(","));
    const missing = transitions.filter((t) => !TIMELINE[t]);
    check("every one of them has a history label", missing.length === 0, "missing: " + missing.join(", "));
    check("and the labels are all callable or plain text",
      Object.values(TIMELINE).every((v) => v && (typeof v.text === "function" || typeof v.text === "string")));
    check("each carries a kind the spine can colour",
      Object.values(TIMELINE).every((v) => ["done", "warn", "stop", "step"].includes(v.kind)),
      JSON.stringify(Object.entries(TIMELINE).filter(([, v]) => !["done", "warn", "stop", "step"].includes(v.kind)).map(([k]) => k)));
    // A milestone that names a type nothing emits would silently never fill in.
    const badMilestone = MILESTONES.filter((m) => m.types.some((t) => !TIMELINE[t]));
    check("every milestone names an event that exists", badMilestone.length === 0, JSON.stringify(badMilestone.map((m) => m.key)));
    const empty = milestonesFrom([]);
    check(`an AFE with no history still shows what is to come (${empty.length} milestones)`,
      empty.length === MILESTONES.length && empty.every((m) => m.at === null));
  }

  // ---------------------------------------------------------------------------------------
  // Static text goes over the wire compressed.
  //
  // The gzip middleware wraps `res.send`; `express.static` streams through `sendFile` and never
  // touches it. So every API response was compressed and not one static file was — `app.css`
  // left UAT at 114,346 bytes with no `Content-Encoding` at all, for a stylesheet that gzips to
  // 28 KB. Nothing in the product would ever have noticed, which is why it is a check.
  console.log("10. static text is compressed");
  {
    const one = await raw("/css/app.css", { "accept-encoding": "gzip" });
    check("app.css is served gzipped", one.headers["content-encoding"] === "gzip", JSON.stringify(one.headers["content-encoding"]));
    check("and says so with Vary", /accept-encoding/i.test(one.headers.vary || ""), one.headers.vary);
    check("the modules are gzipped too", (await raw("/js/components/parts.js", { "accept-encoding": "gzip" })).headers["content-encoding"] === "gzip");
    const size = Number(one.headers["content-length"] || 0);
    check(`and it is much smaller than the file (${Math.round(size / 1024)} KB on the wire)`, size > 0 && size < 60 * 1024, String(size));
    // The unhashed module names are why this must NOT become a long cache: a half-new, half-old
    // module set is a screen built from two incompatible halves (server.js says so at length).
    check("but it is still no-cache, because the module names are not hashed",
      /no-cache/.test(one.headers["cache-control"] || ""), one.headers["cache-control"]);
    const plain = await raw("/css/app.css", { "accept-encoding": "identity" });
    check("a client that cannot take gzip still gets the file",
      plain.status === 200 && plain.headers["content-encoding"] !== "gzip", JSON.stringify({ s: plain.status, e: plain.headers["content-encoding"] }));
  }

  console.log("11. the boot styles match the stylesheet");
  {
    const shell = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
    const css = fs.readFileSync(path.join(ROOT, "public/css/app.css"), "utf8");
    const one = (re, text, what) => { const m = re.exec(text); return m ? m[1].trim().toUpperCase() : "MISSING " + what; };

    const page = one(/--page:\s*([^;]+);/, css, "--page");
    const line = one(/--line:\s*([^;]+);/, css, "--line");
    const topH = one(/\.top \{[^}]*?height:\s*([0-9]+px)/, css, ".top height");
    const bootHtml = one(/html \{ background:\s*([^;]+);/, shell, "boot html background");
    const bootBody = one(/body \{[^}]*background:\s*(#[0-9A-Fa-f]{3,8})/, shell, "boot body background");
    const bootTopH = one(/#top \{[^}]*height:\s*([0-9]+px)/, shell, "boot #top height");
    const bootLine = one(/#top \{[^}]*border-bottom:\s*1px solid\s*(#[0-9A-Fa-f]{3,8})/, shell, "boot #top border");

    check("the boot page colour is --page (" + page + ")", bootHtml === page, bootHtml);
    check("and body agrees with html", bootBody === page, bootBody);
    check("the reserved bar height is .top's (" + topH + ")", bootTopH === topH, bootTopH);
    check("the boot rule under the bar is --line (" + line + ")", bootLine === line, bootLine);
    // The context bar hangs off the masthead's height, so that one is a copy too.
    const ctxTop = one(/\.ctxbar \{[^}]*top:\s*([0-9]+px)/, css, ".ctxbar top");
    check("the context bar sits directly under it (" + ctxTop + ")", ctxTop === topH, ctxTop);
  }

  await quoteReaderChecks();
  await databaseEntraChecks();

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nsmoke-boot could not run:", e.message);
  console.error(`(is the server up on ${BASE}? start it with: npm start)`);
  process.exit(1);
});

// ---------------------------------------------------------------------------------------------
// The quote reader (R170), against stand-ins for App Service's identity endpoint and for the
// reader — here, because this suite is the one whose subject is the AI boundary, and the only one
// the boundary scans let name the reader's settings.
//
// What it proves is non-negotiable #1 at work: a token from the platform and never a key; a read
// that is a set of proposals with their confidence, a weak one held back; nothing typed moving and
// no rule seeing a figure until a person presses Use these; the override and the decision on the
// record; and every refusal said in words a screen can show.
// ---------------------------------------------------------------------------------------------
async function quoteReaderChecks() {
  console.log("R170. the quote reader: a token from the app's identity, proposals a person confirms");
  const { spawn } = require("child_process");
  const fakes = require("./smoke-fakes");
  const mi = require(path.join(ROOT, "lib/integrations/managedIdentity.js"));
  const di = require(path.join(ROOT, "lib/integrations/docintel.js"));
  const HEADER = "this-containers-own-header", TOKEN = "token-for-the-reader";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const id = await fakes.identity({ header: HEADER, token: TOKEN });
  const rd = await fakes.reader({ token: TOKEN, result: () => fakes.invoiceResult({ total: 20000, date: ago(20), vendor: "Vaisala Oyj" }) });
  const saved = { e: process.env.IDENTITY_ENDPOINT, h: process.env.IDENTITY_HEADER, d: process.env.DI_ENDPOINT };
  let child = null;
  try {
    // 1. A token from the platform, remembered, shared, and refused out loud.
    delete process.env.IDENTITY_ENDPOINT; delete process.env.IDENTITY_HEADER; mi.reset();
    let none = null;
    try { await mi.getToken(di.AUDIENCE); } catch (e) { none = e.code; }
    check("with no identity there is no token, and it says so rather than inventing one", !mi.available() && none === "no_identity", none);
    process.env.IDENTITY_ENDPOINT = id.endpoint; process.env.IDENTITY_HEADER = HEADER; mi.reset();
    const t1 = await mi.getToken(di.AUDIENCE), t2 = await mi.getToken(di.AUDIENCE);
    check("a token comes from the platform's endpoint and is remembered — two asks, one request",
      t1 === TOKEN && t2 === TOKEN && id.hits.length === 1 && id.hits[0].apiVersion === "2019-08-01" && id.hits[0].resource === di.AUDIENCE, JSON.stringify(id.hits));
    mi.reset();
    const both = await Promise.all([mi.getToken("https://one.example"), mi.getToken("https://one.example")]);
    check("two callers asking at the same moment share one request", both.every((t) => t === TOKEN) && id.hits.length === 2, String(id.hits.length));
    process.env.IDENTITY_HEADER = "not-this-containers"; mi.reset();
    let denied = null;
    try { await mi.getToken("https://two.example"); } catch (e) { denied = e; }
    check("a refusal comes back with the endpoint's reason, and never with the header",
      denied && denied.code === "token_refused" && /401/.test(denied.message) && !denied.message.includes("not-this-containers"), denied && denied.message);
    process.env.IDENTITY_HEADER = HEADER; mi.reset();

    // 2. What the reader read, as proposals.
    const p = di.proposalsFrom(fakes.invoiceResult({ total: 20000, date: "2026-06-12", vendor: "Vaisala Oyj" }));
    check("a read is proposals with their confidence, and one under the policy is held back, not offered",
      p.fields.amount && p.fields.amount.value === 20000 && p.fields.amount.confidence === 0.94 && p.fields.quoteDate.value === "2026-06-12"
        && !p.fields.vendor && p.held.some((h) => h.field === "vendor" && h.confidence === 0.62), JSON.stringify(p));
    check("each proposal keeps where on the page it was read, for Show me",
      p.fields.amount.where && p.fields.amount.where.page === 1 && p.fields.amount.where.unit === "inch" && p.fields.amount.where.polygon.length === 8);

    // 3. Reading, against the stand-in.
    delete process.env.DI_ENDPOINT;
    check("with no endpoint the reader says it is not configured", (await di.readQuote(Buffer.from("x"))).code === "not_configured");
    process.env.DI_ENDPOINT = rd.url + "/";
    const ok = await di.readQuote(Buffer.from("%PDF-1.4 a quote"));
    check("a read follows the operation it was handed, with the identity's token, and returns proposals",
      ok.ok === true && ok.fields.amount.value === 20000 && ok.model === "prebuilt-invoice" && rd.hits.every((h) => h.authorised), JSON.stringify(ok).slice(0, 200));
    const no = await di.readQuote(Buffer.from("%PDF-1.4 %scenario:forbidden"));
    check("an identity with no role on the reader is told so, in words a screen can show",
      no.ok === false && no.code === "not_authorised" && /Cognitive Services User/.test(no.reason), JSON.stringify(no));
    const elsewhere = await fakes.reader({ token: TOKEN, foreign: true, result: () => ({}) });
    process.env.DI_ENDPOINT = elsewhere.url;
    const strayed = await di.readQuote(Buffer.from("%PDF-1.4 a quote"));
    check("an operation on another host is never followed — the token travels with every poll",
      strayed.ok === false && strayed.code === "refused" && elsewhere.hits.length === 1, JSON.stringify(strayed));
    await elsewhere.close();

    // 4. End to end, on a server of its own: the reader on, a quote attached, a proposal, a decision.
    const PORT = 8098;
    const env = Object.assign({}, process.env, { PORT: String(PORT), UNAUTHENTICATED_AS: "shashank_srivastava@example.com",
      IDENTITY_ENDPOINT: id.endpoint, IDENTITY_HEADER: HEADER, DI_ENDPOINT: rd.url });
    for (const k of ["DATABASE_URL", "FEATURES_LOCKED", "SCHEDULER_ENABLED", "DEMO_MODE"]) delete env[k];
    child = spawn(process.execPath, [path.join(ROOT, "server.js")], { env, stdio: "ignore" });
    const base = `http://127.0.0.1:${PORT}`;
    const api = async (method, pth, body) => {
      const r = await fetch(base + "/api" + pth, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
      const t = await r.text();
      let b; try { b = JSON.parse(t); } catch { b = t; }
      return { status: r.status, body: b };
    };
    for (let i = 0; i < 80; i++) { try { if ((await fetch(base + "/health")).ok) break; } catch { /* booting */ } await sleep(250); }
    const health = async () => (await (await fetch(base + "/health")).json()).integrations.ai;
    check("on a fresh server the reader is off, and /health says so", (await health()) === "none");

    const PDFQ = (tag) => Buffer.from(`%PDF-1.4\n% ${tag}\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n`
      + "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");
    const docOf = (r, name) => ((r.body.afe && r.body.afe.documents) || []).find((d) => d.filename === name);
    const settle = async (afeId, attachmentId) => {
      for (let i = 0; i < 50; i++) {
        const d = ((await api("GET", `/afes/${afeId}`)).body.afe.documents || []).find((x) => x.attachmentId === attachmentId);
        if (d && d.reading && d.reading.status !== "reading") return d;
        await sleep(100);
      }
      return null;
    };
    const afeId = (await api("POST", "/afes")).body.afe.id;
    await api("PATCH", `/afes/${afeId}`, { "project.title": "Quote reader", costCenter: "30145", "money.classification": "capex", "money.capexUsd": 20000 });
    const hitsBefore = rd.hits.length;
    const off = await api("POST", `/afes/${afeId}/documents`, { filename: "Quote while off.pdf", role: "quote", contentBase64: PDFQ("off") });
    const offDoc = docOf(off, "Quote while off.pdf");
    await sleep(300);
    check("with the switch off a quote is attached and nothing reads it", off.status === 201 && offDoc && !offDoc.reading && rd.hits.length === hitsBefore,
      JSON.stringify({ status: off.status, reading: offDoc && offDoc.reading, hits: rd.hits.length - hitsBefore }));
    const notNow = await api("POST", `/afes/${afeId}/documents/${offDoc.attachmentId}/read`);
    check("and asking for a read says it is switched off", notNow.status === 409 && /switched off/.test(notNow.body.error), JSON.stringify(notNow.body));

    const on = await api("PUT", "/admin/features/quoteReading", { on: true });
    check("an administrator switches it on, and /health says the reader is live",
      on.status === 200 && on.body.features.find((f) => f.name === "quoteReading").on === true && (await health()) === "quote-reading", JSON.stringify(on.body.error || on.body.state));

    const up = await api("POST", `/afes/${afeId}/documents`, { filename: "Vaisala quote.pdf", role: "quote", contentBase64: PDFQ("Vaisala") });
    const first = docOf(up, "Vaisala quote.pdf");
    check("a quote attached now is answered at once, marked as being read",
      up.status === 201 && first.reading && first.reading.status === "reading" && first.amountUsd === null, JSON.stringify(first && first.reading));
    const read = await settle(afeId, first.attachmentId);
    check("the read lands as a PROPOSAL: the total and the date offered, the vendor held back, and nothing typed has moved",
      read && read.reading.status === "read" && read.reading.fields.amount.value === 20000 && read.reading.fields.quoteDate.value === ago(20)
        && !read.reading.fields.vendor && read.reading.held.some((h) => h.field === "vendor")
        && read.amountUsd === null && read.vendor === null && read.quoteDate === null, JSON.stringify(read));
    const before = (await api("GET", `/afes/${afeId}`)).body;
    check("so the AFE still has no quote total — a proposal counts for nothing yet",
      !before.quoteTotalUsd && (before.validation.pending || []).some((x) => x.rule === "quote_covers_estimate"), JSON.stringify(before.quoteTotalUsd));
    const show = await fetch(`${base}/api/afes/${afeId}/documents/${first.attachmentId}/reading/amount/show.pdf`);
    const shown = Buffer.from(await show.arrayBuffer());
    check("Show me draws the page the total was read from", show.status === 200 && show.headers.get("content-type") === "application/pdf" && shown.slice(0, 5).toString() === "%PDF-",
      String(show.status));

    const used = await api("POST", `/afes/${afeId}/documents/${first.attachmentId}/reading`, { use: true });
    const u = docOf(used, "Vaisala quote.pdf");
    check("Use these makes the proposals the figures, each marked read and confirmed by whoever pressed it",
      used.status === 200 && u.amountUsd === 20000 && u.quoteDate === ago(20) && u.provenance.amountUsd.source === "read"
        && u.provenance.amountUsd.confidence === 0.94 && /Shashank/.test(u.provenance.amountUsd.byName) && u.reading.decision.outcome === "used",
      JSON.stringify(used.body.error || { amount: u.amountUsd, prov: u.provenance, decision: u.reading.decision }));
    check("and the AFE's quote total counts it from that moment", used.body.quoteTotalUsd === 20000, JSON.stringify(used.body.quoteTotalUsd));
    check("a reading is decided once", (await api("POST", `/afes/${afeId}/documents/${first.attachmentId}/reading`, { use: true })).status === 409);
    const over = await api("PATCH", `/afes/${afeId}/documents/${first.attachmentId}`, { amountUsd: 21500 });
    const o = docOf(over, "Vaisala quote.pdf");
    check("typing over a figure that was read makes it the person's own, and says so — the date stays as read",
      over.status === 200 && o.amountUsd === 21500 && o.provenance.amountUsd.source === "typed" && o.provenance.quoteDate.source === "read", JSON.stringify(o.provenance));

    const trail = (await api("GET", `/admin/audit?afeId=${afeId}`)).body;
    const readRow = trail.find((e) => e.type === "quote_read");
    check("the proposal, the decision and the override are each a row of the audit trail",
      readRow && readRow.payload.offered.amount.confidence === 0.94 && readRow.payload.held.some((h) => h.field === "vendor")
        && trail.some((e) => e.type === "quote_reading_used" && e.payload.applied.amountUsd.to === 20000)
        && trail.some((e) => e.type === "document_updated" && e.payload.from.amountUsd === 20000 && e.payload.to.amountUsd === 21500),
      JSON.stringify(trail.map((e) => e.type)));
    const hist = (await api("GET", `/afes/${afeId}/history`)).body.timeline || [];
    check("and the AFE's history says where its figures came from",
      hist.some((r) => /Vaisala quote\.pdf read — proposed the total \$20,000 \(94%\)/.test(r.text)) && hist.some((r) => /used — total, date/.test(r.text)),
      JSON.stringify(hist.map((r) => r.text).slice(0, 6)));

    const up2 = await api("POST", `/afes/${afeId}/documents`, { filename: "Refused quote.pdf", role: "quote", contentBase64: PDFQ("%scenario:forbidden") });
    const refused = await settle(afeId, docOf(up2, "Refused quote.pdf").attachmentId);
    check("a reader that refuses this app says why on the card, and the typed path stands",
      refused && refused.reading.status === "failed" && /Cognitive Services User/.test(refused.reading.reason) && refused.amountUsd === null,
      JSON.stringify(refused && refused.reading));
    // Until somebody grants the role every upload would fail the same way, one audit row each.
    const hitsCool = rd.hits.length;
    const up3 = await api("POST", `/afes/${afeId}/documents`, { filename: "During the pause.pdf", role: "quote", contentBase64: PDFQ("pause") });
    const paused = docOf(up3, "During the pause.pdf");
    await sleep(300);
    check("after 'not authorised' the reader rests: the next upload is not sent to it, and the card says it was not read",
      up3.status === 201 && paused && paused.reading && paused.reading.status === "failed" && paused.reading.skipped === true && rd.hits.length === hitsCool,
      JSON.stringify({ reading: paused && paused.reading, hits: rd.hits.length - hitsCool }));
    const features = (await api("GET", "/admin/features")).body.features || [];
    const qr = features.find((f) => f.name === "quoteReading");
    check("…and Admin › Features shows the last failure where the switch is",
      qr && qr.lastError && /Cognitive Services User/.test(qr.lastError.reason || ""), JSON.stringify(qr && qr.lastError));

    // The platform's reason is an administrator's line, not a requester's: it sat in afe-0032's
    // history on 15 Oct. Checked on the history itself, as each reader is given it.
    {
      const { timelineFor } = require(path.join(ROOT, "lib/views/timeline.js"));
      const rows = [{ afeId: "afe-x", type: "quote_read_failed", actorEmail: "system", createdAt: "2026-10-15T15:33:53.000Z",
        payload: { filename: "s07-challan.pdf", code: "not_authorised", reason: "its identity needs the Cognitive Services User role" } }];
      const stub = { auditEvents: { all: async (pred) => rows.filter(pred || (() => true)) },
        afes: { get: async () => ({ requester: { email: "a@example.com" }, preparer: { email: "a@example.com" } }) }, users: { all: async () => [] } };
      const forRequester = await timelineFor(stub, "afe-x", {});
      const forAdmin = await timelineFor(stub, "afe-x", { admin: true });
      check("a failed read is in an administrator's history and not in a requester's",
        forRequester.length === 0 && forAdmin.length === 1 && /could not be read/.test(forAdmin[0].text), JSON.stringify({ forRequester, forAdmin }));
    }

    const again = await api("POST", `/afes/${afeId}/documents/${offDoc.attachmentId}/read`);
    const reread = again.status === 202 ? await settle(afeId, offDoc.attachmentId) : null;
    const aside = reread ? await api("POST", `/afes/${afeId}/documents/${offDoc.attachmentId}/reading`, { use: false }) : { status: 0, body: {} };
    const s = aside.body.afe ? aside.body.afe.documents.find((d) => d.attachmentId === offDoc.attachmentId) : null;
    check("a quote attached before the switch can be read on request, and Not right sets the reading aside — nothing typed moves",
      again.status === 202 && s && s.reading.decision.outcome === "set_aside" && s.amountUsd === null && !(s.provenance && s.provenance.amountUsd),
      JSON.stringify({ again: again.status, aside: aside.status, s: s && s.reading }));
  } finally {
    if (child) child.kill();
    for (const [k, v] of [["IDENTITY_ENDPOINT", saved.e], ["IDENTITY_HEADER", saved.h], ["DI_ENDPOINT", saved.d]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    mi.reset();
    await id.close();
    await rd.close();
  }
}

// ---------------------------------------------------------------------------------------------
// The database signs the app in with Entra ID (Part B) — inert until DATABASE_AUTH=entra, so what
// can be proved without Azure is proved here: the pool is built from discrete fields with a token
// function and a verified certificate, the token is the identity's for the database's audience,
// /health says which mode is live, and the dry run says what is missing without changing anything.
// That a read-write-only role cannot run the boot DDL, and that ensureSchema does not ask it to,
// was proved against Postgres 16 itself on 2026-10-14.
// ---------------------------------------------------------------------------------------------
async function databaseEntraChecks() {
  console.log("Part B. the database signs the app in with Entra ID — inert until switched");
  const fakes = require("./smoke-fakes");
  const pg = require(path.join(ROOT, "lib/repos/pgStore.js"));
  const mi = require(path.join(ROOT, "lib/integrations/managedIdentity.js"));
  const saved = { a: process.env.DATABASE_AUTH, e: process.env.IDENTITY_ENDPOINT, h: process.env.IDENTITY_HEADER };
  const id = await fakes.identity({ header: "db-header", token: "token-for-the-database" });
  try {
    delete process.env.DATABASE_AUTH;
    check("without DATABASE_AUTH the app signs in with its password, exactly as before", pg.authMode() === "password");
    process.env.DATABASE_AUTH = "entra";
    check("DATABASE_AUTH=entra switches it", pg.authMode() === "entra");
    const cfg = pg.entraConfig("postgres://contact-c4d93f@outside.example:5432/afe?sslmode=require");
    check("the pool is built from discrete fields — a connection string would wipe the token with an empty password",
      !cfg.connectionString && cfg.host === "your-server.postgres.database.azure.com" && cfg.port === 5432 && cfg.database === "afe" && cfg.user === "afe-workbench-uat",
      JSON.stringify(Object.assign({}, cfg, { password: typeof cfg.password })));
    check("and the server's certificate is verified before a token is handed to it",
      cfg.ssl && cfg.ssl.rejectUnauthorized === true && cfg.ssl.servername === cfg.host);
    process.env.IDENTITY_ENDPOINT = id.endpoint; process.env.IDENTITY_HEADER = "db-header"; mi.reset();
    const pw = await cfg.password();
    check("the password is the identity's token, for the database's own audience",
      pw === "token-for-the-database" && id.hits.length === 1 && id.hits[0].resource === pg.PG_AUDIENCE, JSON.stringify(id.hits));
  } finally {
    for (const [k, v] of [["DATABASE_AUTH", saved.a], ["IDENTITY_ENDPOINT", saved.e], ["IDENTITY_HEADER", saved.h]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    mi.reset();
    await id.close();
  }

  const health = await get("/health");
  check("/health says how the app signs in to its database",
    health.body.storage === "postgres" ? health.body.storageAuth === "password" : health.body.storageAuth === null, JSON.stringify({ storage: health.body.storage, auth: health.body.storageAuth }));
  const res = await fetch(BASE + "/api/admin/db/entra-check", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ user: "afe-workbench-uat" }) });
  const dry = await res.json();
  check("the dry run from inside the container says what is missing — here, any identity at all — and is not ready",
    res.status === 200 && dry.ready === false && (dry.problems || []).length > 0
      && (health.body.storage !== "postgres" || /identity|token/i.test(dry.problems[0])), JSON.stringify(dry).slice(0, 300));
}
