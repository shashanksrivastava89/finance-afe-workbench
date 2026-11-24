"use strict";
// Fixed Assets: the queue, the judgment, red flags (acknowledge with a reason, clear drift
// with evidence, draft the digest), the KO01 sheet, recording the internal orders, the
// hand-off steps after KO01. Every state change goes through stateMachine.applyTransition;
// every other write is guard → repo write → audit.record.
const express = require("express");
const stateMachine = require("../domain/stateMachine");
const faJudgment = require("../domain/faJudgment");
const afeRules = require("../domain/afeRules");
const redFlags = require("../domain/redFlags");
const mail = require("../integrations/mail");
const notify = require("../notify");
const audit = require("../audit");
const issuedPack = require("../pdf/issuedPack");
const { faView, faQueueRow, inFaHands, toCheck } = require("../views/faView");
const { afeView } = require("../views/afeView");
const { ORDER_TYPES, CLASSIFICATIONS, HANDOFF_STEPS, LEVEL_LADDER } = require("../domain/refData");
const rbac = require("../domain/rbac");

module.exports = function faRoutes({ repos }) {
  const r = express.Router();
  const nowIso = () => new Date().toISOString();
  const isFa = (ctx) => rbac.can(ctx, "fa.process");

  r.use("/fa", (req, res, next) => {
    if (!isFa(req.ctx)) return res.status(403).json({ error: "Fixed Assets only" });
    next();
  });

  const load = async (req, res) => {
    const afe = await repos.afes.get(req.params.id);
    if (!afe) { res.status(404).json({ error: "no such AFE" }); return null; }
    return afe;
  };
  const view = (afe, req, opts) => faView(repos, afe, req.ctx, opts);
  const inReview = (afe, res) => {
    if (afe.state === "fa_review") return true;
    res.status(409).json({ error: `this AFE is ${String(afe.state).replace(/_/g, " ")} — Fixed Assets judges it while it is in review`, state: afe.state });
    return false;
  };
  const who = (req) => ({ byEmail: req.ctx.user.email, byName: req.ctx.userRow.displayName });

  // ---- the queue: aggregation first --------------------------------------------------------------
  r.get("/fa/queue", async (req, res) => {
    const now = nowIso();
    const rows = await repos.afes.all(inFaHands);
    const groups = { toCheck: [], issued: [], sentBack: [], done: [] };
    for (const a of rows) {
      const row = await faQueueRow(repos, a, req.ctx, now);
      if (toCheck(a)) groups.toCheck.push(row);
      else if (["issued", "tracking"].includes(a.state)) groups.issued.push(row);
      else if (a.state === "returned") groups.sentBack.push(row);
      else groups.done.push(row);
    }
    groups.toCheck.sort((a, b) => String(a.receivedAt || "").localeCompare(String(b.receivedAt || "")));       // oldest first
    groups.issued.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    groups.sentBack.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    groups.done.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const counts = {};
    for (const k of Object.keys(groups)) counts[k] = groups[k].length;
    counts.flagged = groups.toCheck.filter((x) => x.flags.openBlocks > 0).length;
    // What is sitting on somebody's approval to issue, and what is sitting on THIS person's.
    // Judithmelanie signing in had no way to find out that anything wanted him (R142).
    counts.needsIssueApproval = groups.toCheck.filter((x) => x.needsIssueApproval).length;
    counts.myIssueApproval = groups.toCheck.filter((x) => x.canApproveIssue).length;
    counts.ko22Outstanding = groups.issued.filter((x) => !(x.steps && x.steps.KO22_BUDGET)).length;
    res.json({ counts, groups, matrixBatch: repos.meta.matrixBatch || null });
  });

  // ---- one AFE, everything derived -----------------------------------------------------------------
  r.get("/fa/afes/:id", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    res.json(await view(afe, req));
  });

  r.get("/fa/afes/:id/ko01", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const fv = await view(afe, req, { light: true });
    res.json(Object.assign({ afeId: afe.id, afeNo: afe.afeNo, state: afe.state, orderType: (afe.fa && afe.fa.orderType) || null }, fv.ko01, { handoff: fv.handoff, readiness: fv.readiness }));
  });

  // ---- the judgment rows and the order type ------------------------------------------------------------
  /**
   * R98 — Fixed Assets reads the form and the signatures BEFORE forming a judgment.
   *
   * "FA Checker view — land them on the 2nd tab, not the checklist directly" (Shashank) and
   * "FA workflow to complete AFE form and signature review before the Judgement tab" (Lyndsay).
   * The screen opens on the form; this is the record that somebody actually looked at it.
   */
  r.post("/fa/afes/:id/form-reviewed", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!inReview(afe, res)) return;
    if (!rbac.can(req.ctx, "fa.process")) return res.status(403).json({ error: "Fixed Assets only" });
    afe.fa = afe.fa || {};
    const undo = Boolean(req.body && req.body.undo);
    const before = afe.fa.formReviewed || null;
    afe.fa.formReviewed = undo ? null : Object.assign({ at: nowIso() }, who(req));
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: undo ? "fa_form_review_undone" : "fa_form_reviewed",
      payload: { before, after: afe.fa.formReviewed } });
    res.json(await view(afe, req));
  });

  r.post("/fa/afes/:id/judgment", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!inReview(afe, res)) return;
    // The judgment does not open until the form and the signatures have been read (R98). The
    // server decides that, not the screen: a tab order is a suggestion, a refusal is a control.
    if (!(afe.fa && afe.fa.formReviewed)) {
      return res.status(422).json({ error: "Read the form and the signatures first, then record that you have — "
        + "the judgment opens after that.", needs: "fa_form_reviewed" });
    }
    const b = req.body || {};
    const ticks = b.ticks && typeof b.ticks === "object" ? b.ticks : {};
    const known = new Set(faJudgment.ROWS.map((x) => x.id));
    for (const id of Object.keys(ticks)) if (!known.has(id)) return res.status(422).json({ error: `no judgment row called ${id}` });
    if (b.orderType !== undefined && b.orderType !== null && !ORDER_TYPES.some((o) => o.code === b.orderType)) {
      return res.status(422).json({ error: `order type must be ${ORDER_TYPES.map((o) => o.code).join(" or ")}` });
    }
    afe.fa = afe.fa || {};
    const before = { judgment: Object.assign({}, afe.fa.judgment), orderType: afe.fa.orderType || null };
    afe.fa.judgment = Object.assign({}, afe.fa.judgment);
    for (const [id, val] of Object.entries(ticks)) {
      if (val === true) afe.fa.judgment[id] = true; else delete afe.fa.judgment[id];
    }
    if (b.orderType !== undefined) afe.fa.orderType = b.orderType || null;
    afe.fa.judgedByEmail = req.ctx.user.email;
    afe.fa.judgedAt = nowIso();
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "fa_judgment",
      payload: { ticks, from: before, to: { judgment: afe.fa.judgment, orderType: afe.fa.orderType || null } } });

    // R146 — the moment the judgment is finished, the people it now waits on are TOLD.
    //
    // "At what time will they get to know that something is pending for review? Once the FA team
    // member will review the AFE form, when at what time they will get notifications that
    // something is pending in their queue for approval?" (Lyndsay, Meeting #6). Until now the only
    // answer was that somebody remembered to press Ask, or that an approver happened to open the
    // queue — and a control nobody is told about is a control that does not run.
    //
    // Fired once per AFE: `issueApprovalAskedAt` is the guard, so ticking another row later, or
    // unticking and re-ticking, does not send it again. The button stays for chasing.
    let told = null;
    const after = await view(afe, req);
    if (!after.judgment.open && !after.issue.approval && !(afe.fa && afe.fa.issueApprovalAskedAt)) {
      const out = await askIssueApproval(req.ctx, afe, after, { auto: true });
      if (out.note && !out.error) {
        told = out.note;
        afe.updatedAt = nowIso();
        await repos.afes.update(afe.id, afe);
      }
    }
    res.json(Object.assign({ told }, told ? await view(afe, req) : after));
  });

  // The rate Fixed Assets keys the local company code at (R161). "We have this field, so it should
  // be… allowed" (Judithmelanie, Meeting #7): the AFE carries Global Finance's month-end rate from the
  // month it was written, and SAP is keyed in the month it is issued. So Fixed Assets may set the
  // rate THEY use. It is theirs, not the AFE's: it never touches the signed page — it prints in
  // red in the issued AFE's note strip, the same as anything else they record after signing — and
  // the approved figure is still US dollars.
  r.post("/fa/afes/:id/fx", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!["fa_review", "issued", "tracking"].includes(afe.state)) {
      return res.status(409).json({ error: `this AFE is ${String(afe.state).replace(/_/g, " ")} — the rate is set while Fixed Assets is keying it`, state: afe.state });
    }
    const code = String((afe.money && afe.money.currency) || "USD").toUpperCase();
    if (code === "USD") return res.status(422).json({ error: "This AFE is in US dollars — there is no local rate to set." });
    const raw = req.body && req.body.localPerUsd;
    const local = raw === null || raw === "" || raw === undefined ? null : Number(String(raw).replace(/[,\s]/g, ""));
    if (local !== null && !(local > 0 && Number.isFinite(local))) return res.status(422).json({ error: `${raw} is not a rate: give the ${code} one US dollar buys, like 1.286505.` });
    const was = (afe.fa && afe.fa.fx) || null;
    afe.fa = afe.fa || {};
    // Blank puts it back to the AFE's own rate.
    afe.fa.fx = local === null ? null : Object.assign({ currency: code, localPerUsd: local, month: (req.body && req.body.month) || null, at: nowIso() }, who(req));
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "fa_fx_set",
      payload: { currency: code, localPerUsd: local, was: was ? was.localPerUsd : null } });
    res.json(await view(afe, req));
  });

  // Fixed Assets' one edit right on the AFE: the classification, with a reason (R57 — accounting
  // cares about classification). Audited with before and after.
  r.post("/fa/afes/:id/reclassify", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!inReview(afe, res)) return;
    const to = String((req.body && req.body.classification) || "");
    const reason = String((req.body && req.body.reason) || "").trim();
    if (!CLASSIFICATIONS.some((c) => c.id === to)) return res.status(422).json({ error: `classification must be one of ${CLASSIFICATIONS.map((c) => c.id).join(", ")}` });
    // An AFE is capital (R158): one Fixed Assets judges to be an expense goes back to the
    // requester, it is not turned into an AFE for nothing.
    if (to === "none") return res.status(422).json({ error: "An AFE is for capital. If this is an expense, send it back to the requester instead." });
    if (!reason) return res.status(422).json({ error: "a reclassification needs a reason — it is printed on the audit trail and the project page" });
    const from = (afe.money && afe.money.classification) || null;
    if (from === to) return res.status(422).json({ error: `already classified as ${to}` });
    afe.money.classification = to;
    afe.fa = afe.fa || {};
    afe.fa.reclassified = Object.assign({ from, to, reason, at: nowIso() }, who(req));
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "fa_reclassified", payload: { from, to, reason } });
    res.json(await view(afe, req));
  });

  // ---- red flags -------------------------------------------------------------------------------------------
  // A flag is acknowledged with a reason. Drift is different: it is cleared with evidence — the new
  // approver's email approval attached to the AFE — through the drift route below.
  r.post("/fa/afes/:id/red-flags/:flagId/ack", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!inReview(afe, res)) return;
    const fv = await view(afe, req, { light: true });
    const flag = fv.redFlags.flags.find((f) => f.id === req.params.flagId);
    if (!flag) return res.status(404).json({ error: `no red flag ${req.params.flagId} on this AFE right now — flags are derived, so one that is gone needs no acknowledgement` });
    if (flag.source === "drift") return res.status(422).json({ error: "matrix drift is cleared with evidence, not a note — attach the new approver's email approval and acknowledge it on the drift route", route: `/api/fa/afes/${afe.id}/drift/${flag.level}/ack` });
    const note = String((req.body && req.body.note) || "").trim();
    if (!note) return res.status(422).json({ error: "say why this flag stands — the note is printed for the checker and audited" });
    afe.fa = afe.fa || {};
    afe.fa.flagAcks = (afe.fa.flagAcks || []).filter((a) => a.flagId !== flag.id).concat([Object.assign({ flagId: flag.id, title: flag.title, severity: flag.severity, note, at: nowIso() }, who(req))]);
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "red_flag_acknowledged", payload: { flagId: flag.id, title: flag.title, severity: flag.severity, source: flag.source, note } });
    res.json(await view(afe, req));
  });

  // Matrix drift: the level (A2) or the routing recipient id; the evidence is an email_approval
  // document already attached to the AFE (POST /afes/:id/documents with role email_approval).
  r.post("/fa/afes/:id/drift/:key/ack", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!inReview(afe, res)) return;
    const fv = await view(afe, req, { light: true });
    const key = String(req.params.key);
    const d = fv.redFlags.drift.changed.find((x) => x.level === key || x.recipientId === key);
    if (!d) return res.status(404).json({ error: `no matrix drift at ${key} on this AFE` });
    const attachmentId = String((req.body && req.body.attachmentId) || "");
    const doc = (afe.documents || []).find((x) => x.attachmentId === attachmentId);
    if (!doc) return res.status(422).json({ error: "attach the email approval to the AFE first, then acknowledge the drift with its attachmentId" });
    if (doc.role !== "email_approval") return res.status(422).json({ error: `${doc.filename} is a ${doc.role}, not an email approval — the evidence for drift is the new approver's email` });
    const note = String((req.body && req.body.note) || "").trim();
    afe.fa = afe.fa || {};
    afe.fa.driftAck = (afe.fa.driftAck || []).filter((a) => a.level !== d.level).concat([Object.assign({
      level: d.level, was: d.was, now: d.now, recipientId: d.recipientId, attachmentId, filename: doc.filename, note, at: nowIso(),
    }, who(req))]);
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "drift_acknowledged",
      payload: { level: d.level, was: d.was, now: d.now, attachmentId, filename: doc.filename, note } });
    res.json(await view(afe, req));
  });

  // The digest: one email per AFE, every open flag, drafted into the outbox and handed back as an
  // .eml that opens in Outlook as an unsent draft. `red_flag_digest` rows can never be sent by
  // the tool (lib/notify.js DRAFT_ONLY_KINDS) — R51.
  r.post("/fa/afes/:id/red-flags/draft", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const fv = await view(afe, req);
    if (!fv.permissions.canDraftDigest) return res.status(409).json({ error: `this AFE is ${String(afe.state).replace(/_/g, " ")} — the digest is drafted while it is in review` });
    const digest = fv.digest;
    if (!digest.to) return res.status(422).json({ error: "this AFE has no coordinator or requester mailbox to address the digest to" });
    const row = await notify.enqueue(repos, {
      recipientEmail: digest.to, recipientName: digest.toName, cc: digest.cc, afeId: afe.id, kind: "red_flag_digest",
      subject: digest.subject, body: digest.body, meta: { flagIds: digest.flagIds, draftedByEmail: req.ctx.user.email },
    });
    afe.fa = afe.fa || {};
    afe.fa.digests = (afe.fa.digests || []).concat([Object.assign({ notificationId: row.id, at: row.createdAt, flagIds: digest.flagIds, to: digest.to }, who(req))]);
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "notification", entityId: row.id, afeId: afe.id, type: "red_flag_digest_drafted",
      payload: { to: digest.to, cc: digest.cc, subject: digest.subject, flagIds: digest.flagIds, status: row.status } });
    const eml = mail.buildEml({ to: row.recipientEmail, toName: row.recipientName, cc: row.cc, subject: row.subject, body: row.body, date: row.createdAt, afeId: afe.id, messageId: `${row.id}.${afe.id}@afe-workbench` });
    // With the Graph registration in place the draft also lands in the RTR_FA mailbox. It is
    // still a draft: nothing here sends it, and a Graph outage only costs the convenience.
    let mailbox = { mode: "eml", drafted: false };
    try { mailbox = await mail.draft({ to: row.recipientEmail, cc: row.cc, subject: row.subject, body: row.body, afeId: afe.id }); }
    catch (e) { mailbox = { mode: "graph", drafted: false, error: e.message }; }
    if (mailbox.drafted) await repos.notifications.update(row.id, { channel: "graph", graphMessageId: mailbox.messageId, graphWebLink: mailbox.webLink });
    res.status(201).json({ notification: await repos.notifications.get(row.id), draft: digest, eml, filename: mail.emlFilename(row.subject),
      emlUrl: `/api/fa/afes/${afe.id}/red-flags/drafts/${row.id}.eml`, mode: mail.mode(), mailbox });
  });

  // The stored draft as a file. Express treats the dot as a literal, so `:nid` stops before `.eml`.
  r.get("/fa/afes/:id/red-flags/drafts/:nid.eml", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const row = await repos.notifications.get(req.params.nid);
    if (!row || row.afeId !== afe.id || row.kind !== "red_flag_digest") return res.status(404).json({ error: "no such digest draft on this AFE" });
    const eml = mail.buildEml({ to: row.recipientEmail, toName: row.recipientName, cc: row.cc, subject: row.subject, body: row.body, date: row.createdAt, afeId: afe.id, messageId: `${row.id}.${afe.id}@afe-workbench` });
    res.setHeader("Content-Type", "message/rfc822");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `attachment; filename="${mail.emlFilename(row.subject)}"`);
    res.send(eml);
  });

  // ---- lifecycle ------------------------------------------------------------------------------------------
  r.post("/fa/afes/:id/return", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "fa_return", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.json(Object.assign({ note: result.note }, await view(afe, req, { light: true })));
  });

  // R101 — the FA Supervisor or Manager approves before SAP is touched.
  /**
   * Ask the named approvers to look at it (R142).
   *
   * Four eyes on the creation of an internal order is a control, and a control nobody is told
   * about is a control that does not run: an AFE could sit judged, flag-free and finished
   * waiting for an approval neither Judithmelanie nor Jarrod had any way of knowing was wanted.
   * Nothing about the AFE changes — this is a mail, not a transition.
   */
  /**
   * Tell the people this AFE is waiting on. ONE function, two callers (R142, R146).
   *
   * Lyndsay, Meeting #6: "at what time will they get to know that something is pending for
   * review?" — so the judgment completing fires this by itself; the button stays for chasing.
   * Both go through here, so a chase and an automatic ask are the same mail to the same people.
   *
   * Returns `{ note }` or `{ already }`, or `{ status, error }` for the route to pass on.
   * It MUTATES the AFE (`fa.issueApprovalAskedAt`); the caller writes it.
   */
  async function askIssueApproval(ctx, afe, fv, opts) {
    const auto = Boolean(opts && opts.auto);
    if (!fv.issue.required) return { status: 409, error: "no approval is required to issue" };
    if (fv.issue.approval) return { status: 409, error: `already approved by ${fv.issue.approval.byName}` };
    // Mirrors the transition's own gate: red flags block an approval, the judgment does not.
    // Chasing somebody for something the server would refuse is worse than not chasing.
    if (!fv.redFlags.ready) {
      return { status: 409, error: "clear or acknowledge the red flags first — the approval would be refused while they are open" };
    }
    // Whoever the preparer named, or everyone if nobody has named anyone (R145).
    const who = fv.issue.chosen || fv.issue.approvers || [];
    const to = who.map((x) => x.email).filter(Boolean);
    const names = who.map((x) => x.name).join(" and ");
    if (!to.length) return { status: 409, error: "no issue approver has a mailbox — Admin › Org rules, kind fa_issue_approver" };
    // Once a day, however many people press it, and whether it fired by itself or by hand.
    const today = nowIso().slice(0, 10);
    const already = await repos.notifications.find((n) => n.kind === "fa_issue_approval_wanted"
      && n.afeId === afe.id && String(n.createdAt || "").slice(0, 10) === today);
    if (already) return { already: true, note: `${names} ${who.length === 1 ? "was" : "were"} already asked today.` };
    // ONE mail, the shape every other hand-off uses: the first is the recipient and the rest are
    // copied, so the outbox shows one identifiable row rather than three.
    const title = (afe.project && afe.project.title) || afe.id;
    const row = await notify.enqueue(repos, {
      recipientEmail: to[0], recipientName: who[0].name || null, cc: to.slice(1),
      afeId: afe.id, kind: "fa_issue_approval_wanted",
      subject: `AFE ready for your approval to issue | ${afe.costCenter || ""} | ${title}`,
      body: `${title} is with Fixed Assets and its red flags are clear.\n\n`
        + `No internal order is created until ${who.length === 1 ? "you approve" : "one of you approves"} it.\n\n`
        + `${notify.link(`/fa/${afe.id}/judge`)}\n`,
      headers: { "X-AFE-Id": afe.id, "X-AFE-Action": "issue-approval" },
    });
    afe.fa = afe.fa || {};
    afe.fa.issueApprovalAskedAt = nowIso();
    await audit.record(repos, ctx, { entity: "afe", entityId: afe.id, type: "fa_issue_approval_asked",
      payload: { to, notificationId: row.id, auto } });
    return { note: auto ? `${names} ${who.length === 1 ? "has" : "have"} been told.` : `Asked ${names}.` };
  }

  r.post("/fa/afes/:id/ask-issue-approval", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const fv = await view(afe, req, { light: true });
    if (!fv.permissions.canJudge) return res.status(403).json({ error: "not yours to ask about" });
    const out = await askIssueApproval(req.ctx, afe, fv, { auto: false });
    if (out.error) return res.status(out.status).json({ error: out.error });
    if (!out.already) { afe.updatedAt = nowIso(); await repos.afes.update(afe.id, afe); }
    res.json(out);
  });

  /**
   * Who this AFE goes to for approval (R145).
   *
   * "There is some option that preparer can choose either me or Jarrod or Manaia" (Judithmelanie);
   * "Imogen, Lyndsay, Ebony should be able to select the approval as per the requirement". An
   * empty list hands it back to all of them, which is what an AFE nobody has chosen for does.
   */
  r.post("/fa/afes/:id/issue-approver", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (!inReview(afe, res)) return;
    const fv = await view(afe, req, { light: true });
    if (!fv.permissions.canJudge) return res.status(403).json({ error: "only Fixed Assets chooses who approves the issue" });
    if (fv.issue.approval) return res.status(409).json({ error: `${fv.issue.approval.byName} has already approved this for issue` });
    const wanted = Array.isArray(req.body && req.body.emails) ? req.body.emails : [];
    const known = new Map((fv.issue.approvers || []).map((a) => [a.email, a]));
    const picked = [];
    for (const e of wanted) {
      const email = String(e || "").trim().toLowerCase();
      // Only somebody the org rules already name: the choice narrows, it never widens.
      if (!known.has(email)) return res.status(422).json({ error: `${e} is not an issue approver`, approvers: [...known.keys()] });
      if (!picked.includes(email)) picked.push(email);
    }
    const before = (afe.fa && afe.fa.issueApprovalAskedOf) || [];
    afe.fa = afe.fa || {};
    afe.fa.issueApprovalAskedOf = picked;
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "fa_issue_approver_chosen",
      payload: { from: before, to: picked } });
    res.json(Object.assign({ note: picked.length
      ? `With ${picked.map((e) => known.get(e).name).join(" and ")}.`
      : "Open to any issue approver." }, await view(afe, req)));
  });

  r.post("/fa/afes/:id/approve-issue", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "fa_approve_issue", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null });
    res.json(Object.assign({ note: result.note }, await view(afe, req)));
  });

  r.post("/fa/afes/:id/record-io", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "fa_record_io", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.json(Object.assign({ note: result.note }, await view(afe, req, { light: true })));
  });

  // R93/R104 — send the issued AFE: the signed form with the numbers on it, in red, the SAP
  // budget table beside them and the quote bound in behind.
  r.post("/fa/afes/:id/issue-pack", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "fa_issue_pack", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.json(Object.assign({ note: result.note }, await view(afe, req, { light: true })));
  });

  // ---- the end of the line: capitalize, then a second person closes ---------------------------
  // Four eyes is the point of splitting these: the preparer settles the AuC to a fixed asset,
  // and somebody else agrees it is finished. The state machine holds the rule (it is about the
  // person, not the role); these routes only carry it there.
  r.post("/fa/afes/:id/capitalize", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "capitalize", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.json(Object.assign({ note: result.note }, await view(afe, req, { light: true })));
  });

  r.post("/fa/afes/:id/close", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, "close", req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.json(Object.assign({ note: result.note }, await view(afe, req, { light: true })));
  });

  // The steps after KO01 (KO22 budget, AS01 AUC, KO02 settlement) — ticked as done, with the value
  // SAP gave back where there is one (the AUC number). Not lifecycle: the AFE stays issued until
  // SAP's extracts show it tracking (Stage 6).
  /**
   * The issued AFE as it WOULD go out, built and thrown away (R134).
   *
   * "The FA team has no place to see the modified AFE (post approvals) before sending to
   * requester" (Shashank, 2026-09-22) — and they were right: the pack only existed once it had
   * been built AND sent, so the first person to see the red marks, the SAP table and the bound
   * documents was the requester. That is the wrong way round for a document a team assembles by
   * hand today precisely so they can check it.
   *
   * It is the SAME builder the send uses, with the same arguments, so this is a preview of the
   * real thing rather than a second rendering that could disagree with it. Nothing is stored:
   * no attachment, no document row, no audit, no state change. The profit centre and the note
   * can be passed as query parameters so the sheet can preview what has been typed but not yet
   * saved.
   */
  r.get("/fa/afes/:id/issued-pack/preview.pdf", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const fv = await afeView(repos, afe, req.ctx);
    if (!fv.permissions.canView) return res.status(403).json({ error: "not yours to view" });
    const ios = await repos.ios.all((i) => i.afeId === afe.id && i.kind === "parent");
    const ioNumber = (ios[0] && ios[0].ioNumber) || afe.afeNo;
    if (!ioNumber) return res.status(409).json({ error: "there is no internal order on this AFE yet" });

    const routing = afe.routingId ? await repos.routings.get(afe.routingId) : null;
    // The view already computed this AFE's validation; the Exceptions block on the form wants
    // exactly that, so reuse it rather than reaching into the state machine for a private helper.
    const v = fv.validation || null;
    const q = req.query || {};
    const ex = typeof q.exclude === "string" && q.exclude ? q.exclude.split(",") : undefined;
    let built;
    try {
      built = await issuedPack.buildIssuedPack(repos, afe, routing, {
        ioNumber, aucNumber: (afe.fa && afe.fa.aucNumber) || null, plant: afe.plant,
        // What the sheet has typed wins over what is stored, so the preview shows the pack the
        // button would actually produce.
        profitCentre: q.profitCentre !== undefined ? String(q.profitCentre) : ((afe.fa && afe.fa.profitCentre) || null),
        budgetLoadedUsd: (afe.fa && afe.fa.budgetLoadedUsd) !== undefined ? afe.fa.budgetLoadedUsd : null,
        note: q.note !== undefined ? String(q.note).slice(0, 400) : ((afe.fa && afe.fa.issuedNote) || null),
        fx: (afe.fa && afe.fa.fx) || null,
        orderType: (afe.fa && afe.fa.orderType) || null,
        issuedAt: (afe.fa && afe.fa.issuedAt) || new Date().toISOString(),
        approvedBy: (afe.fa && afe.fa.issueApproval && afe.fa.issueApproval.byName) || null,
      }, { exclude: ex, validation: v });
    } catch (e) {
      return res.status(422).json({ error: `The issued AFE would not assemble: ${String(e.message).slice(0, 160)}` });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `inline; filename="preview-${built.filename.replace(/"/g, "")}"`);
    res.send(built.bytes);
  });

  r.post("/fa/afes/:id/steps/:key", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const step = HANDOFF_STEPS.find((s) => s.key === req.params.key && s.key !== "KO01_IO");
    if (!step) return res.status(404).json({ error: `no hand-off step ${req.params.key}` });
    const fv = await afeView(repos, afe, req.ctx);
    if (!fv.permissions.canTickSteps) return res.status(409).json({ error: `steps are ticked once the internal order is recorded (this AFE is ${String(afe.state).replace(/_/g, " ")})` });
    const b = req.body || {};
    afe.fa = afe.fa || {};
    afe.fa.steps = Object.assign({}, afe.fa.steps);
    if (b.undo) {
      // A later step standing on this one has to go first, or the chain claims a foundation that
      // is no longer there.
      const dependent = HANDOFF_STEPS.find((s) => s.after === step.key && afe.fa.steps[s.key]);
      if (dependent) return res.status(422).json({ error: `${dependent.title} was done after this one — undo that first.`, needs: dependent.key });
      const was = afe.fa.steps[step.key] || null;
      delete afe.fa.steps[step.key];
      if (step.needsValue) afe.fa[step.needsValue.field] = null;
      if (step.needsAmount) afe.fa[step.needsAmount.field] = null;
      if (step.key === "AS01_AUC") for (const io of await repos.ios.all((i) => i.afeId === afe.id && i.kind === "parent")) await repos.ios.update(io.id, { aucNumber: null });
      afe.updatedAt = nowIso();
      await repos.afes.update(afe.id, afe);
      await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "fa_step_undone", payload: { step: step.key, was } });
      return res.json(await view(afe, req, { light: true }));
    }
    // A step is done when what it needed came back with it (R99, R100, R103). What it needs is
    // declared on the step in refData, so the route, the screen and the issued version read one
    // description rather than three copies of it.
    if (step.after && !(afe.fa.steps[step.after])) {
      const prior = HANDOFF_STEPS.find((s) => s.key === step.after);
      return res.status(422).json({ error: `${(prior && prior.title) || step.after} comes first.`, needs: step.after });
    }

    const value = b.value === undefined || b.value === null ? null : String(b.value).trim();
    if (step.needsValue) {
      if (!value) return res.status(422).json({ error: `${step.needsValue.label} is required — ${step.needsValue.help}`, needs: "value" });
      if (!new RegExp(step.needsValue.pattern).test(value)) {
        return res.status(422).json({ error: `${value} is not ${/^[aeiou]/i.test(step.needsValue.label) ? "an" : "a"} ${step.needsValue.label} — it is ${step.needsValue.shape}.`, needs: "value" });
      }
    }

    let amountUsd = null;
    if (step.needsAmount) {
      amountUsd = afeRules.toNum(b.amountUsd);
      if (amountUsd === null) return res.status(422).json({ error: `${step.needsAmount.label} is required — ${step.needsAmount.help}`, needs: "amount" });
      if (!(amountUsd >= 0)) return res.status(422).json({ error: `${step.needsAmount.label} cannot be negative.`, needs: "amount" });
    }

    // The hard gate. "Many times, IO number is generated" and the budget is never loaded, so the
    // tick on its own proves nothing — the SAP table does, and it is the same picture Fixed
    // Assets pastes onto the form by hand today.
    if (step.needsEvidence) {
      const have = (afe.documents || []).filter((d) => d.role === step.needsEvidence.role);
      if (!have.length) {
        return res.status(422).json({
          error: `Attach the ${step.needsEvidence.label} screenshot first — ${step.needsEvidence.help}`,
          needs: "evidence", role: step.needsEvidence.role,
        });
      }
    }

    afe.fa.steps[step.key] = Object.assign({ doneAt: nowIso(), value, amountUsd, note: b.note ? String(b.note).trim() : null }, who(req));

    // The figures live on the AFE as well as on the step, because that is where everything that
    // prints them looks. `afe.fa.aucNumber` has been read by the issued pack since v0.5 and
    // written by nothing at all until now (R100).
    if (step.needsValue) afe.fa[step.needsValue.field] = value;
    if (step.needsAmount) afe.fa[step.needsAmount.field] = amountUsd;
    if (step.key === "AS01_AUC" && value) {
      for (const io of await repos.ios.all((i) => i.afeId === afe.id && i.kind === "parent")) await repos.ios.update(io.id, { aucNumber: value });
    }
    afe.updatedAt = nowIso();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "fa_step_done", payload: { step: step.key, value, amountUsd } });
    res.json(await view(afe, req, { light: true }));
  });

  return r;
};

module.exports.LEVELS = LEVEL_LADDER;
