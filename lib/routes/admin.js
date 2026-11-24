"use strict";
const express = require("express");
const store = require("../store");
const people = require("../domain/people");
const { MAIL_DOMAIN, ORG_RULE_KIND_IDS } = require("../domain/refData");
const scheduler = require("../scheduler");
const audit = require("../audit");
const rbac = require("../domain/rbac");

module.exports = function adminRoutes({ repos, actAsMap, DEMO_MODE }) {
  const r = express.Router();

  r.use((req, res, next) => {
    if (!rbac.isAdmin(req.ctx)) return res.status(403).json({ error: "admin only" });
    next();
  });

  r.get("/admin/users", async (req, res) => {
    res.json(await repos.users.all());
  });

  // The roles an administrator may give, in the words the People tab shows them.
  r.get("/admin/roles", async (req, res) => {
    res.json(rbac.ASSIGNABLE_ROLES.map((name) => ({ name, label: rbac.ROLES[name].label, description: rbac.ROLES[name].description || "" })));
  });

  r.put("/admin/users/:id", async (req, res) => {
    const u = await repos.users.get(req.params.id);
    if (!u) return res.status(404).json({ error: "user not found" });
    const patch = {};
    for (const f of ["roles", "matrixNames", "active", "displayName", "title", "coordinatorFor"]) if (req.body[f] !== undefined) patch[f] = req.body[f];
    // A role is a permission, so a change to one is checked and on the record. This route took any
    // list and wrote it unaudited; the People tab changes roles through it now (2026-10-16).
    if (patch.roles !== undefined) {
      if (!Array.isArray(patch.roles)) return res.status(422).json({ error: "roles is a list" });
      const unknown = patch.roles.filter((x) => !rbac.ASSIGNABLE_ROLES.includes(x));
      if (unknown.length) return res.status(422).json({ error: `not a role that can be given: ${unknown.join(", ")}` });
      patch.roles = Array.from(new Set(patch.roles));
    }
    const before = { roles: u.roles || [], active: u.active !== false, coordinatorFor: u.coordinatorFor || [] };
    const after = await repos.users.update(u.id, patch);
    if (patch.roles !== undefined || patch.active !== undefined || patch.coordinatorFor !== undefined) {
      await audit.record(repos, req.ctx, { entity: "user", entityId: u.email, type: "user_access_changed",
        payload: { email: u.email, from: before, to: { roles: after.roles || [], active: after.active !== false, coordinatorFor: after.coordinatorFor || [] } } });
    }
    res.json(after);
  });

  r.post("/admin/users", async (req, res) => {
    const b = req.body || {};
    if (!b.email) return res.status(422).json({ error: "email required" });
    res.status(201).json(await repos.users.insert({
      email: b.email.toLowerCase(), displayName: b.displayName || b.email, title: b.title || null,
      roles: b.roles || [], matrixNames: b.matrixNames || [], coordinatorFor: b.coordinatorFor || [], active: true,
    }));
  });

  // Jobs: what ran last, and run one now (the reminders job, R54). A manual run may pass
  // options — `{ "olderThanDays": 0 }` nudges everyone who holds an AFE today.
  r.get("/admin/jobs", async (req, res) => {
    res.json({ scheduler: scheduler.status(), jobs: await repos.jobs.all() });
  });

  // A dry run of the database signing the app in with Entra ID, from inside the container, before
  // anybody switches DATABASE_AUTH (Part B): token, certificate, sign-in, privileges. Changes
  // nothing; the token is never returned; the result is audited so the switch has its evidence.
  r.post("/admin/db/entra-check", async (req, res) => {
    const out = await require("../repos/pgStore").entraCheck({ user: req.body && req.body.user });
    await audit.record(repos, req.ctx, { entity: "settings", entityId: "database", type: "db_entra_check",
      payload: { ready: out.ready, problems: out.problems, user: out.connect && out.connect.user, tls: out.connect && out.connect.tls } });
    res.json(out);
  });

  r.post("/admin/jobs/:name", async (req, res) => {
    try {
      const out = await scheduler.run(repos, req.params.name, req.body || {});
      await audit.record(repos, req.ctx, { entity: "job", entityId: req.params.name, type: "job_run",
        payload: { opts: req.body || {}, result: out.result } });
      res.json(out);
    } catch (e) {
      if (e.status) return res.status(e.status).json({ error: e.message });
      throw e;
    }
  });

  // Demo persona switcher — PoC ONLY. Requires admin + the DEMO_MODE code constant.
  // Every audit event records both the real login and the acted-as identity.
  r.post("/admin/act-as", async (req, res) => {
    if (!DEMO_MODE) return res.status(403).json({ error: "act-as is disabled outside demo mode" });
    const email = String((req.body && req.body.email) || "").toLowerCase().trim();
    let target = await repos.users.find((u) => u.email === email && u.active);

    // Most approvers are NOT users here — the matrix names people who have never opened the
    // tool, and testing a chain meant hitting "Wayne is not a persona that I have mocked yet"
    // (Meeting #5, 31:57). So if a signature is genuinely waiting on this mailbox, provision
    // the row and switch to it. Only ever for someone a live chain already names: this is a
    // way to see what an approver sees, not a way to invent a person.
    if (!target && email) {
      const routings = await repos.routings.all((x) => x.status !== "superseded");
      const waiting = routings.some((x) => (x.recipients || []).some(
        (rec) => String(rec.email || "").toLowerCase() === email
          && ["pending", "sent", "viewed"].includes(rec.status)));
      if (waiting) {
        const named = routings.flatMap((x) => x.recipients || [])
          .find((rec) => String(rec.email || "").toLowerCase() === email);
        target = await repos.users.insert({
          email, displayName: (named && named.name) || people.nameFromEmail(email),
          title: null, roles: [], matrixNames: named && named.name ? [named.name] : [],
          coordinatorFor: [], active: true, provisioned: true, firstSeenAt: new Date().toISOString(),
        });
        await audit.record(repos, req.ctx, { entity: "user", entityId: email, type: "user_provisioned",
          payload: { reason: "a signature is waiting on this mailbox", by: req.ctx.realUser.email } });
      }
    }
    if (!target) return res.status(404).json({ error: "no active user with that email, and no signature is waiting on it" });
    // Keyed by this browser while the site is open, by the mailbox once SSO is in front (R171).
    actAsMap.set(req.ctx.viewKey, target.email);
    // Audited (architecture §2.9): who started acting as whom, and from where.
    await audit.record(repos, req.ctx, { entity: "user", entityId: req.ctx.realUser.email, type: "act_as_started",
      payload: { actingAs: target.email, scope: String(req.ctx.viewKey).startsWith("browser:") ? "this browser" : "this mailbox",
        userAgent: String(req.headers["user-agent"] || "").slice(0, 120), referer: String(req.headers.referer || "").slice(0, 120) } });
    res.json({ actingAs: target.email });
  });

  r.delete("/admin/act-as", async (req, res) => {
    const was = actAsMap.get(req.ctx.viewKey) || null;
    actAsMap.delete(req.ctx.viewKey);
    await audit.record(repos, req.ctx, { entity: "user", entityId: req.ctx.realUser.email, type: "act_as_stopped",
      payload: { was, userAgent: String(req.headers["user-agent"] || "").slice(0, 120), referer: String(req.headers.referer || "").slice(0, 120) } });
    res.json({ actingAs: null });
  });

  // Routing rules the SAP matrix does not carry: pre-approvers, overrides, additional
  // signers, CC recipients, coordinators (R41-R43, R47, R58). Configuration, not code.
  r.get("/admin/org-rules", async (req, res) => {
    const rows = await repos.orgRules.all((x) => !x.retiredAt);
    res.json(rows);
  });

  // Simulate a new SAP approver-matrix extract — UAT's way to show matrix drift before the
  // scheduled ingest exists (Stage 6). Changes the named cells and stamps a new batch id;
  // in-flight chains are never touched (they were frozen at send), so the difference shows
  // up as a red flag at Fixed Assets' receipt (R46). Audited.
  r.post("/admin/matrix/simulate-extract", async (req, res) => {
    const b = req.body || {};
    const changes = Array.isArray(b.changes) ? b.changes : [];
    if (!changes.length) return res.status(422).json({ error: "changes: [{costCenter, level, name}] is required" });
    const applied = [];
    for (const c of changes) {
      const row = await repos.matrix.find((m) => m.costCenter === String(c.costCenter || ""));
      if (!row) return res.status(404).json({ error: `cost centre ${c.costCenter} is not in the matrix` });
      const level = String(c.level || "");
      if (!row.levels || !(level in row.levels) && !/^(M1|A[1-9])$/.test(level)) return res.status(422).json({ error: `${level} is not a matrix level` });
      const was = row.levels[level] ? row.levels[level].name : null;
      row.levels = Object.assign({}, row.levels, { [level]: { name: c.name ? String(c.name).trim() : "" } });
      await repos.matrix.update(row.id, { levels: row.levels });
      applied.push({ costCenter: row.costCenter, level, was, now: row.levels[level].name });
    }
    const prev = repos.meta.matrixBatch || {};
    repos.meta.matrixBatch = Object.assign({}, prev, {
      batchId: b.batchId ? String(b.batchId) : `${prev.batchId || "matrix"}-sim${Date.now().toString(36)}`,
      importedAt: new Date().toISOString(), simulated: true, previousBatchId: prev.batchId || null,
    });
    await audit.record(repos, req.ctx, { entity: "matrix", entityId: repos.meta.matrixBatch.batchId, type: "matrix_simulated_extract",
      payload: { previousBatchId: prev.batchId || null, applied } });
    res.json({ matrixBatch: repos.meta.matrixBatch, applied });
  });

  // The other door onto the extract pipeline (lib/routes/ingest.js owns the machine one):
  // a person uploads the file here, behind SSO and the admin role, and it goes through the
  // same snapshot discipline — idempotent, sanity-checked, activated only once the rows land.
  r.post("/admin/ingest/:kind", async (req, res) => {
    const ingest = require("./ingest");
    const b = req.body || {};
    const out = await ingest.receive(repos, req.ctx, Object.assign({
      kind: req.params.kind, snapshotId: b.snapshotId, filename: b.filename, asOfDate: b.asOfDate,
      force: b.force === true, source: "upload", preview: b.preview === true,
    }, ingest.bodyBytes(req)));
    res.status(out.status).json(out.body);
  });

  r.get("/admin/extracts", async (req, res) => {
    const { KIND_NAMES, KINDS } = require("../ingest");
    const snapshots = require("../ingest/snapshots");
    const rows = await repos.snapshots.all();
    rows.sort((a, b) => String(b.importedAt || "").localeCompare(String(a.importedAt || "")));
    res.json({
      kinds: KIND_NAMES.map((k) => ({ kind: k, label: KINDS[k].label })),
      status: await snapshots.status(repos, KIND_NAMES),
      snapshots: rows.slice(0, 50),
    });
  });

  // ---- routing rules ------------------------------------------------------------------------
  // The chain the SAP matrix does not carry (R41-R43, R47, R58). Retiring one never touches an
  // AFE already sent: that chain was frozen at send, and a rule change only shows on the next
  // preview. Everything is audited with before and after.
  // `controllership` and `assistant` are on this list because WE are their system of record —
  // no SAP report carries the Technical Accounting Review above $1M (Imogen, Meeting #5 28:42:
  // "no, no, it's a separate requirement"), and nothing anywhere carries who checks an AFE
  // before a leader signs it. A rule nobody else owns has to be editable here.
  const RULE_KINDS = ORG_RULE_KIND_IDS;                   // one list, in refData
  const cleanRule = (b, existing) => {
    const out = Object.assign({}, existing || {});
    if (b.kind !== undefined) {
      if (!RULE_KINDS.includes(b.kind)) throw new Error(`kind must be one of ${RULE_KINDS.join(", ")}`);
      out.kind = b.kind;
    }
    if (b.person !== undefined) {
      const name = String((b.person && b.person.name) || "").trim();
      if (!name) throw new Error("the rule needs a person's name");
      const email = people.normEmail(b.person.email);
      if (email && !people.isCompanyMailbox(email)) throw new Error(`${email} is not a ${MAIL_DOMAIN} mailbox`);
      out.person = { name, email: email || null };
    }
    if (b.scope !== undefined) {
      const sc = b.scope || {};
      out.scope = {};
      for (const k of ["division", "costCenter", "ownerName", "projectType"]) if (sc[k]) out.scope[k] = String(sc[k]).trim();
      // An assistant rule names the SIGNER it applies to, by mailbox.
      if (sc.personEmail) {
        const pe = people.normEmail(sc.personEmail);
        if (pe && !people.isCompanyMailbox(pe)) throw new Error(`${pe} is not a ${MAIL_DOMAIN} mailbox`);
        out.scope.personEmail = pe;
      }
    }
    for (const k of ["group", "placement", "aboveLimit", "note"]) if (b[k] !== undefined) out[k] = b[k] ? String(b[k]).trim() : null;
    if (b.handoff !== undefined) out.handoff = Boolean(b.handoff);
    if (b.conditions !== undefined) out.conditions = b.conditions || null;
    if (b.active !== undefined) out.active = Boolean(b.active);
    return out;
  };

  r.post("/admin/org-rules", async (req, res) => {
    try {
      const row = cleanRule(req.body || {}, { active: true, retiredAt: null, createdByEmail: req.ctx.user.email, createdAt: new Date().toISOString() });
      if (!row.kind || !row.person) return res.status(422).json({ error: "kind and person are required" });
      const saved = await repos.orgRules.insert(row);
      await audit.record(repos, req.ctx, { entity: "orgRule", entityId: saved.id, type: "org_rule_added", payload: { rule: saved } });
      res.status(201).json(saved);
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  r.put("/admin/org-rules/:id", async (req, res) => {
    const before = await repos.orgRules.get(req.params.id);
    if (!before) return res.status(404).json({ error: "no such rule" });
    try {
      const patch = cleanRule(req.body || {}, before);
      const saved = await repos.orgRules.update(before.id, patch);
      await audit.record(repos, req.ctx, { entity: "orgRule", entityId: before.id, type: "org_rule_changed",
        payload: { from: before, to: saved } });
      res.json(saved);
    } catch (e) { res.status(422).json({ error: e.message }); }
  });

  // Retiring keeps the row — an AFE sent under it can still explain itself.
  r.delete("/admin/org-rules/:id", async (req, res) => {
    const row = await repos.orgRules.get(req.params.id);
    if (!row) return res.status(404).json({ error: "no such rule" });
    const reason = String((req.body && req.body.reason) || "").trim();
    if (!reason) return res.status(422).json({ error: "say why the rule is retired — it is printed on the AFEs that used it" });
    const saved = await repos.orgRules.update(row.id, { active: false, retiredAt: new Date().toISOString(), retiredByEmail: req.ctx.user.email, retiredReason: reason });
    await audit.record(repos, req.ctx, { entity: "orgRule", entityId: row.id, type: "org_rule_retired", payload: { reason, rule: row } });
    res.json(saved);
  });

  // ---- budget pots ---------------------------------------------------------------------------
  r.post("/admin/budget-pots", async (req, res) => {
    const b = req.body || {};
    const amountUsd = Number(b.amountUsd);
    if (!b.division || !b.fiscalYear || !b.budgetCategory || !b.region) {
      return res.status(422).json({ error: "division, fiscalYear, budgetCategory and region are required" });
    }
    if (!Number.isFinite(amountUsd) || amountUsd < 0) return res.status(422).json({ error: "amountUsd has to be a number" });
    const dup = await repos.budgetPots.find((p) => p.division === b.division && p.fiscalYear === Number(b.fiscalYear) &&
      p.budgetCategory === b.budgetCategory && p.region === b.region);
    if (dup) return res.status(409).json({ error: `that pot already exists (${dup.id}) — edit it instead`, id: dup.id });
    const saved = await repos.budgetPots.insert({ division: String(b.division), fiscalYear: Number(b.fiscalYear),
      budgetCategory: String(b.budgetCategory), region: String(b.region), amountUsd: Math.round(amountUsd * 100) / 100, note: b.note || null });
    await audit.record(repos, req.ctx, { entity: "budgetPot", entityId: saved.id, type: "pot_added", payload: { pot: saved } });
    res.status(201).json(saved);
  });

  r.put("/admin/budget-pots/:id", async (req, res) => {
    const before = await repos.budgetPots.get(req.params.id);
    if (!before) return res.status(404).json({ error: "no such pot" });
    const b = req.body || {};
    const patch = {};
    if (b.amountUsd !== undefined) {
      const n = Number(b.amountUsd);
      if (!Number.isFinite(n) || n < 0) return res.status(422).json({ error: "amountUsd has to be a number" });
      patch.amountUsd = Math.round(n * 100) / 100;
    }
    if (b.note !== undefined) patch.note = b.note || null;
    if (!Object.keys(patch).length) return res.status(422).json({ error: "nothing to change — send amountUsd or note" });
    const saved = await repos.budgetPots.update(before.id, patch);
    await audit.record(repos, req.ctx, { entity: "budgetPot", entityId: before.id, type: "pot_changed",
      payload: { from: { amountUsd: before.amountUsd, note: before.note || null }, to: { amountUsd: saved.amountUsd, note: saved.note || null } } });
    res.json(saved);
  });

  // ---- the name to mailbox directory -----------------------------------------------------------
  // Normally learned when a coordinator confirms one on a routing screen; this is the door for
  // the ones nobody has met yet, and for fixing a wrong one.
  r.put("/admin/directory/:id", async (req, res) => {
    const before = await repos.directory.get(req.params.id);
    if (!before) return res.status(404).json({ error: "no such directory entry" });
    const email = people.normEmail((req.body || {}).email);
    if (!email) return res.status(422).json({ error: "an email address is required" });
    if (!people.isCompanyMailbox(email)) return res.status(422).json({ error: `${email} is not a ${MAIL_DOMAIN} mailbox — every approver is a Acme employee` });
    const saved = await repos.directory.update(before.id, { email, source: "confirmed", confirmedByEmail: req.ctx.user.email, confirmedAt: new Date().toISOString() });
    await audit.record(repos, req.ctx, { entity: "directory", entityId: before.id, type: "directory_learned",
      payload: { name: before.matrixName || before.displayName, from: before.email || null, to: email, how: "admin" } });
    res.json(saved);
  });

  r.post("/admin/directory", async (req, res) => {
    const b = req.body || {};
    const name = String(b.matrixName || b.displayName || "").trim();
    const email = people.normEmail(b.email);
    if (!name) return res.status(422).json({ error: "the name as it appears in the matrix is required" });
    if (!email || !people.isCompanyMailbox(email)) return res.status(422).json({ error: `a ${MAIL_DOMAIN} mailbox is required` });
    const dup = await repos.directory.find((d) => people.normName(d.matrixName || d.displayName) === people.normName(name));
    if (dup) return res.status(409).json({ error: `${name} is already in the directory (${dup.email})`, id: dup.id });
    const saved = await repos.directory.insert({ matrixName: name, displayName: b.displayName || name, email,
      source: "confirmed", confirmedByEmail: req.ctx.user.email, confirmedAt: new Date().toISOString(), note: b.note || "added in Admin" });
    await audit.record(repos, req.ctx, { entity: "directory", entityId: saved.id, type: "directory_learned",
      payload: { name, from: null, to: email, how: "admin" } });
    res.status(201).json(saved);
  });

  r.get("/admin/budget-pots", async (req, res) => {
    res.json(await repos.budgetPots.all());
  });

  // Approver name -> mailbox. `unresolved` entries block sending until someone supplies
  // the address; `guessed` ones must be confirmed by the coordinator (R60).
  r.get("/admin/directory", async (req, res) => {
    const rows = await repos.directory.all();
    rows.sort((a, b) => String(a.matrixName || "").localeCompare(String(b.matrixName || "")));
    res.json(rows);
  });

  r.get("/admin/audit", async (req, res) => {
    const rows = await repos.auditEvents.all(
      req.query.afeId ? (e) => e.afeId === req.query.afeId : null
    );
    rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json(rows.slice(0, 200));
  });

  r.get("/admin/outbox", async (req, res) => {
    const all = await repos.notifications.all();
    all.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    res.json(all.slice(0, 200));
  });

  // ---- master data and feature flags (R88, R89) ------------------------------------------------
  // Their own files: this one is long enough, and both are self-contained.
  require("./adminMasters")({ repos, router: r });
  require("./adminFeatures")({ repos, router: r });

  r.post("/admin/reset", async (req, res) => {
    actAsMap.clear();
    const info = await store.reset(repos);
    res.json({ ok: true, seedInfo: info });
  });

  return r;
};
