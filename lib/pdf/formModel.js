"use strict";
// What the form prints: one plain object, derived from the AFE and its routing.
//
// Pure — no repos, no clock beyond what is passed in. Keeping it separate from the renderer
// means the values can be asserted in a test without producing a PDF, and the same model
// feeds the Review step's on-screen summary later.
//
// The one piece of real work here is assigning people to the form's fixed rows: the AFE Form
// sheet has four Project Approvals rows and fourteen Financial Approvals rows, and a person
// named at two levels signs once (R45) while an extra finance partner the coordinator added
// signs on the band row they were labelled with (R43).
const afeRules = require("../domain/afeRules");
const fx = require("../domain/fx");
const cloudTree = require("../domain/cloudTree");
const layout = require("./afeFormLayout");
const extra = require("./extraPages");
const financials = require("../domain/financials");
const { LEVEL_TITLES, CURRENCY, FINANCIALS, SUPPORTING_ROLES } = require("../domain/refData");
const notify = require("../notify");

// How an attachment's role reads on the Documents page. The requester chose the role; this is
// the same word in the language the PR and PO teams use.
const DOC_ROLE_LABEL = {
  quote: "Vendor quote", sow: "Statement of work", backup: "Supporting",
  // R150. Sixteen characters at most: the Documents page's column clips anything longer.
  internal_quote: "Acme quote", material_evidence: "SAP material",
  email_approval: "Email approval", budget_evidence: "Budget (KO22)",
  afe_form_pdf: "The AFE form", sent_packet: "The AFE, as sent for signature",
  envelope_pdf: "Signed set", certificate: "DocuSign certificate",
  issued_pack: "Issued AFE",
};
// Attached by a person in support of the request, before it was sent: `refData.SUPPORTING_ROLES`,
// the one list. Stable for the life of the AFE, which is what lets the form's hash keep its
// promise. The two R150 roles changed no AFE already signed, because none could carry them.
// Added by Fixed Assets after the signatures. Only ever printed on the issued copy.
const POST_APPROVAL_ROLES = ["budget_evidence", "email_approval"];

/** Bytes as a person reads them: KB below a megabyte, so a 218-byte file is not "0.00 MB". */
function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

const LIVE = ["pending", "sent", "signed"];
const money = (n) => {
  const v = afeRules.toNum(n);
  if (v === null) return "";
  return (v < 0 ? "-" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
const dash = (n) => (afeRules.toNum(n) ? money(n) : "-");
/** Handed in at all — "" counts, because a cleared field is an answer. */
const given = (v) => v !== undefined && v !== null;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** The template's own date format: 1-Sep-26. */
function formDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`;
}
/**
 * A moment as the people who act on it read it: India Standard Time, which has no daylight
 * saving, so it is a fixed offset rather than a time-zone database the pack's bytes would then
 * depend on. Everyone who approves an issue works in India, and the reminder job runs on the same
 * clock (`WEBSITE_TIME_ZONE`). Returns { day: "14-Oct-26", long: "14 Oct 2026, 09:12 IST" }.
 */
function istStamp(iso) {
  const t = Date.parse(iso || "");
  if (!Number.isFinite(t)) return { day: "", long: "" };
  const d = new Date(t + 330 * 60000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  return {
    day: `${d.getUTCDate()}-${MONTHS[d.getUTCMonth()]}-${String(d.getUTCFullYear()).slice(2)}`,
    long: `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hm} IST`,
  };
}
const check =(value, options) => options.map((o) => ({ label: o.label || o.value, on: value !== null && value !== undefined && String(value) === o.value }));

/**
 * Put every live signer on a row of the printed form.
 *
 * Pre-approvers, charge-to owners and signers with no approval level go in the Project
 * Approvals block; matrix, additional and override signers go on the band row for their
 * level. Where the form repeats a level (A2 appears in two bands, A4 and A6 likewise) the
 * first free row for that level is used — what a person filling this in by hand does.
 * Anyone left over prints in an overflow block rather than silently losing their signature.
 */
function assignRows(routing) {
  const recipients = ((routing && routing.recipients) || []).filter((r) => r.role !== "cc");
  const signers = recipients.filter((r) => LIVE.includes(r.status)).sort((a, b) => (a.order || 0) - (b.order || 0));

  const projectRows = Array.from({ length: layout.PROJECT_APPROVAL_ROWS }, () => null);
  const financialRows = layout.FINANCIAL_ROWS.map((row) => Object.assign({}, row, { recipient: null, note: null }));
  const controllership = [];
  const overflow = [];
  let anchorIndex = 0;
  const anchors = new Map();                       // recipient id -> { n, sig, date }

  for (const rec of signers) {
    anchorIndex += 1;
    anchors.set(rec.id, { n: anchorIndex, sig: layout.ANCHOR.sig(anchorIndex), date: layout.ANCHOR.date(anchorIndex) });

    if (rec.role === "controllership") { controllership.push(rec); continue; }

    const pa = /^project_approvals_(\d)$/.exec(rec.printRow || "");
    if (pa) {
      const i = Number(pa[1]) - 1;
      if (i >= 0 && i < projectRows.length && !projectRows[i]) { projectRows[i] = rec; continue; }
    }
    if (rec.level) {
      const row = financialRows.find((r) => r.level === rec.level && !r.recipient);
      if (row) { row.recipient = rec; continue; }
    }
    const free = projectRows.findIndex((r) => !r);
    if (!pa && !rec.level && free >= 0) { projectRows[free] = rec; continue; }
    overflow.push(rec);
  }

  // Someone who does not sign still explains themselves on their row, so the form says why
  // a level is not signed rather than leaving a silent gap.
  for (const rec of recipients.filter((r) => !LIVE.includes(r.status))) {
    if (!rec.level) continue;
    const row = financialRows.find((r) => r.level === rec.level && !r.recipient && !r.note);
    if (!row) continue;
    if (rec.status === "skipped") {
      const at = recipients.find((x) => x.id === rec.signsAs);
      row.note = `${rec.name} — signs at ${at && at.level ? at.level : "a higher row"}`;
    } else if (rec.status === "sod_blocked") {
      const standIn = recipients.find((x) => x.standInFor === rec.id);
      row.note = `${rec.name} — cannot sign (party to this AFE)${standIn ? `; ${standIn.name} stands in at ${standIn.level}` : ""}`;
    } else if (rec.status === "blank") {
      row.note = "not named in the SAP approver matrix";
    } else if (rec.status === "external") {
      row.note = `${rec.name} — approves outside DocuSign`;
    }
  }

  const seat = (rec) => (rec ? {
    id: rec.id, name: rec.name || "", group: rec.group || null, level: rec.level || null,
    role: rec.role, status: rec.status, why: rec.why || "",
    signedAt: rec.signedAt || null,
    anchor: anchors.get(rec.id) || null,
  } : null);

  return {
    projectApprovals: projectRows.map(seat),
    financialApprovals: financialRows.map((r) => ({ band: r.band, bandSpan: r.bandSpan || 1, role: r.role, level: r.level, seat: seat(r.recipient), note: r.note })),
    controllership: controllership.map(seat),
    overflow: overflow.map(seat),
    anchorCount: anchorIndex,
    anchors,
  };
}

/**
 * @param {object} afe
 * @param {object} routing   the frozen chain, or the preview before send
 * @param {object} [opts]    { validation } for the Exceptions block (R69),
 *                           { issued } for the Fixed Assets block on the issued copy (R71),
 *                           { documentsMerged } ids of attachments bound into this PDF,
 *                           { documentsDrawn } the one attachment printed on page one
 */
/**
 * The financial case as the printed pages read it (R94), or null when there is nothing in it.
 *
 * Computed here rather than passed in, so a form rendered from an AFE alone — which is what the
 * hash check does — carries the same figures as the screen.
 */
function financialsOf(a) {
  return financials.fromAfe(a, FINANCIALS);
}

/** A local amount the way the template's `#,##0` cells print it, or the bare dash. */
const lcCell = (usd, rate) => { const n = fx.toLocal(usd, rate); return n ? n.toLocaleString("en-US") : "-"; };

function buildFormModel(afe, routing, opts) {
  const a = afe || {};
  // The currency is read from the ROUTING, never the live AFE (R161). Before send that is the
  // preview, which reads the AFE; after send it is what was frozen, so a page re-rendered for the
  // hash check prints the rate it was signed at. A routing with no `fx` is a US-dollar AFE.
  const rate = (routing && routing.basis && routing.basis.fx) || null;
  const project = a.project || {};
  const schedule = a.schedule || {};
  const m = a.money || {};
  const budget = a.budget || {};
  const rows = assignRows(routing);
  const total = afeRules.total(a);
  const lines = (m.lines || []).filter((l) => l && (l.site || l.country || afeRules.toNum(l.amountUsd) !== null));
  const cloud = cloudTree.evaluate(a.cloud || {});
  const supplemental = a.kind === "supplemental";
  const classification = (a.money && a.money.classification) || null;
  const CLASS_LABEL = { capex: "CapEx", cloud_capex: "Cloud CapEx (CCA)", none: "No capital spend", opex_only: "OpEx only" };

  return {
    meta: {
      afeId: a.id || null,
      state: a.state || null,
      round: a.round || 1,
      currency: CURRENCY,
      requester: a.requester ? a.requester.name : null,
      division: a.division || null,
      region: a.region || null,
      generatedFor: routing && routing.id ? routing.id : null,
      bandLabel: afeRules.bandFor(a).label,
    },
    header: {
      // The AFE number IS the SAP internal order, generated at KO01 and written back by
      // Fixed Assets. It prints blank on the form nobody has keyed yet — never typed here.
      afeNo: a.afeNo || "",
      costCenter: a.costCenter ? String(a.costCenter) : "",
      projectType: project.projectType || "",
      preparedBy: (a.preparer && a.preparer.name) || (a.requester && a.requester.name) || "",
      startDate: formDate(schedule.startDate),
      finishDate: formDate(schedule.finishDate),
      location: a.location || "",
      projectCode: a.projectCode || "",
      title: project.title || "",
      description: project.description || "",
    },
    money: {
      totalUsd: money(total),
      roi: project.roiPct === undefined || project.roiPct === null ? "" : `${project.roiPct}%`,
      paybackYears: project.paybackYears === undefined || project.paybackYears === null ? "" : String(project.paybackYears),
      // A US-dollar AFE prints exactly what it always printed: an empty rate and a dash in every
      // local cell. Those two blanks draw differently (an empty accounting value pads its dash
      // further in than a literal one), so they are kept as they were, byte for byte.
      fxRate: rate ? fx.rateText(rate.localPerUsd) : "",
      capexUsd: dash(m.capexUsd), opexUsd: dash(m.opexUsd), cloudCapexUsd: dash(m.cloudCapexUsd),
      capexLc: rate ? lcCell(m.capexUsd, rate) : "-", opexLc: rate ? lcCell(m.opexUsd, rate) : "-", cloudCapexLc: rate ? lcCell(m.cloudCapexUsd, rate) : "-",
      // The Financial Summary's Total row sits directly under Materials, Labor, Other and, with
      // one cost row on the sheet, sums to the same figures. It was left empty until 2026-09-14,
      // which printed a dash under a real number and is the first thing a reader's eye lands on
      // — the "looks unfinished" Shashank raised at 27:05.
      totalCapexUsd: dash(m.capexUsd), totalOpexUsd: dash(m.opexUsd), totalCloudCapexUsd: dash(m.cloudCapexUsd),
      totalCapexLc: rate ? lcCell(m.capexUsd, rate) : "-", totalOpexLc: rate ? lcCell(m.opexUsd, rate) : "-", totalCloudCapexLc: rate ? lcCell(m.cloudCapexUsd, rate) : "-",
      classificationNote: classification ? `Classified as ${CLASS_LABEL[classification] || classification}` +
        (cloud.fpaReviewRequired ? " · FP&A Business Partner review required" : "") : "",
      laborUsd: dash(m.laborUsd),
    },
    budget: {
      budgetedCheck: check(budget.budgeted, [{ value: "Yes" }, { value: "No" }]),
      capexUsd: budget.budgeted === "Yes" ? dash(m.capexUsd) : "",
      opexUsd: budget.budgeted === "Yes" ? dash(m.opexUsd) : "",
      cloudCapexUsd: budget.budgeted === "Yes" ? dash(m.cloudCapexUsd) : "",
      additionUsd: budget.budgeted === "No" ? money(total) : "",
      // "Other" in the requester's words (R167) — only an AFE that chose it prints differently, so
      // every AFE already signed renders exactly as it did.
      potNote: (budget.potId === "other" || !budget.potId) && String(budget.otherBudget || "").trim()
        ? `Other: ${String(budget.otherBudget).trim()}${schedule.fiscalYear ? ` · FY${schedule.fiscalYear}` : ""}${a.region ? ` · ${a.region}` : ""}`
        : budget.budgetCategory || budget.potId
          ? `${budget.budgetCategory || "Budget"}${schedule.fiscalYear ? ` · FY${schedule.fiscalYear}` : ""}${a.region ? ` · ${a.region}` : ""}` : "",
      unbudgetedNote: budget.budgeted === "No" && budget.unbudgetedReason ? `Unbudgeted: ${budget.unbudgetedReason}` : "",
    },
    supplemental: {
      check: check(supplemental ? "Yes" : (a.kind ? "No" : null), [{ value: "Yes" }, { value: "No" }]),
      originalUsd: supplemental ? money(afeRules.toNum(a.supplementalOf && a.supplementalOf.approvedTotalUsd)) : money(total),
      amountUsd: supplemental ? money(total) : "",
      note: supplemental && a.supplementalOf && a.supplementalOf.ioNumber ? `Tops up internal order ${a.supplementalOf.ioNumber}` : "",
    },
    assist: { check: check(project.assistAsset, [{ value: "Yes" }, { value: "No" }]) },
    approvals: rows,
    details: {
      description: project.description || "",
      scope: project.scope || "",
      justification: project.justification || "",
      alternatives: project.alternatives || "",
      ehsImpact: project.ehsImpact || "",
      newEquipment: project.newEquipment || "",
      buyVsLease: project.buyVsLease || "",
      surplusChecked: project.surplusChecked || "",
      // The 925 surplus row is printed only when the AFE buys something physical, for the same
      // reason the wizard stops asking: the surplus store holds equipment, not subscriptions.
      surplusApplies: afeRules.surplusCheckApplies(a),
      // Printed only when the equipment comes from Acme's own inventory (R150), so the page of
      // every AFE that buys from a vendor is exactly the page it always was.
      fromInventory: afeRules.sourcingOf(a) === "internal",
      sourcing: afeRules.sourcingOf(a) === "internal" ? "Acme's own inventory" : "",
      // Page 1 has a rate box and local columns but no cell for WHICH currency, so it is said here —
      // and only on an AFE in another currency, so a US-dollar AFE's page is the page it always was.
      hasLocalCurrency: Boolean(rate),
      localCurrency: rate ? `${rate.currency} · ${fx.rateLine(rate)}. The approved figure is USD.` : "",
      finishDate: formDate(schedule.finishDate),
    },
    // A flag somebody accepted, and why.
    //
    // Once the AFE has been sent these come from the FROZEN routing, not from validation run
    // today: they were printed on the page the approvers signed, and the form's hash has to
    // keep reproducing that page. Before send there is no frozen copy, so the live validation
    // feeds the preview — which is the point of the preview.
    exceptions: ((routing && routing.basis && routing.basis.exceptions)
      || (opts && opts.validation ? afeRules.exceptions(opts.validation) : []))
      .map((e) => ({ label: e.label, note: e.note, by: e.by, at: formDate(String(e.at || "").slice(0, 10)) })),
    lines: {
      any: lines.length > 0,
      rows: lines.map((l) => ({ site: l.site || "", country: l.country || "", description: l.description || "", amountUsd: money(l.amountUsd) })),
      totalUsd: money(afeRules.lineTotal(a)),
    },
    // The financial case (R94). Two things travel: the computed model, which the pages print,
    // and the rows a person actually typed, because a total says nothing about what it is made
    // of and the sheet's own detail lines are what an approver reads.
    financials: financialsOf(a),
    financialsInput: (a.financials) || null,
    cloud: {
      // R95 — the Cloud CapEx questionnaire prints on any AFE carrying capital, not only when
      // the tree has been triggered. The Excel prints the sheet on every AFE; this matches it
      // without printing it on a request that is purely operating spend, where it would be four
      // questions about nothing.
      print: cloudTree.isTriggered(a) || afeRules.toNum(a.money && a.money.capexUsd) > 0
        || afeRules.toNum(a.money && a.money.cloudCapexUsd) > 0,
      triggered: cloudTree.isTriggered(a),
      answers: a.cloud || {},
      outcome: cloud.outcome,
      fpaReviewRequired: cloud.fpaReviewRequired,
      questions: extra.CLOUD_PAGE.questions.map((q) => ({
        n: q.n, q: q.q, options: check((a.cloud || {})[q.id], q.options),
      })),
    },
    // WHAT THE APPROVERS WERE GIVEN — and nothing that arrived afterwards.
    //
    // An AFE keeps accumulating documents after it is signed: the generated form itself, the
    // signed set, the DocuSign certificate, an email approval Fixed Assets attaches to clear
    // drift, the issued pack. Listing those on the form would mean a form re-rendered next
    // month no longer matches the one that was signed — and the form hash exists precisely to
    // promise that it does. So the signed page lists only what a person attached in support of
    // the request; the issued copy adds the two Fixed Assets contribute, because by then the
    // page is a different document with a different purpose and no hash riding on it.
    documents: (a.documents || [])
      .filter((d) => SUPPORTING_ROLES.includes(d.role)
        || (opts && opts.issued && POST_APPROVAL_ROLES.includes(d.role)))
      .map((d) => ({
        filename: d.filename, role: d.role, vendor: d.vendor || "",
        amountUsd: d.amountUsd ? money(d.amountUsd) : "",
        roleLabel: DOC_ROLE_LABEL[d.role] || d.role || "attachment",
        sizeBytes: d.sizeBytes || 0,
        size: fileSize(d.sizeBytes),
        merged: Boolean(opts && (opts.documentsMerged || []).includes(d.attachmentId)),
        drawn: Boolean(opts && opts.documentsDrawn && opts.documentsDrawn === d.attachmentId),
        attachmentId: d.attachmentId,
      })),
    // Only present on the issued copy, where it fills the space Fixed Assets writes into by
    // hand today (R71).
    issued: (opts && opts.issued) ? {
      ioNumber: opts.issued.ioNumber || "",
      aucNumber: opts.issued.aucNumber || "",
      plant: opts.issued.plant || a.plant || "",
      // Written on by hand today, in red, at the same moment as the AuC number (R104).
      // A value handed in wins, blank included — the preview of a field somebody just cleared must
      // come out blank rather than fall back to what was saved (R166). `null` means "not given".
      profitCentre: given(opts.issued.profitCentre) ? String(opts.issued.profitCentre) : (a.fa && a.fa.profitCentre) || "",
      budgetLoaded: opts.issued.budgetLoadedUsd !== undefined && opts.issued.budgetLoadedUsd !== null
        ? money(opts.issued.budgetLoadedUsd)
        : (a.fa && a.fa.budgetLoadedUsd !== undefined && a.fa.budgetLoadedUsd !== null ? money(a.fa.budgetLoadedUsd) : ""),
      note: given(opts.issued.note) ? String(opts.issued.note) : (a.fa && a.fa.issuedNote) || "",
      // The rate Fixed Assets keyed SAP at, when they set one (R161) — theirs, printed with the note.
      fxText: opts.issued.fx && opts.issued.fx.localPerUsd
        ? `rate for SAP 1 USD = ${fx.rateText(opts.issued.fx.localPerUsd)} ${opts.issued.fx.currency}` : "",
      orderType: opts.issued.orderType || "",
      issuedAt: formDate((opts.issued.issuedAt || "").slice(0, 10)),
      approvedBy: opts.issued.approvedBy || "",
      // Who approved the issue, by name, at the head of the note strip (R168) — "the finance
      // signature" Lyndsay asked for, the person and not the RTR_FA mailbox. The page of its own
      // behind the index carries the rest.
      approvalText: opts.issued.approval && opts.issued.approval.byName
        ? `approved for issue by ${opts.issued.approval.byName}${opts.issued.approval.group ? ` (${opts.issued.approval.group})` : ""}`
          + `${opts.issued.approval.at ? `, ${istStamp(opts.issued.approval.at).day}` : ""}`
        : "",
      // The address of the AFE itself, so a reader holding only this PDF can reach the documents
      // it could not bind in (Judithmelanie, 55:31 — "they can click on the link and they can respond").
      // Only on the issued copy: the signed form's bytes are hashed, and a hash that moves when
      // an environment setting changes is a hash that proves nothing.
      link: notify.link(`/afe/${a.id}`),
    } : null,
    levelTitles: LEVEL_TITLES,
  };
}

module.exports = { buildFormModel, assignRows, formDate, istStamp, money, fileSize, DOC_ROLE_LABEL };
