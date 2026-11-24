"use strict";
// The AFE aggregate: create, autosave, validate, attach, clone.
//
// The wizard PATCHes one field at a time by its dot path and gets back the whole AFE plus
// the validation result, so a single round trip both saves and answers "is this right yet?".
// Nothing derived is stored — see lib/views/afeView.js.
const express = require("express");
const crypto = require("crypto");
const afeRules = require("../domain/afeRules");
const cloudTree = require("../domain/cloudTree");
const people = require("../domain/people");
const fx = require("../domain/fx");
const refData = require("../domain/refData");
const { afeView, afeBrief, routingBrief, sourcingOfAfe } = require("../views/afeView");
const { timelineFor, milestonesFrom } = require("../views/timeline");
const audit = require("../audit");
const rbac = require("../domain/rbac");
const quoteReader = require("../quoteReader");
const ringed = require("../pdf/ringed");

// What may be attached, from refData so a change is business config rather than a deploy.
// The old 10 MB per-file cap was well under the mail channel this replaces: facilities packs
// run to "a PDF over mail with 60 or 65 pages" (Imogen, Meeting #5 16:35), and refusing those
// would have sent them straight back to email.
const { perFileBytes: MAX_FILE_BYTES, perAfeBytes: MAX_AFE_BYTES, maxFiles: MAX_FILES,
  docusignPerDocumentBytes: DOCUSIGN_MAX_BYTES } = refData.ATTACHMENT_LIMITS;
const mb = (n) => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} MB`;
// What a person attaches in support, plus the two Fixed Assets adds after the signatures.
const DOC_ROLES = refData.SUPPORTING_ROLES.concat(["email_approval", "budget_evidence"]);

/**
 * A quote's own date (R169), typed like its vendor and total. A real day, on a document that is a
 * price, and not a day that has not happened yet: a quote dated next month is a typo, and taking
 * it would make an old price look new. Blank clears it. Returns the reason, or null.
 */
function quoteDateProblem(value, role) {
  if (value === undefined || value === null || value === "") return null;
  if (!refData.QUOTE_ROLES.includes(role)) return "only a quote, a SOW or a Acme quotation carries a date";
  if (!afeRules.isDay(String(value))) return `"${String(value).slice(0, 20)}" is not a date — use YYYY-MM-DD`;
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  return String(value) > tomorrow ? `${value} has not happened yet — check the date on the quote` : null;
}

/** What this actually is, by its own first bytes — never by what the filename claims. */
function sniffType(buf) {
  if (buf.slice(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf.length > 8 && buf[0] === 0x89 && buf.slice(1, 4).toString("latin1") === "PNG") return "image/png";
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return "image/jpeg";
  return null;
}

// Paths the wizard and the coordinator may write. Anything else is ignored, so a rogue
// PATCH cannot set `state`, `afeNo`, `routingId` or an audit trail.
const WRITABLE = new Set(
  afeRules.FIELDS.map((f) => f.id).concat([
    "budget.unbudgetedReason", "budget.budgetCategory", "budget.afeCategory",
    "project.newEquipment", "projectCode",     // printed on the form; not rule-bearing
    "cloud.q1Software", "cloud.q2ExternallyHosted", "cloud.q3Subscription", "cloud.q4CanChangeHost",
    "chargeTo.business", "chargeTo.costCenter", "chargeTo.ownerName", "chargeTo.ownerEmail",
    "supplementalOf.ioNumber", "supplementalOf.afeId", "supplementalOf.approvedTotalUsd",
    "approverNote", "requestType",
    // The currency the local amounts are shown in (R161). Only the CODE is writable: the rate is
    // Global Finance's, attached by the server from the master, and never typed.
    "money.currency",
    // The financial case (R94). Each part is written whole, like `money.lines`, because the
    // grid is edited a row at a time in the browser and sent as one.
    "financials.startYear", "financials.capexRows", "financials.opexRows", "financials.cloudRows",
    "financials.benefitRows", "financials.assets", "financials.costCentreRows",
    // The whole case, to REMOVE it (null only): "Set it up" started one with an asset that has no
    // life yet — a block — and the only asset had no ×, so an optional step became a trap.
    "financials",
  ])
);
// The grid lists of the financial case, whose `amounts` must be figures (R162).
const FIN_GRID_PATHS = new Set(["financials.capexRows", "financials.opexRows", "financials.cloudRows", "financials.benefitRows", "financials.costCentreRows"]);
const GRID_NUMBER = /^-?\$?(\d[\d,]*)?(\.\d*)?$/;
/** The first cell in a list of grid rows that is not a figure, quoted — or null when all are. */
function badGridCell(rows) {
  if (rows === null || rows === undefined) return null;
  if (!Array.isArray(rows)) return "The list";
  for (const r of rows) {
    for (const v of (r && Array.isArray(r.amounts) ? r.amounts : [])) {
      if (v === null || v === undefined || v === "" || (typeof v === "number" && Number.isFinite(v))) continue;
      if (typeof v === "string" && GRID_NUMBER.test(v.trim())) continue;
      return `“${String(v).slice(0, 24)}”`;
    }
  }
  return null;
}

// Only the coordinator re-points an AFE at the person it is raised for (R41: Aiden prepares
// on behalf of a project manager). The preparer is never writable — it is who created it.
const COORDINATOR_ONLY = new Set(["requester.name", "requester.email"]);

/**
 * A draft nobody has typed into: created by "New AFE" and never saved since. Every field save
 * bumps `version`, so version 1 with no title and no cost centre is a page somebody opened and
 * left. UAT held "(untitled)" afe-0029 for exactly that reason (2026-10-16).
 */
function untouchedDraft(a) {
  return a.state === "draft" && (a.version || 1) === 1 && a.kind === "original" && !a.supplementalOf
    && !(a.project && a.project.title) && !a.costCenter;
}

function blankAfe(ctx) {
  const now = new Date().toISOString();
  const who = { email: ctx.user.email, name: ctx.userRow.displayName };
  return {
    afeNo: null, state: "draft", round: 1, kind: "original", supplementalOf: null,
    requester: who, preparer: who, coordinator: null,
    division: null, region: null, companyCode: "1000", costCenter: null, plant: null, location: null,
    projectCode: null,                              // the division's own reference, printed on the form
    project: {
      title: "", projectType: null, description: "", scope: "", justification: "",
      alternatives: "", ehsImpact: "", newEquipment: null, buyVsLease: null,
      surplusChecked: null, assistAsset: null,
    },
    schedule: { startDate: null, finishDate: null, fiscalYear: null },
    money: { classification: null, lines: [], capexUsd: null, cloudCapexUsd: null, opexUsd: null, laborUsd: null },
    cloud: { q1Software: null, q2ExternallyHosted: null, q3Subscription: null, q4CanChangeHost: null, outcome: null, fpaReviewRequired: false },
    budget: { budgeted: null, potId: null, budgetCategory: null, afeCategory: null, unbudgetedReason: "" },
    chargeTo: null,
    documents: [], approverNote: "", ccRecipients: [], waivers: [], thread: [],
    // Why a red flag was accepted anyway, one entry per rule. Travels to every approver (R69).
    flagNotes: [],
    // what the coordinator adds to the chain, and the mailboxes confirmed for this AFE (R43, R60)
    routingEdits: { preApprovers: [], additional: [], suppressedRules: [], emails: {} },
    returnedTo: null, hold: null,
    routingId: null, envelopeId: null,
    fa: { receivedAt: null, judgment: {}, driftAck: [], flagAcks: [], orderType: null, issuedAt: null },
    ioNumbers: [],
    createdAt: now, updatedAt: now, submittedAt: null, sentAt: null, approvedAt: null,
  };
}

module.exports = function afeRoutes({ repos }) {
  const r = express.Router();

  const load = async (req, res) => {
    const afe = await repos.afes.get(req.params.id);
    if (!afe) { res.status(404).json({ error: "no such AFE" }); return null; }
    return afe;
  };
  const view = (afe, req, opts) => afeView(repos, afe, req.ctx, opts);

  // The division decides who coordinates the AFE (R41) and which budget pots apply. It is
  // read from data we already hold, so the requester never has to know what "division"
  // means: the recon extract where it covers the cost centre, otherwise the matrix
  // description. No match leaves it null for a human to set.
  async function divisionFor(costCenter, matrixRow) {
    if (!costCenter) return null;
    const row = await repos.tracker.find((t) => String(t.costCenter) === String(costCenter) && t.division);
    if (row) return row.division;
    const desc = matrixRow ? String(matrixRow.description || "") : "";
    const hit = refData.DIVISION_KEYWORDS.find((d) => d.match.test(desc));
    return hit ? hit.division : null;
  }
  async function coordinatorFor(division) {
    if (!division) return null;
    const rule = await repos.orgRules.find(
      (x) => x.kind === "coordinator" && x.active && !x.retiredAt && x.scope && x.scope.division === division
    );
    return rule ? rule.person : null;
  }

  // ---- create ------------------------------------------------------------------
  r.post("/afes", async (req, res) => {
    // "New AFE" pressed again reopens the blank one you already have rather than leaving another
    // "(untitled)" behind — from the requester's side an AFE exists once something is typed.
    const email = String(req.ctx.user.email || "").toLowerCase();
    const blank = await repos.afes.find((a) => untouchedDraft(a) && String((a.requester && a.requester.email) || "").toLowerCase() === email);
    if (blank) return res.status(200).json(await view(blank, req));
    const afe = await repos.afes.insert(blankAfe(req.ctx));
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "afe_created" });
    res.status(201).json(await view(afe, req));
  });

  // ---- list --------------------------------------------------------------------
  r.get("/afes", async (req, res) => {
    const email = req.ctx.user.email;
    const mine = req.query.mine === "1";
    const division = req.query.division ? String(req.query.division) : null;
    const state = req.query.state ? String(req.query.state).split(",") : null;
    // "If I can apply a filter… that can ease out my work" (Imogen, Meeting #6): internal or vendor.
    const sourcing = req.query.sourcing ? String(req.query.sourcing) : null;

    let rows = await repos.afes.all((a) => {
      if (mine && !((a.requester && a.requester.email === email) || (a.preparer && a.preparer.email === email))) return false;
      if (division && a.division !== division) return false;
      if (state && !state.includes(a.state)) return false;
      if (sourcing && sourcingOfAfe(a) !== sourcing) return false;
      // A draft nobody has typed into is not a request yet, and is not listed as one.
      if (untouchedDraft(a)) return false;
      return true;
    });
    // Someone who is neither an owner, FA, leadership nor admin sees only their own.
    const roles = req.ctx.roles;
    const privileged = roles.some((x) => ["fa_preparer", "fa_checker", "leadership", "admin", "coordinator"].includes(x));
    if (!privileged) {
      rows = rows.filter((a) => (a.requester && a.requester.email === email) || (a.preparer && a.preparer.email === email));
    }
    rows.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    // A row in a list says who holds it and how far along it is (design rule 7: identity on
    // every row) — the routing is a cheap get, so the hub does not round-trip per row.
    const out = [];
    for (const a of rows) {
      const brief = afeBrief(a);
      if (a.routingId) brief.routing = routingBrief(await repos.routings.get(a.routingId));
      brief.returnedTo = a.state === "returned" ? a.returnedTo || null : null;
      out.push(brief);
    }
    res.json(out);
  });

  // ---- read --------------------------------------------------------------------
  r.get("/afes/:id", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req, { full: true });
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });
    res.json(v);
  });

  // Everything that has happened to this AFE, from the append-only trail (R129).
  //
  // The trail has always held it — `applyTransition` writes a row for every transition with the
  // from-state, the to-state, the actor and the moment — and the only reader over HTTP was an
  // admin-only feed that filtered every lifecycle event out. Same `canView` as the AFE itself,
  // because the history says no more than the record does.
  r.get("/afes/:id/history", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canView) return res.status(403).json({ error: "not yours to view" });
    const rows = await timelineFor(repos, afe.id, { oldestFirst: true, admin: rbac.isAdmin(req.ctx) });
    res.json({ afeId: afe.id, timeline: rows, milestones: milestonesFrom(rows) });
  });

  r.get("/afes/:id/validate", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req);
    res.json(v.validation);
  });

  // ---- autosave ----------------------------------------------------------------
  // One field per call, by dot path. The response carries the whole AFE and the fresh
  // validation, so the wizard never has to ask twice.
  r.patch("/afes/:id", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canEdit) {
      return res.status(409).json({ error: `an AFE in state "${afe.state}" cannot be edited`, state: afe.state });
    }

    const patch = req.body || {};
    const applied = {}, ignored = [], cleared = [];
    let reassigned = null;
    // A grid cell is a number (R162). `financials.compute` reads nonsense as 0, which is right for
    // a model and wrong for a save: the figure the person typed would vanish from the NPV unsaid.
    if (patch.financials !== undefined && patch.financials !== null) {
      return res.status(422).json({ error: "The financial case is edited part by part; as a whole it can only be removed.", field: "financials" });
    }
    for (const [path, value] of Object.entries(patch)) {
      const bad = FIN_GRID_PATHS.has(path) ? badGridCell(value) : null;
      if (bad) return res.status(422).json({ error: `${bad} is not a number. The grid takes figures only.`, field: path });
    }
    // A currency Global Finance has no rate for is refused BEFORE anything is applied (R161).
    let fxRate = null;
    if (patch["money.currency"] !== undefined) {
      const code = String(patch["money.currency"] || fx.USD).trim().toUpperCase();
      if (code !== fx.USD) {
        fxRate = fx.lookup(await repos.fxRates.all(), code);
        if (!fxRate) {
          return res.status(422).json({ field: "money.currency",
            error: `Global Finance has no rate for ${code} yet. Keep the AFE in US dollars, or upload their monthly workbook in Admin › Master data.` });
        }
      }
    }
    for (const [path, value] of Object.entries(patch)) {
      if (COORDINATOR_ONLY.has(path)) {
        if (!perms.canCoordinate) { ignored.push(path); continue; }
        if (path === "requester.email" && !people.isCompanyMailbox(value)) {
          return res.status(422).json({ error: `${value} is not a ${refData.MAIL_DOMAIN} mailbox — the requester is a Acme employee.` });
        }
      } else if (!WRITABLE.has(path)) { ignored.push(path); continue; }
      const before = afeRules.get(afe, path);
      if (JSON.stringify(before) === JSON.stringify(value)) continue;
      afeRules.set(afe, path, value);
      applied[path] = { from: before === undefined ? null : before, to: value };
    }

    if (Object.keys(applied).length) {
      // Two things the tool works out rather than asking for.
      if (applied.costCenter) {
        const cc = String(afe.costCenter || "");
        const matrixRow = await repos.matrix.find((m) => m.costCenter === cc);
        afe.plant = matrixRow ? matrixRow.plant : null;
        const was = afe.coordinator && afe.coordinator.email;
        afe.division = await divisionFor(cc, matrixRow);
        afe.coordinator = await coordinatorFor(afe.division);
        // A cost centre in another division puts the AFE in another coordinator's review (R157).
        // Said out loud — to whoever typed it, and in the history — because in `submitted` the
        // person typing may have just handed their own review to somebody else.
        const now = afe.coordinator && afe.coordinator.email;
        if (afe.state !== "draft" && people.normEmail(was) !== people.normEmail(now)) {
          reassigned = { division: afe.division || null, coordinatorName: afe.coordinator ? afe.coordinator.name : null };
        }
      }
      // An answer that DEPENDS on one that just changed is cleared, and the reader is told.
      //
      // "When the user goes back a step and changes cost centre and region, the next step still
      // shows the previous pot selected." (Shashank, 2026-09-21). The budget pot is a pointer
      // into a list that the division and the region decide, so changing either can leave it
      // pointing at a pot that is not on offer any more — and it stays SELECTED, which is worse
      // than being wrong, because it looks like a decision somebody made.
      //
      // Only what the change invalidates, and nothing else. Wiping the later answers on any
      // step back would throw away real work to fix a typo; leaving a dangling pointer is how a
      // form gets filed against the wrong pot. Between those two, clearing the one pointer and
      // saying so out loud is the only honest option.
      // "Other" is not a pointer into the pot list but the requester's own words (R167): a new cost
      // centre cannot leave it dangling, so it is never cleared here.
      if ((applied.costCenter || applied.region) && afe.budget && afe.budget.potId && afe.budget.potId !== afeRules.OTHER_POT) {
        const pot = await repos.budgetPots.get(afe.budget.potId);
        const divisionFits = !pot || !pot.division || !afe.division || pot.division === afe.division;
        const regionFits = !pot || !pot.region || !afe.region || afe.region === "Global" || pot.region === afe.region;
        if (!pot || !divisionFits || !regionFits) {
          cleared.push({
            field: "budget.potId", was: afe.budget.potId,
            label: pot ? `${pot.budgetCategory || "the budget"}${pot.region ? " · " + pot.region : ""}` : "the budget it was against",
            because: applied.costCenter ? "the cost centre changed" : "the region changed",
          });
          afe.budget.potId = null;
        }
      }
      // A real pot chosen after "Other" was typed: the words no longer describe the AFE (R167). It
      // is the same answer replaced, like a second chip pressed, so it goes into the history as an
      // edit rather than being announced as something a different field took away.
      if (applied["budget.potId"] && afe.budget.potId !== afeRules.OTHER_POT && afe.budget.otherBudget) {
        applied["budget.otherBudget"] = { from: afe.budget.otherBudget, to: "" };
        afe.budget.otherBudget = "";
      }
      // The rate travels with the currency: picked now, from the newest month, and kept until
      // somebody picks again — an AFE never moves under the person who wrote it.
      if (applied["money.currency"]) {
        const code = String(afe.money.currency || fx.USD).trim().toUpperCase();
        afe.money.currency = code;
        afe.money.fx = code === fx.USD ? null : fx.fxFrom(fxRate);
      }
      if (Object.keys(applied).some((p) => p.startsWith("cloud."))) {
        const r2 = cloudTree.evaluate(afe.cloud || {});
        afe.cloud.outcome = r2.outcome;
        afe.cloud.fpaReviewRequired = r2.fpaReviewRequired;
        if (r2.classification && !afe.money.classification) afe.money.classification = r2.classification;
      }
      afe.updatedAt = new Date().toISOString();
      await repos.afes.update(afe.id, afe);
      await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "afe_edited",
        payload: Object.assign({ applied }, cleared.length ? { cleared } : {}, reassigned ? { reassigned } : {}) });
    }

    const v = await view(afe, req);
    res.json({ afe: v.afe, validation: v.validation, applied: Object.keys(applied), ignored, cleared, reassigned, view: v });
  });

  // ---- documents ---------------------------------------------------------------
  // PDF only, sniffed, capped, de-duplicated by content hash. Bytes go to the attachment
  // store (Postgres bytea); only metadata rides on the AFE.
  r.post("/afes/:id/documents", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    const b = req.body || {};
    const role = DOC_ROLES.includes(b.role) ? b.role : "quote";
    // Fixed Assets attaches evidence — an email approval for matrix drift — while the AFE is
    // theirs to judge; nothing else on the AFE is editable then.
    const evidence = role === "email_approval" && perms.canAttachEvidence;
    // The KO22 budget screenshot Fixed Assets pastes onto the form today — "we put the budget
    // screenshot on the AFE after completion" (Imogen, Meeting #5 60:50). It belongs to Fixed
    // Assets and arrives around the time the order is created, so it is not bound by `canEdit`:
    // by then the AFE is signed and nothing else on it is editable.
    const faEvidence = role === "budget_evidence"
      && rbac.can(req.ctx, "fa.process")
      && ["fa_review", "issued", "tracking"].includes(afe.state);
    if (!perms.canEdit && !evidence && !faEvidence) {
      return res.status(409).json({ error: role === "budget_evidence"
        ? "the budget evidence is attached by Fixed Assets, once the AFE has reached them"
        : `an AFE in state "${afe.state}" cannot be edited` });
    }

    const filename = String(b.filename || "").trim();
    if (!filename) return res.status(422).json({ error: "filename is required" });
    if (!b.contentBase64) return res.status(422).json({ error: "contentBase64 is required" });
    const dateWrong = quoteDateProblem(b.quoteDate, role);
    if (dateWrong) return res.status(422).json({ error: dateWrong, field: "quoteDate" });

    let buf;
    try { buf = Buffer.from(String(b.contentBase64), "base64"); }
    catch { return res.status(422).json({ error: "contentBase64 is not valid base64" }); }
    if (!buf.length) return res.status(422).json({ error: "the file is empty" });
    if (buf.length > MAX_FILE_BYTES) {
      return res.status(413).json({ error: `${filename} is ${mb(buf.length)} — the limit is ${mb(MAX_FILE_BYTES)} per file, `
        + "which is what Outlook carries and what DocuSign accepts as one document." });
    }
    const existing = afe.documents || [];
    if (existing.length >= MAX_FILES) {
      return res.status(413).json({ error: `${MAX_FILES} attachments is the limit on one AFE. Remove something first.` });
    }
    const totalBytes = existing.reduce((n, d) => n + (Number(d.sizeBytes) || 0), 0);
    if (totalBytes + buf.length > MAX_AFE_BYTES) {
      return res.status(413).json({ error: `that would take this AFE to ${mb(totalBytes + buf.length)} of attachments — `
        + `the limit is ${mb(MAX_AFE_BYTES)}.` });
    }
    // A PDF, a PNG or a JPEG, for every role (R151). It used to be PDF only except for the KO22
    // evidence, and asking somebody to turn a screenshot into a PDF before they can upload it is
    // exactly the friction this replaces: a material screenshot from SAP is a screenshot, and so is
    // half of what gets forwarded as a quote. The binder places an image on a page of its own and
    // pdf-lib embeds both formats natively, so the file the approvers sign carries it either way.
    const mimeType = sniffType(buf);
    if (!["application/pdf", "image/png", "image/jpeg"].includes(mimeType)) {
      return res.status(415).json({ error: `${filename} is not a PDF, a PNG or a JPEG. Save it as one of those and attach it again.` });
    }

    const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
    const already = (afe.documents || []).find((d) => d.sha256 === sha256);
    if (already) return res.status(409).json({ error: `${already.filename} is already attached (same file).`, attachmentId: already.attachmentId });

    const meta = await repos.attachmentsMeta.insert({
      afeId: afe.id, filename, role, mimeType,
      sizeBytes: buf.length, sha256, uploadedByEmail: req.ctx.user.email, uploadedAt: new Date().toISOString(),
    });
    await repos.attachmentStore.put(meta.id, buf);

    const doc = {
      attachmentId: meta.id, role, filename, sizeBytes: buf.length, sha256, mimeType,
      vendor: b.vendor || (role === "internal_quote" ? "Acme" : null), amountUsd: afeRules.toNum(b.amountUsd),
      quoteDate: refData.QUOTE_ROLES.includes(role) && afeRules.isDay(String(b.quoteDate || "")) ? String(b.quoteDate) : null,
    };
    for (const f of ["vendor", "amountUsd", "quoteDate"]) if (b[f] !== undefined && b[f] !== null && b[f] !== "") quoteReader.typed(doc, f, req.ctx);
    // A priced document is read in the background while the quote reader is switched on (R170):
    // the answer here does not wait for it, and what comes back is a proposal on the document.
    const wantsRead = quoteReader.readable(doc) && await quoteReader.enabled(repos);
    if (wantsRead && quoteReader.coolingDown()) quoteReader.skip(doc);
    const readFrom = wantsRead && !quoteReader.coolingDown() ? quoteReader.begin(doc, req.ctx) : null;
    afe.documents = (afe.documents || []).concat([doc]);
    afe.updatedAt = new Date().toISOString();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "document_attached",
      payload: { attachmentId: meta.id, filename, role, sizeBytes: buf.length, read: Boolean(readFrom) } });
    if (readFrom) quoteReader.readLater(repos, afe.id, meta.id, readFrom);

    const v = await view(afe, req);
    res.status(201).json({ afe: v.afe, validation: v.validation, attachmentId: meta.id, quoteTotalUsd: v.quoteTotalUsd, resume: v.resume });
  });

  // Vendor, quote total and the quote's date are typed, not read from the file (R62 — no
  // extraction). A reading of the file, where one is switched on, is only ever a proposal a
  // person confirms into these same fields (R170).
  r.patch("/afes/:id/documents/:attachmentId", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canEdit) return res.status(409).json({ error: `an AFE in state "${afe.state}" cannot be edited` });
    const doc = (afe.documents || []).find((d) => d.attachmentId === req.params.attachmentId);
    if (!doc) return res.status(404).json({ error: "no such attachment on this AFE" });
    const b = req.body || {};
    const role = b.role !== undefined && DOC_ROLES.includes(b.role) ? b.role : doc.role;
    const dateWrong = quoteDateProblem(b.quoteDate, role);
    if (dateWrong) return res.status(422).json({ error: dateWrong, field: "quoteDate" });

    const before = { vendor: doc.vendor, amountUsd: doc.amountUsd, role: doc.role, quoteDate: doc.quoteDate || null };
    if (b.vendor !== undefined) doc.vendor = b.vendor || null;
    if (b.amountUsd !== undefined) doc.amountUsd = afeRules.toNum(b.amountUsd);
    if (b.quoteDate !== undefined) doc.quoteDate = b.quoteDate ? String(b.quoteDate) : null;
    doc.role = role;
    // Whatever a person types is theirs, including a change to a figure that was read and used: that
    // is the override, and the provenance and the audit row below both say who made it (R170).
    for (const f of ["vendor", "amountUsd", "quoteDate"]) if ((before[f] || null) !== (doc[f] || null)) quoteReader.typed(doc, f, req.ctx);
    afe.updatedAt = new Date().toISOString();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "document_updated",
      payload: { attachmentId: doc.attachmentId, from: before,
        to: { vendor: doc.vendor, amountUsd: doc.amountUsd, role: doc.role, quoteDate: doc.quoteDate || null } } });
    const v = await view(afe, req);
    res.json({ afe: v.afe, validation: v.validation, quoteTotalUsd: v.quoteTotalUsd, resume: v.resume });
  });

  // ---- the quote reader (R170) -------------------------------------------------------------
  // Read a quote that is already attached — one from before the reader was switched on, or one
  // whose read failed. The same background read as at upload.
  r.post("/afes/:id/documents/:attachmentId/read", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canEdit) return res.status(409).json({ error: `an AFE in state "${afe.state}" cannot be edited` });
    const doc = (afe.documents || []).find((d) => d.attachmentId === req.params.attachmentId);
    if (!doc) return res.status(404).json({ error: "no such attachment on this AFE" });
    if (!quoteReader.readable(doc)) return res.status(422).json({ error: "only a quote, a SOW or a Acme quotation is read" });
    if (!(await quoteReader.enabled(repos))) return res.status(409).json({ error: "the quote reader is switched off here — type the figures" });
    if (doc.reading && doc.reading.status === "reading" && !quoteReader.interrupted(doc.reading)) {
      return res.status(409).json({ error: "it is being read already" });
    }
    const startedAt = quoteReader.begin(doc, req.ctx);
    afe.updatedAt = new Date().toISOString();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "quote_read_asked",
      payload: { attachmentId: doc.attachmentId, filename: doc.filename } });
    quoteReader.readLater(repos, afe.id, doc.attachmentId, startedAt);
    const v = await view(afe, req);
    res.status(202).json({ afe: v.afe, validation: v.validation, quoteTotalUsd: v.quoteTotalUsd, resume: v.resume });
  });

  // A person's decision on what was read: `{ use: true }` makes the proposals the typed figures,
  // marked as read and confirmed by them; `{ use: false }` sets the reading aside. Nothing a model
  // read counts for anything until this has been pressed (non-negotiable #1).
  r.post("/afes/:id/documents/:attachmentId/reading", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canEdit) return res.status(409).json({ error: `an AFE in state "${afe.state}" cannot be edited` });
    const doc = (afe.documents || []).find((d) => d.attachmentId === req.params.attachmentId);
    if (!doc) return res.status(404).json({ error: "no such attachment on this AFE" });
    const use = Boolean(req.body && req.body.use);
    const out = quoteReader.decide(doc, req.ctx, use);
    if (out.error) return res.status(409).json({ error: out.error });
    afe.updatedAt = new Date().toISOString();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: use ? "quote_reading_used" : "quote_reading_set_aside",
      payload: { attachmentId: doc.attachmentId, filename: doc.filename, model: doc.reading.model,
        proposed: quoteReader.summarise(doc.reading.fields), applied: out.applied, skipped: out.skipped } });
    const v = await view(afe, req);
    res.json({ afe: v.afe, validation: v.validation, quoteTotalUsd: v.quoteTotalUsd, resume: v.resume, applied: out.applied, skipped: out.skipped });
  });

  // Show me (design rule 5): the page a proposal was read from, with the box it came from ringed —
  // so a person confirms against the document, not against a number.
  r.get("/afes/:id/documents/:attachmentId/reading/:field/show.pdf", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const v = await view(afe, req, { permissionsOnly: true });
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to view" });
    const doc = (afe.documents || []).find((d) => d.attachmentId === req.params.attachmentId);
    const f = doc && doc.reading && doc.reading.fields && doc.reading.fields[req.params.field];
    if (!f || !f.where) return res.status(404).json({ error: "nothing was read there" });
    const bytes = await repos.attachmentStore.get(doc.attachmentId);
    if (!bytes) return res.status(404).json({ error: "the file is no longer in the store" });
    const shown = req.params.field === "amount"
      ? `${f.currency || "USD"} ${Number(f.value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : String(f.value);
    let out;
    try {
      out = await ringed.ringRead(bytes, doc.mimeType || "application/pdf", f.where,
        `${{ amount: "Total", quoteDate: "Date", vendor: "Vendor" }[req.params.field] || "Read"} ${shown} - read at ${Math.round(f.confidence * 100)}%`);
    } catch (e) {
      return res.status(422).json({ error: `the page could not be drawn: ${String(e.message).slice(0, 120)}` });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `inline; filename="read-${req.params.field}.pdf"`);
    res.send(out);
  });

  r.delete("/afes/:id/documents/:attachmentId", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canEdit) return res.status(409).json({ error: `an AFE in state "${afe.state}" cannot be edited` });
    const doc = (afe.documents || []).find((d) => d.attachmentId === req.params.attachmentId);
    if (!doc) return res.status(404).json({ error: "no such attachment on this AFE" });
    afe.documents = afe.documents.filter((d) => d.attachmentId !== doc.attachmentId);
    afe.updatedAt = new Date().toISOString();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "document_removed",
      payload: { attachmentId: doc.attachmentId, filename: doc.filename } });
    const v = await view(afe, req);
    res.json({ afe: v.afe, validation: v.validation, quoteTotalUsd: v.quoteTotalUsd, resume: v.resume });
  });

  /**
   * Throw a draft away.
   *
   * Only a draft: the moment an AFE is sent it has a frozen chain, a hashed form and possibly
   * signatures, and none of that may be made to disappear — a sent AFE is withdrawn, not
   * deleted. The row goes, its attachment metadata goes with it, and the audit keeps a line
   * saying what was deleted and by whom, so the deletion itself is on the record.
   */
  /**
   * Why a red flag was accepted anyway.
   *
   * "You can add a text box in case of red flag, they can put the comment in case of exceptional
   * thing" (Imogen, Meeting #5 24:26), and Euan's reason for wanting it: "it will be easy for
   * the approval, because once they receive for the approval, then there is an exception around
   * it. So either they need to send it back or start a communication to understand why it is a
   * red flag" (24:46). So the note is not a private annotation — it rides with the flag onto
   * every approver's screen, into the DocuSign message and onto the printed form.
   *
   * Only flags that DO NOT block can be explained: a rule that stops the AFE is fixed, not
   * argued with. `afeRules.checkFlagNote` decides which is which.
   */
  r.put("/afes/:id/flag-notes", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canEdit) return res.status(403).json({ error: "only the requester, the preparer or the coordinator can explain a flag" });

    const ruleId = String((req.body && req.body.ruleId) || "").trim();
    const note = String((req.body && req.body.note) !== undefined ? req.body.note : "").trim();
    const problems = afeRules.checkFlagNote(ruleId, note);
    if (problems.length) return res.status(422).json({ error: problems.join(" "), problems });

    const before = (afe.flagNotes || []).find((n) => n.ruleId === ruleId) || null;
    const rest = (afe.flagNotes || []).filter((n) => n.ruleId !== ruleId);
    // An empty note removes it — the requester changed their mind, or fixed the underlying thing.
    afe.flagNotes = note
      ? rest.concat([{ ruleId, note, by: req.ctx.user.email, byName: req.ctx.userRow.displayName, at: new Date().toISOString() }])
      : rest;
    afe.updatedAt = new Date().toISOString();
    await repos.afes.update(afe.id, afe);
    await audit.record(repos, req.ctx, {
      entity: "afe", entityId: afe.id, type: note ? "flag_note_written" : "flag_note_cleared",
      payload: { ruleId, note: note || null, was: before ? before.note : null },
    });
    res.json(await view(afe, req));
  });

  r.delete("/afes/:id", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    if (afe.state !== "draft") {
      return res.status(409).json({ error: `only a draft can be deleted — this one is "${afe.state}". Withdraw it instead.` });
    }
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canEdit) return res.status(403).json({ error: "only the requester, the preparer or the coordinator can delete this draft" });

    await audit.record(repos, req.ctx, {
      entity: "afe", entityId: afe.id, type: "afe_deleted",
      payload: {
        title: (afe.project && afe.project.title) || null,
        costCenter: afe.costCenter || null,
        documents: (afe.documents || []).length,
        createdAt: afe.createdAt || null,
      },
    });
    for (const doc of afe.documents || []) {
      if (doc.attachmentId && repos.attachmentsMeta && repos.attachmentsMeta.remove) {
        try { await repos.attachmentsMeta.remove(doc.attachmentId); } catch { /* metadata only */ }
      }
    }
    await repos.afes.remove(afe.id);
    res.json({ deleted: afe.id });
  });

  r.get("/afes/:id/documents/:attachmentId/raw", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canView) return res.status(403).json({ error: "not yours to view" });
    const doc = (afe.documents || []).find((d) => d.attachmentId === req.params.attachmentId);
    if (!doc) return res.status(404).json({ error: "no such attachment on this AFE" });
    const bytes = await repos.attachmentStore.get(doc.attachmentId);
    if (!bytes) return res.status(404).json({ error: "the bytes for that attachment are gone" });
    // The stored type, not an assumed one: a budget screenshot served as application/pdf is a
    // file the browser refuses to draw, with nosniff below making sure it cannot recover.
    res.setHeader("Content-Type", doc.mimeType || "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${doc.filename.replace(/"/g, "")}"`);
    res.send(bytes);
  });

  /**
   * The issued pack, by name rather than by attachment id.
   *
   * It is already in `afe.documents` and the raw route above serves it, but that needs an id
   * nobody can guess. This is the address a person can be given — in a mail, in a message, in
   * a ticket — and it always resolves to the latest one, so a rebuilt pack does not leave an
   * old link pointing at a superseded file. Same guard as everything else on the AFE.
   */
  r.get("/afes/:id/issued-pack.pdf", async (req, res) => {
    const afe = await load(req, res); if (!afe) return;
    const perms = (await view(afe, req, { permissionsOnly: true })).permissions;
    if (!perms.canView) return res.status(403).json({ error: "not yours to view" });
    const packs = (afe.documents || []).filter((d) => d.role === "issued_pack");
    const doc = packs[packs.length - 1];
    if (!doc) {
      return res.status(404).json({ error: "there is no issued pack yet — it is built when Fixed Assets records the internal order" });
    }
    const bytes = await repos.attachmentStore.get(doc.attachmentId);
    if (!bytes) return res.status(404).json({ error: "the bytes for the issued pack are gone" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${doc.filename.replace(/"/g, "")}"`);
    res.send(bytes);
  });

  // ---- supplemental (R48) ---------------------------------------------------------
  // A project that has outgrown its approval does not get its AFE edited — the signatures
  // cover what was signed. It gets a new AFE of kind `supplemental`, pointing at the internal
  // order it tops up, and the chain is rebuilt on the NEW CUMULATIVE TOTAL (refData
  // .SUPPLEMENTAL_BASIS, Q39): $600K approved plus $200K more is an $800K decision, so the
  // people who could approve $600K are not enough.
  r.post("/afes/:id/supplemental", async (req, res) => {
    const original = await load(req, res); if (!original) return;
    const v = await view(original, req);
    if (!v.permissions.canView) return res.status(403).json({ error: "not yours to top up" });
    if (!["issued", "tracking", "capitalized"].includes(original.state)) {
      return res.status(409).json({ error: `“${(original.project && original.project.title) || original.id}” is ${original.state.replace(/_/g, " ")} — a supplemental tops up an AFE that already has its internal order. Edit this one instead.`, state: original.state });
    }
    const ioNumber = String((req.body && req.body.ioNumber) || original.afeNo || "").trim();
    if (!ioNumber) return res.status(422).json({ error: "which internal order is being topped up?" });
    const known = (original.ioNumbers || []).includes(ioNumber) || original.afeNo === ioNumber;
    if (!known) return res.status(422).json({ error: `internal order ${ioNumber} is not one of this AFE's orders (${(original.ioNumbers || []).join(", ") || "none recorded"})` });

    const copy = blankAfe(req.ctx);
    copy.kind = "supplemental";
    copy.supplementalOf = { afeId: original.id, ioNumber, approvedTotalUsd: afeRules.total(original),
      title: (original.project && original.project.title) || null };
    copy.costCenter = original.costCenter;
    copy.plant = original.plant;
    copy.division = original.division;
    copy.region = original.region;
    copy.location = original.location;
    copy.companyCode = original.companyCode;
    copy.coordinator = original.coordinator;
    copy.projectCode = original.projectCode;
    copy.project = Object.assign({}, original.project, { title: String((original.project && original.project.title) || "").slice(0, 26) + " (supplemental)" });
    copy.money = { classification: original.money.classification, lines: [], capexUsd: null, cloudCapexUsd: null, opexUsd: null, laborUsd: null };
    copy.cloud = Object.assign({}, original.cloud);
    copy.budget = { budgeted: null, potId: original.budget.potId, budgetCategory: original.budget.budgetCategory,
      afeCategory: original.budget.afeCategory, unbudgetedReason: "", otherBudget: original.budget.otherBudget || "" };
    copy.chargeTo = original.chargeTo;

    const afe = await repos.afes.insert(copy);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "supplemental_raised",
      payload: { of: original.id, ioNumber, originalApprovedUsd: copy.supplementalOf.approvedTotalUsd, basis: refData.SUPPLEMENTAL_BASIS } });
    const created = await view(afe, req, { full: true });
    res.status(201).json(Object.assign({
      note: `topping up internal order ${ioNumber} — the chain is rebuilt on the new cumulative total`,
      original: { id: original.id, title: (original.project && original.project.title) || null, approvedTotalUsd: copy.supplementalOf.approvedTotalUsd },
    }, created));
  });

  // ---- clone for another region -------------------------------------------------
  // One AFE per region is the rule (R56): the same programme becomes three AFEs, so the
  // second and third are a copy with the region-specific facts cleared.
  r.post("/afes/:id/clone", async (req, res) => {
    const source = await load(req, res); if (!source) return;
    const perms = (await view(source, req)).permissions;
    if (!perms.canView) return res.status(403).json({ error: "not yours to copy" });

    const copy = blankAfe(req.ctx);
    copy.project = Object.assign({}, source.project);
    copy.money = Object.assign({}, source.money, { lines: [], capexUsd: null, cloudCapexUsd: null, opexUsd: null });
    copy.cloud = Object.assign({}, source.cloud);
    copy.schedule = Object.assign({}, source.schedule);
    copy.budget = { budgeted: source.budget.budgeted, potId: null, budgetCategory: source.budget.budgetCategory,
      afeCategory: source.budget.afeCategory, unbudgetedReason: source.budget.unbudgetedReason };
    copy.region = req.body && req.body.region ? String(req.body.region) : null;
    copy.clonedFromAfeId = source.id;

    const afe = await repos.afes.insert(copy);
    await audit.record(repos, req.ctx, { entity: "afe", entityId: afe.id, type: "afe_cloned",
      payload: { from: source.id, region: afe.region } });
    res.status(201).json(await view(afe, req));
  });

  return r;
};
