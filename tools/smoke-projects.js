"use strict";
// Stage 6 gate: projects, the SAP extracts, budget moves and supplementals.
//
// Part 0 is the pure half offline — the tolerant table reader (UTF-16, Indian grouping, ALV
// decoration, "* Total" rows), the four extract shapes, the internal-order registry (child
// plans, ± budget moves) and the reconciliation. Part 1 walks the API: an issued AFE with
// three cost lines, a budget extract that gives it real figures, an order master and PO lines,
// a matrix extract that raises drift on an AFE already signed, a third child order paid for
// out of the parent, a budget move, the CSV in Aiden's column order, and a supplemental whose
// chain is rebuilt on the cumulative total. Part 2 starts a second server with INGEST_SECRET
// set and proves the machine door.
//
//   node tools/smoke-projects.js      (needs a server on :8080; resets its data first)
const path = require("path");
const { spawn } = require("child_process");
const ROOT = path.join(__dirname, "..");
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + String(detail).slice(0, 320) : "")); }
};
const j = (x) => JSON.stringify(x);
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");

// ---------------------------------------------------------------------------------------------
// Fixtures — the four extracts, in the shapes SAP actually produces
// ---------------------------------------------------------------------------------------------
const BUDGET_TSV = [
  "Order\tDescription\tBudget\tActual\tCommitment\tAllotted\tAvailable",
  "318801\tPC Hardware Lifecycle Replacement APAC\t30,000.00\t0.00\t0.00\t0.00\t30,000.00",
  "318802\tPC Hardware — Singapore DC\t1,15,000.00\t62,500.00\t18,400.00\t80,900.00\t34,100.00",
  "318803\tPC Hardware — India\t70,000.00\t12,000.00\t0.00\t12,000.00\t58,000.00",
  "*\tTotal\t2,15,000.00\t74,500.00\t18,400.00\t92,900.00\t1,22,100.00",
].join("\r\n");

// The next night's run: India has invoiced another 6,000. Same orders, different figures.
const BUDGET_TSV_V2 = BUDGET_TSV
  .replace("318803	PC Hardware — India	70,000.00	12,000.00	0.00	12,000.00	58,000.00",
    "318803	PC Hardware — India	70,000.00	18,000.00	0.00	18,000.00	52,000.00");

const MASTER_CSV = [
  "Order,Description,Order Type,Company Code,Responsible Cost Center,Plant,Person Responsible,Created On,System Status,Currency",
  "318801,PC HARDWARE LIFECYCLE REPLACEMENT,Z002,1000,0000030145,3026,Shashank Srivastava,04.09.2026,REL,USD",
  "318802,PC HARDWARE - SINGAPORE DC,Z002,1000,0000030145,3026,Shashank Srivastava,04.09.2026,REL,USD",
  "318803,PC HARDWARE - INDIA,Z002,1000,0000030145,3026,Shashank Srivastava,04.09.2026,REL,USD",
].join("\n");

const PO_CSV = [
  "Purchasing Document,Item,Order,Vendor,Short Text,Net Order Value,Invoiced,Still to be Invoiced,Document Date,Currency",
  "4500218831,10,318802,Dell Singapore Pte Ltd,Latitude 5450 x 120,\"48,500.00\",\"48,500.00\",0.00,02.07.2026,USD",
  "4500219102,10,318802,Dell Singapore Pte Ltd,Docking stations x 120,\"14,000.00\",\"14,000.00\",0.00,18.07.2026,USD",
  "4500219477,10,318802,Ingram Micro,Monitors 27in x 60,\"18,400.00\",0.00,\"18,400.00\",08.08.2026,USD",
  "4500219640,10,318803,Redington India,Latitude 5450 x 30,\"12,000.00\",\"12,000.00\",0.00,21.08.2026,USD",
].join("\n");

const QUOTE = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n").toString("base64");
const JUDITHMELANIE = "judithmelanie_ware@example.com", SYED = "aiden-mulqueeny_crilly@example.com", SHASHANK = "shashank_srivastava@example.com";

// ---------------------------------------------------------------------------------------------
// Part 0 — offline
// ---------------------------------------------------------------------------------------------
function offline() {
  const table = require(path.join(ROOT, "lib/ingest/table.js"));
  const ingest = require(path.join(ROOT, "lib/ingest"));
  const reg = require(path.join(ROOT, "lib/domain/ioRegistry.js"));
  const { reconcile } = require(path.join(ROOT, "lib/domain/reconcile.js"));
  const { CSV_COLUMNS } = require(path.join(ROOT, "lib/routes/projects.js"));

  console.log("0. reading what SAP actually drops on us");
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BUDGET_TSV, "utf16le")]);
  check("a UTF-16LE export with a byte-order mark decodes", table.decode(utf16).startsWith("Order\tDescription"));
  check("so does UTF-8 with a BOM", table.decode(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Order\tX")])) === "Order\tX");
  check("the delimiter is sniffed, not assumed", table.sniffDelimiter("a,b,c,d") === "," && table.sniffDelimiter("a\tb\tc") === "\t" && table.sniffDelimiter("a;b;c;d;e") === ";");
  check("Indian digit grouping survives (1,96,71,13,618.79)", table.amount("1,96,71,13,618.79") === 1967113618.79);
  check("European decimals survive (1.234,50)", table.amount("1.234,50") === 1234.5);
  check("negatives in both SAP spellings", table.amount("(1,234.50)") === -1234.5 && table.amount("1,234.50-") === -1234.5);
  check("a blank cell is zero, not NaN", table.amount("") === 0 && table.amount("  ") === 0 && table.amount("-") === 0);
  check("dates in every SAP spelling", table.date("04.09.2026") === "2026-09-04" && table.date("2026-09-04") === "2026-09-04" && table.date("20260904") === "2026-09-04" && table.date("") === null);

  console.log("1. the four extracts");
  const b = ingest.KINDS.io_budget.parse(Buffer.from(BUDGET_TSV, "utf8"));
  check("the budget export gives three orders and skips the total row", b.rows.length === 3 && !b.rows.some((r) => r.ioNumber === "*"), j(b.rows.map((r) => r.ioNumber)));
  check("its figures are read, grouping and all", b.rows[1].ioNumber === "318802" && b.rows[1].budget === 115000 && b.rows[1].actual === 62500 && b.rows[1].commitment === 18400 && b.rows[1].available === 34100, j(b.rows[1]));
  const bAlv = ingest.KINDS.io_budget.parse(Buffer.from("  318801 Autolabe 390S\t98,300.00\t52,900.00\t18,400.00\t71,300.00\t27,000.00\n", "utf8"));
  check("the headerless ALV 'Budget Details' variant still lands", bAlv.rows.length === 1 && bAlv.rows[0].ioNumber === "318801" && bAlv.rows[0].budget === 98300, j(bAlv.rows));
  const m = ingest.KINDS.io_master.parse(Buffer.from(MASTER_CSV, "utf8"));
  check("the order master reads, and leading zeros come off the cost centre", m.rows.length === 3 && m.rows[0].costCenter === "30145" && m.rows[0].orderType === "Z002" && m.rows[0].createdOn === "2026-09-04", j(m.rows[0]));
  const p = ingest.KINDS.po_lines.parse(Buffer.from(PO_CSV, "utf8"));
  check("PO lines read, with quoted amounts", p.rows.length === 4 && p.rows[0].poNumber === "4500218831" && p.rows[0].invoicedUsd === 48500 && p.rows[2].stillToInvoiceUsd === 18400, j(p.rows[0]));
  const mx = ingest.KINDS.matrix.parse(Buffer.from(["Cost Center\tDescription\tPlant\tStatus\tM1\tA1\tA2\tA3",
    "0000030145\t3026 SG IT - Infrastructure\t3026\tActive\tUdarsh Atwal\tUdarsh Atwal\tLekha Rogerson\tVrishti Aguirre"].join("\n"), "utf8"));
  check("the approver matrix reads one row per cost centre with its levels", mx.rows.length === 1 && mx.rows[0].costCenter === "30145" && mx.rows[0].levels.A2.name === "Lekha Rogerson", j(mx.rows[0]));
  const bad = ingest.KINDS.io_master.parse(Buffer.from("Widget,Colour\nfoo,red\n", "utf8"));
  check("a file that is not the extract at all is refused with what was expected", Boolean(bad.error) && /header/i.test(bad.error), bad.error);

  console.log("2. internal orders on one AFE");
  const afe = { id: "afe-t", money: { capexUsd: 215000, lines: [
    { site: "Singapore DC", country: "SG", amountUsd: 115000 }, { site: "India", country: "IN", amountUsd: 70000 }, { site: "South Korea", country: "KR", amountUsd: 30000 }] } };
  const ios = [
    { id: "io-1", ioNumber: "318801", kind: "parent", allocatedBudgetUsd: 30000, budgetMoves: [] },
    { id: "io-2", ioNumber: "318802", kind: "child", lineSeq: 1, site: "Singapore DC", allocatedBudgetUsd: 115000, budgetMoves: [] },
    { id: "io-3", ioNumber: "318803", kind: "child", lineSeq: 2, site: "India", allocatedBudgetUsd: 70000, budgetMoves: [] },
  ];
  const plan = reg.childPlan(afe, ios);
  check("the plan says which cost lines have an order and which do not", plan.length === 3 && plan[0].recorded && plan[2].recorded === false && plan[2].site === "South Korea", j(plan.map((x) => [x.site, x.ioNumber])));
  const alloc = reg.allocation(afe, ios, 215000);
  check("what is allocated ties back to what was approved", alloc.balanced && alloc.allocatedUsd === 215000 && alloc.parentUsd === 30000 && alloc.childUsd === 185000, j(alloc));
  check("a cost line with no order refuses a number that is not one", reg.validateChild(afe, ios, { seq: 3, ioNumber: "abc" }) !== null);
  check("a line that already has an order says so", /already has internal order/.test(reg.validateChild(afe, ios, { seq: 1, ioNumber: "313999" }) || ""));
  check("a good child passes", reg.validateChild(afe, ios, { seq: 3, ioNumber: "318804" }) === null);
  check("a move needs two different orders", /two different/.test(reg.planMove(afe, ios, { fromIo: "318801", toIo: "318801", amountUsd: 10, note: "x" }).error || ""));
  check("a move needs an amount", /greater than zero/.test(reg.planMove(afe, ios, { fromIo: "318802", toIo: "318803", amountUsd: 0, note: "x" }).error || ""));
  check("a move needs a reason", /why/.test(reg.planMove(afe, ios, { fromIo: "318802", toIo: "318803", amountUsd: 10 }).error || ""));
  check("an order cannot give up more than it holds", /cannot give up more/.test(reg.planMove(afe, ios, { fromIo: "318801", toIo: "318802", amountUsd: 40000, note: "x" }).error || ""));
  const mv = reg.planMove(afe, ios, { fromIo: "318802", toIo: "318803", amountUsd: 15000, note: "Korea slipped to India" });
  check("a good move is a ± pair and the total does not change", mv.pair.length === 2 && mv.pair[0].deltaUsd === -15000 && mv.pair[1].deltaUsd === 15000 &&
    mv.fromAfterUsd + mv.toAfterUsd === 115000 + 70000, j({ pair: mv.pair.map((x) => x.deltaUsd), after: [mv.fromAfterUsd, mv.toAfterUsd] }));
  const moved = [Object.assign({}, ios[1], { budgetMoves: [{ fromIo: "318802", toIo: "318803", amountUsd: 15000, deltaUsd: -15000, note: "n", byName: "K", at: "2026-09-05T00:00:00Z" }] }),
    Object.assign({}, ios[2], { budgetMoves: [{ fromIo: "318802", toIo: "318803", amountUsd: 15000, deltaUsd: 15000, note: "n", byName: "K", at: "2026-09-05T00:00:00Z" }] })];
  check("the history shows one line per pair, not two", reg.moveHistory(moved).length === 1 && reg.moveHistory(moved)[0].amountUsd === 15000);

  console.log("3. does the tool still agree with SAP?");
  const issued = Object.assign({}, afe, { state: "issued", project: { title: "APAC refresh" }, fa: { issuedAt: "2026-08-01T00:00:00Z" }, costCenter: "30145" });
  const stale = reconcile({ afes: [], ios: [], budgetMap: new Map(), masterMap: new Map(),
    extracts: [{ kind: "io_budget", batchId: "b1", stale: true, ageDays: 12, importedAt: "2026-08-23T00:00:00Z" }, { kind: "io_master", batchId: null, stale: true }] });
  check("a stale extract and a missing one are both reported", stale.findings.some((f) => f.code === "extract_stale" && /12 days old/.test(f.title)) &&
    stale.findings.some((f) => f.code === "extract_missing"), j(stale.findings.map((f) => f.code)));
  const master = new Map([["318801", { ioNumber: "318801", costCenter: "30999", orderType: "Z005" }]]);
  const r1 = reconcile({ afes: [issued], ios: ios.slice(0, 1).map((x) => Object.assign({}, x, { afeId: "afe-t", costCenter: "30145", orderType: "Z002" })), budgetMap: new Map(), masterMap: master, extracts: [] });
  check("an order on a different cost centre in SAP is a review finding", r1.findings.some((f) => f.code === "cost_centre_differs" && /30999/.test(f.title)), j(r1.findings.map((f) => f.code)));
  check("so is a different order type", r1.findings.some((f) => f.code === "order_type_differs"));
  const over = new Map([["318801", { ioNumber: "318801", budget: 300000 }]]);
  const r2 = reconcile({ afes: [issued], ios: [Object.assign({}, ios[0], { afeId: "afe-t" })], budgetMap: over, masterMap: new Map([["318801", { ioNumber: "318801" }]]), extracts: [] });
  check("budget beyond the 105 % tolerance says a supplemental is needed", r2.findings.some((f) => f.code === "budget_over_approved" && /supplemental/.test(f.detail)), j(r2.findings.map((f) => f.code)));
  const r3 = reconcile({ afes: [issued], ios: [Object.assign({}, ios[0], { afeId: "afe-t" })], budgetMap: new Map(), masterMap: new Map(), extracts: [] });
  check("cost lines without their own order are a note, not a block", r3.findings.some((f) => f.code === "lines_without_io" && f.severity !== "review"));
  check("an AFE issued with no order at all is a review finding", reconcile({ afes: [issued], ios: [], budgetMap: new Map(), masterMap: new Map(), extracts: [] }).findings.some((f) => f.code === "issued_without_io"));

  console.log("4. the tracker's own column order");
  check("the CSV keeps Aiden's workbook order, with where the equipment came from appended after it (R152)",
    CSV_COLUMNS.join("|") === "AFE name|Order|CC|Function|Sub-Function|Cost Center Owner|Functional lead|Country|Region|Created|Fiscal Year|AFE Category|Budget Category|Reduction|Budget|Actual|Commitment|Allotted|Available|KOB1 actuals|Sourcing",
    CSV_COLUMNS.join("|"));
}

// ---------------------------------------------------------------------------------------------
// Part 1 — the API
// ---------------------------------------------------------------------------------------------
async function call(method, p, body, base) {
  const res = await fetch((base || BASE) + "/api" + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const actAs = (email) => call("POST", "/admin/act-as", { email });
const actAsNone = () => call("DELETE", "/admin/act-as");

async function raiseSignIssue() {
  await actAsNone();
  const id = (await call("POST", "/afes")).body.afe.id;
  await call("PATCH", `/afes/${id}`, {
    "project.title": "PC Hardware Lifecycle Replacement APAC", costCenter: "30145", "money.classification": "capex", "money.capexUsd": 215000,
    "money.lines": [{ site: "Singapore DC", country: "SG", amountUsd: 115000 }, { site: "India", country: "IN", amountUsd: 70000 }, { site: "South Korea", country: "KR", amountUsd: 30000 }],
    location: "SGP_Singapore_Site 5", region: "APAC", "project.projectType": "Office Equip/Furniture",
    "project.description": "The HW REFRESH Project will be used to stock inventory in APAC for FY 2026.",
    "project.justification": "Devices past their lifecycle fail more often and cannot run the current security baseline.",
    "project.newEquipment": "Yes", "project.surplusChecked": "Yes", "project.buyVsLease": "N/A", "project.assistAsset": "No",
    "schedule.startDate": "2026-10-01", "schedule.finishDate": "2026-12-30", "schedule.fiscalYear": 2026,
    "budget.budgeted": "Yes", "budget.potId": "pot-0003", "budget.budgetCategory": "Life Cycle Refresh",
  });
  await call("POST", `/afes/${id}/documents`, { filename: "APAC_HW_estimate.pdf", role: "quote", contentBase64: QUOTE, vendor: "Multiple vendors", amountUsd: 215000 });
  // Raised by Shashank, reviewed and sent by Aiden, the division's coordinator (R157).
  await call("POST", `/afes/${id}/submit`);
  await actAs("aiden-mulqueeny_crilly@example.com");
  await call("PUT", `/afes/${id}/routing/recipients`, { additional: [{ name: "Lekha Rogerson", level: "A2" }] });
  await call("POST", `/afes/${id}/routing/confirm-emails`, { confirmations: [{ name: "Kai Lun Ong", email: "kailun_ong@example.com" }] });
  const sent = await call("POST", `/afes/${id}/send`);
  if (sent.status !== 200) throw new Error("send failed: " + j(sent.body));
  for (let i = 0; i < 10; i++) {
    await actAsNone();
    const cur = await call("GET", `/afes/${id}`);
    if (cur.body.afe.state !== "in_approval") break;
    const h = cur.body.routing.recipients.find((r) => r.status === "sent");
    const known = await call("GET", "/admin/users");
    if (!known.body.some((u) => u.email === h.email)) await call("POST", "/admin/users", { email: h.email, displayName: h.name, roles: ["approver"] });
    await actAs(h.email);
    const dec = await call("GET", `/afes/${id}/decision`);
    const r = await call("POST", `/afes/${id}/recipients/${dec.body.me.recipientId}/sign`);
    if (r.status !== 200) throw new Error(`${h.name} could not sign: ` + j(r.body));
  }
  await actAs(JUDITHMELANIE);
  await call("POST", `/fa/afes/${id}/form-reviewed`, {});          // R98 — the form is read first
  await call("POST", `/fa/afes/${id}/judgment`, { orderType: "Z002", ticks: { asset_not_expense: true, amount_reasonable: true, classification_agreed: true, no_duplicate_io: true, order_type: true } });
  // R101 — the FA Supervisor releases it, and then a DIFFERENT preparer keys SAP.
  const ok = await call("POST", `/fa/afes/${id}/approve-issue`, {});
  if (ok.status !== 200) throw new Error("approve-issue failed: " + j(ok.body));
  await actAs("ebony_lowe@example.com");
  const rec = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "318801", orderType: "Z002", children: [{ seq: 1, ioNumber: "318802" }, { seq: 2, ioNumber: "318803" }] });
  if (rec.status !== 200) throw new Error("record-io failed: " + j(rec.body));
  await actAsNone();
  return id;
}

async function online() {
  console.log("5. a clean slate, and an AFE issued with a parent and two child orders");
  const reset = await call("POST", "/admin/reset");
  check("the store resets", reset.status === 200 && reset.body.ok === true);
  const id = await raiseSignIssue();
  const p0 = await call("GET", `/projects/${id}`);
  check("the project exists with three orders and ties back to the approved total",
    p0.status === 200 && p0.body.ios.length === 3 && p0.body.allocation.balanced && p0.body.allocation.approvedUsd === 215000, j(p0.body.allocation));
  check("no extract names these orders yet, so the figures are the tool's own allocation and say so",
    p0.body.ios.every((io) => io.figures.inExtract === false) && p0.body.ios[0].figures.budgetUsd === 30000,
    j(p0.body.ios.map((i) => [i.ioNumber, i.figures.inExtract])));

  console.log("6. the budget extract arrives");
  const health0 = await (await fetch(BASE + "/health")).json();
  const configured = health0.integrations.sapExtracts === "endpoint-open";
  const noSecret = await call("POST", "/ingest/io_budget", { contentBase64: b64(BUDGET_TSV) });
  check(configured ? "the machine door refuses a caller with no secret" : "the machine door is off until INGEST_SECRET is configured",
    configured ? noSecret.status === 401 : noSecret.status === 503 && /INGEST_SECRET/.test(noSecret.body.error), j(noSecret.body));
  // Admin reads a file and says what it would change BEFORE it replaces anything (2026-10-16).
  const snapsBefore = (await call("GET", "/admin/extracts")).body.snapshots.length;
  const pre = await call("POST", "/admin/ingest/io_budget", { filename: "IO_budget_20260905.txt", contentBase64: b64(BUDGET_TSV), preview: true });
  check("a preview counts the rows and writes nothing — no batch, nothing applied",
    pre.status === 200 && pre.body.preview && pre.body.preview.rows === 3 && (await call("GET", "/admin/extracts")).body.snapshots.length === snapsBefore, j(pre.body));
  const up = await call("POST", "/admin/ingest/io_budget", { snapshotId: "BUD-2026-09-05", filename: "IO_budget_20260905.txt", asOfDate: "2026-09-05", contentBase64: b64(BUDGET_TSV) });
  check("uploaded: three rows, activated", up.status === 201 && up.body.snapshot.status === "active" && up.body.snapshot.rowCount === 3, j(up.body.error || up.body.snapshot));
  const again = await call("POST", "/admin/ingest/io_budget", { snapshotId: "BUD-2026-09-05", contentBase64: b64(BUDGET_TSV) });
  check("the same snapshotId is a no-op, not a second copy", again.status === 200 && again.body.duplicate === "snapshotId" && /nothing was changed/.test(again.body.note), j(again.body));
  const sameBytes = await call("POST", "/admin/ingest/io_budget", { snapshotId: "BUD-DIFFERENT-ID", contentBase64: b64(BUDGET_TSV) });
  check("so are the same bytes under a different id — Power Automate retries", sameBytes.status === 200 && sameBytes.body.duplicate === "content", j(sameBytes.body));
  const truncated = await call("POST", "/admin/ingest/io_budget", { snapshotId: "BUD-TRUNC", contentBase64: b64(["Order\tBudget\tActual\tCommitment\tAllotted\tAvailable", "318801\t30,000.00\t0\t0\t0\t30,000.00"].join("\n")) });
  check("a truncated extract is refused before it replaces a good one", truncated.status === 409 && /looks truncated/.test(truncated.body.error), j(truncated.body.error));
  const forced = await call("POST", "/admin/ingest/io_budget", { snapshotId: "BUD-TRUNC", force: true, contentBase64: b64(["Order\tBudget\tActual\tCommitment\tAllotted\tAvailable", "318801\t30,000.00\t0\t0\t0\t30,000.00"].join("\n")) });
  check("with force it lands, and the batch it replaced is superseded", forced.status === 201 && forced.body.snapshot.status === "active", j(forced.body.error || forced.body.snapshot.status));
  const identical = await call("POST", "/admin/ingest/io_budget", { snapshotId: "BUD-AGAIN", contentBase64: b64(BUDGET_TSV) });
  check("re-sending yesterday's bytes is recognised, not loaded twice", identical.status === 200 && identical.body.duplicate === "content", j(identical.body.note || identical.body.error));
  await actAs(JUDITHMELANIE);
  const back = await call("POST", "/admin/ingest/io_budget", { snapshotId: "BUD-2026-09-06", asOfDate: "2026-09-06", contentBase64: b64(BUDGET_TSV_V2) });
  check("tonight's run lands as its own batch", back.status === 201 && back.body.snapshot.rowCount === 3 && back.body.snapshot.previousId === "BUD-TRUNC", j(back.body.error || back.body.snapshot.previousId));
  await actAsNone();
  const upAudit = (await call("GET", "/admin/audit")).body.filter((e) => e.type === "extract_imported");
  check("every import is audited with the real login and who they were acting as",
    upAudit.length >= 2 && upAudit[0].actorEmail === SHASHANK && upAudit[0].actingAsEmail === JUDITHMELANIE && upAudit[0].payload.rows === 3,
    j(upAudit.slice(0, 1).map((e) => [e.actorEmail, e.actingAsEmail, e.payload.rows])));
  const closed = (await call("GET", "/admin/extracts")).body.snapshots;
  check("a refused batch is closed out as failed, not left loading", closed.every((x) => x.status !== "loading"), j(closed.map((x) => [x.id, x.status])));

  const p1 = await call("GET", `/projects/${id}`);
  const sg = p1.body.ios.find((x) => x.ioNumber === "318802");
  check("the project now shows SAP's own figures per order",
    sg.figures.inExtract && sg.figures.budgetUsd === 115000 && sg.figures.actualUsd === 62500 && sg.figures.commitmentUsd === 18400 && sg.figures.availableUsd === 34100, j(sg.figures));
  check("tonight's extract moved India without anyone touching the AFE — every figure is derived at read time",
    p1.body.ios.find((x) => x.ioNumber === "318803").figures.actualUsd === 18000, j(p1.body.ios.map((x) => [x.ioNumber, x.figures.actualUsd])));
  check("and the roll-up across parent and children", p1.body.totals.budgetUsd === 215000 && p1.body.totals.actualUsd === 80500 && p1.body.totals.availableUsd === 116100, j(p1.body.totals));

  console.log("7. the order master and the purchase orders");
  const mUp = await call("POST", "/admin/ingest/io_master", { snapshotId: "KOK5-2026-09-05", contentBase64: b64(MASTER_CSV) });
  check("the order master lands", mUp.status === 201 && mUp.body.snapshot.rowCount === 3, j(mUp.body.error));
  const pUp = await call("POST", "/admin/ingest/po_lines", { snapshotId: "ME2K-2026-09-05", contentBase64: b64(PO_CSV) });
  check("the PO lines land", pUp.status === 201 && pUp.body.snapshot.rowCount === 4, j(pUp.body.error));
  const io404 = await call("GET", "/io/318802");
  check("the order page shows the money and the purchase orders behind it",
    io404.status === 200 && io404.body.poLines.length === 3 && io404.body.figures.actualUsd === 62500 && io404.body.master.orderType === "Z002", j({ po: io404.body.poLines.length, fig: io404.body.figures }));
  // The route used to ship a separate `siblings` array that no screen ever read — `project.ios`
  // already carries every order on the AFE, which is what the order page actually renders. The
  // duplicate went (R125); the fact it asserted is checked here through the live path instead.
  check("it names its siblings and its AFE",
    io404.body.project.ios.filter((x) => x.ioNumber !== "318802").length === 2 && io404.body.project.afe.id === id,
    j(io404.body.project.ios.map((x) => x.ioNumber)));
  const recon1 = await call("GET", "/projects/reconcile");
  check("reconciliation is quiet once the extracts agree", recon1.status === 200 && !recon1.body.findings.some((f) => f.code === "io_not_in_master" || f.code === "cost_centre_differs"), j(recon1.body.findings.map((f) => f.code)));
  check("but it still notes the cost line without its own order", recon1.body.findings.some((f) => f.code === "lines_without_io"), j(recon1.body.findings.map((f) => f.code)));

  console.log("8. a matrix extract, and an AFE already signed against the old one");
  const before = await call("GET", "/afes/" + id);
  const mxCsv = ["Cost Center\tDescription\tPlant\tStatus\tM1\tA1\tA2\tA3\tA4\tA5",
    "30145\t3026 SG IT - Infrastructure\t3026\tActive\tUdarsh Atwal\tUdarsh Atwal\tLekha Rogerson\tVrishti Aguirre\tIsabel Armstrong\tVrishti Aguirre",
    "30146\t3026 SG IT - Applications\t3026\tActive\tUdarsh Atwal\tUdarsh Atwal\tKai Lun Ong\tVrishti Aguirre\tIsabel Armstrong\tVrishti Aguirre"].join("\n");
  // The same two-row file WITHOUT force. A matrix export is a full snapshot and a cost centre
  // missing from it is deleted, so a truncated file is how 1,197 cost centres quietly become
  // two. The seeded matrix carries no batch record, which is exactly why the check reads the
  // live collection rather than the previous snapshot.
  const mxTrunc = await call("POST", "/admin/ingest/matrix", { snapshotId: "MATRIX-TRUNCATED", contentBase64: b64(mxCsv) });
  check("a matrix extract that would wipe the matrix is refused without force",
    mxTrunc.status === 409 && mxTrunc.body.detail && mxTrunc.body.detail.liveRowCount > 1000 && mxTrunc.body.detail.rowCount === 2,
    j({ status: mxTrunc.status, detail: mxTrunc.body.detail }));
  const stillThere = await call("GET", "/matrix/all");
  check("and the cost centres it would have removed are all still there", stillThere.body.length > 1000, j(stillThere.body.length));

  const mxUp = await call("POST", "/admin/ingest/matrix", { snapshotId: "MATRIX-2026-09-15", contentBase64: b64(mxCsv), force: true });
  check("the matrix extract applies as a diff and says what changed",
    mxUp.status === 201 && mxUp.body.snapshot.summary.changed.some((c) => c.costCenter === "30145" && c.levels.some((l) => l.level === "A2" && l.was === "Kai Lun Ong" && l.now === "Lekha Rogerson")),
    j(mxUp.body.error || mxUp.body.snapshot.summary));
  check("cost centres missing from the export are removed, and counted", mxUp.body.snapshot.summary.removed > 1000, j(mxUp.body.snapshot.summary.removed));
  const after = await call("GET", "/afes/" + id);
  check("the chain frozen at send is untouched by the new extract",
    after.body.routing.basis.matrixRow.levels.A2.name === "Kai Lun Ong" && before.body.routing.recipients.length === after.body.routing.recipients.length,
    j(after.body.routing.basis.matrixRow.levels.A2));
  const mb = await call("GET", "/refdata");
  check("the live matrix batch is the one just imported", mb.body.matrixBatch.batchId === "MATRIX-2026-09-15", j(mb.body.matrixBatch));

  console.log("9. the third cost line gets its own order, paid for out of the parent");
  await actAs(JUDITHMELANIE);
  const badChild = await call("POST", `/projects/${id}/ios`, { seq: 1, ioNumber: "313999" });
  check("a line that already has an order is refused", badChild.status === 422 && /already has internal order/.test(badChild.body.error), j(badChild.body.error));
  // SAP's order master decides whether a number can be this AFE's (2026-09-28). Tonight's
  // extract already lists 318804 — Fixed Assets created it today, for this AFE, and records it
  // after the extract ran, which must go through — and 318806, opened in March for somebody else.
  {
    const d = new Date();
    const today = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}.${d.getFullYear()}`;
    const again = MASTER_CSV.split("\n").concat([
      `318804,PC HARDWARE - SOUTH KOREA,Z002,1000,0000030145,3026,Shashank Srivastava,${today},REL,USD`,
      "318806,CHROMATOGRAPHY SKID SITE A,Z002,1000,0000010270,1000,Tessa Arnott,02.03.2026,REL,USD",
    ]).join("\n");
    const up = await call("POST", "/admin/ingest/io_master", { snapshotId: "KOK5-2026-09-28", contentBase64: b64(again) });
    check("a newer order master lands", up.status === 201 && up.body.snapshot.rowCount === 5, j(up.body.error));
    const theirs = await call("POST", `/projects/${id}/ios`, { seq: 3, ioNumber: "318806" });
    check("a child order the order master opened before this AFE was raised is refused, naming it",
      theirs.status === 422 && /SAP order master/.test(theirs.body.error) && /SITE A/.test(theirs.body.error) && /before this AFE was raised/.test(theirs.body.error),
      j(theirs.body.error));
  }
  const child = await call("POST", `/projects/${id}/ios`, { seq: 3, ioNumber: "318804" });
  check("the Korea line gets order 318804 and the AFE moves to tracking",
    child.status === 201 && child.body.afe.state === "tracking" && child.body.ios.length === 4, j(child.body.error || child.body.afe.state));
  const parent = child.body.ios.find((x) => x.kind === "parent");
  const korea = child.body.ios.find((x) => x.ioNumber === "318804");
  check("the budget came out of the parent as a ± pair — the parent is empty, Korea holds 30,000",
    parent.allocatedBudgetUsd === 0 && korea.allocatedBudgetUsd === 30000 && child.body.allocation.balanced &&
    parent.budgetMoves.slice(-1)[0].deltaUsd === -30000 && korea.budgetMoves[0].deltaUsd === 30000,
    j({ parent: parent.allocatedBudgetUsd, korea: korea.allocatedBudgetUsd, moves: parent.budgetMoves.length }));
  check("and nobody is mailed about it: a child order is shown on the project page, not sent (R164)",
    !(await call("GET", "/admin/outbox")).body.some((n) => n.kind === "child_io_added"));

  console.log("10. moving budget between the orders");
  const tooMuch = await call("POST", `/projects/${id}/budget-moves`, { fromIo: "318804", toIo: "318802", amountUsd: 999999, note: "x" });
  check("an order cannot give up more than it holds", tooMuch.status === 422 && /cannot give up more/.test(tooMuch.body.error), j(tooMuch.body.error));
  const noWhy = await call("POST", `/projects/${id}/budget-moves`, { fromIo: "318804", toIo: "318802", amountUsd: 5000 });
  check("a move without a reason is refused", noWhy.status === 422 && /why/.test(noWhy.body.error));
  const moved = await call("POST", `/projects/${id}/budget-moves`, { fromIo: "318803", toIo: "318802", amountUsd: 15000, note: "India slipped a quarter; Singapore needs the monitors now" });
  check("a good move lands as a pair on both orders", moved.status === 201 &&
    moved.body.ios.find((x) => x.ioNumber === "318803").allocatedBudgetUsd === 55000 &&
    moved.body.ios.find((x) => x.ioNumber === "318802").allocatedBudgetUsd === 130000, j(moved.body.error || moved.body.ios.map((x) => [x.ioNumber, x.allocatedBudgetUsd])));
  check("the approved total is unchanged — that is the point of a pair", moved.body.allocation.balanced && moved.body.allocation.allocatedUsd === 215000, j(moved.body.allocation));
  check("the history shows one line per move, with the reason", moved.body.moves.length === 2 && /India slipped/.test(moved.body.moves[0].note), j(moved.body.moves.map((m) => [m.fromIo, m.toIo, m.amountUsd])));
  const kinds = (await call("GET", `/admin/audit?afeId=${id}`)).body.map((e) => e.type);
  check("both are audited", kinds.includes("add_child_io") && kinds.includes("move_budget"), j(kinds.slice(0, 6)));

  console.log("11. KO22 posted, and the tracker in the column order the division already uses");
  await actAs(JUDITHMELANIE);
  // R103 — the budget step comes back with the figure and SAP's own table, or not at all.
  const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  await call("POST", `/afes/${id}/documents`, { filename: "KO22.png", role: "budget_evidence", contentBase64: PNG_1PX });
  const ko22 = await call("POST", `/fa/afes/${id}/steps/KO22_BUDGET`, { amountUsd: 215000 });
  check("KO22 is ticked, so the project stops waiting for its budget", ko22.status === 200, j(ko22.body.error));
  await actAsNone();
  const csvRes = await fetch(BASE + "/api/projects/export.csv");
  const rawBytes = Buffer.from(await csvRes.arrayBuffer());
  const csv = rawBytes.toString("utf8");
  const rows = csv.replace(/^﻿/, "").trim().split("\r\n");
  check("it downloads as CSV whose bytes start with a UTF-8 BOM and use CRLF, so Excel opens it right",
    csvRes.status === 200 && /text\/csv/.test(csvRes.headers.get("content-type")) && /attachment; filename="afe-projects-/.test(csvRes.headers.get("content-disposition")) &&
    rawBytes[0] === 0xef && rawBytes[1] === 0xbb && rawBytes[2] === 0xbf && csv.includes("\r\n"),
    `${csvRes.headers.get("content-type")} · first bytes ${rawBytes.slice(0, 3).toString("hex")}`);
  check("the header is Aiden's own column order", rows[0] === require(path.join(ROOT, "lib/routes/projects.js")).CSV_COLUMNS.join(","), rows[0]);
  check("one row per internal order", rows.length === 5, j(rows.length));
  const sgRow = rows.find((r) => r.includes("318802")).split(",");
  check("a row carries the AFE, the order, the cost centre, the owner and SAP's figures",
    sgRow[0] === "PC Hardware Lifecycle Replacement APAC" && sgRow[1] === "318802" && sgRow[2] === "30145" && sgRow[5] === "Udarsh Atwal" && sgRow[7] === "SG" && sgRow[14] === "115000.00" && sgRow[15] === "62500.00",
    j(sgRow.slice(0, 8)));
  const koreaRow = rows.find((r) => r.includes("318804")).split(",");
  check("and the reduction column carries what was moved away", rows.find((r) => r.includes("318803")).split(",")[13] === "15000.00" && koreaRow[13] === "", j([rows.find((r) => r.includes("318803")).split(",")[13], koreaRow[13]]));
  check("KOB1 actuals come from the PO lines", sgRow[19] === "62500.00", sgRow[19]);
  check("and the last column says where the equipment came from (R152)", sgRow[20] === "Vendor", sgRow[20]);
  const onlyInv = await fetch(BASE + "/api/projects/export.csv?sourcing=internal");
  check("the export can be cut to what came from Acme inventory, which here is nothing",
    (await onlyInv.text()).replace(/^\uFEFF/, "").trim().split("\r\n").length === 1);
  const projInv = await call("GET", "/projects?sourcing=internal");
  check("and so can the projects list", projInv.status === 200 && (projInv.body.counts ? projInv.body.counts.projects === 0 : true), j(projInv.body.counts));
  check("the CSV's own figures are tonight's, not last night's", rows.find((r) => r.includes("318803")).split(",")[15] === "18000.00", rows.find((r) => r.includes("318803")).split(",")[15]);

  console.log("12. the pots see what SAP reports");
  const pots = await call("GET", "/pots");
  const pot = pots.body.pots.find((x) => x.id === "pot-0003");
  check("the pot shows created, allotted, actual and commitment",
    pots.status === 200 && pot.createdUsd === 215000 && pot.allottedUsd === 215000 && pot.actualUsd === 80500 && pot.commitmentUsd === 18400 && pot.inExtract,
    j({ created: pot.createdUsd, actual: pot.actualUsd, commitment: pot.commitmentUsd }));
  check("and names the extract the figures came from", Boolean(pots.body.extract && pots.body.extract.batchId), j(pots.body.extract));

  console.log("13. the project list, and who may see it");
  await actAsNone();
  const list = await call("GET", "/projects");
  check("the AFE is listed as running, with its orders and the roll-up",
    list.status === 200 && list.body.counts.projects === 1 && list.body.counts.orders === 4 && list.body.groups.running.length === 1 &&
    list.body.groups.running[0].ioNumber === "318801" &&
    // SAP's figure for the three orders it knows, plus the tool's allocation for the fourth,
    // which was created after tonight's extract ran.
    list.body.groups.running[0].totals.budgetUsd === 245000, j({ counts: list.body.counts, totals: list.body.groups.running[0].totals }));
  await actAs("lekha_rogerson@example.com");
  const signerView = await call("GET", "/projects");
  check("someone who only signed the AFE does not carry it in their project list", signerView.body.counts.projects === 0, j(signerView.body.counts));
  check("but may still open what they signed", (await call("GET", `/projects/${id}`)).status === 200);
  await actAsNone();
  await call("POST", "/admin/users", { email: "isabel_armstrong@example.com", displayName: "Isabel Armstrong", roles: ["approver"] });
  await actAs("isabel_armstrong@example.com");
  const outsider = await call("GET", `/projects/${id}`);
  check("someone with no part in it cannot open the project at all", outsider.status === 403, outsider.status);
  await actAsNone();

  // R73 — "the requester should be able to see the status of their own project" (Euan, 44:56).
  // Everyone signed in is a requester and nothing else, so Projects has to earn its place in the
  // top bar on `projects.own.read` alone; the list already narrows to the caller's own rows.
  await call("POST", "/admin/users", { email: "kai-lun_ong@example.com", displayName: "Kai Lun Ong" });
  await actAs("kai-lun_ong@example.com");
  const plain = await call("GET", "/me");
  const secs = (plain.body.sections || []).map((s) => s.key);
  check("an employee with no roles at all still gets Projects in the top bar, and nothing they cannot use",
    secs.includes("projects") && secs.includes("requests") && !secs.includes("fa") && !secs.includes("admin") && !secs.includes("leadership"),
    j(secs));
  const theirs = await call("GET", "/projects");
  check("and it opens on their own projects — none here — rather than the whole company's",
    theirs.status === 200 && theirs.body.counts.projects === 0, j(theirs.body.counts || theirs.body));
  await actAsNone();

  console.log("14. a supplemental, rebuilt on the cumulative total (R48, Q39)");
  const early = await call("POST", "/afes", {});
  const earlyId = early.body.afe.id;
  const notIssued = await call("POST", `/afes/${earlyId}/supplemental`, {});
  check("a draft cannot be topped up — it is edited instead", notIssued.status === 409 && /already has its internal order/.test(notIssued.body.error), j(notIssued.body.error));
  const wrongIo = await call("POST", `/afes/${id}/supplemental`, { ioNumber: "999999" });
  check("the order has to be one of this AFE's", wrongIo.status === 422 && /not one of this AFE/.test(wrongIo.body.error), j(wrongIo.body.error));
  const supp = await call("POST", `/afes/${id}/supplemental`, { ioNumber: "318801" });
  const sid = supp.body.afe.id;
  check("the supplemental is a NEW AFE pointing at the order it tops up",
    supp.status === 201 && supp.body.afe.kind === "supplemental" && supp.body.afe.supplementalOf.ioNumber === "318801" &&
    supp.body.afe.supplementalOf.approvedTotalUsd === 215000 && sid !== id, j(supp.body.error || supp.body.afe.supplementalOf));
  check("it inherits the cost centre, the category and the classification, and nothing financial",
    supp.body.afe.costCenter === "30145" && supp.body.afe.budget.budgetCategory === "Life Cycle Refresh" &&
    supp.body.afe.money.classification === "capex" && supp.body.afe.money.capexUsd === null, j(supp.body.afe.money));
  check("the original AFE is untouched", (await call("GET", `/afes/${id}`)).body.afe.state === "tracking");
  await call("PATCH", `/afes/${sid}`, { "money.capexUsd": 200000 });
  const sv = await call("GET", `/afes/${sid}`);
  check("the band is the CUMULATIVE total, not the increment — $415,000, not $200,000",
    sv.body.band.totalUsd === 415000 && sv.body.band.basisKind === "new_total" && sv.body.validation.blocks.every((b) => b.rule !== "supplemental_needs_original"),
    j({ band: sv.body.band.label, total: sv.body.band.totalUsd }));
  const origLevels = after.body.routing.basis.levels;
  check("so more levels sign than signed the original", sv.body.band.levels.length > origLevels.length,
    j({ original: origLevels.join(" "), supplemental: sv.body.band.levels.join(" ") }));
  const preview = await call("GET", `/afes/${sid}/routing/preview`);
  check("and the chain preview really carries them", preview.body.basis.totalUsd === 415000 && preview.body.recipients.filter((r) => r.role !== "cc" && r.status === "pending").length > 4,
    j(preview.body.recipients.filter((r) => r.status === "pending").map((r) => r.level || r.role)));
  check("raising it is audited against the original", (await call("GET", `/admin/audit?afeId=${sid}`)).body.some((e) => e.type === "supplemental_raised" && e.payload.of === id));

  console.log("15. the platform");
  const health = await (await fetch(BASE + "/health")).json();
  check("/health reports every extract and whether it is stale",
    health.extracts.length === 4 && health.extracts.find((x) => x.kind === "io_budget").rowCount === 3 && health.extracts.find((x) => x.kind === "io_budget").stale === false &&
    health.extracts.find((x) => x.kind === "matrix").batchId === "MATRIX-2026-09-15" &&
    health.integrations.sapExtracts === (configured ? "endpoint-open" : "upload-only"),
    j(health.extracts.map((x) => [x.kind, x.rowCount])));
  const extracts = await call("GET", "/admin/extracts");
  check("admin lists the batches, newest first, with the superseded ones",
    extracts.status === 200 && extracts.body.kinds.length === 4 && extracts.body.snapshots.some((s) => s.status === "superseded"),
    j(extracts.body.snapshots.map((s) => [s.kind, s.status])));
}

// ---------------------------------------------------------------------------------------------
// Part 2 — the machine door, on its own server with the secret configured
// ---------------------------------------------------------------------------------------------
async function machineDoor() {
  const PORT = 8099, SECRET = "smoke-ingest-secret";
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")],
    { env: Object.assign({}, process.env, { PORT: String(PORT), INGEST_SECRET: SECRET }), stdio: "ignore" });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    for (let i = 0; i < 40; i++) {
      try { if ((await fetch(base + "/health")).ok) break; } catch { /* still booting */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const post = (headers) => fetch(base + "/api/ingest/io_budget", {
      method: "POST", headers: Object.assign({ "content-type": "application/json" }, headers),
      body: JSON.stringify({ snapshotId: "MACHINE-1", filename: "nightly.txt", contentBase64: b64(BUDGET_TSV) }),
    });
    const noHeader = await post({});
    check("no secret header — 401, and nothing is imported", noHeader.status === 401, String(noHeader.status));
    const wrong = await post({ "x-ingest-secret": "not-the-secret-at-all" });
    check("a wrong secret of a different length — 401", wrong.status === 401, String(wrong.status));
    const wrongSameLength = await post({ "x-ingest-secret": "x".repeat(SECRET.length) });
    check("a wrong secret of the right length — 401 (compared in constant time)", wrongSameLength.status === 401, String(wrongSameLength.status));
    const good = await post({ "x-ingest-secret": SECRET });
    const body = await good.json();
    check("the right secret imports it, with no user identity anywhere in the request",
      good.status === 201 && body.snapshot.status === "active" && body.snapshot.importedByEmail === "system" && body.snapshot.source === "scheduled",
      j(body.error || body.snapshot));
    const retry = await post({ "x-ingest-secret": SECRET });
    check("a retry of the same POST changes nothing", (await retry.json()).duplicate === "snapshotId", String(retry.status));
    const health = await (await fetch(base + "/health")).json();
    check("/health says the endpoint is open when the secret is configured", health.integrations.sapExtracts === "endpoint-open", j(health.integrations.sapExtracts));
  } finally {
    child.kill();
  }
}


// ---------------------------------------------------------------------------------------------
// The reconciliation history, split back into the entries it is made of (R126).
//
// The contract that matters is LOSSLESSNESS: the workbook's follow-up history is the only record
// of why a line has not capitalized, some of it a decade long, and a parser that silently drops a
// sentence is worse than no parser. Run against every real body in the seed, not a fixture.
// ---------------------------------------------------------------------------------------------
function reconNoteChecks() {
  console.log("17. the reconciliation history is a conversation");
  const reconNotes = require("../lib/domain/reconNotes");
  const seed = require("../seed/tracker.json");
  const lines = Array.isArray(seed) ? seed : Object.values(seed).find(Array.isArray);

  let bodies = 0, entries = 0, dated = 0, lossy = 0;
  for (const line of lines) {
    for (const c of line.comments || []) {
      bodies += 1;
      const es = reconNotes.splitEntries(c.body);
      entries += es.length;
      dated += es.filter((e) => e.at).length;
      if (es.map((e) => e.raw).join("\n") !== String(c.body)) lossy += 1;
    }
  }
  check(`every real comment body round-trips exactly (${bodies} bodies)`, lossy === 0, `${lossy} lossy`);
  check(`and they hold more than one entry each (${bodies} -> ${entries})`, entries > bodies * 1.5, String(entries));
  check(`most entries carry the date they were written (${dated}/${entries})`, dated > entries * 0.6, String(dated));

  // The shapes the real file actually uses, one at a time.
  const one = reconNotes.splitEntries("12/16/2025 Tasha - Project completed.\n03/11/2026 - Signs received. On-Site.");
  check("a two-entry body splits on the date", one.length === 2, JSON.stringify(one.map((e) => e.at)));
  check("and reads the dates", one[0].at === "2025-12-16" && one[1].at === "2026-03-11", JSON.stringify(one.map((e) => e.at)));
  const plain = reconNotes.splitEntries("Completed.");
  check("a body with no date is one entry, not none", plain.length === 1 && plain[0].at === null, JSON.stringify(plain));
  check("an empty body is no entries", reconNotes.splitEntries("").length === 0 && reconNotes.splitEntries(null).length === 0);
  const wrapped = reconNotes.splitEntries("1/10/2025 - Per Shawn, order placed.\nStill waiting on parts.");
  check("a line with no date belongs to the entry above it", wrapped.length === 1 && /Still waiting/.test(wrapped[0].text), JSON.stringify(wrapped));
  check("and the author is read when the line names one", wrapped[0].author === "Shawn", String(wrapped[0].author));
  // "Excluded - AuC assets/project had been previously confirmed..." is a STATUS, not a person.
  const status = reconNotes.splitEntries("6/3/2025 - Excluded - AuC assets had a future go-live.");
  check("a status word is never mistaken for a person", status[0].author === null, String(status[0].author));
  const lead = reconNotes.splitEntries("Need the building number.\n7/19/2023 - Per Jerry, IQ/OQ booked.");
  check("text before the first date keeps its place", lead.length === 2 && lead[0].at === null && /building number/.test(lead[0].text), JSON.stringify(lead.map((e) => e.at)));
}


// ---------------------------------------------------------------------------------------------
// Whose pots you may see (R128).
//
// Two bugs sat here, pulling opposite ways: holding `coordinator` NARROWED someone who also held
// `leadership`, and `?division=` overrode the pin with no check at all, so a coordinator for one
// division could read another's amounts by typing the parameter. Authorisation rules are
// controls, so they are tested.
// ---------------------------------------------------------------------------------------------
async function potsAccess() {
  console.log("18. whose pots you may see");
  const wide = await call("GET", "/pots");
  check("a wide role sees every division that has pots", wide.status === 200 && (wide.body.canChoose || []).length > 1,
    j({ showing: wide.body.divisions, canChoose: wide.body.canChoose }));
  const one = await call("GET", "/pots?division=" + encodeURIComponent(wide.body.canChoose[1]));
  check("and may switch to any of them", one.status === 200 && one.body.divisions.length === 1, j(one.body.divisions));
  check("the fiscal years offered are the ones that division actually has",
    (one.body.fiscalYears || []).length > 0, j(one.body.fiscalYears));

  const users = await call("GET", "/admin/users");
  const list = Array.isArray(users.body) ? users.body : (users.body.users || []);
  const coord = list.find((u) => (u.roles || []).includes("coordinator") && !(u.roles || []).includes("leadership")
    && !(u.roles || []).includes("fa_preparer") && !(u.roles || []).includes("fa_checker") && !(u.roles || []).includes("admin"));
  if (!coord) { check("a coordinator-only persona exists to test the pin", false, "none in seed/users.json"); return; }
  await call("POST", "/admin/act-as", { email: coord.email });
  const mine = await call("GET", "/pots");
  check(`a coordinator is pinned to their own divisions (${coord.email.split("@")[0]})`,
    mine.status === 200 && JSON.stringify(mine.body.divisions) === JSON.stringify(coord.coordinatorFor), j(mine.body.divisions));
  check("and is offered no switcher", (mine.body.canChoose || []).length === 0, j(mine.body.canChoose));
  const other = (wide.body.canChoose || []).find((d) => !(coord.coordinatorFor || []).includes(d));
  const sneak = await call("GET", "/pots?division=" + encodeURIComponent(other));
  check(`asking for ${other} by hand is refused, not served`, sneak.status === 403, j({ status: sneak.status, body: sneak.body }));
  await call("DELETE", "/admin/act-as");
  const back = await call("GET", "/pots");
  check("and the wider view comes back when the act-as ends", (back.body.canChoose || []).length > 1, j(back.body.canChoose));
}

(async () => {
  try {
    offline();
    reconNoteChecks();
    let up = false;
    try { up = (await fetch(BASE + "/health")).ok; } catch { up = false; }
    if (!up) console.log("\n(no server on " + BASE + " — the API parts were skipped)");
    else { await online(); console.log("16. the machine door (its own server, INGEST_SECRET set)"); await machineDoor(); await potsAccess(); }
  } catch (e) {
    failures += 1;
    console.log("  ✗ suite crashed — " + (e.stack || e.message));
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
