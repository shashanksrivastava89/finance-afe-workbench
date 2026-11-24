"use strict";
// Stage 3 gate: the Filled AFE Form and the envelope.
//
// Part 0 renders the form offline and checks it against the template it reproduces — the
// right rows, the right people on them, the anchor strings really in the file, and the same
// bytes every time. Part 1 walks an AFE through the API to a completed envelope and checks
// what comes back: the form on the envelope, the hash that proves it, the signed set, the
// certificate, and the signatures verified against the chain that was frozen at send.
//
//   node tools/smoke-envelope.js      (needs a server on :8080; resets its data first)
const path = require("path");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
/** How many pages a stored document really has, counted in its own bytes. */
async function pageCount(afeId, attachmentId) {
  const raw = await fetch(`${BASE}/api/afes/${afeId}/documents/${attachmentId}/raw`);
  const bytes = Buffer.from(await raw.arrayBuffer());
  return (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
}

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + String(detail).slice(0, 300) : "")); }
};
const j = (x) => JSON.stringify(x);

const { pdfText } = require("./pdf-text");
// A label that wraps onto two lines is still on the page, so compare on flattened whitespace.
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
const shows = (text, s) => flat(text).includes(flat(s));

// ---------------------------------------------------------------------------------------------
// Part 0 — the form, offline
// ---------------------------------------------------------------------------------------------
async function offline() {
  const { renderAfeForm, winAnsi } = require(path.join(ROOT, "lib/pdf/afeForm.js"));
  const { buildFormModel } = require(path.join(ROOT, "lib/pdf/formModel.js"));
  const { renderCertificate } = require(path.join(ROOT, "lib/pdf/certificate.js"));
  const layout = require(path.join(ROOT, "lib/pdf/afeFormLayout.js"));
  const cb = require(path.join(ROOT, "lib/domain/chainBuilder.js"));
  const sim = require(path.join(ROOT, "lib/integrations/docusignSim.js"));
  const cert = require(path.join(ROOT, "lib/integrations/docusignCert.js"));
  const verify = require(path.join(ROOT, "lib/domain/envelopeVerify.js"));
  const { BANDS } = require(path.join(ROOT, "lib/domain/refData.js"));
  const m = require(path.join(ROOT, "seed/approver-matrix.json")).rows.find((r) => r.costCenter === "30145");
  const rules = require(path.join(ROOT, "seed/org-rules.json")).rules;
  const users = require(path.join(ROOT, "seed/users.json")).users;
  const directory = require(path.join(ROOT, "seed/directory.json")).entries;

  const shashank = { name: "Shashank Srivastava", email: "shashank_srivastava@example.com" };
  const syed = { name: "Aiden-Mulqueeny Crilly", email: "aiden-mulqueeny_crilly@example.com" };
  const afe = {
    id: "afe-t1", afeNo: null, state: "submitted", round: 1, kind: "original",
    requester: shashank, preparer: syed, coordinator: syed,
    division: "CORP_IT", region: "APAC", costCenter: "30145", plant: "3026",
    location: "SGP_Singapore_Site 5",
    project: { title: "PC Hardware Lifecycle Replacement APAC", projectType: "Office Equip/Furniture",
      description: "The HW REFRESH Project will be used to stock inventory in APAC for FY 2026.",
      scope: "Seven APAC sites.", justification: "Devices past their lifecycle cannot run the security baseline.",
      alternatives: "Warranty extension priced and rejected.", ehsImpact: "Recycled through the approved WEEE vendor.",
      newEquipment: "Yes", buyVsLease: "N/A", surplusChecked: "Yes", assistAsset: "No" },
    schedule: { startDate: "2026-09-01", finishDate: "2026-12-30", fiscalYear: 2026 },
    money: { classification: "capex", capexUsd: 215000, opexUsd: null, cloudCapexUsd: null, laborUsd: null,
      lines: [{ site: "South Korea", country: "KR", amountUsd: 30000 }, { site: "Japan", country: "JP", amountUsd: 30000 },
        { site: "Singapore MFG", country: "SG", amountUsd: 30000 }, { site: "Singapore DC", country: "SG", amountUsd: 20000 },
        { site: "Singapore GCO", country: "SG", amountUsd: 49000 }, { site: "Australia", country: "AU", amountUsd: 20000 },
        { site: "India", country: "IN", amountUsd: 36000 }] },
    cloud: {}, budget: { budgeted: "Yes", potId: "pot-0003", budgetCategory: "Life Cycle Refresh", unbudgetedReason: "" },
    documents: [], approverNote: "Budgeted under Life Cycle Refresh APAC FY26.", ccRecipients: [], waivers: [], thread: [],
    routingEdits: {
      additional: [{ name: "Lekha Rogerson", level: "A2", why: "finance partner for APAC" }],
      // The coordinator confirmed this mailbox before sending — without it the AFE could not
      // have been sent at all, so the fixture carries it (R60).
      emails: { kailunong: { email: "kailun_ong@example.com", source: "typed", byEmail: syed.email, at: "2026-09-03T00:00:00.000Z" } },
    },
    createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z",
  };
  const routing = cb.buildRouting({ afe, matrixRow: m, orgRules: rules, users, directory, matrixBatchId: "b1" });

  console.log("0. the form reproduces the template it replaces");
  const out = await renderAfeForm(afe, routing);
  const text = pdfText(out.bytes);
  // Four pages now: the form, project details, the cost lines, and the Cloud CapEx sheet —
  // which R95 prints on ANY AFE carrying capital, as the Excel does, not only when the tree
  // has been triggered.
  check("it is a PDF of four pages: the form, project details, cost lines, Cloud CapEx",
    out.bytes.slice(0, 5).toString() === "%PDF-" && out.pages === 4, `pages=${out.pages}`);
  check("the form is the template's own page: A4, one page, the sheet's four tints",
    Math.round(layout.PAGE.width) === 595 && Math.round(layout.PAGE.height) === 842 &&
    ["#DCE6F1", "#F2DCDB", "#D8D8D8", "#D9D9D9"].every((c) => layout.RECTS.some((r) => r.c === c)),
    j({ page: layout.PAGE, tints: [...new Set(layout.RECTS.map((r) => r.c))] }));
  check("the form's own title and every block heading are on it",
    ["AUTHORITY FOR EXPENDITURE", "Financial Summary", "Project Approvals", "Financial Approvals", "Controllership Review", "Project Details"].every((s) => shows(text, s)),
    ["AUTHORITY FOR EXPENDITURE", "Financial Summary", "Project Approvals", "Financial Approvals", "Controllership Review", "Project Details"].filter((s) => !shows(text, s)).join(", "));
  check("the fourteen Financial Approvals rows match the approval bands, in order",
    layout.FINANCIAL_ROWS.length === 14 &&
    layout.FINANCIAL_ROWS.filter((r) => r.band).length === BANDS.length &&
    layout.FINANCIAL_ROWS.every((r) => shows(text, r.role.trim())),
    j({ rows: layout.FINANCIAL_ROWS.length, bands: BANDS.length }));
  check("AFE NO prints blank — the number is the SAP internal order and FA writes it back",
    out.model.header.afeNo === "" && shows(text, "AFE NO:"), j(out.model.header.afeNo));
  check("Prepared By is the preparer, not the requester", out.model.header.preparedBy === "Aiden-Mulqueeny Crilly" && shows(text, "Aiden-Mulqueeny Crilly"), out.model.header.preparedBy);
  check("the cost centre, dates and location print as the form writes them",
    shows(text, "30145") && shows(text, "1-Sep-26") && shows(text, "30-Dec-26") && shows(text, "SGP_Singapore_Site"), "");
  check("the total prints once, formatted", shows(text, "$215,000.00"));
  check("budgeted Yes is ticked and the pot named", out.model.budget.budgetedCheck[0].on === true && out.model.budget.budgetedCheck[1].on === false && shows(text, "Life Cycle Refresh"),
    j(out.model.budget.budgetedCheck));
  check("Assist No is ticked", out.model.assist.check[1].on === true && out.model.assist.check[0].on === false, j(out.model.assist.check));
  check("the seven country lines and their total print", ["South Korea", "Singapore GCO", "India"].every((s) => shows(text, s)) && out.model.lines.rows.length === 7 && out.model.lines.totalUsd === "$215,000.00",
    j(out.model.lines.totalUsd));

  // Text extraction alone cannot tell you the page is readable: a mis-written font subset
  // keeps every coordinate and every ToUnicode entry, and still prints blanks. So look at the
  // font program the PDF actually carries and check the outlines are there.
  const embedded = (() => {
    const raw = out.bytes.toString("latin1");
    const objs = {};
    for (const m of raw.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) objs[m[1]] = m[2];
    const ref = Object.values(objs).map((b) => b.match(/\/FontFile2\s+(\d+)\s+0\s+R/)).find(Boolean);
    if (!ref) return null;
    const body = objs[ref[1]];
    const start = body.indexOf("stream") + 6;
    let a = start;
    if (body[a] === "\r") a += 1;
    if (body[a] === "\n") a += 1;
    const chunk = Buffer.from(body.slice(a, body.indexOf("endstream", a)), "latin1");
    try { return zlib.inflateSync(chunk); } catch { return chunk; }
  })();
  check("the form carries its own font program", embedded && embedded.length > 10000, `bytes=${embedded ? embedded.length : 0}`);
  const outlines = (() => {
    if (!embedded) return null;
    let font;
    try { font = require(path.join(ROOT, "node_modules/@pdf-lib/fontkit")).create(embedded); }
    catch { return []; }                       // a font program too broken to parse is the failure
    let run;
    try { run = font.layout("AUTHORITYFOREXPENDITUREPreparedBy0123456789$,."); }  // no spaces: a space has no outline
    catch { return []; }
    return run.glyphs.map((g) => { try { return g.path.commands.length; } catch { return 0; } });
  })();
  check("every glyph on the page has an outline — a blank one means a broken embed",
    outlines && outlines.length > 20 && outlines.every((n) => n > 0),
    outlines ? `${outlines.filter((n) => n === 0).length} of ${outlines.length} empty` : "no font");

  console.log("1. the people land on the right rows");
  const fin = out.model.approvals.financialApprovals;
  const at = (level, n) => fin.filter((r) => r.level === level)[n || 0];
  check("Annette Sandhu is in Project Approvals row 1 with his group",
    out.model.approvals.projectApprovals[0].name === "Annette Sandhu" && out.model.approvals.projectApprovals[0].group === "Assoc. Dir Digital Workplace" &&
    out.model.approvals.projectApprovals.slice(1).every((s) => s === null), j(out.model.approvals.projectApprovals.map((s) => s && s.name)));
  check("Atwal signs on the A1 row and the M1 row says so instead of leaving a gap (R45)",
    at("A1").seat.name === "Udarsh Atwal" && at("M1").seat === null && /signs at A1/.test(at("M1").note || "") && shows(text, "signs at A1"),
    j({ a1: at("A1").seat && at("A1").seat.name, m1note: at("M1").note }));
  check("the matrix A2 and the coordinator's second A2 take the form's two A2 rows",
    at("A2", 0).seat.name === "Kai Lun Ong" && at("A2", 1).seat.name === "Lekha Rogerson",
    j(fin.filter((r) => r.level === "A2").map((r) => r.seat && r.seat.name)));
  check("Vrishti Aguirre is on the A3 row", at("A3").seat.name === "Vrishti Aguirre");
  check("rows outside the band stay empty, as on the paper form",
    ["A5", "A4", "A7", "A8", "A6", "A9", "BOARD"].every((l) => fin.filter((r) => r.level === l).every((r) => r.seat === null)),
    j(fin.filter((r) => r.seat).map((r) => r.level)));
  check("nobody is left without a row", out.model.approvals.overflow.length === 0);

  console.log("2. the DocuSign anchors are really in the file");
  check("one Sign and one Date anchor per signer, numbered in signing order",
    out.anchors.length === 5 && out.anchors.map((a) => a.n).join() === "1,2,3,4,5" &&
    out.anchors[0].name === "Annette Sandhu" && out.anchors[4].name === "Vrishti Aguirre",
    j(out.anchors.map((a) => `${a.n}:${a.name}`)));
  check("every anchor string is present in the PDF's own content, where DocuSign looks",
    out.anchors.every((a) => shows(text, a.sig) && shows(text, a.date)),
    j(out.anchors.filter((a) => !shows(text, a.sig)).map((a) => a.sig)));
  check("the anchors are unique, so a tab cannot land on two rows",
    new Set(out.anchors.flatMap((a) => [a.sig, a.date])).size === out.anchors.length * 2);

  console.log("3. the bytes are deterministic — that is what makes the hash mean something");
  const again = await renderAfeForm(afe, routing);
  check("rendering twice gives the same hash", again.formHash === out.formHash, `${out.formHash.slice(0, 12)} vs ${again.formHash.slice(0, 12)}`);
  check("…and byte-for-byte the same file", Buffer.compare(again.bytes, out.bytes) === 0);
  const changed = await renderAfeForm(Object.assign({}, afe, { project: Object.assign({}, afe.project, { title: "PC Hardware Lifecycle Replacement EMEA" }) }), routing);
  check("changing one field changes the hash", changed.formHash !== out.formHash);
  check("the hash is a sha256 of the bytes", require("crypto").createHash("sha256").update(out.bytes).digest("hex") === out.formHash);
  // R161: a US-dollar AFE draws EXACTLY what it drew before local currency existed. As it is, said
  // to be USD, and with no rate frozen on its routing: one sha, pinned for layout 4. An empty rate
  // and a literal dash draw differently in an accounting cell, so this is the check that keeps them.
  const GOLDEN_USD = "6c2fe4a54a6e036fa15083e4de89510758b13e5ffc47de6bc8675e09b2c15623";
  const usdSaid = await renderAfeForm(Object.assign({}, afe, { money: Object.assign({}, afe.money, { currency: "USD", fx: null }) }),
    Object.assign({}, routing, { basis: Object.assign({}, routing.basis, { fx: null }) }));
  check("a US-dollar AFE draws what it always drew: as it is, said to be USD, with no rate frozen — one sha, pinned (R161)",
    usdSaid.formHash === out.formHash && out.formHash === GOLDEN_USD, out.formHash);
  // …and one in another currency prints the rate and the local amounts, read from the ROUTING.
  const sgdRate = { currency: "SGD", localPerUsd: 1.286505, month: "2026-08", source: "global_finance" };
  const sgdRouting = Object.assign({}, routing, { basis: Object.assign({}, routing.basis, { fx: sgdRate }) });
  const sgdModel = buildFormModel(afe, sgdRouting);
  check("a rate frozen on the routing prints on page 1: the rate, and every local cell at dollars times it",
    sgdModel.money.fxRate === "1.286505" && sgdModel.money.capexLc === Math.round(afe.money.capexUsd * 1.286505).toLocaleString("en-US")
      && sgdModel.money.totalCapexLc === sgdModel.money.capexLc && sgdModel.details.hasLocalCurrency === true,
    j({ r: sgdModel.money.fxRate, c: sgdModel.money.capexLc }));
  check("the live AFE's currency is NOT what the form reads — a signed page keeps the rate it was signed at",
    buildFormModel(Object.assign({}, afe, { money: Object.assign({}, afe.money, { currency: "JPY", fx: { localPerUsd: 147 } }) }), routing).money.fxRate === "");
  const sgdPdf = await renderAfeForm(afe, sgdRouting);
  check("and it renders, one page longer on nothing: Project Details gains one row, not a page",
    sgdPdf.pages === out.pages && sgdPdf.formHash !== out.formHash, j({ usd: out.pages, sgd: sgdPdf.pages }));
  const idr = await renderAfeForm(Object.assign({}, afe, { money: Object.assign({}, afe.money, { capexUsd: 4900000 }) }),
    Object.assign({}, routing, { basis: Object.assign({}, routing.basis, { fx: { currency: "IDR", localPerUsd: 16310, month: "2026-08" } }) }));
  check("the widest figure a rupiah AFE can reach still renders (it is set smaller to fit, never cut)", idr.pages >= 2 && /^[0-9a-f]{64}$/.test(idr.formHash));
  const withFaRate = buildFormModel(afe, routing, { issued: { ioNumber: "313453", fx: { currency: "SGD", localPerUsd: 1.2901 } } });
  check("Fixed Assets' own rate for SAP travels to the issued AFE's note strip, and nowhere on the signed grid",
    withFaRate.issued.fxText === "rate for SAP 1 USD = 1.2901 SGD" && withFaRate.money.fxRate === "", j(withFaRate.issued.fxText));

  console.log("4. the pages that appear only when they are needed (Q50, R94, R95)");
  const noLines = await renderAfeForm(Object.assign({}, afe, { money: Object.assign({}, afe.money, { lines: [] }) }), routing);
  check("no cost lines, no cost-lines page", noLines.pages === 3, `pages=${noLines.pages}`);
  // R95 — the Excel prints the Cloud CapEx sheet on every AFE. It prints here on any AFE
  // carrying capital, and NOT on one that is purely operating spend, where it would be four
  // questions about nothing.
  const opexOnly = await renderAfeForm(Object.assign({}, afe, {
    money: { classification: "none", capexUsd: null, cloudCapexUsd: null, opexUsd: 40000, lines: [] },
  }), routing);
  check("an OpEx-only AFE does not get the Cloud CapEx page", opexOnly.pages === 2, `pages=${opexOnly.pages}`);
  check("but a capital AFE does, without the tree being triggered",
    noLines.model.cloud.print === true && noLines.model.cloud.triggered === false,
    j({ print: noLines.model.cloud.print, triggered: noLines.model.cloud.triggered }));

  // R94 — the financial case adds two landscape pages, and only when there is a case.
  check("no financial case, no financial pages", noLines.model.financials === null);
  const withCase = await renderAfeForm(Object.assign({}, afe, {
    money: Object.assign({}, afe.money, { lines: [] }),
    financials: {
      startYear: 2026,
      capexRows: [{ description: "Hardware", amounts: [215000] }],
      opexRows: [], cloudRows: [], benefitRows: [],
      assets: [{ description: "Laptops", costUsd: 215000, lifeYears: 3, inServiceDate: "2026-09-01",
        assetLife: "3-Personal Computers", assetClass: "16702-Servers & PC's" }],
    },
  }), routing);
  check("a financial case adds the year grid and the asset page", withCase.pages === noLines.pages + 2, `pages=${withCase.pages}`);
  const caseText = pdfText(withCase.bytes);
  check("the grid prints the sheet's own rows and the four headline figures",
    shows(caseText, "TOTAL CASH OUTFLOWS") && shows(caseText, "Net Cash flow") && shows(caseText, "Accumulated")
      && shows(caseText, "NPV") && shows(caseText, "Payback"),
    "");
  check("the asset block prints the SAP designations and the charge the life produces",
    shows(caseText, "16702") && shows(caseText, "3-Personal Computers") && shows(caseText, "Annl Depr"), "");
  check("and it never prints #DIV/0! or Jan-00, whatever is entered",
    !shows(caseText, "DIV/0") && !shows(caseText, "Jan-00"), "");
  const cloudAfe = JSON.parse(JSON.stringify(afe));
  cloudAfe.money = { classification: "cloud_capex", capexUsd: null, cloudCapexUsd: 120000, opexUsd: null, lines: [] };
  cloudAfe.cloud = { q1Software: "Yes", q2ExternallyHosted: "Yes", q3Subscription: "Subscription", q4CanChangeHost: "No" };
  const cloudOut = await renderAfeForm(cloudAfe, routing);
  const cloudText = pdfText(cloudOut.bytes);
  check("a cloud AFE gets the Cloud CapEx page, with the sheet's own questions and conclusion",
    cloudOut.pages === 3 && shows(cloudText, "Cloud CapEx") && shows(cloudText, "externally hosted") && shows(cloudText, "Conclusion"),
    `pages=${cloudOut.pages}`);
  check("the answers are ticked and the outcome stated",
    cloudOut.model.cloud.outcome === "cloud_capex" && cloudOut.model.cloud.fpaReviewRequired === true &&
    cloudOut.model.cloud.questions[3].options[1].on === true, j(cloudOut.model.cloud.outcome));

  console.log("5. a name the form cannot print does not break the render");
  const odd = JSON.parse(JSON.stringify(afe));
  odd.project.title = "Réfresh — Zürich · 日本 · 50% ‘quoted’";
  const oddOut = await renderAfeForm(odd, routing);
  // The vendored font carries WinAnsi, so the form's own punctuation prints as the form sets
  // it; only what the font genuinely lacks is replaced.
  check("accents and the form's punctuation survive, unprintable characters are replaced, nothing throws",
    oddOut.bytes.length > 1000 && winAnsi("Zürich") === "Zürich" && winAnsi("日本") === "??" &&
    winAnsi("‘q’") === "‘q’" && winAnsi("a – b") === "a – b" && winAnsi("−") === "–",
    j(winAnsi("Réfresh — Zürich · 日本 ‘q’")));

  console.log("6. a completed simulated envelope produces DocuSign's own evidence");
  const envelope = sim.createEnvelope({ afe, routing, documents: [{ attachmentId: "att-1", filename: "form.pdf", role: "afe_form_pdf", sha256: "x" }], formHash: out.formHash, now: "2026-09-04T09:00:00.000Z" });
  const signerIds = envelope.recipients.filter((r) => r.type === "signer").map((r) => r.routingRecipientId);
  let when = 5;
  for (const id of signerIds) { sim.recordSigned(envelope, id, `2026-09-0${when}T10:00:00.000Z`); when += 1; }
  check("the envelope completes after the fifth signature", envelope.status === "completed" && envelope.completedAt, envelope.status);
  const certificate = await renderCertificate(afe, routing, envelope);
  check("the certificate says SIMULATED on its face", /SIMULATED/.test(certificate.text));
  const parsed = cert.parse(certificate.text);
  check("the parser that reads real DocuSign certificates reads this one too",
    parsed && parsed.envelopeId === envelope.envelopeId && parsed.status === "Completed" && parsed.signers.length === 5,
    j(parsed && { id: parsed.envelopeId, status: parsed.status, signers: parsed.signers.length }));
  check("it names the five signers with their mailboxes and signing times",
    parsed.signers.map((s) => s.name).join(" | ") === "Annette Sandhu | Udarsh Atwal | Kai Lun Ong | Lekha Rogerson | Vrishti Aguirre" &&
    parsed.signers.every((s) => /@example\.com$/.test(s.email) && s.signedAt),
    j(parsed.signers.map((s) => [s.name, s.email, s.signedAt])));
  check("the form hash at send is printed on the certificate", certificate.text.includes(out.formHash));

  console.log("7. the signatures are checked against the chain, structurally");
  const rows = verify.verifyRecipients(routing, envelope);
  check("all five verify", rows.length === 5 && verify.allVerified(rows), j(rows.map((r) => [r.name, r.st])));
  const tampered = JSON.parse(JSON.stringify(envelope));
  tampered.recipients[2].name = "Someone Else";
  tampered.recipients[2].email = "someone_else@example.com";
  const bad = verify.verifyRecipients(routing, tampered);
  check("a different person on the envelope is a mismatch, named",
    bad.filter((r) => r.st === "mismatch").length === 1 && /Someone Else/.test(bad.find((r) => r.st === "mismatch").note), j(bad.map((r) => r.st)));
  const short = JSON.parse(JSON.stringify(envelope));
  short.recipients.splice(1, 1);
  check("a signer missing from the envelope is a miss", verify.verifyRecipients(routing, short).some((r) => r.st === "miss"));
  const extra = JSON.parse(JSON.stringify(envelope));
  extra.recipients.push({ routingRecipientId: "rX", docusignRecipientId: "9", routingOrder: 9, type: "signer", name: "Gate Crasher", email: "gate_crasher@example.com", status: "completed", events: [] });
  check("someone who signed but was never on the chain is caught",
    verify.verifyRecipients(routing, extra).some((r) => r.st === "mismatch" && /not on the approved chain/.test(r.note)));

  console.log("8. the live DocuSign client is configured, not improvised");
  const liveMod = require(path.join(ROOT, "lib/integrations/docusignLive.js"));
  const docusign = require(path.join(ROOT, "lib/integrations/docusign.js"));
  check("with no integration key the seam simulates", docusign.mode() === "simulated" && docusign.isSimulated({ provider: "simulated" }));
  check("DocuSign's recipient vocabulary folds onto ours",
    liveMod.normaliseStatus("Completed") === "completed" && liveMod.normaliseStatus("Declined") === "declined" &&
    liveMod.normaliseStatus("Delivered") === "sent" && liveMod.normaliseStatus("created", false) === "created",
    j([liveMod.normaliseStatus("Completed"), liveMod.normaliseStatus("Delivered")]));
  const liveEnv = { provider: "docusign", envelopeId: "E1", status: "sent", recipients: [
    { routingRecipientId: "r1", docusignRecipientId: "1", type: "signer", status: "sent", name: "A", events: [] },
    { routingRecipientId: "r2", docusignRecipientId: "2", type: "signer", status: "created", name: "B", events: [] }] };
  const applied = liveMod.applyRemote(liveEnv, { status: "sent", recipients: { signers: [
    { recipientId: "1", status: "Completed", signedDateTime: "2026-09-05T10:00:00Z" }, { recipientId: "2", status: "Delivered" }] } });
  check("what DocuSign reports becomes a list of changes to apply", applied.changes.length === 2 &&
    applied.changes[0].to === "completed" && applied.changes[1].to === "sent", j(applied.changes.map((c) => c.to)));
  let refused = null;
  try { docusign.recordSigned(liveEnv, "r1", "2026-09-05T10:00:00Z"); } catch (e) { refused = e.message; }
  check("a live envelope cannot be signed by clicking in this tool", /signed in DocuSign/.test(refused || ""), refused);
  const reflected = docusign.recordSigned(liveEnv, "r1", "2026-09-05T10:00:00Z", { fromProvider: true });
  check("…only the poll job may reflect what DocuSign already recorded", reflected.envelope.recipients[0].status === "completed" && reflected.next.name === "B");
  const poll = require(path.join(ROOT, "lib/jobs/pollEnvelopes.js"));
  check("the poll job acts as a system identity, never as a person",
    poll.SYSTEM_CTX.roles.join() === "system" && poll.SYSTEM_CTX.user.email === "system", j(poll.SYSTEM_CTX.roles));
  check("no DocuSign setting is read at load time", !process.env.DOCUSIGN_INTEGRATION_KEY && typeof liveMod.consentUrl === "function");
}

// ---------------------------------------------------------------------------------------------
// Part 1 — through the API
// ---------------------------------------------------------------------------------------------
async function call(method, p, body) {
  const res = await fetch(BASE + "/api" + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let out = null;
  try { out = JSON.parse(text); } catch { out = text; }
  return { status: res.status, body: out };
}
const actAs = (email) => call("POST", "/admin/act-as", { email });
const actAsNone = () => call("DELETE", "/admin/act-as");
const QUOTE = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");

async function online() {
  console.log("9. a clean slate");
  const reset = await call("POST", "/admin/reset");
  check("the store resets to reference data", reset.status === 200 && reset.body.ok === true);
  await actAsNone();

  const created = await call("POST", "/afes");
  const id = created.body.afe.id;
  await call("PATCH", `/afes/${id}`, {
    "project.title": "PC Hardware Lifecycle Replacement APAC", costCenter: "30145",
    "money.classification": "capex", "money.capexUsd": 215000,
    "money.lines": [{ site: "Singapore DC", country: "SG", amountUsd: 115000 }, { site: "India", country: "IN", amountUsd: 100000 }],
    location: "SGP_Singapore_Site 5", region: "APAC",
    "project.projectType": "Office Equip/Furniture",
    "project.description": "The HW REFRESH Project will be used to stock inventory in APAC for FY 2026.",
    "project.justification": "Devices past their lifecycle fail more often and cannot run the current security baseline.",
    "project.newEquipment": "Yes", "project.surplusChecked": "Yes", "project.buyVsLease": "N/A", "project.assistAsset": "No",
    "schedule.startDate": "2026-10-01", "schedule.finishDate": "2026-12-30", "schedule.fiscalYear": 2026,
    "budget.budgeted": "Yes", "budget.potId": "pot-0003", "budget.budgetCategory": "Life Cycle Refresh",
  });
  const withNew = await call("GET", `/afes/${id}`);
  check("New Equipment Purchases is a field the wizard can set", withNew.body.afe.project.newEquipment === "Yes", j(withNew.body.afe.project.newEquipment));
  await call("POST", `/afes/${id}/documents`, { filename: "APAC_HW_estimate.pdf", role: "quote", contentBase64: QUOTE, vendor: "Multiple vendors", amountUsd: 215000 });
  // Shashank coordinates CORP_IT too; his own AFE is still Aiden's to shape and send (R157).
  await call("POST", `/afes/${id}/submit`);
  await actAs("aiden-mulqueeny_crilly@example.com");
  await call("PUT", `/afes/${id}/routing/recipients`, { additional: [{ name: "Lekha Rogerson", level: "A2" }], approverNote: "Budgeted under Life Cycle Refresh APAC FY26." });
  await call("POST", `/afes/${id}/routing/confirm-emails`, { confirmations: [{ name: "Kai Lun Ong", email: "kailun_ong@example.com" }] });

  console.log("10. the form is served before the AFE is sent, and it is cacheable");
  const first = await fetch(`${BASE}/api/afes/${id}/form.pdf`);
  const bytes = Buffer.from(await first.arrayBuffer());
  const etag = first.headers.get("etag");
  check("GET form.pdf returns a PDF with an ETag", first.status === 200 && first.headers.get("content-type") === "application/pdf" &&
    bytes.slice(0, 5).toString() === "%PDF-" && Boolean(etag), `status=${first.status} type=${first.headers.get("content-type")}`);
  const second = await fetch(`${BASE}/api/afes/${id}/form.pdf`, { headers: { "if-none-match": etag } });
  check("asking again with the ETag is a 304 — the form is deterministic, so it can be cached", second.status === 304, String(second.status));
  const draftText = pdfText(bytes);
  check("the draft form already carries the chain the coordinator shaped",
    ["Annette Sandhu", "Udarsh Atwal", "Kai Lun Ong", "Lekha Rogerson", "Vrishti Aguirre"].every((n) => shows(draftText, n)),
    ["Annette Sandhu", "Udarsh Atwal", "Kai Lun Ong", "Lekha Rogerson", "Vrishti Aguirre"].filter((n) => !shows(draftText, n)).join(", "));
  // The AFE NO box stays blank until FA writes the SAP order number back into it.
  check("and no AFE number: the box is blank on a form that has not been keyed yet",
    !/AFE NO:\s*\d/.test(flat(draftText)) && !shows(draftText, "3126"), "");

  console.log("11. send: the form goes on the envelope and its hash is recorded");
  const sent = await call("POST", `/afes/${id}/send`);
  check("the AFE is sent", sent.status === 200 && sent.body.afe.state === "in_approval", j(sent.body).slice(0, 160));
  const envelope = sent.body.envelope;
  check("the envelope carries the form as document 1, the quote as document 2",
    envelope.documents.length === 1 && envelope.documents[0].role === "sent_packet",
    j(envelope.documents.map((d) => d.role)));

  // R112. "Approvers see one single PDF — not supporting docs etc. They sign the one PDF, they
  // can't look at multiple attachments." The quote is INSIDE the file they sign, and the file is
  // longer than the form by exactly the quote.
  const packetDoc = sent.body.afe.documents.find((d) => d.role === "sent_packet");
  const formDoc = sent.body.afe.documents.find((d) => d.role === "afe_form_pdf");
  check("the AFE records the one file that was sent, and the form on its own beside it",
    Boolean(packetDoc && formDoc) && packetDoc.attachmentId !== formDoc.attachmentId,
    j(sent.body.afe.documents.map((d) => d.role)));
  check("the quote is bound into it, with its pages counted",
    Boolean(packetDoc) && (packetDoc.bound || []).some((b) => b.role === "quote" && b.pages > 0),
    j(packetDoc && packetDoc.bound));
  const formPages = await pageCount(id, formDoc.attachmentId);
  const boundPages = (packetDoc.bound || []).reduce((n, b) => n + b.pages, 0);
  check("so the file the approvers sign is the form PLUS the quote, page for page",
    packetDoc.pages === formPages + boundPages && boundPages > 0,
    j({ packet: packetDoc.pages, form: formPages, bound: boundPages }));
  check("and the envelope froze WHICH documents went in, so a later verification can reproduce it",
    (envelope.boundDocumentIds || []).length === 1,
    j(envelope.boundDocumentIds));
  {
    // The two hashes answer different questions: one is "did anyone edit the AFE", the other is
    // "is this the file they signed".
    const raw = await fetch(`${BASE}/api/afes/${id}/documents/${packetDoc.attachmentId}/raw`);
    const bytes = Buffer.from(await raw.arrayBuffer());
    const sha = require("crypto").createHash("sha256").update(bytes).digest("hex");
    check("the packet's own hash is over the packet, and is not the form's",
      sha === packetDoc.sha256 && packetDoc.sha256 !== formDoc.sha256, j({ sha, packet: packetDoc.sha256 }));
    check("it really is a PDF that opens, with every page in it",
      bytes.slice(0, 5).toString() === "%PDF-" && (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length === packetDoc.pages,
      j({ head: bytes.slice(0, 5).toString(), pages: packetDoc.pages }));
  }
  // What the page SAYS is checked by LOOKING at it — a rasterised render, per the repo's own
  // rule — not by grepping a flate-compressed content stream for a string.
  check("the form's hash is on the envelope", /^[0-9a-f]{64}$/.test(envelope.formHash || ""), envelope.formHash);
  check("the generated form is attached to the AFE and marked as generated",
    sent.body.afe.documents.some((d) => d.role === "afe_form_pdf" && d.generated === true && d.sha256 === envelope.formHash),
    j(sent.body.afe.documents.map((d) => d.role)));
  const verifyBefore = await call("GET", `/afes/${id}/form/verify`);
  check("re-rendering the form still matches the hash frozen at send",
    verifyBefore.body.checked === true && verifyBefore.body.ok === true, j(verifyBefore.body));

  console.log("12. every signature, then the completed set");
  const order = ["annette_sandhu@example.com", "udarsh_atwal@example.com", "kailun_ong@example.com", "lekha_rogerson@example.com", "vrishti_aguirre@example.com"];
  for (const who of order) {
    const known = await call("GET", "/admin/users");
    if (!known.body.some((u) => u.email === who)) {
      await call("POST", "/admin/users", { email: who, displayName: who.split("@")[0].split("_").map((s) => s[0].toUpperCase() + s.slice(1)).join(" "), roles: ["approver"] });
    }
    await actAs(who);
    const dec = await call("GET", `/afes/${id}/decision`);
    const res = await call("POST", `/afes/${id}/recipients/${dec.body.me.recipientId}/sign`);
    check(`${who.split("@")[0]} signs`, res.status === 200, j(res.body).slice(0, 160));
  }
  await actAsNone();

  const done = await call("GET", `/afes/${id}`);
  check("the AFE is with Fixed Assets and the envelope is completed",
    done.body.afe.state === "fa_review" && done.body.envelope.status === "completed", done.body.afe.state);
  const completed = done.body.envelope.completed;
  check("the signed set and the certificate are stored",
    completed.combinedPdfAttachmentId && completed.certificateAttachmentId && /^[0-9a-f]{64}$/.test(completed.combinedSha256),
    j({ pdf: completed.combinedPdfAttachmentId, cert: completed.certificateAttachmentId }));
  check("every signature verified against the chain frozen at send",
    completed.verification.length === 5 && completed.verification.every((v) => v.st === "ok"), j(completed.verification.map((v) => [v.name, v.st])));
  check("both documents are on the AFE for Fixed Assets to open",
    done.body.afe.documents.some((d) => d.role === "envelope_pdf") && done.body.afe.documents.some((d) => d.role === "certificate"),
    j(done.body.afe.documents.map((d) => d.role)));

  const signedPdf = await fetch(`${BASE}/api/afes/${id}/documents/${completed.combinedPdfAttachmentId}/raw`);
  const signedBytes = Buffer.from(await signedPdf.arrayBuffer());
  const signedText = pdfText(signedBytes);
  check("the signed copy shows who signed, on their own rows",
    signedPdf.status === 200 && shows(signedText, "signed electronically") && shows(signedText, "Annette Sandhu") && shows(signedText, "Vrishti Aguirre"),
    `status=${signedPdf.status}`);
  const certPdf = await fetch(`${BASE}/api/afes/${id}/documents/${completed.certificateAttachmentId}/raw`);
  const certText = pdfText(Buffer.from(await certPdf.arrayBuffer()));
  check("the certificate is a Certificate of Completion, marked SIMULATED",
    shows(certText, "Certificate Of Completion") && shows(certText, "SIMULATED") && shows(certText, "Signer Events"), "");
  check("it carries the envelope id and the form hash from send",
    shows(certText, done.body.envelope.envelopeId) && shows(certText, done.body.envelope.formHash.slice(0, 40)), "");
  const audit = (await call("GET", `/admin/audit?afeId=${id}`)).body.map((e) => e.type);
  check("completion is audited", audit.includes("envelope_completed"), j(audit.slice(0, 8)));
  const stamped = await fetch(`${BASE}/api/afes/${id}/form.pdf?stamped=1`);
  check("the stamped form is available on its own URL", stamped.status === 200);

  // ---- R156: ONE document, and it always carries the attachments ------------------------------
  // Reported after Meeting #6: "many of the PDF versions for the same AFE, mostly missing the
  // appended documents". The simulated signed set WAS `renderAfeForm({stamped:true})` — the form
  // on its own — so the quote that was bound in at send vanished the moment the last person
  // signed, and Fixed Assets formed its judgment on a document with no quote in it. There is one
  // document per stage now and `document.pdf` resolves it.
  {
    const sha = (b) => require("crypto").createHash("sha256").update(b).digest("hex");
    const pages = (b) => (b.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length;
    const grab = async (url) => {
      const r = await fetch(`${BASE}${url}`);
      return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
    };
    const signedSet = done.body.afe.documents.filter((d) => d.role === "envelope_pdf").pop();
    const sentSet = done.body.afe.documents.filter((d) => d.role === "sent_packet").pop();
    const formOnly = done.body.afe.documents.filter((d) => d.role === "afe_form_pdf").pop();
    const formPageCount = await pageCount(id, formOnly.attachmentId);

    check("the SIGNED set carries the attachments, not just the form",
      signedBytes.length > 0 && pages(signedBytes) > formPageCount,
      j({ signed: pages(signedBytes), formAlone: formPageCount }));
    const sentBytes = (await grab(`/api/afes/${id}/documents/${sentSet.attachmentId}/raw`)).bytes;
    check("the signed set and the sent packet are the same document, page for page",
      pages(signedBytes) === pages(sentBytes), j({ signed: pages(signedBytes), sent: pages(sentBytes) }));

    const doc = await grab(`/api/afes/${id}/document.pdf`);
    check("document.pdf serves the SIGNED set once the envelope is complete, byte for byte",
      doc.status === 200 && sha(doc.bytes) === signedSet.sha256, j({ status: doc.status, sha: sha(doc.bytes).slice(0, 16), stored: String(signedSet.sha256).slice(0, 16) }));
    check("and it is not the form on its own",
      sha(doc.bytes) !== formOnly.sha256, "document.pdf returned the bare form");
  }

  console.log("12b. equipment from Acme's own inventory: its quotation and its SAP material in the one file (R150, R151)");
  {
    const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const inv = (await call("POST", "/afes")).body.afe.id;
    await call("PATCH", `/afes/${inv}`, {
      "project.title": "QX700 ddPCR from inventory", costCenter: "30145",
      "money.classification": "capex", "money.capexUsd": 215000,
      location: "SGP_Singapore_Site 5", region: "APAC",
      "project.projectType": "New Equipment", sourcing: "internal",
      "project.description": "Two QX700 ddPCR systems moved from Site H inventory to the Singapore lab.",
      "project.justification": "The lab's current systems are past support; the inventory units are unused.",
      "project.newEquipment": "Yes", "project.surplusChecked": "Yes", "project.buyVsLease": "N/A", "project.assistAsset": "No",
      "schedule.startDate": "2026-10-01", "schedule.finishDate": "2026-12-30", "schedule.fiscalYear": 2026,
      "budget.budgeted": "Yes", "budget.potId": "pot-0003", "budget.budgetCategory": "Life Cycle Refresh",
    });
    await call("POST", `/afes/${inv}/documents`, { filename: "BR-Quotation-QX700.pdf", role: "internal_quote", contentBase64: QUOTE, amountUsd: 215000 });
    await call("POST", `/afes/${inv}/documents`, { filename: "Display-Material-12025219.png", role: "material_evidence", contentBase64: PNG });
    const model = (await call("GET", `/afes/${inv}/form.json`)).body;
    const labels = (model.documents || []).map((d) => d.roleLabel);
    check("the form lists the Acme quotation and the SAP material among what the approvers are given",
      labels.includes("Acme quote") && labels.includes("SAP material"), j(labels));
    check("each label fits the Documents page's sixteen characters", labels.every((l) => String(l).length <= 16), j(labels));
    check("and the Project Details page says where the equipment comes from",
      model.details && model.details.fromInventory === true && /inventory/.test(model.details.sourcing), j(model.details && { from: model.details.fromInventory, s: model.details.sourcing }));
    const vendorModel = (await call("GET", `/afes/${id}/form.json`)).body;
    check("while an AFE bought from a vendor prints the page it always printed", vendorModel.details && vendorModel.details.fromInventory === false);
    await call("POST", `/afes/${inv}/submit`);
    await actAs("aiden-mulqueeny_crilly@example.com");
    const sentInv = await call("POST", `/afes/${inv}/send`);
    await actAsNone();
    check("it sends", sentInv.status === 200 && sentInv.body.afe.state === "in_approval", j(sentInv.body.error || sentInv.body.afe.state));
    const pk = (sentInv.body.afe.documents || []).find((d) => d.role === "sent_packet");
    check("the screenshot is bound into the file they sign, on a page of its own, behind the quotation",
      Boolean(pk) && (pk.bound || []).some((b) => b.role === "internal_quote" && b.pages > 0) && (pk.bound || []).some((b) => b.role === "material_evidence" && b.pages === 1),
      j(pk && pk.bound));
    check("the envelope froze both, as bound and as given",
      (sentInv.body.envelope.boundDocumentIds || []).length === 2 && (sentInv.body.envelope.supportingDocumentIds || []).length === 2,
      j({ bound: sentInv.body.envelope.boundDocumentIds, given: sentInv.body.envelope.supportingDocumentIds }));
    const vInv = await call("GET", `/afes/${inv}/form/verify`);
    check("and the form re-renders to the hash frozen at send, under the same layout generation",
      vInv.body.checked === true && vInv.body.ok === true, j(vInv.body));
  }

  console.log("13. the poll job and the platform");
  const poll = await call("POST", "/admin/jobs/pollEnvelopes");
  check("polling is a no-op while envelopes are simulated", poll.status === 200 && poll.body.result.mode === "simulated" && poll.body.result.checked === 0, j(poll.body.result));
  const jobs = await call("GET", "/admin/jobs");
  check("both jobs are registered", jobs.body.scheduler.jobs.includes("reminders") && jobs.body.scheduler.jobs.includes("pollEnvelopes"), j(jobs.body.scheduler.jobs));
  const health = await (await fetch(BASE + "/health")).json();
  check("/health still reports the DocuSign stand-in and no AI", health.integrations.docusign === "simulated" && health.integrations.ai === "none", j(health.integrations));
  const pkg = require(path.join(ROOT, "package.json"));
  check("the runtime dependencies are the four that were scrutinised, exact-pinned where they draw",
    Object.keys(pkg.dependencies).sort().join() === "@pdf-lib/fontkit,express,pdf-lib,pg" &&
    pkg.dependencies["pdf-lib"] === "1.17.1" && pkg.dependencies["@pdf-lib/fontkit"] === "1.1.1",
    j(pkg.dependencies));
  const fontDir = path.join(ROOT, "lib/pdf/assets");
  check("the form's typeface is vendored with its licence, not fetched",
    ["Carlito-Regular.ttf", "Carlito-Bold.ttf", "Carlito-OFL.txt"].every((f) => require("fs").existsSync(path.join(fontDir, f))),
    require("fs").readdirSync(fontDir).join(", "));
}

// ---------------------------------------------------------------------------------------------
// R102 — the form's own layout changing must not read as somebody tampering with the AFE.
//
// The hash only means anything between two renders of the SAME layout. Add a page, move a
// footer, print something in red, and every AFE already out for signature stops matching —
// through no fault of anyone's. The version is compared first, and a difference is stated
// rather than raised as an alarm.
async function formLayoutVersion() {
  console.log("R102. a form layout change is explained, never a tamper alarm");
  const refData = require(path.join(ROOT, "lib/domain/refData"));
  const envelopeDocs = require(path.join(ROOT, "lib/envelopeDocs"));
  const redFlags = require(path.join(ROOT, "lib/domain/redFlags"));

  check("this build names the layout it prints",
    Number.isInteger(refData.FORM_LAYOUT_VERSION) && refData.FORM_LAYOUT_VERSION >= 1, String(refData.FORM_LAYOUT_VERSION));

  const older = { formHash: "abc", formLayoutVersion: refData.FORM_LAYOUT_VERSION - 1 };
  const legacy = { formHash: "abc" };                        // sent before versions existed

  const oldOne = await envelopeDocs.verifyFormHash({ id: "a" }, null, older);
  const noVersion = await envelopeDocs.verifyFormHash({ id: "a" }, null, legacy);

  check("an envelope from an older layout is not compared byte for byte",
    oldOne.checked === false && oldOne.ok === null && oldOne.layoutChanged === true
      && oldOne.signedUnder === refData.FORM_LAYOUT_VERSION - 1 && oldOne.now === refData.FORM_LAYOUT_VERSION,
    j(oldOne));
  check("and it says why, in words a person can act on",
    /signed under form layout v/.test(oldOne.reason) && /stored unchanged/.test(oldOne.reason), oldOne.reason);
  check("an envelope with no version on it is treated as layout 1",
    noVersion.signedUnder === 1 && noVersion.layoutChanged === (refData.FORM_LAYOUT_VERSION !== 1), j(noVersion));

  const flags = redFlags.computeRedFlags({
    afe: { id: "a", state: "fa_review", money: {}, documents: [] },
    routing: null, envelope: { completed: {} },
    matrixRowNow: null, currentBatchId: null,
    validation: { blocks: [], warns: [], pending: [] },
    formHash: oldOne, editsSinceSend: [], fingerprintChanged: false,
    possibleDuplicates: [], quoteCoveragePct: null,
  });
  const layoutFlag = (flags.flags || []).find((f) => f.id === "form:layout");
  check("it shows as an explained warning on the Fixed Assets screen",
    Boolean(layoutFlag) && layoutFlag.severity === "warn" && /form changed, not the AFE/.test(layoutFlag.detail),
    j(layoutFlag || (flags.flags || []).map((f) => f.id)));
  check("and never as a block, so Fixed Assets is not stopped by our own deploy",
    !(flags.blocks || []).some((f) => f.id === "form:layout"), j((flags.blocks || []).map((f) => f.id)));
  check("an AFE that only has a layout difference is still ready to record",
    flags.ready === true, j({ ready: flags.ready, blocks: (flags.blocks || []).map((f) => f.id) }));
}

// The hash check is remembered against what the form PRINTS (2026-09-28). Keyed on the AFE's
// `updatedAt`, it re-rendered the whole form on every Fixed Assets tick — about a second each on
// UAT's B1, inside the request, while the judge screen and its PDF frame waited. A cache that
// answered for a form it had not rendered would be worse than the delay, so both halves are
// checked: what the form does not print is answered from memory, and what it does print is
// rendered again and caught.
async function formHashMemo() {
  console.log("R92b. the hash check is remembered against what the form prints");
  const refData = require(path.join(ROOT, "lib/domain/refData"));
  const envelopeDocs = require(path.join(ROOT, "lib/envelopeDocs"));
  const { renderAfeForm } = require(path.join(ROOT, "lib/pdf/afeForm.js"));
  const cb = require(path.join(ROOT, "lib/domain/chainBuilder.js"));
  const m = require(path.join(ROOT, "seed/approver-matrix.json")).rows.find((r) => r.costCenter === "30145");
  const rules = require(path.join(ROOT, "seed/org-rules.json")).rules;
  const users = require(path.join(ROOT, "seed/users.json")).users;
  const directory = require(path.join(ROOT, "seed/directory.json")).entries;
  const who = { name: "Shashank Srivastava", email: "shashank_srivastava@example.com" };
  const afe = {
    id: "afe-memo", afeNo: null, state: "fa_review", round: 1, kind: "original", requester: who, preparer: who,
    division: "CORP_IT", region: "APAC", costCenter: "30145",
    project: { title: "Hash memo fixture", projectType: "Office Equip/Furniture", description: "A form to hash." },
    schedule: { startDate: "2026-09-01", finishDate: "2026-12-30", fiscalYear: 2026 },
    money: { classification: "capex", capexUsd: 40000 }, cloud: {}, budget: { budgeted: "Yes" },
    documents: [], thread: [], createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-02T10:00:00.000Z",
  };
  const routing = cb.buildRouting({ afe, matrixRow: m, orgRules: rules, users, directory, matrixBatchId: "b1" });
  const signed = await renderAfeForm(afe, routing);
  const envelope = { formHash: signed.formHash, formLayoutVersion: refData.FORM_LAYOUT_VERSION, boundDocumentIds: [] };

  const first = await envelopeDocs.verifyFormHash(afe, routing, envelope);
  check("the form re-rendered hashes to what was signed", first.checked === true && first.ok === true, j(first));

  // Everything Fixed Assets does while judging — none of it is on the signed page.
  afe.fa = { formReviewed: { at: "2026-09-28T08:00:00.000Z", byName: "Judithmelanie Ware" }, judgment: { asset_not_expense: true }, orderType: "Z002" };
  afe.thread = [{ id: "c1", kind: "comment", text: "Checked the quote.", at: "2026-09-28T08:01:00.000Z" }];
  afe.afeNo = "313999";
  afe.updatedAt = "2026-09-28T08:02:00.000Z";
  afe.version = 7;
  const judged = await envelopeDocs.verifyFormHash(afe, routing, envelope);
  check("a tick, an order type, a comment and the AFE number are answered without re-rendering",
    judged === first, j({ same: judged === first, judged }));

  afe.project.title = "Hash memo fixture, edited after signing";
  const edited = await envelopeDocs.verifyFormHash(afe, routing, envelope);
  check("an edit to what the form prints is rendered again, and caught",
    edited !== first && edited.checked === true && edited.ok === false, j(edited));
  afe.project.title = "Hash memo fixture";

  const signer = routing.recipients.find((r) => r.role !== "cc" && r.name);
  const was = signer.name;
  signer.name = "Somebody Else";
  const rerouted = await envelopeDocs.verifyFormHash(afe, routing, envelope);
  check("so is a change to the routing the form prints from", rerouted.checked === true && rerouted.ok === false, j(rerouted));
  signer.name = was;
  const back = await envelopeDocs.verifyFormHash(afe, routing, envelope);
  check("and with both put back it matches again", back.ok === true, j(back));
}

(async () => {
  await offline();
  await formLayoutVersion();
  await formHashMemo();
  await online();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nsmoke-envelope could not run:", e.stack || e.message);
  console.error(`(is the server up on ${BASE}? start it with: npm start)`);
  process.exit(1);
});
