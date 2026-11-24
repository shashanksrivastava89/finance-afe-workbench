"use strict";
// Fill an environment with AFEs so it looks like a tool people have been using, rather than an
// empty form.
//
//   node tools/seed-demo.js                                   # against :8080
//   SMOKE_BASE=https://your-app.azurewebsites.net node tools/seed-demo.js
//   node tools/seed-demo.js --reset                           # wipe to the seed first
//
// Every AFE here is built THROUGH THE API, exactly as a person would build it: create, autosave
// field by field, attach a quote, route, send, sign, hand over, key the order. Nothing is
// written straight into storage. That is the whole point — a hand-written JSON document would
// bypass the guards and produce an AFE that no sequence of real actions could have created, and
// every derived view (validation, red flags, chain preview, pot figures, the roll-forward)
// would then be showing something that cannot happen. Built this way they are all correct by
// construction, because they went through the same code the tool runs in front of a user.
//
// The people are the real seeded identities (ADC rule: no invented personnel). The amounts,
// titles and dates are representative rather than real — they are here to show the shape of the
// thing. Reference data — 1,197 cost centres, the AuC recon lines, the budget baseline — is
// already in `seed/` and is not touched.
//
// This is NOT run at boot. A deployed environment starts empty and stays empty until someone
// decides otherwise, which is why it is a tool and not a seed file.
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
const RESET = process.argv.includes("--reset");

const ADMIN = "shashank_srivastava@example.com";
let acting = ADMIN;

async function call(method, p, body, as) {
  const headers = { "x-ms-client-principal-name": as || acting };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(BASE + "/api" + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let out = null;
  try { out = JSON.parse(text); } catch { out = text; }
  if (res.status >= 400) throw new Error(`${method} ${p} → ${res.status} ${JSON.stringify(out).slice(0, 200)}`);
  return out;
}
const patch = (id, obj) => call("PATCH", `/afes/${id}`, obj);

// A stand-in vendor quote with REAL pages on it.
//
// It used to be 193 bytes of valid-but-blank PDF, which exercised the upload path and nothing
// else. Now that the supporting documents are bound into the file the approvers sign (R112), a
// blank page is exactly the thing that would hide a broken append — the merge "worked" and the
// page was empty, and only rasterising it showed which. Three pages with words on them.
async function quotePdf(vendor, totalUsd) {
  const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
  const doc = await PDFDocument.create();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const rows = [
    ["Item", "Qty", "Unit", "Amount"],
    ["Hardware, as specified", "2", "38,000", "76,000"],
    ["Modules and optics", "6", "9,400", "56,400"],
    ["Cabling and patching", "1", "21,300", "21,300"],
    ["Installation and commissioning", "1", "42,000", "42,000"],
    ["Three-year support", "1", "72,300", "72,300"],
  ];
  for (let n = 1; n <= 3; n++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(vendor, { x: 48, y: 770, size: 18, font: bold, color: rgb(0.1, 0.1, 0.1) });
    page.drawText("Quotation - valid 30 days - all amounts USD", { x: 48, y: 750, size: 10, font: body, color: rgb(0.35, 0.35, 0.35) });
    page.drawLine({ start: { x: 48, y: 740 }, end: { x: 547, y: 740 }, thickness: 1, color: rgb(0.8, 0.8, 0.8) });
    let y = 706;
    for (const row of rows) {
      const f = row[0] === "Item" ? bold : body;
      page.drawText(row[0], { x: 48, y, size: 10, font: f });
      page.drawText(row[1], { x: 330, y, size: 10, font: f });
      page.drawText(row[2], { x: 390, y, size: 10, font: f });
      page.drawText(row[3], { x: 470, y, size: 10, font: f });
      y -= 22;
    }
    page.drawLine({ start: { x: 48, y: y + 8 }, end: { x: 547, y: y + 8 }, thickness: 1, color: rgb(0.2, 0.2, 0.2) });
    page.drawText("Total", { x: 48, y: y - 12, size: 11, font: bold });
    page.drawText("$" + Math.round(totalUsd).toLocaleString("en-US"), { x: 470, y: y - 12, size: 11, font: bold });
    page.drawText("Terms and conditions continue - page " + n + " of 3", { x: 48, y: 60, size: 9, font: body, color: rgb(0.45, 0.45, 0.45) });
  }
  return Buffer.from(await doc.save()).toString("base64");
}

// First_Last@example.com, the pattern every observed Acme mailbox follows. The tool flags
// its own version of this as a guess and makes a person confirm it; here we are standing in for
// that person, so the guess is accepted deliberately and only for demonstration data.
const guessMailbox = (name) => {
  const t = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (t.length < 2) return null;
  const clean = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return `${clean(t.slice(0, -1).join(""))}_${clean(t[t.length - 1])}@example.com`;
};

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

/**
 * The AFEs. `stop` says how far down the lifecycle each one is taken, so the queues on every
 * screen have something in them: a coordinator sees drafts waiting to be sent, an approver sees
 * signatures waiting, Fixed Assets sees approved AFEs waiting to be keyed, and the portfolio
 * sees orders already issued.
 */
const CASES = [
  { stop: "draft", by: "aiden-mulqueeny_crilly@example.com", cc: "30145", region: "APAC",
    title: "Meeting Room AV Refresh Singapore", type: "Office Equip/Furniture", capex: 48000,
    what: "Replace end-of-life video bars and displays in eleven meeting rooms at the Singapore ICON office.",
    why: "The current Polycom units are out of support and no longer receive firmware updates.", surplus: "Yes" },

  { stop: "draft", by: "shashank_srivastava@example.com", cc: "30146", region: "APAC",
    title: "Field Service Laptop Refresh FY26", type: "New Equipment", capex: 132000,
    what: "Replace 60 field-service laptops that reach end of lease in the second quarter.",
    why: "Lease expiry; the fleet is four years old and failing at an increasing rate.", surplus: "Yes" },

  { stop: "in_approval", by: "shashank_srivastava@example.com", cc: "30145", region: "APAC",
    title: "Core Switch Replacement Singapore", type: "New Equipment", capex: 268000,
    what: "Replace the two core switches at the Singapore ICON data centre, including optics and installation.",
    why: "Both units are past end-of-support and a failure would take the site offline.", surplus: "No",
    quote: { vendor: "Cisco Systems", amount: 240000 } },

  { stop: "in_approval", by: "aiden-mulqueeny_crilly@example.com", cc: "30146", region: "APAC",
    title: "Identity Platform Subscription FY26", type: "Other", capex: 96000, cloud: true,
    what: "Three-year subscription to the externally hosted identity platform covering all APAC sites.",
    why: "Consolidates four regional directories onto one platform and retires two servers.",
    quote: { vendor: "Okta", amount: 92000 } },

  { stop: "approved", by: "shashank_srivastava@example.com", cc: "30145", region: "APAC",
    title: "Warehouse Barcode Scanners APAC", type: "New Equipment", capex: 74000,
    what: "Ninety rugged barcode scanners and charging cradles across the Singapore and Australia warehouses.",
    why: "The existing units are out of warranty and spares are no longer manufactured.", surplus: "Yes",
    quote: { vendor: "Zebra Technologies", amount: 68000 } },

  { stop: "issued", by: "shashank_srivastava@example.com", cc: "30145", region: "APAC",
    title: "Lab Cold Storage Monitoring", type: "Quality", capex: 118000,
    what: "Continuous temperature monitoring for 34 freezers and cold rooms, with alerting and audit reporting.",
    why: "Required for the quality system; current manual checks are twice daily and paper-based.", surplus: "Yes",
    quote: { vendor: "Vaisala", amount: 111000 }, order: "318900", orderType: "Z002" },
];

async function build(c, index) {
  const label = `${index + 1}/${CASES.length} ${c.title}`;
  acting = c.by;
  const created = await call("POST", "/afes");
  const id = created.afe.id;

  await patch(id, { "project.title": c.title, "project.projectType": c.type });
  await patch(id, { costCenter: c.cc });
  // The location master's own spelling, building number and all. A near-miss raises the
  // not-on-the-list warning on every demo AFE, which makes a real flag look like noise.
  await patch(id, { region: c.region, location: c.region === "APAC"
    ? "SGP_Singapore_Site 5"
    : "USA_Site A_Site 1" });
  await patch(id, {
    "money.classification": c.cloud ? "cloud_capex" : "capex",
    [c.cloud ? "money.cloudCapexUsd" : "money.capexUsd"]: c.capex,
  });
  if (c.cloud) {
    // The template's own decision tree: software, hosted outside, subscription, cannot move host.
    await patch(id, { "cloud.q1Software": "Yes", "cloud.q2ExternallyHosted": "Yes", "cloud.q3Subscription": "Subscription", "cloud.q4CanChangeHost": "No" });
  }
  await patch(id, { "budget.budgeted": "Yes", "budget.potId": "pot-0003" });
  await patch(id, {
    "project.description": c.what, "project.justification": c.why,
    "schedule.startDate": day(21), "schedule.finishDate": day(180),
    "project.buyVsLease": "N/A", "project.newEquipment": "New",
    "project.assistAsset": "No",
  });
  if (c.surplus) await patch(id, { "project.surplusChecked": c.surplus });
  if (c.quote) {
    await call("POST", `/afes/${id}/documents`, {
      filename: `${c.quote.vendor.toLowerCase().replace(/\W+/g, "-")}-quote.pdf`, role: "quote",
      vendor: c.quote.vendor, amountUsd: c.quote.amount, contentBase64: await quotePdf(c.quote.vendor, c.quote.amount),
    });
  }
  if (c.stop === "draft") { console.log(`  · ${label} — draft`); return id; }

  // Sent by whoever may send it: the coordinator when the division has one, else the requester.
  // Somebody else's AFE reaches the coordinator by being submitted to them, and only then is it
  // theirs to send (R157) — the coordinator's own AFE they send from the draft.
  const view = await call("GET", `/afes/${id}`);
  const coordinator = view.afe.coordinator && view.afe.coordinator.email;
  if (coordinator && coordinator !== c.by) await call("POST", `/afes/${id}/submit`, {});
  acting = coordinator || c.by;

  // Mailboxes below `rule` grade block the send until a person confirms or types them (R60).
  // The matrix carries names, not addresses, so this is the normal state of a fresh chain
  // rather than an error — the coordinator does exactly this on the routing screen.
  const preview = await call("GET", `/afes/${id}/routing/preview`);
  if ((preview.needsEmail || []).length) {
    await call("POST", `/afes/${id}/routing/confirm-emails`, {
      confirmations: preview.needsEmail.map((r) => ({ recipientId: r.recipientId, email: r.email || guessMailbox(r.name) })),
    });
  }
  await call("POST", `/afes/${id}/send`, { note: "Budgeted under the FY26 lifecycle pot; the quote covers the full scope." });
  if (c.stop === "in_approval") {
    const sent = await call("GET", `/afes/${id}`);
    const waiting = (sent.routing.recipients || []).find((r) => r.status === "pending");
    console.log(`  · ${label} — out for signature, with ${waiting ? waiting.name : "the first approver"}`);
    return id;
  }

  // Every signature, in order, each by the person the chain actually names.
  for (let guard = 0; guard < 24; guard += 1) {
    const v = await call("GET", `/afes/${id}`, null, ADMIN);
    if (v.afe.state !== "in_approval") break;
    // The chain is sequential, so it is not "a pending recipient" but THE one whose turn it
    // is: lowest order wins, and anything at a higher order is refused with "it is not with
    // you" — which is the guard working, not a problem to route around.
    // "Still to act" is pending OR sent OR viewed — the envelope has reached the person whose
    // turn it is, so theirs reads `sent`, not `pending`.
    const OPEN = ["pending", "sent", "viewed"];
    const next = (v.routing.recipients || [])
      .filter((r) => OPEN.includes(r.status) && r.role !== "cc")
      .sort((a, b) => (a.order || 0) - (b.order || 0))[0];
    if (!next) break;
    await call("POST", `/afes/${id}/recipients/${next.id}/sign`, { name: next.name }, next.email);
  }
  if (c.stop === "approved") { console.log(`  · ${label} — signed, waiting for Fixed Assets`); return id; }

  // Fixed Assets: tick the judgment, then key the order.
  acting = "judithmelanie_ware@example.com";
  const fa = await call("GET", `/fa/afes/${id}`);
  const ticks = {};
  for (const row of fa.judgment.rows || []) ticks[row.id] = true;
  await call("POST", `/fa/afes/${id}/form-reviewed`, {});          // R98 — the form before the checklist
  await call("POST", `/fa/afes/${id}/judgment`, { ticks, orderType: c.orderType });
  for (const flag of ((fa.redFlags && fa.redFlags.blocks) || [])) {
    await call("POST", `/fa/afes/${id}/red-flags/${flag.id}/ack`, { note: "Checked against the quote and the signed form." }).catch(() => {});
  }
  // R101 — the FA Supervisor releases it for issue, and a DIFFERENT preparer keys SAP. Four
  // eyes by identity, so Judithmelanie cannot do both halves even holding both roles.
  await call("POST", `/fa/afes/${id}/approve-issue`, { note: "Checked against the quote and the signed form." });
  acting = "ebony_lowe@example.com";
  await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: c.order, orderType: c.orderType });
  console.log(`  · ${label} — issued as internal order ${c.order}`);
  return id;
}


/**
 * Purchase-order lines for the orders this script just created (R130).
 *
 * There are no PO lines anywhere — no seed file, no extract — so every order page in every
 * environment says "Nothing invoiced against this order yet", and the Spent and Committed tiles
 * open onto an empty card. "If spaces are seen open because data doesn't exist, then seed some
 * mock data to show the actual layout" (Shashank, 2026-09-22).
 *
 * It goes in through the REAL ingest door as a CSV, exactly as Power Automate will drop it — so
 * this also exercises the snapshot discipline, the column sniffing and the machine route, rather
 * than reaching past them into the store. Demo data only; `seed/*.json` is reference data from
 * the real exports and is never touched by this script.
 */
async function seedPoLines() {
  const list = await call("GET", "/projects");
  // The list row carries `ios` as a COUNT; the orders themselves are on the detail view.
  const projects = [];
  for (const row of Object.values(list.groups || {}).flat()) {
    try { projects.push(await call("GET", `/projects/${row.id}`)); } catch { /* not ours to see */ }
  }
  const rows = [];
  const vendors = [
    ["Cognex Corporation", "Vision system — cameras and controller"],
    ["Insight Systems Pvt Ltd", "Installation and commissioning"],
    ["Arrow Electronics", "Network switches and optics"],
    ["Blue Ridge Facilities", "Electrical and cabling works"],
    ["Thermo Fisher Scientific", "Cold storage monitoring units"],
  ];
  let po = 4500100000;
  for (const pr of projects) {
    for (const io of (pr.ios || [])) {
      const budget = Number(io.allocatedBudgetUsd) || 0;
      if (!budget) continue;
      // Three lines an order: one invoiced in full, one part-invoiced, one still open. That is
      // the shape that makes Spent, Committed and Still available all mean something on screen.
      const split = [0.45, 0.3, 0.15];
      for (let i = 0; i < split.length; i += 1) {
        po += 7;
        const ordered = Math.round(budget * split[i] / 100) * 100;
        if (!ordered) continue;
        const invoiced = i === 0 ? ordered : i === 1 ? Math.round(ordered * 0.6 / 100) * 100 : 0;
        const v = vendors[(po + i) % vendors.length];
        const d = new Date(Date.now() - (60 - i * 17) * 86400000).toISOString().slice(0, 10);
        rows.push([io.ioNumber, po, (i + 1) * 10, v[0], v[1], ordered, invoiced, ordered - invoiced, d, "USD"]);
      }
    }
  }
  if (!rows.length) return;
  const head = ["Order", "Purchasing Document", "Item", "Vendor", "Short Text", "Net Order Value", "Invoiced", "Still to be Invoiced", "Document Date", "Currency"];
  const csv = [head.join(",")].concat(rows.map((r) => r.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(","))).join("\r\n");
  try {
    const res = await call("POST", "/admin/ingest/po_lines", {
      snapshotId: `demo-po-${new Date().toISOString().slice(0, 10)}`,
      asOfDate: new Date().toISOString().slice(0, 10),
      filename: "demo-po-lines.csv",
      contentBase64: Buffer.from(csv, "utf8").toString("base64"),
      force: true,
    });
    console.log(`  · ${rows.length} purchase-order lines loaded (batch ${res.batchId || "?"}) — so Spent and Committed have something behind them`);
  } catch (e) {
    console.log(`  ! purchase-order lines — ${e.message}`);
  }
}

(async () => {
  console.log(`Seeding demonstration AFEs into ${BASE}`);
  const health = await fetch(BASE + "/health").then((r) => r.json());
  console.log(`  storage ${health.storage} · auth ${health.auth} · docusign ${health.integrations.docusign}`);

  if (RESET) {
    await call("POST", "/admin/reset", {}, ADMIN);
    console.log("  store reset to the seed");
  }

  const existing = await call("GET", "/afes?mine=1", null, ADMIN);
  if (Array.isArray(existing) && existing.length && !RESET) {
    console.log(`  ${existing.length} AFEs are already here — add --reset to start from the seed instead.`);
  }

  let made = 0;
  for (let i = 0; i < CASES.length; i += 1) {
    try { await build(CASES[i], i); made += 1; }
    catch (e) { console.log(`  ! ${CASES[i].title} — ${e.message}`); }
  }
  acting = ADMIN;
  await seedPoLines();
  const mailbox = await call("GET", "/mailbox?limit=1");
  console.log(`\n${made}/${CASES.length} AFEs built · ${mailbox.counts.total} messages in the outbox (${mailbox.counts.queued} waiting to send)`);
  console.log(`Open ${BASE.replace(/\/$/, "")}/requests`);
})().catch((e) => { console.error("\nseed-demo failed:", e.message); process.exit(1); });
