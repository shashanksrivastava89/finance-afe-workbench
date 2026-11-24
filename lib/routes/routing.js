"use strict";
// The chain and the request-side lifecycle: preview, the coordinator's edits, mailbox
// confirmation, submit / send / send back / answer / withdraw, and the
// coordinator's queue. Every state change goes through stateMachine.applyTransition.
const express = require("express");
const routingSvc = require("../routing");
const stateMachine = require("../domain/stateMachine");
const reminders = require("../domain/reminders");
const people = require("../domain/people");
const coordination = require("../domain/coordination");
const afeRules = require("../domain/afeRules");
const { afeView, afeBrief } = require("../views/afeView");
const { renderAfeForm } = require("../pdf/afeForm");
const { buildFormModel } = require("../pdf/formModel");
const envelopeDocs = require("../envelopeDocs");
const audit = require("../audit");
const { LEVEL_LADDER, MAIL_DOMAIN } = require("../domain/refData");
const rbac = require("../domain/rbac");

const ACTIONS = { submit: "submit", send: "send", "send-back": "send_back", answer: "answer", withdraw: "withdraw", comment: "comment" };
const SHAPEABLE = ["draft", "submitted", "returned"];      // the chain can still change
const { HttpError } = routingSvc;

/** One person as the coordinator typed them; throws a 422 on anything unusable. */
function cleanPerson(p, what, opts) {
  const o = opts || {};
  const name = String((p && p.name) || "").trim();
  if (!name) throw new HttpError(422, `${what}: a name is required.`);
  const email = people.normEmail(p.email);
  if (email && !people.isCompanyMailbox(email)) throw new HttpError(422, `${what} ${name}: ${email} is not a ${MAIL_DOMAIN} mailbox.`);
  if (o.emailRequired && !email) throw new HttpError(422, `${what} ${name}: an email address is required.`);
  const out = { name, email: email || null };
  if (o.group) out.group = p.group ? String(p.group).trim() : null;
  if (o.level) {
    if (p.level && (!LEVEL_LADDER.includes(p.level) || p.level === "BOARD")) throw new HttpError(422, `${what} ${name}: ${p.level} is not an approval level.`);
    out.level = p.level || null;
    out.group = p.group ? String(p.group).trim() : null;
  }
  if (p.why) out.why = String(p.why).trim();
  return out;
}

module.exports = function routingRoutes({ repos }) {
  const r = express.Router();
  const nowIso = () => new Date().toISOString();

  const load = async (req, res) => {
    const afe = await repos.afes.get(req.params.id);
    if (!afe) { res.status(404).json({ error: "no such AFE" }); return null; }
    return afe;
  };
  const view = (afe, req, opts) => afeView(repos, afe, req.ctx, opts);
  const failed = (res, e) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    throw e;
  };

  // ---- the chain as it stands ----------------------------------------------------------
  r.get("/afes/:id/routing/preview", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req);
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });
    if (afe.routingId && !SHAPEABLE.includes(afe.state)) {
      return res.json(Object.assign({ frozen: true }, await repos.routings.get(afe.routingId)));
    }
    res.json(await routingSvc.preview(repos, afe));
  });

  // ---- the form itself ------------------------------------------------------------------
  // The PDF the approvers sign, generated on demand from the AFE and the chain. Before send
  // it is the live preview the Review step embeds; after send it is re-rendered from the
  // frozen routing, so `?hash=1` can prove the bytes still match what the envelope recorded.
  r.get("/afes/:id/form.pdf", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req, { full: true });
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });
    const routing = v.routing || v.routingPreview || await routingSvc.preview(repos, afe);
    const stamped = req.query.stamped === "1" && v.envelope && v.envelope.status === "completed";

    // The ETag is derived from what the form is MADE of, not from the bytes it renders to.
    //
    // It used to be the render's own hash, which is exact but means a revalidation costs a full
    // PDF every time — and the wizard embeds this in an iframe, so that was on the path of every
    // step (R92). Everything the render reads moves one of these: the AFE's own version and
    // updatedAt cover its fields, its documents and the write-back of the AFE number; the
    // routing's cover who signs and the exceptions frozen onto it; `stamped` is the caller's own
    // choice. Weak, because it is a statement about the inputs rather than the output.
    const etag = `W/"${[
      afe.id, afe.version === undefined ? "" : afe.version, afe.updatedAt || "",
      routing ? `${routing.id || "preview"}:${routing.version === undefined ? "" : routing.version}:${routing.updatedAt || ""}` : "-",
      stamped ? "s" : "u",
    ].join("|")}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    let out;
    // The validation goes in so the form can print the Exceptions block: a red flag somebody
    // accepted, and the reason they gave (R69). It is the same validation the screen shows.
    try { out = await renderAfeForm(afe, routing, { stamped, validation: v.validation }); }
    catch (e) { return res.status(500).json({ error: `the form could not be produced: ${e.message}` }); }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="AFE_${String(afe.id)}.pdf"`);
    res.send(out.bytes);
  });

  // ---- the file the approvers actually get (R112, R115) ---------------------------------------
  // `form.pdf` is the FORM. This is the DOCUMENT: the form with every attachment bound in behind
  // it, which is what goes to DocuSign and therefore the only honest thing to show on a screen
  // titled "this is what they sign".
  //
  // It was `form.pdf` there, so the review screen showed the form alone and its Documents table
  // said "Attached to this AFE" about a quote that was about to be bound in — a preview that
  // contradicted both the panel beside it and the file that would be sent. Reported on
  // 2026-09-21 as "the attached vendor quote was not appended", which is exactly what it looked
  // like.
  //
  // Before sending, this is assembled by the SAME function the send uses, so a preview cannot
  // diverge from the thing itself. After sending it stops previewing and serves the stored
  // bytes, because by then the answer is not "what would we build" but "what did they get".
  r.get("/afes/:id/packet.pdf", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req, { full: true });
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });

    const sent = (afe.documents || []).filter((d) => d.role === "sent_packet").pop();
    const routing = v.routing || v.routingPreview || await routingSvc.preview(repos, afe);
    const etag = `W/"${[
      afe.id, afe.version === undefined ? "" : afe.version, afe.updatedAt || "",
      sent ? `sent:${sent.attachmentId}` : (routing ? `${routing.id || "preview"}:${routing.version === undefined ? "" : routing.version}` : "-"),
    ].join("|")}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    let bytes;
    if (sent) {
      bytes = await repos.attachmentStore.get(sent.attachmentId);
      if (!bytes) return res.status(404).json({ error: "the file that was sent is no longer in the store" });
    } else {
      try { bytes = (await envelopeDocs.assemblePacket(repos, afe, routing, { validation: v.validation })).packetBytes; }
      catch (e) { return res.status(500).json({ error: `the document could not be assembled: ${e.message}` }); }
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="AFE_${String(afe.id)}.pdf"`);
    res.send(bytes);
  });

  /**
   * THE document for this AFE, whatever stage it is at (R156).
   *
   * "Many of the PDF versions for the same AFE, mostly missing the appended documents. The AFE
   * form is always the same PDF that everyone involved views until signed by all approvers. The
   * only change comes at FA review where red lines are added and more documents appended. Post-FA
   * finalisation the document remains untampered" (Shashank, 2026-09-22).
   *
   * Measured, one signed AFE had THREE: `packet.pdf` served the sent packet (attachments, no
   * signatures), `form.pdf?stamped=1` served the form alone (signatures, no attachments) and the
   * FA judge screen showed that one — so the judgment was formed on a document with no vendor
   * quote in it — and the real signed set was reachable only as a row in a list.
   *
   * There is one answer per stage and this resolves it. Everything a person clicks points here;
   * `form.pdf` stays for the hash and for `verify`, and no screen links it.
   */
  r.get("/afes/:id/document.pdf", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req, { full: true });
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });

    const stored = envelopeDocs.storedDocument(afe, v.envelope, v.resume);

    const routing = stored ? null : (v.routing || v.routingPreview || await routingSvc.preview(repos, afe));
    const etag = `W/"${[
      afe.id, afe.version === undefined ? "" : afe.version, afe.updatedAt || "",
      stored ? `doc:${stored.attachmentId}` : `live:${routing ? `${routing.id || "preview"}:${routing.version === undefined ? "" : routing.version}` : "-"}`,
    ].join("|")}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "private, max-age=0, must-revalidate");
    if (req.headers["if-none-match"] === etag) return res.status(304).end();

    let bytes;
    let filename;
    if (stored) {
      bytes = await repos.attachmentStore.get(stored.attachmentId);
      if (!bytes) return res.status(404).json({ error: `the bytes for ${stored.filename} are no longer in the store` });
      filename = stored.filename;
    } else {
      // Nothing sent yet, so the document does not exist until it is asked for. It is assembled
      // by the SAME function the send uses, so a preview cannot diverge from the thing itself.
      try { bytes = (await envelopeDocs.assemblePacket(repos, afe, routing, { validation: v.validation })).packetBytes; }
      catch (e) { return res.status(500).json({ error: `the document could not be assembled: ${e.message}` }); }
      filename = `AFE_${String(afe.id)}.pdf`;
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${String(filename).replace(/"/g, "")}"`);
    res.send(bytes);
  });

  // The same model the PDF prints, as JSON — the Review step's on-screen sheet and the
  // coordinator's "who prints where" both read this rather than re-deriving it.
  r.get("/afes/:id/form.json", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req, { full: true });
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });
    const routing = v.routing || v.routingPreview || await routingSvc.preview(repos, afe);
    const model = buildFormModel(afe, routing);
    delete model.approvals.anchors;                         // a Map; the PDF's concern, not the screen's
    res.json(model);
  });

  // Does the form still hash to what the envelope recorded at send? (architecture §8)
  r.get("/afes/:id/form/verify", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req, { full: true });
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });
    if (!v.routing || !v.envelope) return res.json({ checked: false, ok: null, reason: "this AFE has not been sent" });
    res.json(await envelopeDocs.verifyFormHash(afe, v.routing, v.envelope));
  });

  // ---- the coordinator shapes it -------------------------------------------------------
  // Pre-approvers beyond the rules, additional signers ("a second A2"), copies, a rule left
  // out of this one AFE with a reason, and the note approvers read. Stored as facts on the
  // AFE; the chain itself stays derived until send.
  r.put("/afes/:id/routing/recipients", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req);
    if (!v.permissions.canEditRouting) return res.status(403).json({ error: "only the coordinator shapes the chain (or the requester, when the division has no coordinator)" });
    if (!SHAPEABLE.includes(afe.state)) return res.status(409).json({ error: `the chain is frozen once sent (state ${afe.state})` });
    const b = req.body || {};
    try {
      const before = JSON.parse(JSON.stringify({ routingEdits: afe.routingEdits || {}, ccRecipients: afe.ccRecipients || [], approverNote: afe.approverNote || "" }));
      const edits = Object.assign({ preApprovers: [], additional: [], suppressedRules: [], emails: {}, ruleChoice: {} }, afe.routingEdits || {});
      if (b.preApprovers !== undefined) edits.preApprovers = (b.preApprovers || []).map((p) => cleanPerson(p, "pre-approver", { group: true }));
      if (b.additional !== undefined) edits.additional = (b.additional || []).map((p) => cleanPerson(p, "additional signer", { level: true }));
      if (b.suppressedRules !== undefined) {
        edits.suppressedRules = (b.suppressedRules || []).map((s) => {
          if (!s || !s.ruleId || !String(s.reason || "").trim()) throw new HttpError(422, "leaving a rule out needs its ruleId and a reason");
          return { ruleId: String(s.ruleId), reason: String(s.reason).trim() };
        });
      }
      // Which of a rule's named people signs it, where the rule offers a choice (the $1M
      // technical accounting review is either of two). An index into the rule's own pool, so
      // nobody can name somebody the rule does not.
      if (b.ruleChoice !== undefined) {
        const out = {};
        for (const [ruleId, idx] of Object.entries(b.ruleChoice || {})) {
          const n = Number(idx);
          if (!Number.isInteger(n) || n < 0 || n > 9) throw new HttpError(422, `ruleChoice.${ruleId} must be the index of one of that rule's people`);
          out[String(ruleId)] = n;
        }
        edits.ruleChoice = out;
      }
      if (b.cc !== undefined) afe.ccRecipients = (b.cc || []).map((p) => cleanPerson(p, "copy recipient", { emailRequired: true }));
      if (b.approverNote !== undefined) afe.approverNote = String(b.approverNote || "").trim();
      afe.routingEdits = edits;
      afe.updatedAt = nowIso();
      await repos.afes.update(afe.id, afe);
      await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "routing_edited",
        payload: { from: before, to: { routingEdits: afe.routingEdits, ccRecipients: afe.ccRecipients, approverNote: afe.approverNote } } });
      res.json({ afe, routing: await routingSvc.preview(repos, afe) });
    } catch (e) { failed(res, e); }
  });

  // ---- mailboxes are confirmed before anything is sent (R60) --------------------------------
  r.post("/afes/:id/routing/confirm-emails", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req);
    if (!v.permissions.canEditRouting) return res.status(403).json({ error: "only the coordinator confirms mailboxes (or the requester, when the division has no coordinator)" });
    if (!SHAPEABLE.includes(afe.state)) return res.status(409).json({ error: `the chain is frozen once sent (state ${afe.state})` });
    const confirmations = Array.isArray(req.body && req.body.confirmations) ? req.body.confirmations : null;
    if (!confirmations || !confirmations.length) return res.status(422).json({ error: "confirmations: [{recipientId | name, email?}] is required" });
    try {
      res.json(await routingSvc.confirmEmails(repos, req.ctx, afe, confirmations));
    } catch (e) { failed(res, e); }
  });

  // ---- lifecycle, requester and coordinator side ------------------------------------------------
  r.post("/afes/:id/:action(submit|send|send-back|answer|withdraw|comment)", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const result = await stateMachine.applyTransition(repos, req.ctx, afe, ACTIONS[req.params.action], req.body || {});
    if (!result.ok) return res.status(result.status).json({ error: result.error, detail: result.detail || null, state: result.state || afe.state });
    res.json(Object.assign({ note: result.note }, await view(afe, req, { full: true })));
  });

  // ---- the coordinator's queue: aggregation first ---------------------------------------------
  r.get("/coordinator/queue", async (req, res) => {
    const isCoord = rbac.can(req.ctx, "afe.coordinate");
    const isAdmin = rbac.isAdmin(req.ctx);
    if (!isCoord) return res.status(403).json({ error: "coordinators only" });
    const divisions = req.ctx.coordinatorFor || [];
    const me = req.ctx.user.email;
    // Only what this person reviews (R157): the badge counts the same thing, and a coordinator's
    // own AFE is with the assigned coordinator — it is on their Requests page, as the requester.
    const mine = (a) => coordination.coordinates(req.ctx, a) || (isAdmin && !divisions.length);
    const rows = await repos.afes.all((a) => mine(a) && a.state !== "withdrawn");
    const now = nowIso();
    const groups = { toSend: [], drafts: [], inApproval: [], onHold: [], returned: [], withFa: [], issued: [], rejected: [] };
    for (const a of rows) {
      const brief = afeBrief(a);
      if (["in_approval", "on_hold"].includes(a.state) && a.routingId) {
        const rt = await repos.routings.get(a.routingId);
        const h = rt ? rt.recipients.find((x) => x.status === "sent") : null;
        brief.waitingOn = h ? { recipientId: h.id, name: h.name, level: h.level, role: h.role, since: h.notifiedAt,
          days: reminders.daysWaiting(h, now), reminders: (h.remindedAt || []).length } : null;
        brief.progress = rt ? { signed: rt.recipients.filter((x) => x.status === "signed").length,
          of: rt.recipients.filter((x) => x.role !== "cc" && x.order !== null).length } : null;
      }
      if (a.state === "returned") brief.returnedTo = a.returnedTo || null;
      // For what is still to send, the queue says the ONE thing standing between it and Send.
      if (["submitted", "draft", "returned"].includes(a.state)) {
        const pv = await routingSvc.preview(repos, a);
        const val = (await view(a, req)).validation;
        brief.readiness = {
          canSend: pv.canSend && val.sendable, signers: pv.recipients.filter((x) => x.role !== "cc" && x.order !== null).length,
          needsEmail: pv.needsEmail.length, blocks: val.blocks.length, pending: val.pending.length,
          blockers: pv.blockers.map((b) => ({ code: b.code, message: b.message })),
          sodExcluded: pv.sod.excluded.map((x) => ({ name: x.name, standIn: x.standIn ? (pv.recipients.find((r) => r.id === x.standIn) || {}).name || null : null })),
        };
      }
      switch (a.state) {
        case "submitted": groups.toSend.push(brief); break;
        case "draft": if (a.preparer && a.preparer.email === me) groups.drafts.push(brief); break;
        case "in_approval": groups.inApproval.push(brief); break;
        case "on_hold": groups.onHold.push(brief); break;
        case "returned": groups.returned.push(brief); break;
        case "approved": case "fa_review": groups.withFa.push(brief); break;
        case "issued": case "tracking": groups.issued.push(brief); break;
        case "rejected": groups.rejected.push(brief); break;
        default: break;
      }
    }
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const counts = {};
    for (const k of Object.keys(groups)) counts[k] = groups[k].length;
    res.json({ divisions, counts, groups });
  });

  return r;
};
