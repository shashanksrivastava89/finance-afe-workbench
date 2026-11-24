"use strict";
// Master data through Excel, end to end (R88).
//
//   node tools/smoke-masters.js            (needs a server on :8080, or SMOKE_BASE)
//
// The promise this suite holds the code to: a person downloads a list, edits it in Excel like
// any other sheet, sends it back, and what they then see in the tool is exactly what they typed
// — with nothing applied until they have seen what it would do, and nothing lost if they are
// wrong. Also that the two doors the business asked NOT to have are shut: an import cannot
// delete, and SAP's own lists cannot be imported at all.
//
// The most important check here is the last one. `excel-saved-roundtrip.xlsx` is a workbook that
// REAL EXCEL wrote — shared strings and all — because the whole feature rests on reading what
// Excel saves, and a reader tested only against its own output proves nothing.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
const ADMIN = "shashank_srivastava@example.com";
const wb = require(path.join(ROOT, "lib/xlsx/workbook"));

let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + detail : "")); }
};
const j = (x) => JSON.stringify(x);

async function call(method, p, body, as) {
  const headers = { "x-ms-client-principal-name": as || ADMIN };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(BASE + "/api" + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let out = null;
  try { out = JSON.parse(text); } catch { out = text; }
  return { status: res.status, body: out };
}
async function download(kind, as) {
  const res = await fetch(`${BASE}/api/admin/masters/${kind}/export.xlsx`,
    { headers: { "x-ms-client-principal-name": as || ADMIN } });
  return { status: res.status, type: res.headers.get("content-type"), disposition: res.headers.get("content-disposition"),
    bytes: Buffer.from(await res.arrayBuffer()) };
}
const upload = (kind, bytes, opts) => call("POST", `/admin/masters/${kind}/import`,
  Object.assign({ contentBase64: bytes.toString("base64"), filename: `afe-master-${kind}.xlsx` }, opts || {}));

(async () => {
  console.log("0. a clean slate");
  const reset = await call("POST", "/admin/reset");
  check("the store resets to the seed", reset.status === 200, j(reset.body).slice(0, 120));

  console.log("1. every master is listed, with who owns it");
  const st = await call("GET", "/admin/masters");
  const byKind = Object.fromEntries((st.body.masters || []).map((m) => [m.kind, m]));
  check("the ten lists are there", Object.keys(byKind).length === 10, Object.keys(byKind).join(", "));
  check("the FX rates are Global Finance's, and start empty", byKind.fx_rates && byKind.fx_rates.systemOfRecord === "global_finance"
    && byKind.fx_rates.rowCount === 0, j(byKind.fx_rates));
  // R96 — the two SAP designations the Asset Acquisition block asks for.
  check("asset classes are the template's 35, and ours to maintain",
    byKind.asset_classes && byKind.asset_classes.rowCount === 35 && byKind.asset_classes.systemOfRecord === "tool",
    j(byKind.asset_classes));
  check("asset lives are the template's 13, each carrying the YEARS it depreciates over",
    byKind.asset_lives && byKind.asset_lives.rowCount === 13, j(byKind.asset_lives));
  const lifeCols = (byKind.asset_lives.columns || []).map((c) => c.name);
  check("the years column is required — a band without a number cannot divide a cost",
    (byKind.asset_lives.columns || []).some((c) => c.name === "years" && c.required), j(lifeCols));
  check("locations carry the template's 150 sites", byKind.locations.rowCount === 150, j(byKind.locations.rowCount));
  check("the approver matrix is marked as SAP's, not ours",
    byKind.matrix.systemOfRecord === "sap" && byKind.locations.systemOfRecord === "tool",
    j({ matrix: byKind.matrix.systemOfRecord, locations: byKind.locations.systemOfRecord }));
  check("nothing has been changed yet", byKind.locations.version === 0, j(byKind.locations.version));

  console.log("2. the export is a workbook, and it is the import format");
  const ex = await download("locations");
  check("it downloads as an .xlsx with a filename", ex.status === 200
    && /spreadsheetml/.test(ex.type) && /afe-master-locations\.xlsx/.test(ex.disposition), j({ status: ex.status, type: ex.type }));
  const sheets = wb.read(ex.bytes);
  check("it carries the data and a README the editor can read",
    sheets.length === 2 && sheets[0].name === "Data" && sheets[1].name === "README" && sheets[1].rows.length > 8,
    j(sheets.map((s) => `${s.name}:${s.rows.length}`)));
  check("the header is the column list, and every site is a row",
    sheets[0].rows[0].join(",") === "code,country,city,active" && sheets[0].rows.length === 151,
    j(sheets[0].rows[0]));
  // The round trip that matters: sending back an untouched export must be a no-op, or nobody
  // can trust the diff on the one they did edit.
  const asIs = await upload("locations", ex.bytes);
  check("sending back an untouched export changes nothing",
    asIs.status === 200 && asIs.body.summary.added === 0 && asIs.body.summary.changed === 0
      && asIs.body.summary.unchanged === 150,
    j(asIs.body.summary));
  check("and a dry run really is dry", asIs.body.applied === false
    && (await call("GET", "/admin/masters")).body.masters.find((m) => m.kind === "locations").version === 0,
    j(asIs.body.applied));

  console.log("3. an edit, seen before it is applied");
  const edited = sheets[0].rows.map((r) => r.slice());
  edited[1][2] = "Dubai (corrected)";                       // a change
  edited[2][3] = "N";                                       // a deactivation
  edited.push(["IND_Gurugram_EMAAR Digital Greens Tower A", "IND", "Gurugram", "Y"]);   // an addition
  const editedBook = wb.write([{ name: "Data", rows: edited, freezeHeader: true, boldFirstRow: true }, sheets[1]]);

  const dry = await upload("locations", editedBook);
  check("the dry run names all three changes", dry.status === 200
    && dry.body.summary.added === 1 && dry.body.summary.changed === 2 && dry.body.summary.deactivated === 1,
    j(dry.body.summary));
  check("a change says which field moved, and from what",
    dry.body.changed.some((c) => c.fields.some((f) => f.field === "city" && f.was === "Dubai" && f.now === "Dubai (corrected)")),
    j(dry.body.changed.map((c) => c.fields)));

  const applied = await upload("locations", editedBook, { apply: true });
  check("applying saves it as a version", applied.status === 200 && applied.body.version === 1, j(applied.body.version));
  const after = (await call("GET", "/admin/masters")).body.masters.find((m) => m.kind === "locations");
  check("the list grew by one and one is now inactive",
    after.rowCount === 151 && after.activeCount === 150 && after.lastChangedBy === ADMIN,
    j({ rows: after.rowCount, active: after.activeCount, by: after.lastChangedBy }));
  const rows = await call("GET", "/admin/masters/locations/rows");
  check("the edit is in the data", rows.body.rows.some((r) => r.city === "Dubai (corrected)"), "");
  check("a deactivated site is kept, not deleted",
    rows.body.rows.some((r) => r.active === "N"), j(rows.body.rows.filter((r) => r.active === "N").length));

  console.log("4. an import adds and updates; it never deletes");
  // The commonest spreadsheet accident: sending back a filtered copy. Three rows must not wipe
  // a hundred and fifty.
  const partial = wb.write([{ name: "Data", rows: [edited[0], edited[1], edited[3]] }]);
  const thin = await upload("locations", partial, { apply: true });
  check("a sheet with three rows leaves the other 148 alone",
    thin.status === 200 && thin.body.summary.absent >= 148,
    j(thin.body.summary));
  const stillThere = (await call("GET", "/admin/masters")).body.masters.find((m) => m.kind === "locations");
  check("nothing was removed", stillThere.rowCount === 151, j(stillThere.rowCount));

  console.log("5. a bad sheet is refused, with the spreadsheet's own row numbers");
  const rulesEx = await download("org_rules");
  const rules = wb.read(rulesEx.bytes)[0].rows.map((r) => r.slice());
  rules[1][1] = "not_a_kind";                                // bad enum on row 2
  rules.push(rules[2].slice());                              // a duplicate id
  rules.push(["", "pre_approver", "", "", "", "", "", "definitely-not-a-mailbox", "", "", "", "", "", "", "Y", ""]);
  const bad = await upload("org_rules", wb.write([{ name: "Data", rows: rules }]));
  check("three problems are found and each names its row",
    bad.body.summary.errors === 3 && bad.body.errors.every((e) => e.line >= 2),
    j(bad.body.errors.map((e) => [e.line, e.problems[0]])));
  check("the messages say what is wrong in words",
    bad.body.errors.some((e) => /kind must be one of/.test(e.problems.join(" ")))
      && bad.body.errors.some((e) => /each row must be unique/.test(e.problems.join(" ")))
      && bad.body.errors.some((e) => /Acme mailbox/.test(e.problems.join(" "))),
    j(bad.body.errors.map((e) => e.problems)));
  const badApply = await upload("org_rules", wb.write([{ name: "Data", rows: rules }]), { apply: true });
  check("and none of it is applied — all of the sheet, or none of it",
    badApply.status === 422 && (await call("GET", "/admin/masters")).body.masters.find((m) => m.kind === "org_rules").version === 0,
    j({ status: badApply.status, error: badApply.body.error }));

  console.log("6. a missing column is refused before anything is read");
  const noKey = wb.write([{ name: "Data", rows: [["country", "city"], ["IND", "Pune"]] }]);
  const missing = await upload("locations", noKey);
  check("it says which column is missing and where to get a correct file",
    missing.status === 422 && /missing these columns: code/.test(missing.body.error) && /export/i.test(missing.body.error),
    j(missing.body.error));

  console.log("7. SAP's lists are readable, never writable");
  const mx = await download("matrix");
  check("the approver matrix exports, all 1,197 cost centres",
    mx.status === 200 && wb.read(mx.bytes)[0].rows.length === 1198, j(mx.status));
  const refused = await upload("matrix", mx.bytes, { apply: true });
  check("and importing it is refused, because SAP owns it",
    refused.status === 409 && /extract/.test(refused.body.error), j(refused.body.error));

  console.log("8. one row changed in the screen versions like an import");
  const locRows = (await call("GET", "/admin/masters/locations/rows")).body.rows;
  const target = locRows.find((r) => r.active !== "N");
  const patched = await call("PATCH", `/admin/masters/locations/rows/${target._id}`, { active: "N" });
  check("deactivating one row is a version of its own",
    patched.status === 200 && patched.body.fields.some((f) => f.field === "active" && f.now === "N") && patched.body.version > 1,
    j(patched.body));
  const versions = await call("GET", "/admin/masters/locations/versions");
  check("the history says who did what and when",
    versions.body.versions.length >= 3 && versions.body.versions[0].byEmail === ADMIN
      && versions.body.versions.some((v) => v.source === "import") && versions.body.versions.some((v) => v.source === "edit"),
    j(versions.body.versions.map((v) => [v.version, v.source])));

  console.log("9. a bad import is one click to undo");
  const first = versions.body.versions[versions.body.versions.length - 1];
  const restored = await call("POST", `/admin/masters/locations/versions/${first.id}/restore`);
  check("restoring an earlier version puts the rows back",
    restored.status === 200 && restored.body.restoredFrom === first.version, j(restored.body.summary));
  check("as a NEW version — the history is added to, never rewritten",
    restored.body.version.version > versions.body.versions[0].version,
    j({ was: versions.body.versions[0].version, now: restored.body.version.version }));

  console.log("10. only an administrator");
  for (const [who, label] of [["aiden-mulqueeny_crilly@example.com", "a coordinator"], ["judithmelanie_ware@example.com", "Fixed Assets"]]) {
    const r = await call("GET", "/admin/masters", null, who);
    check(`${label} cannot read the master data`, r.status === 403, j(r.status));
  }

  console.log("11. a workbook REAL EXCEL saved, read back");
  // Everything above proves the reader understands its own writer, which is the easy half. This
  // file came out of Excel itself — shared strings, its own styles, its own part ordering.
  const fixture = path.join(ROOT, "tools/fixtures/excel-saved-roundtrip.xlsx");
  check("the fixture is committed", fs.existsSync(fixture), fixture);
  if (fs.existsSync(fixture)) {
    const real = wb.read(fs.readFileSync(fixture));
    const data = real.find((s) => s.name === "Data");
    check("both sheets survive Excel's own save", real.length === 2 && Boolean(data), j(real.map((s) => s.name)));
    check("shared strings resolve to the text a person typed",
      data.rows[1][1] === "Edited in real Excel", j(data.rows[1]));
    check("a leading zero is still a leading zero, not a number",
      data.rows[2][0] === "0123", j(data.rows[2][0]));
    check("quotes, ampersands and angle brackets come back intact",
      data.rows[3][0] === "odd & <chars>" && data.rows[3][1] === `quote "x" and 'y'`, j(data.rows[3]));
  }

  console.log("12. Global Finance's FX workbook, read in THEIR layout (R161)");
  // Their monthly file carries each rate twice — RATE and REVERSE — for this month and the one
  // before, under a title naming the month. These figures are test data in that shape.
  const gf = (title, pairs, swap) => {
    const rate = (x) => String(swap ? 1 / x : x), rev = (x) => String(swap ? x : 1 / x);
    const rows = [
      ["Acme Life Sciences — Monthly FX Rates"], [title], [],
      ["", "", pairs[0], "", pairs[1], ""],
      ["Currency", "Description", "RATE", "REVERSE", "RATE", "REVERSE"],
      ["USD", "US Dollar", "1", "1", "1", "1"],
    ];
    for (const [code, name, now, before] of [["SGD", "Singapore Dollar", 1.286505, 1.2901], ["INR", "Indian Rupee", 87.9, 87.4],
      ["IDR", "Indonesian Rupiah", 16310, 16220], ["KRW", "South Korean Won", 1391.2, 1388.4], ["EUR", "Euro", 0.8573, 0.8611], ["GBP", "British Pound", 0.7412, 0.7466]]) {
      rows.push([code, name, rate(now), rev(now), rate(before), rev(before)]);
    }
    return wb.write([{ name: "FX Rates", rows }]);
  };
  const aug = gf("For The Month of August 2026", ["August 2026", "July 2026"], false);
  const seen = await upload("fx_rates", aug);
  check("their workbook is read as it comes, and nothing is saved until it has been seen",
    seen.status === 200 && seen.body.summary.added === 7 && !seen.body.applied, j(seen.body.summary || seen.body));
  check("it says which month, which columns and which way the rate runs — and why",
    seen.body.source && /August 2026/.test(seen.body.source.note) && /RATE is local currency per US dollar/.test(seen.body.source.note)
      && /INR/.test(seen.body.source.note), j(seen.body.source));
  const augApplied = await upload("fx_rates", aug, { apply: true });
  const fxRows = (await call("GET", "/admin/masters/fx_rates/rows")).body.rows;
  const sgdAug = fxRows.find((r) => r.month_code === "2026-08|SGD");
  check("applied: this month's rate, not last month's, local currency per dollar",
    augApplied.status === 200 && sgdAug && Number(sgdAug.local_per_usd) === 1.286505 && fxRows.length === 7, j(sgdAug));
  // The same rates the other way round: RATE is dollars per unit. Read from the figures, not assumed.
  const sep = gf("For The Month of September 2026", ["September 2026", "August 2026"], true);
  const sepSeen = await upload("fx_rates", sep, { apply: true });
  const sgdSep = (await call("GET", "/admin/masters/fx_rates/rows")).body.rows.find((r) => r.month_code === "2026-09|SGD");
  check("a sheet whose RATE runs the other way is read the right way round, and says so",
    sepSeen.status === 200 && /REVERSE is local currency per US dollar/.test(sepSeen.body.source.note)
      && sgdSep && Math.abs(Number(sgdSep.local_per_usd) - 1.286505) < 1e-9, j({ note: sepSeen.body.source && sepSeen.body.source.note, sgd: sgdSep }));
  check("every month is kept", (await call("GET", "/admin/masters/fx_rates/rows")).body.rows.length === 14);
  const refd = (await call("GET", "/refdata")).body.fx;
  check("the newest month is what the wizard offers — the dollar itself is not a choice",
    refd && refd.month === "2026-09" && refd.rates.length === 6 && refd.rates.some((r) => r.code === "SGD") && !refd.rates.some((r) => r.code === "USD"), j(refd && refd.month));
  const broken = wb.write([{ name: "FX", rows: [["For The Month of October 2026"], ["Code", "Name", "RATE", "REVERSE"],
    ["SGD", "Singapore Dollar", "1.29", "0.5"], ["INR", "Indian Rupee", "88", String(1 / 88)]] }]);
  const badSeen = await upload("fx_rates", broken, { apply: true });
  check("a RATE and REVERSE that disagree are refused with the sheet's own row, and nothing applies",
    badSeen.status === 422 && (badSeen.body.detail || []).some((e) => e.line === 3 && /do not describe the same rate/.test(e.problems.join(" "))),
    j(badSeen.body));
  const notTheirs = await upload("fx_rates", wb.write([{ name: "Sheet1", rows: [["a", "b"], ["1", "2"]] }]));
  check("a workbook that is not theirs is refused, saying what was looked for", notTheirs.status === 422 && /RATE and a REVERSE/.test(notTheirs.body.error), j(notTheirs.body));
  const editFx = await call("PATCH", `/admin/masters/fx_rates/rows/${fxRows[0]._id}`, { local_per_usd: "2" });
  check("and a rate is never edited here, row by row", editFx.status === 409 && /Global Finance/.test(editFx.body.error), j(editFx.body));

  console.log("13. an AFE in another currency carries Global Finance's rate, never a typed one (R161)");
  const cur = (await call("POST", "/afes")).body.afe.id;
  await call("PATCH", `/afes/${cur}`, { "project.title": "IH 500 cooling unit", costCenter: "30145", "money.classification": "capex", "money.capexUsd": 20020 });
  const sgd = await call("PATCH", `/afes/${cur}`, { "money.currency": "sgd" });
  check("picking SGD attaches the newest month's rate from the master",
    sgd.status === 200 && sgd.body.afe.money.currency === "SGD" && sgd.body.afe.money.fx
      && Math.abs(sgd.body.afe.money.fx.localPerUsd - 1.286505) < 1e-9 && sgd.body.afe.money.fx.month === "2026-09"
      && sgd.body.afe.money.fx.source === "global_finance", j(sgd.body.afe && sgd.body.afe.money));
  const typed = await call("PATCH", `/afes/${cur}`, { "money.fx": { localPerUsd: 9 } });
  check("the rate itself cannot be typed", typed.status === 200 && typed.body.ignored.includes("money.fx")
    && Math.abs(typed.body.afe.money.fx.localPerUsd - 1.286505) < 1e-9, j(typed.body.ignored));
  const nope = await call("PATCH", `/afes/${cur}`, { "money.currency": "XYZ" });
  check("a currency Global Finance has no rate for is refused, and nothing changes",
    nope.status === 422 && /no rate for XYZ/.test(nope.body.error)
      && (await call("GET", `/afes/${cur}`)).body.afe.money.currency === "SGD", j(nope.body));
  const form = (await call("GET", `/afes/${cur}/form.json`)).body;
  check("the form prints the rate and the local amounts — AFE 313453's own arithmetic, $20,020 is SGD 25,756",
    form.money && form.money.fxRate === "1.286505" && form.money.capexLc === "25,756" && form.money.totalCapexLc === "25,756"
      && form.money.opexLc === "-", j(form.money && { r: form.money.fxRate, c: form.money.capexLc, o: form.money.opexLc }));
  check("and Project Details says which currency, whose rate, and that USD is what is approved",
    form.details && form.details.hasLocalCurrency === true && /^SGD · 1 USD = 1\.286505 SGD · Global Finance, September 2026 month-end/.test(form.details.localCurrency)
      && /approved figure is USD/.test(form.details.localCurrency), j(form.details && form.details.localCurrency));
  const back = await call("PATCH", `/afes/${cur}`, { "money.currency": "USD" });
  const formUsd = (await call("GET", `/afes/${cur}/form.json`)).body;
  check("back to US dollars, the rate goes and the form is the one it always was",
    back.status === 200 && back.body.afe.money.fx === null && formUsd.money.fxRate === "" && formUsd.money.capexLc === "-"
      && formUsd.details.hasLocalCurrency === false, j({ fx: back.body.afe.money.fx, r: formUsd.money.fxRate }));
  await call("DELETE", `/afes/${cur}`);

  console.log("14. their file as it really is: by country, a bare month, a row they do not price");
  // Global Finance's own sheet (8fx2026.xlsm, as previewed on 2026-09-25): the title names the
  // month, the two pairs are labelled "(August)" and "(July)" under CURRENT and PRIOR MONTH-END,
  // and the rates are listed BY COUNTRY — the euro once for every euro country. A January file's
  // prior pair is "(December)", of the year before. These figures are test data in that shape;
  // only previews run here, so nothing above is disturbed.
  {
    const real = (rows) => wb.write([{ name: "RATES", rows }]);
    const head = (title, now, before) => [
      ["EXCHANGE RATES to the US DOLLAR"], [title], [],
      ["", "", "CURRENT MONTH-END", "", "PRIOR MONTH-END", ""],
      ["Currency", "", `(${now})`, "", `(${before})`, ""],
      ["Code", "", "RATE", "REVERSE", "RATE", "REVERSE"],
    ];
    const line = (code, country, now, before) => [code, country, String(now), String(1 / now), String(before), String(1 / before)];
    const jan = real(head("For The Month of January 2027", "January", "December").concat([
      line("AUD", "Australia", 1.5321, 1.5402),
      line("EUR", "Austria", 0.8573, 0.8611), line("EUR", "Belgium", 0.8573, 0.8611), line("EUR", "France", 0.8573, 0.8611), line("EUR", "Germany", 0.8573, 0.8611),
      line("INR", "India", 87.9, 87.4),
      ["VND", "Vietnam", "26150", "0.00004", "26100", "0.00004"],
      ["VES", "Venezuela", "", "", "", ""],
      line("SGD", "Singapore", 1.2871, 1.2865),
      ["USD", "United States", "1", "1", "1", "1"], ["USD", "Puerto Rico", "1", "1", "1", "1"],
    ]));
    const js = await upload("fx_rates", jan);
    const keys = (js.body.added || []).map((a) => String(a.key).toUpperCase());       // the importer compares keys lower-cased
    const note = (js.body.source && js.body.source.note) || "";
    check("their layout is read: the (January) pair is this month's, and nothing lands as December",
      js.status === 200 && js.body.ok && keys.includes("2027-01|SGD") && !keys.some((k) => k.startsWith("2026-12")) && /January 2027 columns/.test(note),
      j({ keys, note, errors: js.body.errors }));
    const eur = (js.body.added || []).find((a) => String(a.key).toUpperCase() === "2027-01|EUR");
    check("the euro listed for four countries is ONE rate, and the note says so",
      keys.filter((k) => k === "2027-01|EUR").length === 1 && eur && eur.doc.name === "Austria, Belgium, France and 1 more" && /EUR \(4\)/.test(note),
      j(eur && eur.doc));
    check("a country they list and do not price is left out and named, not a reason to refuse the rest",
      !keys.includes("2027-01|VES") && /Left out: VES \(Venezuela\) row \d+, no rate for this month/.test(note), note);
    check("a small side written to five places is rounding, not a contradiction", keys.includes("2027-01|VND"), j(js.body.errors));
    const clash = real(head("For The Month of January 2027", "January", "December").concat([
      line("EUR", "Austria", 0.8573, 0.8611), line("EUR", "Belgium", 0.8753, 0.8611), line("INR", "India", 87.9, 87.4)]));
    const cs = await upload("fx_rates", clash);
    check("the same code at two different rates is refused, naming both rows",
      cs.status === 200 && cs.body.ok === false && cs.body.errors.some((e) => e.key === "EUR" && /0\.8753 here \(Belgium\) and 0\.8573 on row 7 \(Austria\)/.test(e.problems.join(" "))),
      j(cs.body.errors));
  }

  console.log("");
  console.log(failures ? `${failures} CHECK(S) FAILED` : "ALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error("\nsuite crashed:", e.message);
  console.error(`(is the server up on ${BASE}? start it with: node tools/run-local.js)`);
  process.exit(1);
});
