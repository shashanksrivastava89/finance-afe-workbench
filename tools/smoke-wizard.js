"use strict";
// Stage 1 gate: the wizard's API. Walks the APAC hardware refresh end to end the way the
// browser will — create a draft, autosave one field at a time, attach a quote, and read
// the validation back — then proves the guards.
//
//   node tools/smoke-wizard.js      (needs a server on :8080)
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + detail : "")); }
};

async function call(method, p, body) {
  const res = await fetch(BASE + "/api" + p, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let out = null;
  const text = await res.text();
  try { out = JSON.parse(text); } catch { out = text; }
  return { status: res.status, body: out };
}
const patch = (id, obj) => call("PATCH", `/afes/${id}`, obj);
const blocked = (v, id) => v.blocks.some((e) => e.rule === id || e.field === id);
const pending = (v, id) => v.pending.some((e) => e.rule === id || e.field === id);
const warned = (v, id) => v.warns.some((e) => e.rule === id || e.field === id);

// A minimal valid PDF, so the upload path is exercised for real.
const PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
).toString("base64");

(async () => {
  console.log("0. a clean slate");
  // Another suite may have left approved AFEs drawing on the same budget pot — start from the seed.
  const reset = await call("POST", "/admin/reset");
  check("the store resets to the seed", reset.status === 200 && reset.body.ok === true, JSON.stringify(reset.body).slice(0, 120));

  console.log("1. a draft is created and autosaves field by field");
  const created = await call("POST", "/afes");
  check("POST /afes returns a draft", created.status === 201 && created.body.afe.state === "draft",
    JSON.stringify(created.body).slice(0, 140));
  const id = created.body.afe.id;
  check("the draft opens with blocks, not an error", created.body.validation.blocks.length > 0 && created.body.validation.ok === false);
  // "New AFE" pressed again with nothing typed reopens the same blank draft, and a blank draft
  // is not listed — UAT kept an "(untitled)" AFE from a page somebody opened and left.
  const again = await call("POST", "/afes");
  const listed = (await call("GET", "/afes?mine=1")).body.map((a) => a.id);
  check("a second New AFE with nothing typed reopens the same draft, and it is not listed yet",
    again.status === 200 && again.body.afe.id === id && !listed.includes(id), { status: again.status, id: again.body.afe.id, listed: listed.includes(id) });

  let r = await patch(id, { "project.title": "PC Hardware Lifecycle Replacement APAC" });
  check("one field saves and comes back validated", r.status === 200 && r.body.afe.project.title.startsWith("PC Hardware"),
    JSON.stringify(r.body).slice(0, 140));
  check("the title no longer blocks", !blocked(r.body.validation, "project.title"));

  r = await patch(id, { "project.title": "GCO Americas Field Sales QX700 Fiber Case" }); // 41 chars
  check("a 41-character title is blocked inline (SAP keeps 40)", blocked(r.body.validation, "project.title"),
    JSON.stringify(r.body.validation.blocks.map((e) => e.field)));
  await patch(id, { "project.title": "PC Hardware Lifecycle Replacement APAC" });

  console.log("2. the cost centre pulls division, plant and the coordinator");
  r = await patch(id, { costCenter: "30145" });
  check("plant comes from the SAP matrix", r.body.afe.plant === "3026", `plant=${r.body.afe.plant}`);
  check("the cost centre is not a block once it is known", !blocked(r.body.validation, "costCenter") && !pending(r.body.validation, "cost_center_active"),
    JSON.stringify(r.body.validation.pending.map((e) => e.rule)));

  r = await patch(id, { costCenter: "99999" });
  check("an unknown cost centre is pending, never a hard failure",
    pending(r.body.validation, "cost_center_active") && !blocked(r.body.validation, "cost_center_active"),
    JSON.stringify(r.body.validation.pending.map((e) => e.rule)));
  await patch(id, { costCenter: "30145" });

  console.log("3. classification and the cost lines behave");
  r = await patch(id, {
    "money.classification": "capex",
    "money.capexUsd": 215000,
    "money.cloudCapexUsd": 1200,
  });
  check("CapEx and Cloud CapEx together are blocked", blocked(r.body.validation, "classification_exclusive"),
    JSON.stringify(r.body.validation.blocks.map((e) => e.rule)));
  r = await patch(id, { "money.cloudCapexUsd": 0 });
  check("clearing the Cloud CapEx amount clears the block", !blocked(r.body.validation, "classification_exclusive"));

  r = await patch(id, { "money.lines": [
    { site: "South Korea", country: "KR", amountUsd: 30000 },
    { site: "Japan", country: "JP", amountUsd: 30000 },
  ] });
  check("cost lines that do not add up to the total are blocked", blocked(r.body.validation, "lines_sum_to_total"),
    JSON.stringify(r.body.validation.blocks.map((e) => e.rule)));
  r = await patch(id, { "money.lines": [
    { site: "South Korea", country: "KR", amountUsd: 30000 },
    { site: "Japan", country: "JP", amountUsd: 30000 },
    { site: "Singapore MFG", country: "SG", amountUsd: 30000 },
    { site: "Singapore DC", country: "SG", amountUsd: 20000 },
    { site: "Singapore GCO", country: "SG", amountUsd: 49000 },
    { site: "Australia", country: "AU", amountUsd: 20000 },
    { site: "India", country: "IN", amountUsd: 36000 },
  ] });
  check("seven country lines totalling 215,000 are accepted", !blocked(r.body.validation, "lines_sum_to_total"),
    JSON.stringify(r.body.validation.blocks.map((e) => e.rule)));

  console.log("4. the rest of the wizard, then the quote");
  r = await patch(id, {
    location: "SGP_Singapore_Site 5",
    region: "APAC",
    "project.projectType": "Office Equip/Furniture",
    "project.description": "The hardware refresh project will be used to stock inventory in APAC for FY 2026.",
    "project.justification": "Laptops, desktops and monitors past their lifecycle are replaced across seven APAC sites.",
    "project.surplusChecked": "Yes",
    "project.buyVsLease": "N/A",
    "project.assistAsset": "No",
    "schedule.startDate": "2026-09-01",
    "schedule.finishDate": "2026-12-30",
    "schedule.fiscalYear": 2026,
    "budget.budgeted": "Yes",
    "budget.potId": "pot-0003",
  });
  check("only the quote is still outstanding",
    r.body.validation.blocks.length === 1 && blocked(r.body.validation, "quote_present"),
    JSON.stringify(r.body.validation.blocks.map((e) => e.rule || e.field)));

  const up = await call("POST", `/afes/${id}/documents`, { filename: "APAC_HW_estimate.pdf", role: "quote", contentBase64: PDF });
  check("a PDF quote attaches", up.status === 201 && up.body.afe.documents.length === 1, JSON.stringify(up.body).slice(0, 140));
  check("with no total typed, coverage is pending — not a failure", pending(up.body.validation, "quote_covers_estimate"),
    JSON.stringify(up.body.validation.pending.map((e) => e.rule)));
  const attId = up.body.attachmentId;

  r = await call("PATCH", `/afes/${id}/documents/${attId}`, { vendor: "Multiple vendors", amountUsd: 70000 });
  check("a quote covering 33% warns with the figure stated, and does not block Send",
    r.body.validation.warns.some((e) => e.rule === "quote_covers_estimate" && /33%/.test(e.message))
      && !r.body.validation.blocks.some((e) => e.rule === "quote_covers_estimate"),
    JSON.stringify(r.body.validation.warns.filter((e) => e.rule === "quote_covers_estimate").map((e) => e.message)));

  // R69: the requester says why, and the reason travels with the flag from here on.
  const noted = await call("PUT", `/afes/${id}/flag-notes`,
    { ruleId: "quote_covers_estimate", note: "Phased purchase — the rest is quoted next quarter." });
  check("a justification saves against the flag and comes back on it",
    noted.status === 200
      && (noted.body.validation.warns.find((e) => e.rule === "quote_covers_estimate") || {}).note
         === "Phased purchase — the rest is quoted next quarter."
      && noted.body.validation.exceptions.length === 1,
    JSON.stringify(noted.body.validation.exceptions));
  const badNote = await call("PUT", `/afes/${id}/flag-notes`, { ruleId: "quote_present", note: "later" });
  check("a note cannot be attached to a blocking rule", badNote.status === 422, JSON.stringify(badNote.body).slice(0, 120));
  await call("PUT", `/afes/${id}/flag-notes`, { ruleId: "quote_covers_estimate", note: "" });

  r = await call("PATCH", `/afes/${id}/documents/${attId}`, { amountUsd: 215000 });
  check("the AFE is submittable once the quote covers the estimate",
    r.body.validation.ok === true && r.body.validation.sendable === true,
    JSON.stringify(r.body.validation.blocks.concat(r.body.validation.pending)));

  console.log("5. uploads are guarded");
  const notPdf = await call("POST", `/afes/${id}/documents`, { filename: "notes.txt", contentBase64: Buffer.from("hello").toString("base64") });
  check("a non-PDF is refused with a readable reason", notPdf.status === 415 && /not a PDF/.test(notPdf.body.error), JSON.stringify(notPdf.body));
  const dupe = await call("POST", `/afes/${id}/documents`, { filename: "same-file-again.pdf", contentBase64: PDF });
  check("the same file twice is refused", dupe.status === 409 && /already attached/.test(dupe.body.error), JSON.stringify(dupe.body));

  console.log("5b. equipment from Acme's own inventory, and a screenshot is a document (R150, R151)");
  // AFE 313147 (QX700 ddPCR, Site H): no vendor quote, because nothing was bought. A Acme
  // quotation prices it and a screenshot of the material in SAP shows what it is.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const PNG2 = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNgCFhwQoOLAUIBABr4A9XX6wQrAAAAAElFTkSuQmCC";
  const PDF2 = Buffer.from("%PDF-1.4\n% Acme quotation\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");
  const inv = (await call("POST", "/afes")).body.afe.id;
  await call("PATCH", `/afes/${inv}`, { "project.title": "QX700 ddPCR from inventory", "project.projectType": "New Equipment",
    "money.classification": "capex", "money.capexUsd": 240000 });
  const rulesOf = (v) => v.blocks.map((b) => b.rule);
  let iv = (await call("GET", `/afes/${inv}`)).body.validation;
  check("where it comes from is asked of equipment", iv.applies.sourcing === true, JSON.stringify(iv.applies));
  check("and it is an outside vendor until said otherwise: the vendor quote is what is missing",
    rulesOf(iv).includes("quote_present") && !rulesOf(iv).includes("material_evidence_present"), JSON.stringify(rulesOf(iv)));
  iv = (await call("PATCH", `/afes/${inv}`, { sourcing: "internal" })).body.validation;
  check("from Acme inventory, it needs Acme's own quotation and the material in SAP",
    rulesOf(iv).includes("quote_present") && rulesOf(iv).includes("material_evidence_present"), JSON.stringify(rulesOf(iv)));
  const iq = await call("POST", `/afes/${inv}/documents`, { filename: "BR-Quotation-QX700.pdf", role: "internal_quote", contentBase64: PDF2, amountUsd: 240000 });
  const iqDoc = iq.body.afe && iq.body.afe.documents.find((d) => d.role === "internal_quote");
  check("a Acme quotation attaches, priced by Acme", iq.status === 201 && iqDoc && iqDoc.vendor === "Acme", JSON.stringify(iq.body.error || iqDoc));
  check("it is the quote, and it counts toward coverage", !rulesOf(iq.body.validation).includes("quote_present") && iq.body.quoteTotalUsd === 240000,
    JSON.stringify({ rules: rulesOf(iq.body.validation), quoteTotal: iq.body.quoteTotalUsd }));
  check("without the SAP material it still cannot go", rulesOf(iq.body.validation).includes("material_evidence_present"));
  const shot = await call("POST", `/afes/${inv}/documents`, { filename: "Display-Material-12025219.png", role: "material_evidence", contentBase64: PNG });
  const shotDoc = shot.body.afe && shot.body.afe.documents.find((d) => d.role === "material_evidence");
  check("a PNG screenshot attaches, stored as what it is (R151)", shot.status === 201 && shotDoc && shotDoc.mimeType === "image/png", JSON.stringify(shot.body.error || shotDoc));
  check("and nothing about where it comes from blocks any more",
    !rulesOf(shot.body.validation).some((r) => ["quote_present", "material_evidence_present"].includes(r)), JSON.stringify(rulesOf(shot.body.validation)));
  const pngQuote = await call("POST", `/afes/${inv}/documents`, { filename: "vendor-quote-screenshot.png", role: "quote", contentBase64: PNG2 });
  check("a vendor quote may be a picture too", pngQuote.status === 201, JSON.stringify(pngQuote.body.error));
  const soft = (await call("PATCH", `/afes/${inv}`, { "money.classification": "cloud_capex", "money.capexUsd": null, "money.cloudCapexUsd": 240000 })).body.validation;
  check("software is never asked, and an answer given before does not count",
    soft.applies.sourcing === false && !rulesOf(soft).includes("material_evidence_present"), JSON.stringify({ applies: soft.applies, rules: rulesOf(soft) }));
  const mineInv = await call("GET", "/afes?sourcing=internal");
  check("a list can be filtered to what came from inventory", mineInv.status === 200 && !mineInv.body.some((x) => x.id === inv),
    JSON.stringify(mineInv.body.map((x) => [x.id, x.sourcing])));
  await call("PATCH", `/afes/${inv}`, { "money.classification": "capex", "money.cloudCapexUsd": null, "money.capexUsd": 240000 });
  check("...and finds it again once it is equipment", (await call("GET", "/afes?sourcing=internal")).body.some((x) => x.id === inv && x.sourcing === "internal"));

  console.log("6. the view, the clone and the guards");
  const full = await call("GET", `/afes/${id}`);
  check("GET /afes/:id carries validation, band, cost centre and permissions",
    full.body.validation && full.body.band.label === "$100,001 – $300,000" && full.body.costCentre.description &&
    full.body.permissions.canEdit === true,
    JSON.stringify({ band: full.body.band.label, cc: full.body.costCentre && full.body.costCentre.description }));
  check("the coordinator for IT is resolved from the org rules",
    full.body.afe.coordinator && /Aiden/.test(full.body.afe.coordinator.name), JSON.stringify(full.body.afe.coordinator));
  check("the budget pot shows what is left, and what this AFE would take",
    full.body.pot && full.body.pot.remainingUsd === full.body.pot.amountUsd &&
    full.body.pot.thisAfeUsd === 215000 &&
    full.body.pot.remainingAfterThisUsd === full.body.pot.amountUsd - 215000,
    JSON.stringify(full.body.pot && { amount: full.body.pot.amountUsd, remaining: full.body.pot.remainingUsd, thisAfe: full.body.pot.thisAfeUsd }));

  const clone = await call("POST", `/afes/${id}/clone`, { region: "EMEA" });
  check("cloning for another region copies the story and clears the money and cost centre",
    clone.status === 201 && clone.body.afe.project.title === full.body.afe.project.title &&
    clone.body.afe.region === "EMEA" && !clone.body.afe.money.capexUsd &&
    clone.body.afe.money.lines.length === 0 && clone.body.afe.costCenter === null,
    JSON.stringify({ title: clone.body.afe.project.title, region: clone.body.afe.region, cc: clone.body.afe.costCenter }));

  // A near-identical AFE on the SAME cost centre is what the duplicate rule is for. The
  // clone does not trigger it, because a clone is for a different region and so a
  // different cost centre — which is the point of cloning.
  const twin = await call("POST", "/afes");
  await patch(twin.body.afe.id, { costCenter: "30145", "project.title": "PC Hardware Lifecycle Replacement APAC 4Q" });
  const dup = await call("GET", `/afes/${twin.body.afe.id}`);
  check("a similar open AFE on the same cost centre is warned about, never blocked",
    dup.body.possibleDuplicates.some((d) => d.id === id) && warned(dup.body.validation, "duplicate_open_request") &&
    !dup.body.validation.blocks.some((e) => e.rule === "duplicate_open_request"),
    JSON.stringify(dup.body.possibleDuplicates.map((d) => d.id)));

  const rogue = await patch(id, { state: "issued", afeNo: "999999", "project.title": "still writable" });
  check("a PATCH cannot set state or the AFE number",
    rogue.body.afe.state === "draft" && rogue.body.afe.afeNo === null && rogue.body.ignored.includes("state"),
    JSON.stringify({ state: rogue.body.afe.state, ignored: rogue.body.ignored }));

  const list = await call("GET", "/afes?mine=1");
  check("the AFE appears in the requester's own list", list.status === 200 && list.body.some((x) => x.id === id),
    JSON.stringify((list.body || []).map((x) => x.id)));

  console.log("7. what the screen shows is what will be sent (R115)");
  {
    // The review screen is titled "this is what they sign", so the PDF on it has to BE that —
    // the form with every attachment bound in behind it, assembled by the same function the
    // send uses. It pointed at `form.pdf` and showed the form alone, with a Documents table
    // saying "Attached to this AFE" about a quote that was about to be bound in. Reported as
    // "the attached vendor quote was not appended", which is exactly what it looked like.
    const pagesIn = async (path) => {
      const r = await fetch(`${BASE}/api${path}`);
      const b = Buffer.from(await r.arrayBuffer());
      return { status: r.status, pages: (b.toString("latin1").match(/\/Type\s*\/Page[^s]/g) || []).length };
    };
    const form = await pagesIn(`/afes/${id}/form.pdf`);
    const packet = await pagesIn(`/afes/${id}/packet.pdf`);
    check("the preview is served and is longer than the form alone",
      packet.status === 200 && form.status === 200 && packet.pages > form.pages,
      JSON.stringify({ form: form.pages, packet: packet.pages }));
    check("by exactly the pages of what was attached",
      packet.pages === form.pages + 1, JSON.stringify({ form: form.pages, packet: packet.pages }));
  }

  console.log("8. an answer that a later change invalidates is cleared, and said (R115)");
  {
    // A budget pot is a pointer into a list the division and the region decide. Changing the
    // cost centre can leave it pointing at a pot nobody is offering any more — and it stays
    // SELECTED, which is worse than wrong, because it looks like somebody chose it.
    const it = await call("POST", "/afes");
    const mine = it.body.afe.id;
    await call("PATCH", `/afes/${mine}`, { "project.title": "Pot clearing", costCenter: "30145" });
    const pots = await call("GET", "/pots?division=CORP_IT");
    const pot = (pots.body.pots || [])[0];
    check("there is a pot to pick", Boolean(pot), JSON.stringify((pots.body.pots || []).length));
    const set = await call("PATCH", `/afes/${mine}`, { "budget.potId": pot.id });
    check("picking one keeps it", set.body.afe.budget.potId === pot.id && (set.body.cleared || []).length === 0,
      JSON.stringify({ pot: set.body.afe.budget.potId, cleared: set.body.cleared }));
    const moved = await call("PATCH", `/afes/${mine}`, { costCenter: "30146" });
    check("moving the AFE to another division clears it",
      moved.body.afe.division !== "CORP_IT" && moved.body.afe.budget.potId === null,
      JSON.stringify({ division: moved.body.afe.division, pot: moved.body.afe.budget.potId }));
    check("and says which pot went, and why — silently un-picking it would be worse",
      (moved.body.cleared || []).length === 1 && moved.body.cleared[0].field === "budget.potId"
        && /cost centre/.test(moved.body.cleared[0].because) && Boolean(moved.body.cleared[0].label),
      JSON.stringify(moved.body.cleared));
    await call("DELETE", `/afes/${mine}`);
  }

  {
    // "Other" in words, and what a pot has left only for those who manage pots (R167): "There
    // should be one option for other as well… which [budget] does it come out of?" (Judithmelanie, UAT
    // review 2026-10-14), and "I don't know if requesters should have this visibility, or how much
    // is left in the [pot]" (Shashank) — "Right, right" (Lyndsay).
    const it = await call("POST", "/afes");
    const mine = it.body.afe.id;
    await call("PATCH", `/afes/${mine}`, { "project.title": "Other budget", costCenter: "30145", "budget.budgeted": "Yes" });
    const other = await call("PATCH", `/afes/${mine}`, { "budget.potId": "other" });
    const asked = (other.body.validation.warns || []).find((w) => w.rule === "budget_pot_when_budgeted");
    check("Other with nothing typed asks which budget, on the line itself (R167)", asked && asked.field === "budget.otherBudget", JSON.stringify(asked));
    const said = await call("PATCH", `/afes/${mine}`, { "budget.otherBudget": "Facilities FY26 maintenance budget" });
    check("…and saying it answers the question, kept on the AFE",
      said.body.afe.budget.potId === "other" && said.body.afe.budget.otherBudget === "Facilities FY26 maintenance budget"
        && !(said.body.validation.warns || []).some((w) => w.rule === "budget_pot_when_budgeted"), JSON.stringify(said.body.afe.budget));
    const moved = await call("PATCH", `/afes/${mine}`, { costCenter: "30146" });
    check("a new cost centre leaves Other alone — it is words, not a pointer into the pot list",
      moved.body.afe.budget.potId === "other" && !(moved.body.cleared || []).length, JSON.stringify({ b: moved.body.afe.budget, c: moved.body.cleared }));
    const sheet = (await call("GET", `/afes/${mine}/form.json`)).body;
    check("the on-screen sheet names it as the budget", /^Other: Facilities FY26 maintenance budget/.test((sheet.budget && sheet.budget.potNote) || ""),
      JSON.stringify(sheet.budget && sheet.budget.potNote));
    const real = (await call("GET", "/pots?division=CORP_IT")).body.pots[0];
    await call("PATCH", `/afes/${mine}`, { costCenter: "30145" });
    const picked = await call("PATCH", `/afes/${mine}`, { "budget.potId": real.id });
    check("choosing a real pot afterwards drops the words", picked.body.afe.budget.otherBudget === "", JSON.stringify(picked.body.afe.budget));
    await call("DELETE", `/afes/${mine}`);

    // A requester with no pot rights raises one that does not fit the pot.
    await call("POST", "/admin/act-as", { email: "udarsh_atwal@example.com" });
    const his = (await call("POST", "/afes")).body.afe.id;
    await call("PATCH", `/afes/${his}`, { "project.title": "Does not fit", costCenter: "30145", "money.classification": "capex",
      "money.capexUsd": 900000000, "budget.budgeted": "Yes", "budget.potId": real.id });
    const asHim = (await call("GET", `/afes/${his}`)).body;
    const hisWarn = (asHim.validation.warns || []).find((w) => w.rule === "budget_pot_available");
    check("a requester sees which pot, never what is left in it",
      asHim.pot && asHim.pot.id === real.id && asHim.pot.remainingUsd === undefined && asHim.pot.amountUsd === undefined
        && hisWarn && !/\d/.test(hisWarn.message) && !(hisWarn.data && "remainingUsd" in hisWarn.data),
      JSON.stringify({ pot: asHim.pot, warn: hisWarn }));
    await call("DELETE", "/admin/act-as");
    const asCoord = (await call("GET", `/afes/${his}`)).body;
    const coordWarn = (asCoord.validation.warns || []).find((w) => w.rule === "budget_pot_available");
    check("the coordinator and Fixed Assets see the balance, and the figure in the warning",
      asCoord.pot && Number.isFinite(asCoord.pot.remainingUsd) && coordWarn && Number.isFinite(coordWarn.data && coordWarn.data.remainingUsd) && /\d/.test(coordWarn.message),
      JSON.stringify({ remaining: asCoord.pot && asCoord.pot.remainingUsd, warn: coordWarn && coordWarn.message }));
    await call("POST", "/admin/act-as", { email: "udarsh_atwal@example.com" });
    await call("DELETE", `/afes/${his}`);
    await call("DELETE", "/admin/act-as");
  }

  {
    // R169 — the quote's own date, typed like its vendor and total, and a quote that is more than
    // ninety days old asked about: "the quotation should be the latest one" (Imogen, UAT review
    // 2026-10-14); ninety days is the line Shashank drew the same day.
    console.log("8b. a quote has a date, and an old one is flagged (R169)");
    const it = await call("POST", "/afes");
    const mine = it.body.afe.id;
    await call("PATCH", `/afes/${mine}`, { "project.title": "Quote age", costCenter: "30145", "money.classification": "capex", "money.capexUsd": 20000 });
    const today = new Date().toISOString().slice(0, 10);
    const ago = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
    const up = await call("POST", `/afes/${mine}/documents`, { filename: "Vendor quote.pdf", role: "quote", contentBase64: PDF, vendor: "Vaisala", amountUsd: 20000, quoteDate: ago(120) });
    const q = (up.body.afe.documents || [])[0] || {};
    const flag = (v) => (v.warns || []).find((w) => w.rule === "quote_recent");
    check("a quote attaches with its date, and at 120 days it is flagged with its age",
      up.status === 201 && q.quoteDate === ago(120) && flag(up.body.validation) && /is 120 days old —/.test(flag(up.body.validation).message),
      JSON.stringify(up.body.error || { date: q.quoteDate, warn: flag(up.body.validation || {}) }));
    check("…as a flag the requester may explain", (up.body.validation.noteable || []).some((n) => n.rule === "quote_recent"));
    const fresh = await call("PATCH", `/afes/${mine}/documents/${q.attachmentId}`, { quoteDate: today });
    check("a fresh date clears it", fresh.status === 200 && !flag(fresh.body.validation), JSON.stringify(fresh.body.error || flag(fresh.body.validation)));
    const hist = (await call("GET", `/admin/audit?afeId=${mine}`)).body.filter((e) => e.type === "document_updated").pop();
    check("and the change is on the record, from what to what",
      hist && hist.payload.from.quoteDate === ago(120) && hist.payload.to.quoteDate === today, JSON.stringify(hist && hist.payload));
    const notDay = await call("PATCH", `/afes/${mine}/documents/${q.attachmentId}`, { quoteDate: "2026-02-30" });
    const later = await call("PATCH", `/afes/${mine}/documents/${q.attachmentId}`, { quoteDate: new Date(Date.now() + 9 * 86400000).toISOString().slice(0, 10) });
    check("a day that does not exist, or has not happened yet, is refused rather than stored",
      notDay.status === 422 && later.status === 422 && /has not happened yet/.test(later.body.error), JSON.stringify([notDay.body, later.body]));
    const cleared = await call("PATCH", `/afes/${mine}/documents/${q.attachmentId}`, { quoteDate: "" });
    check("blank takes the date off, and the draft asks for it again",
      cleared.status === 200 && cleared.body.afe.documents[0].quoteDate === null && /What date is Vaisala's quote\?/.test((flag(cleared.body.validation) || {}).message || ""),
      JSON.stringify(cleared.body.error || flag(cleared.body.validation)));
    const backup = await call("POST", `/afes/${mine}/documents`, { filename: "Site photo.png", role: "backup", contentBase64: PNG, quoteDate: today });
    check("only a priced document carries a date", backup.status === 422 && backup.body.field === "quoteDate", JSON.stringify(backup.body));
    await call("DELETE", `/afes/${mine}`);
  }

  console.log("9. a block that names a field offers the change that clears it (R115)");
  {
    // The Cloud CapEx tree is reachable to a dead end by answering four questions honestly: it
    // lands on regular CapEx, the AFE still says Cloud CapEx, and Continue is dead with nothing
    // on the screen to press. The rule carries the fix as DATA so the screen stays dumb.
    const it = await call("POST", "/afes");
    const mine = it.body.afe.id;
    await call("PATCH", `/afes/${mine}`, { "project.title": "Cloud dead end", costCenter: "30145",
      "money.classification": "cloud_capex", "money.cloudCapexUsd": 90000 });
    await call("PATCH", `/afes/${mine}`, { "cloud.q1Software": "Yes", "cloud.q2ExternallyHosted": "Yes" });
    const r = await call("PATCH", `/afes/${mine}`, { "cloud.q3Subscription": "Perpetual" });
    const blocked = (r.body.validation.blocks || []).find((x) => x.rule === "cloud_tree_consistent");
    check("the mismatch blocks", Boolean(blocked) && /regular CapEx/.test(blocked.message), JSON.stringify(blocked));
    check("and carries the field, the value and a label for the button",
      blocked && blocked.fix && blocked.fix.field === "money.classification" && blocked.fix.value === "capex"
        && Boolean(blocked.fix.label), JSON.stringify(blocked && blocked.fix));
    // Applying it the way the screen does — which also moves the money across, because CapEx and
    // Cloud CapEx are mutually exclusive and the figure belongs to whichever is chosen.
    const fixed = await call("PATCH", `/afes/${mine}`, {
      "money.classification": "capex", "money.capexUsd": 90000, "money.cloudCapexUsd": null });
    check("applying it clears the block and leaves no other in its place",
      !(fixed.body.validation.blocks || []).some((x) => x.rule === "cloud_tree_consistent")
        && fixed.body.afe.money.capexUsd === 90000 && fixed.body.afe.money.cloudCapexUsd === null,
      JSON.stringify((fixed.body.validation.blocks || []).map((x) => x.rule)));
    await call("DELETE", `/afes/${mine}`);
  }

  console.log("10. the financial case: numbers only, from the AFE's own year (R162)");
  {
    const fin = (await call("POST", "/afes")).body.afe.id;
    await call("PATCH", `/afes/${fin}`, { "project.title": "Grid numbers", costCenter: "30145",
      "money.classification": "capex", "money.capexUsd": 90000, "schedule.startDate": "2026-11-02", "schedule.finishDate": "2027-03-31" });
    const bad = await call("PATCH", `/afes/${fin}`, { "financials.capexRows": [{ description: "Kit", amounts: [90000, "12k5"] }] });
    check("a cell that is not a figure is refused, quoted, and nothing is saved",
      bad.status === 422 && /12k5/.test(bad.body.error) && bad.body.field === "financials.capexRows", JSON.stringify(bad.body));
    const ok = await call("PATCH", `/afes/${fin}`, { "financials.capexRows": [{ description: "Kit", amounts: [90000, "1,250.50", "", null, -300] }],
      "financials.assets": [{ description: "Kit", costUsd: 90000, lifeYears: 5, inServiceDate: "2027-03-31" }] });
    check("figures, grouping commas, blanks and negatives are all figures", ok.status === 200, JSON.stringify(ok.body.error));
    check("with no first year stored, the case starts in the AFE's own start year, not the clock's",
      ok.body.view.financials && ok.body.view.financials.years[0] === 2026, JSON.stringify(ok.body.view.financials && ok.body.view.financials.years.slice(0, 2)));
    // "Set it up" started a case whose only asset could not be removed, and an asset with no
    // life blocks — an optional step became a trap. The whole case can be taken off; only taken off.
    const whole = await call("PATCH", `/afes/${fin}`, { financials: { assets: [] } });
    check("the case as a whole cannot be rewritten in one go", whole.status === 422 && whole.body.field === "financials", JSON.stringify(whole.body));
    const removed = await call("PATCH", `/afes/${fin}`, { financials: null });
    check("…but it can be removed, and then the screen is told there is no case",
      removed.status === 200 && removed.body.afe.financials === null
        && (removed.body.validation.hints || []).some((h) => h.id === "financial_case_missing"), JSON.stringify(removed.body.validation && removed.body.validation.hints));
    await call("DELETE", `/afes/${fin}`);
  }

  console.log("11. a file up to the stated 25 MB actually arrives");
  // Base64 inside JSON is four thirds of the file, so a 25 MB limit on every body refused
  // anything over ~18.7 MB with a bare 413 — the facilities packs the limit was raised for.
  {
    const big = (await call("POST", "/afes")).body.afe.id;
    const pdfOf = (bytes) => Buffer.concat([Buffer.from("%PDF-1.4\n%"), Buffer.alloc(bytes - 20, 0x61), Buffer.from("\n%%EOF\n")]).toString("base64");
    const twenty = await call("POST", `/afes/${big}/documents`, { filename: "facilities-pack.pdf", role: "backup", contentBase64: pdfOf(20 * 1048576) });
    check("a 20 MB document uploads", twenty.status === 201 || twenty.status === 200, JSON.stringify(twenty.body).slice(0, 160));
    const over = await call("POST", `/afes/${big}/documents`, { filename: "too-big.pdf", role: "backup", contentBase64: pdfOf(26 * 1048576) });
    check("a 26 MB one is refused with a reason a person can act on, not a bare error",
      over.status === 413 && typeof over.body === "object" && /25(\.0)? MB/.test(over.body.error || ""), JSON.stringify(over.body).slice(0, 200));
    await call("DELETE", `/afes/${big}`);
  }

  const gone = await call("GET", "/afes/afe-does-not-exist");
  check("an unknown AFE is a 404", gone.status === 404, String(gone.status));

  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nsmoke-wizard could not run:", e.message);
  console.error(`(is the server up on ${BASE}? start it with: npm start)`);
  process.exit(1);
});
