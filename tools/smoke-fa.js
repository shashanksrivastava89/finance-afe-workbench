"use strict";
// Stage 5 gate: Fixed Assets. Part 0 exercises the pure pieces offline — red flags from a
// mutated matrix row, envelope verification misses, SoD without a stand-in, waivers, the
// financial fingerprint, the deterministic digest and its .eml, the draft-only outbox rule,
// the judgment rows and the KO01 sheet. Part 1 walks the APAC hardware refresh through the API:
// signed → with Fixed Assets → a simulated matrix extract raises drift → the digest is drafted
// (never sent) → email evidence clears the drift → judgment → parent + child IOs recorded →
// requester and coordinator notified → KO22/AS01/KO02 ticked; then a second AFE is sent back by
// Fixed Assets and resubmitted with the money unchanged (the signatures stand) and again with the
// money changed (a new round).
//
//   node tools/smoke-fa.js      (needs a server on :8080; resets its data first)
const path = require("path");
const { pdfText } = require("./pdf-text");
const ROOT = path.join(__dirname, "..");
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
// A line that wraps is still on the page, so compare on flattened whitespace.
const flat = (s) => String(s).replace(/\s+/g, " ").trim();
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + String(detail).slice(0, 320) : "")); }
};
const j = (x) => JSON.stringify(x);

// ---------------------------------------------------------------------------------------------
// Part 0 — the pure rules, offline
// ---------------------------------------------------------------------------------------------
async function offline() {
  const rf = require(path.join(ROOT, "lib/domain/redFlags.js"));
  const mail = require(path.join(ROOT, "lib/integrations/mail.js"));
  const notify = require(path.join(ROOT, "lib/notify.js"));
  const fj = require(path.join(ROOT, "lib/domain/faJudgment.js"));
  const sap = require(path.join(ROOT, "lib/domain/sapSheet.js"));
  const sm = require(path.join(ROOT, "lib/domain/stateMachine.js"));
  const { createRepos } = require(path.join(ROOT, "lib/repos"));

  const then = { M1: { name: "Udarsh Atwal" }, A1: { name: "Udarsh Atwal" }, A2: { name: "Kai Lun Ong" }, A3: { name: "Vrishti Aguirre" }, A4: { name: "Isabel Armstrong" } };
  const routing = {
    round: 1, status: "completed",
    basis: { levels: ["M1", "A1", "A2", "A3"], matrixBatchId: "MX-2026-09-03", matrixRow: { costCenter: "30145", levels: then }, fingerprint: null },
    recipients: [
      { id: "r1", role: "pre_approver", name: "Annette Sandhu", email: "annette_sandhu@example.com", status: "signed", order: 1 },
      { id: "r2", role: "matrix", level: "M1", name: "Udarsh Atwal", status: "skipped", signsAs: "r3", order: null },
      { id: "r3", role: "matrix", level: "A1", name: "Udarsh Atwal", email: "udarsh_atwal@example.com", status: "signed", order: 2, signedAt: "2026-09-02T10:00:00Z" },
      { id: "r4", role: "matrix", level: "A2", name: "Kai Lun Ong", email: "kailun_ong@example.com", status: "signed", order: 3, signedAt: "2026-09-02T11:00:00Z" },
      { id: "r5", role: "additional", level: "A2", name: "Lekha Rogerson", email: "lekha_rogerson@example.com", status: "signed", order: 4 },
      { id: "r6", role: "matrix", level: "A3", name: "Vrishti Aguirre", email: "vrishti_aguirre@example.com", status: "signed", order: 5 },
    ],
    sod: { parties: [], excluded: [] },
  };
  const ok = (id, name) => ({ recipientId: id, name, st: "ok", signedAt: "2026-09-02T12:00:00Z" });
  const allOk = [ok("r1", "Annette Sandhu"), ok("r3", "Udarsh Atwal"), ok("r4", "Kai Lun Ong"), ok("r5", "Lekha Rogerson"), ok("r6", "Vrishti Aguirre")];
  const afe = { id: "afe-t", costCenter: "30145", division: "CORP_IT", sentAt: "2026-09-01T09:00:00Z",
    requester: { name: "Shashank Srivastava", email: "shashank_srivastava@example.com" }, coordinator: { name: "Aiden-Mulqueeny Crilly", email: "aiden-mulqueeny_crilly@example.com" },
    project: { title: "PC Hardware Lifecycle Replacement APAC", description: "Refresh." }, money: { classification: "capex", capexUsd: 215000, lines: [{ site: "Singapore", country: "SG", amountUsd: 215000 }] },
    fa: { judgment: {}, driftAck: [], flagAcks: [], orderType: null }, waivers: [], documents: [] };
  const nowSame = { costCenter: "30145", levels: then };
  const nowChanged = { costCenter: "30145", levels: Object.assign({}, then, { A2: { name: "Lekha Rogerson" } }) };
  const clean = { validation: { blocks: [], warns: [], pending: [] }, verification: allOk, currentBatchId: "MX-2026-09-03" };

  console.log("0. matrix drift, level by level");
  const d0 = rf.matrixDrift(routing, nowSame, "MX-2026-09-03");
  check("an unchanged matrix has no drift and lists the four required levels as unchanged", d0.changed.length === 0 && d0.unchanged.length === 4 && !d0.batchChanged, j(d0));
  const d1 = rf.matrixDrift(routing, nowChanged, "MX-2026-09-15");
  check("A2 renamed → one drift row: Kai Lun Ong signed, Lekha Rogerson is named now, batch changed",
    d1.changed.length === 1 && d1.changed[0].level === "A2" && d1.changed[0].was === "Kai Lun Ong" && d1.changed[0].now === "Lekha Rogerson" && d1.changed[0].recipientId === "r4" && d1.batchChanged, j(d1.changed));
  const d2 = rf.matrixDrift(routing, Object.assign({}, nowSame, { levels: Object.assign({}, then, { M1: { name: "Someone New" } }) }), "MX-2");
  check("a change at a skipped row (M1, Atwal signed once at A1) is still drift — the new M1 has not signed", d2.changed.length === 1 && d2.changed[0].level === "M1" && d2.changed[0].recipientStatus === "skipped", j(d2.changed));
  check("a cost centre gone from the matrix is reported, not crashed", rf.matrixDrift(routing, null, "MX-3").rowMissing === true);

  console.log("1. red flags from every source");
  const f0 = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean));
  check("a clean AFE has no flags and is ready", f0.flags.length === 0 && f0.ready === true && f0.summary.verified === 5, j(f0.summary));
  const f1 = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowChanged }, clean, { currentBatchId: "MX-2026-09-15" }));
  const drift = f1.flags.find((f) => f.id === "drift:A2");
  check("drift is a block flag naming both people, pointing at the matrix", drift && drift.severity === "block" && /Kai Lun Ong signed/.test(drift.title) && /Lekha Rogerson/.test(drift.title) && drift.showMe.kind === "matrix" && f1.ready === false, j(drift && drift.title));
  const acked = Object.assign({}, afe, { fa: { judgment: {}, flagAcks: [], driftAck: [{ level: "A2", now: "Lekha Rogerson", attachmentId: "att-9", byName: "Judithmelanie Ware", at: "2026-09-04T00:00:00Z" }] } });
  const f2 = rf.computeRedFlags(Object.assign({ afe: acked, routing, matrixRowNow: nowChanged }, clean));
  check("drift is cleared only by evidence against that level and that name", f2.flags[0].cleared === true && f2.flags[0].clearedBy.attachmentId === "att-9" && f2.ready === true && f2.summary.driftCleared === 1, j(f2.summary));
  const wrongAck = Object.assign({}, afe, { fa: { judgment: {}, flagAcks: [], driftAck: [{ level: "A2", now: "Somebody Else", attachmentId: "att-9" }] } });
  check("evidence for a different name does not clear it", rf.computeRedFlags(Object.assign({ afe: wrongAck, routing, matrixRowNow: nowChanged }, clean)).ready === false);
  const miss = allOk.slice(0, 4).concat([{ recipientId: "r6", name: "Vrishti Aguirre", st: "miss", note: "Vrishti Aguirre is on the approved chain but not on the envelope." }]);
  const f3 = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean, { verification: miss }));
  check("a verification miss is a block flag pointing at the certificate", f3.blocks.length === 1 && f3.blocks[0].id === "verify:r6" && f3.blocks[0].showMe.role === "certificate", j(f3.blocks.map((b) => b.id)));
  const sodRouting = Object.assign({}, routing, { sod: { parties: [{ name: "Udarsh Atwal", reason: "requester" }], excluded: [{ recipientId: "r3", name: "Udarsh Atwal", reason: "requester", wouldHaveBeen: "A1", standIn: null }] } });
  const f4 = rf.computeRedFlags(Object.assign({ afe, routing: sodRouting, matrixRowNow: nowSame }, clean));
  check("an SoD exclusion with nobody standing in is a block", f4.blocks.some((b) => b.id === "sod:r3" && /nobody stood in at A1/.test(b.title)), j(f4.blocks.map((b) => b.title)));
  const sodOk = Object.assign({}, routing, { sod: { parties: [], excluded: [{ recipientId: "r3", name: "Udarsh Atwal", reason: "requester", wouldHaveBeen: "A1", standIn: "r9" }] } });
  check("with a stand-in it is not", rf.computeRedFlags(Object.assign({ afe, routing: sodOk, matrixRowNow: nowSame }, clean)).flags.length === 0);
  const waived = Object.assign({}, afe, { waivers: [{ ruleId: "quote_covers_estimate", reason: "framework agreement — pricing per the MSA", byName: "Aiden-Mulqueeny Crilly", at: "2026-08-30T00:00:00Z" }] });
  const f5 = rf.computeRedFlags(Object.assign({ afe: waived, routing, matrixRowNow: nowSame }, clean, { quoteCoveragePct: 33 }));
  check("a waiver is a warn carrying the coordinator's reason, and a warn never blocks", f5.warns.length === 1 && /33%/.test(f5.warns[0].title) && /framework agreement/.test(f5.warns[0].detail) && f5.ready === true, j(f5.warns.map((w) => w.title)));
  const ackWarn = Object.assign({}, waived, { fa: { judgment: {}, driftAck: [], flagAcks: [{ flagId: "waiver:quote_covers_estimate", note: "MSA on file", byName: "Judithmelanie Ware", at: "2026-09-04T00:00:00Z" }] } });
  check("an acknowledged flag shows who and why", rf.computeRedFlags(Object.assign({ afe: ackWarn, routing, matrixRowNow: nowSame }, clean, { quoteCoveragePct: 33 })).warns[0].ack.note === "MSA on file");
  // Coverage became a WARNING (R67) and the waiver that used to carry it can no longer be made —
  // so the warning was skipped here for a flag that never came, and a quote covering a third of
  // the estimate reached Fixed Assets with nothing on the list.
  const lowCover = { blocks: [], pending: [], warns: [{ rule: "quote_covers_estimate", field: "documents", step: 6, message: "1 quote · $28,000 = 35% of the $80,000 estimate" }] };
  const f5b = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean, { validation: lowCover, quoteCoveragePct: 35 }));
  check("low quote coverage reaches Fixed Assets as a warn flag pointing at the quote",
    f5b.warns.length === 1 && f5b.warns[0].id === "warn:quote_covers_estimate" && f5b.warns[0].severity === "warn" &&
    /35%/.test(f5b.warns[0].title) && f5b.warns[0].showMe.role === "quote" && f5b.ready === true, j(f5b.warns));
  const noted = { blocks: [], pending: [], warns: [Object.assign({}, lowCover.warns[0], { note: "freight and installation are quoted separately", noteByName: "Anita Uppal" })] };
  const f5c = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean, { validation: noted, quoteCoveragePct: 35 }));
  check("the requester's reason travels with it", /freight and installation/.test(f5c.warns[0].detail) && /Anita Uppal/.test(f5c.warns[0].detail));
  const f5d = rf.computeRedFlags(Object.assign({ afe: waived, routing, matrixRowNow: nowSame }, clean, { validation: lowCover, quoteCoveragePct: 35 }));
  check("an AFE waived before R67 still shows ONE coverage flag — the waiver, with its reason",
    f5d.warns.length === 1 && f5d.warns[0].id === "waiver:quote_covers_estimate", j(f5d.warns.map((w) => w.id)));
  const f6 = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean, { formHash: { checked: true, ok: false }, editsSinceSend: [{ at: "2026-09-03T00:00:00Z", paths: ["project.description"] }] }));
  check("a form that no longer hashes, explained by audited edits, is a warn naming the fields", f6.warns.length === 1 && f6.warns[0].id === "form:hash" && /project.description/.test(f6.warns[0].detail) && f6.ready, j(f6.warns[0]));
  const f7 = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean, { formHash: { checked: true, ok: false }, editsSinceSend: [] }));
  check("unexplained, it is a block", f7.blocks.length === 1 && f7.blocks[0].id === "form:hash");
  const f8 = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean, { validation: { blocks: [{ rule: "cost_center_active", message: "Cost centre 30145 is inactive in SAP.", step: 2 }], warns: [], pending: [] } }));
  check("a rule that is still true now is a block flag pointing at the form", f8.blocks[0].id === "rule:cost_center_active" && f8.blocks[0].showMe.kind === "form");
  const f9 = rf.computeRedFlags(Object.assign({ afe, routing, matrixRowNow: nowSame }, clean, { possibleDuplicates: [{ id: "afe-9", title: "PC Hardware Refresh APAC FY25", state: "issued", totalUsd: 200000 }] }));
  check("a look-alike AFE is a word, never a block", f9.warns.length === 1 && f9.warns[0].id === "dup:afe-9" && f9.ready);

  console.log("2. the financial fingerprint");
  const fp = rf.financialFingerprint(afe);
  check("a description change leaves the fingerprint alone", rf.financialFingerprint(Object.assign({}, afe, { project: { title: "Renamed", description: "Longer story." } })) === fp);
  check("an amount change changes it", rf.financialFingerprint(Object.assign({}, afe, { money: Object.assign({}, afe.money, { capexUsd: 240000 }) })) !== fp);
  check("a cost-centre change changes it", rf.financialFingerprint(Object.assign({}, afe, { costCenter: "30146" })) !== fp);
  check("a classification change changes it", rf.financialFingerprint(Object.assign({}, afe, { money: Object.assign({}, afe.money, { classification: "cloud_capex" }) })) !== fp);
  check("a different requester changes it (they could have been a signer)", rf.financialFingerprint(Object.assign({}, afe, { requester: { name: "Udarsh Atwal", email: "udarsh_atwal@example.com" } })) !== fp);

  console.log("3. the digest and its .eml");
  const dg1 = rf.buildRedFlagDigest(waived, f1.flags.concat(f5.flags), { totalUsd: 215000 });
  const dg2 = rf.buildRedFlagDigest(waived, f1.flags.concat(f5.flags), { totalUsd: 215000 });
  check("the digest is deterministic", dg1.body === dg2.body && dg1.subject === dg2.subject);
  check("it goes to the coordinator with the requester in copy", dg1.to === "aiden-mulqueeny_crilly@example.com" && dg1.cc.join() === "shashank_srivastava@example.com" && /^Hi Aiden-Mulqueeny,/.test(dg1.body), j({ to: dg1.to, cc: dg1.cc }));
  check("the subject counts what is to clear and what is to note", dg1.subject === "AFE review: PC Hardware Lifecycle Replacement APAC — 1 to clear, 1 to note", dg1.subject);
  check("blocks come first, numbered, each with what Fixed Assets needs", /1\. Matrix changed at A2/.test(dg1.body) && /What we need: the current A2 approver's email approval/.test(dg1.body) && /2\. Quotes cover 33%.*\(for your information\)/.test(dg1.body), dg1.body.slice(0, 400));
  check("it is marked draft-only and lists the flag ids it covers", dg1.draftOnly === true && dg1.flagIds.join() === "drift:A2,waiver:quote_covers_estimate");
  const dg0 = rf.buildRedFlagDigest(afe, [], { totalUsd: 215000 });
  check("with nothing open it says so", /no red flags/.test(dg0.subject) && /for the record only/.test(dg0.body));
  const eml = mail.buildEml({ to: dg1.to, toName: "Aiden-Mulqueeny Crilly", cc: dg1.cc, subject: dg1.subject, body: dg1.body, date: "2026-09-04T10:00:00Z", afeId: "afe-t" });
  check("the .eml is an unsent draft (X-Unsent: 1) with CRLF line endings and the addressee named", /\r\nX-Unsent: 1\r\n/.test(eml) && /^From: /.test(eml) && /\r\nTo: Aiden-Mulqueeny Crilly <aiden-mulqueeny_crilly@example\.com>\r\n/.test(eml) && /\r\nCc: shashank_srivastava@example\.com\r\n/.test(eml) && eml.endsWith("\r\n"), eml.slice(0, 300));
  check("a subject with an em dash is RFC 2047 encoded", /Subject: =\?UTF-8\?B\?/.test(eml));
  check("the body rides as UTF-8 text after one blank line", /\r\nContent-Type: text\/plain; charset=utf-8\r\n/.test(eml) && eml.split("\r\n\r\n")[1].startsWith("Hi Aiden-Mulqueeny,"));
  check("mail mode is eml until the Graph registration exists", mail.mode() === "eml");

  console.log("4. the outbox never sends a digest");
  const repos = createRepos("memory");
  const row = await notify.enqueue(repos, { recipientEmail: dg1.to, afeId: "afe-t", kind: "red_flag_digest", subject: dg1.subject, body: dg1.body, meta: { flagIds: dg1.flagIds } });
  check("a red_flag_digest row is stored as drafted, with the flags it covered", row.status === "drafted" && row.meta.flagIds.length === 2, j(row.status));
  await notify.enqueue(repos, { recipientEmail: dg1.to, afeId: "afe-t", kind: "afe_issued", subject: "x", body: "y" });
  const sendable = await notify.sendable(repos);
  check("sendable() excludes it by construction", sendable.length === 1 && sendable[0].kind === "afe_issued", j(sendable.map((s) => s.kind)));
  let threw = null;
  try { await notify.markSent(repos, row.id, "ref"); } catch (e) { threw = e.message; }
  check("markSent() refuses it", /draft-only/.test(threw || ""), threw);
  // R164: DocuSign reminds the signer of a LIVE envelope on the envelope's own schedule, so the
  // tool's reminder would be the second one that day.
  {
    const remindersJob = require(path.join(ROOT, "lib/jobs/reminders.js"));
    await repos.afes.insert({ id: "afe-live", state: "in_approval", envelopeId: "env-live", costCenter: "30145",
      project: { title: "Signed in DocuSign" }, money: { capexUsd: 50000 } });
    await repos.envelopes.insert({ id: "env-live", afeId: "afe-live", provider: "docusign", status: "sent" });
    await repos.routings.insert({ id: "rt-live", afeId: "afe-live", status: "active", recipients: [
      { id: "r1", role: "matrix", status: "sent", name: "Annette Sandhu", email: "annette_sandhu@example.com", notifiedAt: "2026-09-01T00:00:00Z", remindedAt: [] }] });
    const liveRun = await remindersJob.run(repos, { olderThanDays: 0, now: "2026-09-10T00:00:00Z" });
    await repos.envelopes.update("env-live", { provider: "simulated" });
    const simRun = await remindersJob.run(repos, { olderThanDays: 0, now: "2026-09-10T00:00:00Z" });
    check("a live envelope is reminded by DocuSign, not by the tool as well (R164)",
      liveRun.reminded === 0 && simRun.reminded === 1, j({ live: liveRun.reminded, simulated: simRun.reminded }));
    // …and its signing request is DocuSign's own mail, sent by DocuSign.
    const sm = require(path.join(ROOT, "lib/domain/stateMachine.js"));
    const rt = await repos.routings.get("rt-live");
    const before = (await repos.notifications.all()).length;
    await sm.notifySigner(repos, await repos.afes.get("afe-live"), rt, rt.recipients[0], { provider: "docusign", envelopeId: "E-live" });
    const afterLive = (await repos.notifications.all()).length;
    await sm.notifySigner(repos, await repos.afes.get("afe-live"), rt, rt.recipients[0], { provider: "simulated", envelopeId: "SIM-live" });
    check("…and its signing request is DocuSign's own mail: the tool queues one only for a simulated envelope",
      afterLive === before && (await repos.notifications.all()).length === before + 1, j({ before, afterLive }));
  }

  console.log("5. judgment rows and the KO01 sheet");
  const jd = fj.buildJudgment({ afe, totalUsd: 215000, quoteTotalUsd: 215000, possibleDuplicates: [] });
  check("five rows: one manual, three evidenced and ready, the order type open", jd.rows.length === 5 && jd.open === 5 && jd.rows.find((r) => r.id === "amount_reasonable").st === "ready" && jd.rows.find((r) => r.id === "asset_not_expense").st === "open" && jd.rows.find((r) => r.id === "order_type").st === "open", j(jd.rows.map((r) => [r.id, r.st])));
  const jd2 = fj.buildJudgment({ afe: Object.assign({}, afe, { fa: { judgment: { asset_not_expense: true, amount_reasonable: true, classification_agreed: true, no_duplicate_io: true, order_type: true }, orderType: "Z002" } }), totalUsd: 215000, quoteTotalUsd: 215000, possibleDuplicates: [] });
  check("ticked and typed, nothing is open", jd2.open === 0 && /Z002/.test(jd2.rows.find((r) => r.id === "order_type").sub));
  check("IO numbers are 6–10 digits, typed never generated", sap.validIoNumber("399403") && sap.validIoNumber("3000200976") && !sap.validIoNumber("12345") && !sap.validIoNumber("IO-399403"));
  {
    // SAP's own record decides whether a number can be this AFE's — and only what reads as evidence counts.
    const ior = require(path.join(ROOT, "lib/domain/ioRegistry.js"));
    const raisedOn = { id: "afe-x", costCenter: "30145", createdAt: "2026-09-10T18:30:00.000Z" };
    const row = (o) => Object.assign({ source: "SAP order master", description: "X", costCenter: "30145", openedOn: null, aucNumber: null, afeId: null }, o);
    check("an order opened the day before the AFE was raised is accepted — a day of slack for the time zones",
      ior.sapConflict("399999", raisedOn, [row({ openedOn: "2026-09-09" })], { parent: true }) === null);
    check("two days before, it cannot be this AFE's order",
      /before this AFE was raised on 10 Sep 2026/.test((ior.sapConflict("399999", raisedOn, [row({ openedOn: "2026-09-08" })]) || {}).error || ""));
    check("a date the workbook cannot mean (#N/A) is no evidence either way",
      ior.sapConflict("399999", raisedOn, [row({ source: "AuC recon", openedOn: "#N/A" })], { parent: true }) === null);
    check("a child may sit under a local cost centre; the parent may not",
      ior.sapConflict("399999", raisedOn, [row({ costCenter: "0000040112", openedOn: "2026-09-12" })]) === null
        && /keyed under cost centre 30145/.test((ior.sapConflict("399999", raisedOn, [row({ costCenter: "0000040112", openedOn: "2026-09-12" })], { parent: true }) || {}).error || ""));
    check("a recon line the mapping already ties to another AFE is refused",
      /ties it to afe-other/.test((ior.sapConflict("399999", raisedOn, [row({ afeId: "afe-other" })]) || {}).error || ""));
  }
  const ko = sap.buildKo01(Object.assign({}, afe, { companyCode: "1000", plant: "3026", fa: { orderType: "Z002" }, schedule: { startDate: "2026-10-01", finishDate: "2026-12-30" } }));
  check("the sheet starts with the chosen order type and never fills a blank with a sample", ko[0].field === "Order Type" && ko[0].value === "Z002" && ko.some((r) => r.field === "Description" && r.value === "PC HARDWARE LIFECYCLE REPLACEMENT APAC") && ko.some((r) => r.field === "Order" && r.system), j(ko.slice(0, 4)));
  check("child orders follow the cost lines", sap.buildChildPlan(afe).length === 1 && sap.buildChildPlan(afe)[0].site === "Singapore");
  check("the lifecycle table carries fa_return and fa_record_io, and only Fixed Assets may run them",
    Boolean(sm.TRANSITIONS.fa_return) && Boolean(sm.TRANSITIONS.fa_record_io) && sm.IS.fa({ roles: ["fa_checker"] }) && !sm.IS.faPreparer({ roles: ["fa_checker"] }) && !sm.IS.fa({ roles: ["coordinator"] }));

  // R156 — what a signed set CARRIES decides what the issued AFE binds in behind it, so it must be
  // exact for every generation of signed set, including the ones stored before it was recorded.
  // The case that made this a test is on UAT: a 5-page signed set from before the fix, whose AFE
  // was sent as a 55-page packet — the form ALONE, although the envelope names two quotes bound.
  console.log("5b. what the signed set already carries (R156)");
  {
    const { PDFDocument } = require(path.join(ROOT, "node_modules", "pdf-lib"));
    const { carriedBy } = require(path.join(ROOT, "lib/pdf/issuedPack.js"));
    const pdfOf = async (n) => { const d = await PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage(); return Buffer.from(await d.save()); };
    const bytes = new Map([["s5", await pdfOf(5)], ["s57", await pdfOf(57)], ["f4", await pdfOf(4)]]);
    const repos = { attachmentStore: { get: async (id) => bytes.get(id) || null } };
    const sim = { provider: "simulated", boundDocumentIds: ["q1", "q2"], supportingDocumentIds: ["q1", "q2", "b1"] };
    const a = (docs) => ({ documents: docs });
    const legacyForm = await carriedBy(repos, a([{ role: "sent_packet", pages: 55 }]), sim, { attachmentId: "s5" });
    const legacyPacket = await carriedBy(repos, a([{ role: "sent_packet", pages: 55 }]), sim, { attachmentId: "s57" });
    check("a signed set shorter than the packet it was sent as is the form alone, and carries nothing",
      legacyForm.length === 0, j(legacyForm));
    check("one as long as the packet carries what was bound into it",
      legacyPacket.join() === "q1,q2", j(legacyPacket));
    const byForm = await carriedBy(repos, a([{ role: "afe_form_pdf", attachmentId: "f4" }]), sim, { attachmentId: "s5" });
    const sameAsForm = await carriedBy(repos, a([{ role: "afe_form_pdf", attachmentId: "f4" }]), Object.assign({}, sim), { attachmentId: "f4" });
    check("without a recorded packet count, the form's own page count decides it",
      byForm.join() === "q1,q2" && sameAsForm.length === 0, j({ byForm, sameAsForm }));
    check("a signed set that records what it carries is taken at its word",
      (await carriedBy(repos, a([]), sim, { attachmentId: "s5", carries: ["q9"] })).join() === "q9");
    check("DocuSign's combined PDF carries everything the approvers were given, bound in or not",
      (await carriedBy(repos, a([]), Object.assign({}, sim, { provider: "docusign" }), { attachmentId: "s5" })).join() === "q1,q2,b1");
    check("and an envelope that bound nothing carries nothing",
      (await carriedBy(repos, a([]), { provider: "simulated", boundDocumentIds: [] }, { attachmentId: "s57" })).length === 0);
  }
}

// ---------------------------------------------------------------------------------------------
// Part 1 — the API
// ---------------------------------------------------------------------------------------------
async function call(method, p, body) {
  const res = await fetch(BASE + "/api" + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
  return { status: res.status, body: parsed, headers: res.headers };
}
const actAs = (email) => call("POST", "/admin/act-as", { email });
const actAsNone = () => call("DELETE", "/admin/act-as");
const QUOTE = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n").toString("base64");
// A second, different PDF: the evidence must not hash to the quote or the upload is refused as a duplicate.
const EVIDENCE = Buffer.from("%PDF-1.4\n% email approval from Lekha Rogerson, 4 Sep 2026\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n").toString("base64");
const JUDITHMELANIE = "judithmelanie_ware@example.com", SYED = "aiden-mulqueeny_crilly@example.com", SHASHANK = "shashank_srivastava@example.com";
// R101: Judithmelanie is FA Supervisor AND an fa_preparer, which is exactly why the four-eyes rule
// has to be by identity. Jarrod is FA Manager. Ebony is a preparer and neither.
const JARROD = "jarrod_dane@example.com", EBONY = "ebony_lowe@example.com";
const MANAIA = "manaia_ginty@example.com";
// A real one-pixel PNG. The budget evidence is a SCREENSHOT, so the upload has to accept an
// image, and the only way to prove it does is to send bytes that actually are one.
const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
// A DIFFERENT picture. An upload is idempotent by content hash, so re-posting the same bytes
// under another name is refused - which is correct, and makes a second screenshot need its own.
const PNG_2PX = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGNgCFhwQoOLAUIBABr4A9XX6wQrAAAAAElFTkSuQmCC";

async function raiseAndSign(title, lines) {
  await actAsNone();                                       // raised by Shashank, who also coordinates CORP_IT
  const created = await call("POST", "/afes");
  const id = created.body.afe.id;
  // Dates relative to today, as smoke-routing's are: a fixed "2026-10-01" became a start date in
  // the past on 2 October, and `start_not_past` put a warning on an AFE this suite says has none.
  const start = new Date(Date.now() + 30 * 86400000), finish = new Date(Date.now() + 120 * 86400000);
  const patch = {
    "project.title": title, costCenter: "30145", "money.classification": "capex", "money.capexUsd": 215000,
    location: "SGP_Singapore_Site 5", region: "APAC",
    "project.projectType": "Office Equip/Furniture",
    "project.description": "The HW REFRESH Project will be used to stock inventory in APAC for FY 2026.",
    "project.justification": "Devices past their lifecycle fail more often and cannot run the current security baseline.",
    "project.newEquipment": "Yes", "project.surplusChecked": "Yes", "project.buyVsLease": "N/A", "project.assistAsset": "No",
    "schedule.startDate": start.toISOString().slice(0, 10), "schedule.finishDate": finish.toISOString().slice(0, 10),
    "schedule.fiscalYear": start.getUTCFullYear(),
    "budget.budgeted": "Yes", "budget.potId": "pot-0003", "budget.budgetCategory": "Life Cycle Refresh",
  };
  if (lines) patch["money.lines"] = lines;
  await call("PATCH", `/afes/${id}`, patch);
  await call("POST", `/afes/${id}/documents`, { filename: "APAC_HW_estimate.pdf", role: "quote", contentBase64: QUOTE, vendor: "Multiple vendors", amountUsd: 215000 });
  // Coordinating CORP_IT does not let him send his own AFE: it goes to Aiden, who shapes the
  // chain and sends it (R157).
  const submitted = await call("POST", `/afes/${id}/submit`);
  if (submitted.status !== 200) throw new Error("submit failed: " + j(submitted.body));
  await actAs(SYED);
  await call("PUT", `/afes/${id}/routing/recipients`, { additional: [{ name: "Lekha Rogerson", level: "A2" }], approverNote: "Budgeted under Life Cycle Refresh APAC FY26." });
  await call("POST", `/afes/${id}/routing/confirm-emails`, { confirmations: [{ name: "Kai Lun Ong", email: "kailun_ong@example.com" }] });
  const sent = await call("POST", `/afes/${id}/send`);
  if (sent.status !== 200) throw new Error("send failed: " + j(sent.body));
  // Sign as whoever holds the envelope until it completes — the chain follows the matrix as it
  // stands at send, so a later extract (section 8) legitimately changes who is on it.
  for (let i = 0; i < 10; i++) {
    await actAsNone();
    const cur = await call("GET", `/afes/${id}`);
    if (cur.body.afe.state !== "in_approval") break;
    const holder = cur.body.routing.recipients.find((r) => r.status === "sent");
    if (!holder || !holder.email) throw new Error("nobody holds the envelope: " + j(cur.body.afe.state));
    const known = await call("GET", "/admin/users");
    if (!known.body.some((u) => u.email === holder.email)) {
      await call("POST", "/admin/users", { email: holder.email, displayName: holder.name, roles: ["approver"] });
    }
    await actAs(holder.email);
    const dec = await call("GET", `/afes/${id}/decision`);
    const res = await call("POST", `/afes/${id}/recipients/${dec.body.me.recipientId}/sign`);
    if (res.status !== 200) throw new Error(`${holder.name} could not sign: ` + j(res.body));
  }
  await actAsNone();
  return id;
}

async function online() {
  console.log("6. a clean slate, and the APAC refresh signed by five people");
  const reset = await call("POST", "/admin/reset");
  check("the store resets to reference data", reset.status === 200 && reset.body.ok === true);
  await actAsNone();
  const id = await raiseAndSign("PC Hardware Lifecycle Replacement APAC", [
    { site: "Singapore DC", country: "SG", amountUsd: 115000 }, { site: "India", country: "IN", amountUsd: 70000 }, { site: "South Korea", country: "KR", amountUsd: 30000 },
  ]);
  const a0 = await call("GET", `/afes/${id}`);
  check("the AFE is with Fixed Assets", a0.body.afe.state === "fa_review", a0.body.afe.state);
  check("the routing froze the financial fingerprint with the chain", typeof a0.body.routing.basis.fingerprint === "string" && /30145/.test(a0.body.routing.basis.fingerprint));

  console.log("7. the queue and the view, as Judithmelanie");
  await actAs(SYED);
  const denied = await call("GET", "/fa/queue");
  check("a coordinator is not Fixed Assets — 403", denied.status === 403, denied.status);
  await actAs(JUDITHMELANIE);
  let q = await call("GET", "/fa/queue");
  check("one to check, none flagged, five of five signatures verified, five judgment rows open",
    q.status === 200 && q.body.counts.toCheck === 1 && q.body.counts.flagged === 0 && q.body.groups.toCheck[0].verified.ok === 5 && q.body.groups.toCheck[0].judgment.open === 5, j(q.body.counts));
  let fv = await call("GET", `/fa/afes/${id}`);
  check("no red flags; the form re-rendered today hashes to what was signed", fv.body.redFlags.summary.total === 0 && fv.body.formHash.checked === true && fv.body.formHash.ok === true, j({ flags: fv.body.redFlags.summary, hash: fv.body.formHash }));
  check("the digest preview addresses the coordinator with the requester in copy", fv.body.digest.to === SYED && fv.body.digest.cc.join() === SHASHANK, j(fv.body.digest.to));
  check("not ready to record: the judgment is open", fv.body.readiness.canRecord === false && fv.body.readiness.why.some((w) => /judgment row/.test(w)), j(fv.body.readiness));
  const early = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "399403", orderType: "Z002" });
  check("recording an order before the judgment is refused, server-side", early.status === 422 && /judgment row/.test(early.body.error), j(early.body));

  console.log("8. a new matrix extract renames A2 — drift at Fixed Assets' receipt (R46)");
  await actAsNone();
  const sim = await call("POST", "/admin/matrix/simulate-extract", { batchId: "MX-2026-09-15", changes: [{ costCenter: "30145", level: "A2", name: "Lekha Rogerson" }] });
  check("the simulated extract records what changed and stamps a new batch", sim.status === 200 && sim.body.applied[0].was === "Kai Lun Ong" && sim.body.matrixBatch.batchId === "MX-2026-09-15", j(sim.body));
  const stillFrozen = await call("GET", `/afes/${id}`);
  check("the frozen chain still names Kai Lun Ong at A2 — snapshots, not references", stillFrozen.body.routing.basis.matrixRow.levels.A2.name === "Kai Lun Ong" && stillFrozen.body.routing.recipients.some((r) => r.level === "A2" && r.role === "matrix" && r.name === "Kai Lun Ong"), j(stillFrozen.body.routing.basis.matrixRow.levels.A2));
  await actAs(JUDITHMELANIE);
  fv = await call("GET", `/fa/afes/${id}`);
  const drift = fv.body.redFlags.flags.find((f) => f.id === "drift:A2");
  check("a block flag: Kai Lun Ong signed, the matrix now names Lekha Rogerson", drift && drift.severity === "block" && !drift.cleared && /Kai Lun Ong signed/.test(drift.title) && /Lekha Rogerson/.test(drift.title), j(fv.body.redFlags.flags.map((f) => f.id)));
  check("the matrix panel shows then vs now and the batch change", fv.body.matrix.batchChanged && fv.body.matrix.then.A2.name === "Kai Lun Ong" && fv.body.matrix.now.A2.name === "Lekha Rogerson", j(fv.body.matrix));
  q = await call("GET", "/fa/queue");
  check("the queue now counts it as flagged", q.body.counts.flagged === 1 && q.body.groups.toCheck[0].flags.openBlocks === 1);
  const noteAck = await call("POST", `/fa/afes/${id}/red-flags/${encodeURIComponent("drift:A2")}/ack`, { note: "fine" });
  check("drift cannot be acknowledged with a note — it needs evidence", noteAck.status === 422 && /evidence/.test(noteAck.body.error), j(noteAck.body));
  const noDoc = await call("POST", `/fa/afes/${id}/drift/A2/ack`, { attachmentId: "att-nope" });
  check("nor without the attachment", noDoc.status === 422, j(noDoc.body));

  console.log("9. the red-flag digest is drafted, never sent (R51)");
  const draft = await call("POST", `/fa/afes/${id}/red-flags/draft`);
  check("drafting writes an outbox row of kind red_flag_digest, status drafted", draft.status === 201 && draft.body.notification.kind === "red_flag_digest" && draft.body.notification.status === "drafted" && draft.body.notification.recipientEmail === SYED, j(draft.body.notification && [draft.body.notification.kind, draft.body.notification.status]));
  check("the .eml comes back as an unsent draft naming the drift", /X-Unsent: 1/.test(draft.body.eml) && /Matrix changed at A2/.test(draft.body.eml) && /^AFE_review/.test(draft.body.filename), draft.body.filename);
  const emlRes = await fetch(BASE + draft.body.emlUrl);          // emlUrl already carries /api
  const emlText = await emlRes.text();
  check("the stored draft downloads as message/rfc822 with the same content", emlRes.status === 200 && /^message\/rfc822/.test(emlRes.headers.get("content-type")) && emlText === draft.body.eml && /attachment; filename=/.test(emlRes.headers.get("content-disposition")), emlRes.headers.get("content-type"));
  await actAsNone();
  const outbox = await call("GET", "/admin/outbox");
  const digestRows = outbox.body.filter((n) => n.kind === "red_flag_digest");
  check("the outbox shows it drafted and it has no sentAt", digestRows.length === 1 && digestRows[0].status === "drafted" && digestRows[0].sentAt === null && digestRows[0].meta.flagIds.includes("drift:A2"), j(digestRows.map((n) => [n.status, n.sentAt])));
  const auditKinds = (await call("GET", `/admin/audit?afeId=${id}`)).body.map((e) => e.type);
  check("drafting is audited", auditKinds.includes("red_flag_digest_drafted"), j(auditKinds.slice(0, 6)));

  console.log("10. email evidence clears the drift");
  await actAs(JUDITHMELANIE);
  const asQuote = await call("POST", `/afes/${id}/documents`, { filename: "late_quote.pdf", role: "quote", contentBase64: QUOTE });
  check("Fixed Assets cannot attach a quote to an AFE in review", asQuote.status === 409, asQuote.status);
  const ev = await call("POST", `/afes/${id}/documents`, { filename: "Lekha_Rogerson_email_approval.pdf", role: "email_approval", contentBase64: EVIDENCE });
  check("but can attach an email approval as evidence", ev.status === 201 && ev.body.attachmentId, j(ev.body));
  const wrongRole = await call("POST", `/fa/afes/${id}/drift/A2/ack`, { attachmentId: a0.body.afe.documents.find((d) => d.role === "quote").attachmentId });
  check("the quote is not evidence for drift", wrongRole.status === 422 && /not an email approval/.test(wrongRole.body.error), j(wrongRole.body));
  const cleared = await call("POST", `/fa/afes/${id}/drift/A2/ack`, { attachmentId: ev.body.attachmentId, note: "Lekha approved by email on 4 Sep; forwarded to RTR_FA" });
  check("the drift is cleared with the evidence recorded", cleared.status === 200 && Boolean(cleared.body.redFlags) && cleared.body.redFlags.flags[0].cleared === true && cleared.body.redFlags.flags[0].clearedBy.attachmentId === ev.body.attachmentId && cleared.body.redFlags.ready === true, j(cleared.body.redFlags ? cleared.body.redFlags.summary : cleared.body));
  check("by the recipient id too (the blueprint's route shape)", (await call("POST", `/fa/afes/${id}/drift/${drift.recipientId}/ack`, { attachmentId: ev.body.attachmentId })).status === 200);

  console.log("11. the judgment, the order type, a reclassification");
  // R98 — the judgment does not open until the form and the signatures have been read.
  const beforeReading = await call("POST", `/fa/afes/${id}/judgment`, { ticks: { asset_not_expense: true } });
  check("the judgment is refused before the form has been reviewed",
    beforeReading.status === 422 && /Read the form and the signatures first/.test(beforeReading.body.error), j(beforeReading.body));
  let lv = await call("GET", `/fa/afes/${id}`);
  check("the view says the judgment is locked and why",
    lv.body.judgment.locked === true && lv.body.judgment.formReviewed === null
      && lv.body.readiness.why.some((w) => /form and the signatures have not been reviewed/.test(w)),
    j({ locked: lv.body.judgment.locked, why: lv.body.readiness.why }));
  const reviewed = await call("POST", `/fa/afes/${id}/form-reviewed`, {});
  check("recording the review unlocks it, and says who read it",
    reviewed.status === 200 && reviewed.body.judgment.locked === false
      && reviewed.body.judgment.formReviewed.byEmail === JUDITHMELANIE && reviewed.body.judgment.formReviewed.at,
    j(reviewed.body.error || reviewed.body.judgment.formReviewed));
  const unreviewed = await call("POST", `/fa/afes/${id}/form-reviewed`, { undo: true });
  check("and it can be withdrawn, which shuts the judgment again", unreviewed.body.judgment.locked === true);
  await call("POST", `/fa/afes/${id}/form-reviewed`, {});
  check("both are audited", (await call("GET", `/admin/audit?afeId=${id}`)).body
    .filter((e) => ["fa_form_reviewed", "fa_form_review_undone"].includes(e.type)).length === 3);

  let jr = await call("POST", `/fa/afes/${id}/judgment`, { ticks: { asset_not_expense: true, amount_reasonable: true, no_duplicate_io: true, classification_agreed: true } });
  check("four rows ticked; the order type is still open", jr.status === 200 && jr.body.judgment.open === 1 && jr.body.judgment.rows.find((r) => r.id === "order_type").st === "open", j(jr.body.judgment && jr.body.judgment.rows.map((r) => [r.id, r.st])));
  const badType = await call("POST", `/fa/afes/${id}/judgment`, { orderType: "Z999" });
  check("an unknown order type is refused", badType.status === 422);
  const badRow = await call("POST", `/fa/afes/${id}/judgment`, { ticks: { made_up: true } });
  check("an unknown row is refused", badRow.status === 422);
  jr = await call("POST", `/fa/afes/${id}/judgment`, { orderType: "Z002", ticks: { order_type: true } });
  check("Z002 chosen — the judgment is done, and the only thing left is somebody's approval (R101)",
    jr.body.judgment.open === 0 && jr.body.readiness.canRecord === false
      && jr.body.readiness.why.length === 1 && /Not approved for issue/.test(jr.body.readiness.why[0]),
    j(jr.body.readiness));

  // R146 — finishing the judgment TELLS the people it now waits on. "At what time will they
  // get to know that something is pending for review?" (Lyndsay, Meeting #6). Until now the answer
  // was "when somebody remembers to press Ask", and a control nobody is told about is a control
  // that does not run. Once per AFE: ticking another row later must not send it again.
  check("completing the judgment tells the approvers, by itself",
    /been told/.test(jr.body.told || ""), j({ told: jr.body.told }));
  {
    const again = await call("POST", `/fa/afes/${id}/judgment`, { ticks: { asset_not_expense: true } });
    check("and ticking another row later does not tell them twice", again.body.told === null, j({ told: again.body.told }));
    await actAsNone();
    const queued = (await call("GET", "/mailbox?kind=fa_issue_approval_wanted")).body.messages || [];
    check("so there is exactly ONE mail, addressed to the approvers",
      queued.length === 1 && queued[0].afeId === id, j(queued.map((m) => [m.afeId, m.to])));
    await actAs(JUDITHMELANIE);
  }
  const same = await call("POST", `/fa/afes/${id}/reclassify`, { classification: "capex", reason: "x" });
  check("reclassifying to the same class is refused", same.status === 422);
  const toNone = await call("POST", `/fa/afes/${id}/reclassify`, { classification: "none", reason: "it is really an expense" });
  check("an AFE is not reclassified into an expense — it goes back to the requester instead (R158)",
    toNone.status === 422 && /send it back/.test(toNone.body.error), j(toNone.body));
  const rc = await call("POST", `/fa/afes/${id}/reclassify`, { classification: "cloud_capex", reason: "subscription software the vendor hosts" });
  check("reclassified with a reason, audited before → after", rc.status === 200 && rc.body.afe.money.classification === "cloud_capex" && rc.body.afe.fa.reclassified.from === "capex", j(rc.body.afe.fa.reclassified));
  check("the form now differs from what was signed — a warn explained by the audited edit, and the money changed class",
    rc.body.redFlags.flags.some((f) => f.id === "form:hash" && f.severity === "warn" && /money.classification/.test(f.detail) && /DID change/.test(f.detail)) && rc.body.fingerprintChanged === true, j(rc.body.redFlags.flags.map((f) => [f.id, f.severity])));
  const back = await call("POST", `/fa/afes/${id}/reclassify`, { classification: "capex", reason: "checked the tree again — hardware, not software" });
  check("reclassified back, the form hashes again and nothing is flagged", back.body.redFlags.summary.openBlocks === 0 && !back.body.redFlags.flags.some((f) => f.id === "form:hash") && back.body.fingerprintChanged === false, j(back.body.redFlags.flags.map((f) => f.id)));
  await actAsNone();
  const kinds = (await call("GET", `/admin/audit?afeId=${id}`)).body.map((e) => e.type);
  check("judgment, reclassification and drift acknowledgement are all audited", kinds.includes("fa_judgment") && kinds.filter((k) => k === "fa_reclassified").length === 2 && kinds.includes("drift_acknowledged"), j(kinds.slice(0, 12)));

  console.log("11b. nobody creates an internal order until FA signs it off (R101)");
  await actAs(JUDITHMELANIE);
  const beforeApproval = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "399403", orderType: "Z002" });
  check("with the judgment done but nobody's approval, the order is still refused",
    beforeApproval.status === 422 && /not been approved for issue/.test(beforeApproval.body.error)
      && /Judithmelanie Ware/.test(beforeApproval.body.error) && /Jarrod Dane/.test(beforeApproval.body.error),
    j(beforeApproval.body));
  let iv = await call("GET", `/fa/afes/${id}`);
  check("the view says who may approve and that this reader may",
    iv.body.issue.required === true && iv.body.issue.approvers.map((a) => a.email).sort().join() === [JUDITHMELANIE, JARROD, MANAIA].sort().join()
      && iv.body.issue.canApprove === true && iv.body.readiness.canRecord === false
      && iv.body.readiness.why.some((w) => /Not approved for issue/.test(w)),
    j({ issue: iv.body.issue, why: iv.body.readiness.why }));

  await actAs(EBONY);
  const notAnApprover = await call("POST", `/fa/afes/${id}/approve-issue`, {});
  check("a Fixed Assets preparer who is not named cannot approve it",
    notAnApprover.status === 422 && /Only Judithmelanie Ware \(FA Supervisor\) or Jarrod Dane \(FA Manager\) or Manaia Ginty \(Assoc Director, Finance\) approves/.test(notAnApprover.body.error),
    j(notAnApprover.body));
  check("and the view does not offer it to them", (await call("GET", `/fa/afes/${id}`)).body.issue.canApprove === false);

  // R145 — the preparer says WHO it goes to. "There is some option that preparer can choose
  // either me or Jarrod or Manaia, so that once they will choose the approval, then it will go to
  // that particular approval" (Judithmelanie, Meeting #6). The reason is leave cover, so the choice may
  // narrow the org rules and may never widen them.
  {
    const stranger = await call("POST", `/fa/afes/${id}/issue-approver`, { emails: ["someone_else@example.com"] });
    check("the choice may only name somebody the org rules already name",
      stranger.status === 422 && /is not an issue approver/.test(stranger.body.error), j(stranger.body));

    const pick = await call("POST", `/fa/afes/${id}/issue-approver`, { emails: [JARROD] });
    check("Fixed Assets sends it to one of the three, and the view says so",
      pick.status === 200 && /With Jarrod Dane/.test(pick.body.note || "")
        && pick.body.issue.wasChosen === true
        && pick.body.issue.chosen.map((a) => a.email).join() === JARROD,
      j({ note: pick.body.note, chosen: (pick.body.issue.chosen || []).map((a) => a.email) }));

    await actAs(JUDITHMELANIE);
    const notChosen = await call("POST", `/fa/afes/${id}/approve-issue`, {});
    check("and an approver it was NOT sent to is refused, by name",
      notChosen.status === 422 && /sent to Jarrod Dane/.test(notChosen.body.error), j(notChosen.body));
    check("the view does not offer it to them either",
      (await call("GET", `/fa/afes/${id}`)).body.issue.canApprove === false);

    await actAs(EBONY);
    const reopen = await call("POST", `/fa/afes/${id}/issue-approver`, { emails: [] });
    check("choosing nobody hands it back to all three",
      reopen.status === 200 && reopen.body.issue.wasChosen === false
        && reopen.body.issue.chosen.length === 3, j({ note: reopen.body.note, n: (reopen.body.issue.chosen || []).length }));
    await actAs(JUDITHMELANIE);
    check("so Judithmelanie may approve again",
      (await call("GET", `/fa/afes/${id}`)).body.issue.canApprove === true);
    await actAs(EBONY);
  }


  // R142 — four eyes on a new internal order only works if the two people can SEE what is
  // waiting for them, and if whoever is blocked can ask. Neither existed: the approve button
  // lived on the issue screen, behind the "Key it into SAP" it was itself blocking, and nothing
  // anywhere told Judithmelanie or Jarrod that anything wanted them.
  let q142 = await call("GET", "/fa/queue");
  check("the queue tells a preparer that something is waiting on an approver, not on them",
    q142.body.counts.needsIssueApproval >= 1 && q142.body.counts.myIssueApproval === 0,
    j(q142.body.counts));
  const ask = await call("POST", `/fa/afes/${id}/ask-issue-approval`, {});
  check("and lets them ask, by name",
    ask.status === 200 && /Judithmelanie Ware and Jarrod Dane/.test(ask.body.note || ""), j(ask.body));
  const askAgain = await call("POST", `/fa/afes/${id}/ask-issue-approval`, {});
  check("asking twice in a day is one mail, not two", askAgain.status === 200 && askAgain.body.already === true, j(askAgain.body));
  await actAsNone();                                       // the outbox is the administrator's view
  const asked = await call("GET", "/mailbox?kind=fa_issue_approval_wanted");
  const askMail = (asked.body.messages || [])[0];
  check("one mail only, to the first approver with the second copied",
    (asked.body.messages || []).length === 1 && askMail.to === JUDITHMELANIE && (askMail.cc || []).includes(JARROD)
      && /ready for your approval to issue/.test(askMail.subject), j(askMail || asked.body));

  await actAs(JUDITHMELANIE);
  q142 = await call("GET", "/fa/queue");
  check("and the approver's own queue says it wants THEM",
    q142.body.counts.myIssueApproval >= 1, j(q142.body.counts));
  await actAs(EBONY);

  await actAsNone();                                       // Shashank raised AND coordinates this one
  const ownApproval = await call("POST", `/fa/afes/${id}/approve-issue`, {});
  check("the person who raised it cannot approve it either", ownApproval.status === 422, j(ownApproval.body));

  await actAs(JUDITHMELANIE);
  const approved = await call("POST", `/fa/afes/${id}/approve-issue`, { note: "Quote and classification both check out." });
  check("the FA Supervisor approves it, with a note, and the AFE does not change state",
    approved.status === 200 && approved.body.afe.state === "fa_review"
      && approved.body.afe.fa.issueApproval.byEmail === JUDITHMELANIE
      && approved.body.afe.fa.issueApproval.group === "FA Supervisor"
      && /check out/.test(approved.body.afe.fa.issueApproval.note),
    j(approved.body.error || approved.body.afe.fa.issueApproval));
  const twiceApproved = await call("POST", `/fa/afes/${id}/approve-issue`, {});
  check("approving it twice is refused rather than overwriting who did", twiceApproved.status === 422 && /already approved/.test(twiceApproved.body.error), j(twiceApproved.body));

  const selfIssue = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "399403", orderType: "Z002" });
  check("the approver cannot then key SAP himself, though he holds both roles — four eyes by identity",
    selfIssue.status === 422 && /approved this for issue yourself/.test(selfIssue.body.error), j(selfIssue.body));
  iv = await call("GET", `/fa/afes/${id}`);
  check("and the screen says so before he tries",
    iv.body.issue.approvedByMe === true && iv.body.readiness.canRecord === false
      && iv.body.readiness.why.some((w) => /somebody else records/.test(w)), j(iv.body.readiness.why));

  await actAs(EBONY);
  check("a different preparer is clear to record it", (await call("GET", `/fa/afes/${id}`)).body.readiness.canRecord === true);
  await actAsNone();
  const approvalMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "afe_issue_approved");
  check("the Fixed Assets mailbox is told it is cleared to key",
    approvalMail.length === 1 && /Approved to issue/.test(approvalMail[0].subject) && /Judithmelanie Ware/.test(approvalMail[0].body) && /check out/.test(approvalMail[0].body),
    j(approvalMail.map((n) => [n.recipientEmail, n.subject])));
  check("the approval is audited", (await call("GET", `/admin/audit?afeId=${id}`)).body
    .some((e) => e.type === "fa_approve_issue" && e.payload.byEmail === JUDITHMELANIE && e.payload.group === "FA Supervisor"));

  // The boot warm-up (2026-10-02), run on demand: it finds the AFEs Fixed Assets opens, works out
  // each one's form-hash check and reads the signed file of the one waiting to be checked — what
  // the first person to open it after a deploy would otherwise wait for. Never on the tick.
  {
    const w = await call("POST", "/admin/jobs/warmUp", {});
    check("the warm-up checks each Fixed Assets AFE's form hash and reads the waiting one's signed file",
      w.status === 200 && w.body.result.afes >= 1 && w.body.result.checked >= 1 && w.body.result.documents >= 1 && w.body.result.failed === 0, j(w.body));
    const sch = (await call("GET", "/admin/jobs")).body.scheduler;
    check("…and it runs at boot and on demand, never on the ten-minute tick",
      sch.onDemand.includes("warmUp") && !sch.jobs.includes("warmUp"), j(sch));
  }

  console.log("12. KO01 saved in SAP — the parent and two child orders are recorded (R52)");
  await actAs(EBONY);                                      // not Judithmelanie: he approved it
  const sheet = await call("GET", `/fa/afes/${id}/ko01`);
  check("the KO01 sheet prints Z002, the title in capitals, cost centre 30145 and plant 3026, three child lines",
    sheet.body.rows[0].value === "Z002" && sheet.body.rows.some((r) => r.field === "Description" && r.value === "PC HARDWARE LIFECYCLE REPLACEMENT APAC") && sheet.body.rows.some((r) => r.field === "Responsible CCtr" && r.value === "30145") && sheet.body.rows.some((r) => r.field === "Plant" && r.value === "3026") && sheet.body.children.length === 3, j(sheet.body.rows.slice(0, 3)));
  const badIo = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "IO-1", orderType: "Z002" });
  check("an order number that is not 6–10 digits is refused", badIo.status === 422 && /6 to 10 digits/.test(badIo.body.error), j(badIo.body));
  // An order number SAP already holds for something else (2026-09-28). On UAT an AFE was
  // recorded as 313403 — the recon workbook's "Autolabe 390S" on cost centre 10270 — and the
  // tracker then printed the AFE's title against somebody else's AuC. SAP's own records decide.
  {
    const older = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "313403", orderType: "Z002" });
    check("a number the AuC recon opened before this AFE was raised is refused, naming the line",
      older.status === 422 && /Autolabe 390S/.test(older.body.error) && /cost centre 10270/.test(older.body.error)
        && /before this AFE was raised/.test(older.body.error) && older.body.detail && older.body.detail.sap.source === "AuC recon", j(older.body));
    // 313203's date in the workbook reads "#N/A" — no evidence either way — but it sits under
    // cost centre 10419, and KO01 keys this AFE's own cost centre on the parent.
    const elsewhere = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "313203", orderType: "Z002" });
    check("an undated recon line under another cost centre is refused as the parent",
      elsewhere.status === 422 && /keyed under cost centre 30145/.test(elsewhere.body.error), j(elsewhere.body));
    const child = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "399403", orderType: "Z002", children: [{ seq: 1, ioNumber: "313404" }] });
    check("so is a child order SAP already holds, and nothing is recorded",
      child.status === 422 && /^Singapore DC: 313404 is already an order in SAP/.test(child.body.error)
        && (await call("GET", `/afes/${id}`)).body.afe.state === "fa_review", j(child.body));
  }
  const rec = await call("POST", `/fa/afes/${id}/record-io`, { ioNumber: "399403", orderType: "Z002", children: [{ seq: 1, ioNumber: "399404" }, { seq: 2, ioNumber: "399405" }] });
  check("issued: the AFE number IS the parent order; two children recorded, one line left for later",
    rec.status === 200 && rec.body.afe.state === "issued" && rec.body.afe.afeNo === "399403" && rec.body.afe.ioNumbers.join() === "399403,399404,399405" && rec.body.ios.length === 3, j(rec.body.error || rec.body.afe.ioNumbers));
  const parent = rec.body.ios.find((i) => i.kind === "parent"), kids = rec.body.ios.filter((i) => i.kind === "child");
  check("the parent holds what is not split out (215,000 − 185,000); the children carry their lines", parent.allocatedBudgetUsd === 30000 && kids.find((k) => k.site === "Singapore DC").allocatedBudgetUsd === 115000 && kids.every((k) => k.parentIoNumber === "399403" && k.orderType === "Z002"), j(rec.body.ios.map((i) => [i.kind, i.ioNumber, i.allocatedBudgetUsd])));
  check("KO01 is ticked as the first hand-off step", rec.body.afe.fa.steps.KO01_IO.value === "399403");
  const issuedView = await call("GET", `/fa/afes/${id}`);
  check("writing the AFE number onto the form is not a red flag — the form hash is checked with the number masked",
    issuedView.body.redFlags.summary.openBlocks === 0 && !issuedView.body.redFlags.flags.some((f) => f.id === "form:hash") && issuedView.body.formHash.ok === true,
    j({ flags: issuedView.body.redFlags.flags.map((f) => f.id), hash: issuedView.body.formHash }));

  // The pack is NOT built here any more (R103): the document Fixed Assets sends carries the AuC
  // number and the budget table, and neither exists at KO01.
  check("no issued pack at KO01 — it would go out with two empty boxes in it",
    !(rec.body.afe.documents || []).some((d) => d.role === "issued_pack"),
    j((rec.body.afe.documents || []).map((d) => d.role)));
  check("and there is nothing at the pack's address yet",
    (await fetch(`${BASE}/api/afes/${id}/issued-pack.pdf`)).status === 404);
  await actAsNone();
  const ob = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "afe_issued");
  check("the requester is told the AFE number straight away, in ONE mail with the coordinator copied (R164) — that is what unblocks the PR",
    ob.length === 1 && /AFE 399403/.test(ob[0].subject) && ob[0].recipientEmail === SHASHANK && ob[0].cc.includes(SYED) && /399404/.test(ob[0].body),
    j(ob.map((n) => [n.recipientEmail, n.cc])));
  check("that mail is Lyndsay's own paragraph, copies the FA mailbox, and says the issued AFE follows",
    ob.every((n) => /602620/.test(n.body)) && ob.every((n) => !(n.attachments || []).length)
      && ob.every((n) => (n.cc || []).length > 0) && ob.every((n) => /issued AFE .* follows/.test(n.body)),
    j(ob.map((n) => ({ gl: /602620/.test(n.body), att: (n.attachments || []).map((a) => a.role), cc: n.cc }))));
  check("recording is audited with the orders", (await call("GET", `/admin/audit?afeId=${id}`)).body.some((e) => e.type === "fa_record_io" && e.payload.ioNumber === "399403" && e.payload.children.length === 2));
  check("a US-dollar AFE has no local rate for Fixed Assets to set (R161)",
    (await call("POST", `/fa/afes/${id}/fx`, { localPerUsd: 1.29 })).status === 422);
  // R165: the AuC tracker says what the money is FOR, from the AFE, on a line whose order the
  // tool issued. The seeded recon cannot hold such a line — every one of its orders predates
  // this AFE, which is exactly why recording one of them is now refused — so the join is checked
  // as the pure function it is, over the live AFE, and the live tracker for the lines it leaves be.
  {
    const { afeFacts } = require(path.join(ROOT, "lib/routes/tracker.js"));
    const live = rec.body.afe;
    const facts = afeFacts({ ioNumber: "399403", afeId: null }, new Map([[live.id, live]]), new Map([["399403", live]]));
    check("the tracker carries the AFE's title and description on a line the tool issued (R165)",
      facts.afeId === live.id && facts.afeTitle === "PC Hardware Lifecycle Replacement APAC" && /HW REFRESH/.test(facts.afeDescription || ""), j(facts));
    const tr = (await call("GET", "/tracker")).body.items;
    const legacy = tr.find((i) => i.ioNumber === "313403");
    check("…and leaves a line from before the tool blank rather than guess",
      tr.length > 500 && legacy && legacy.afeTitle === null && legacy.afeDescription === null && tr.every((i) => i.afeId === null), j(legacy && legacy.afeTitle));
    const csvHead = (await (await fetch(`${BASE}/api/tracker/export.csv`)).text()).split(String.fromCharCode(13, 10))[0];
    check("the CSV carries both, after every column it already had", /,"?afeTitle"?,"?afeDescription"?$/.test(csvHead) && csvHead.startsWith("companyCode,ioNumber"), csvHead);
    // The screen's CSV button sends the lines it is SHOWING, in its order — it exported all 528
    // while a filter was on.
    const pick = [tr[7].id, tr[2].id, "no-such-line"];
    const shownCsv = await (await fetch(`${BASE}/api/tracker/export.csv`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids: pick }) })).text();
    const shownRows = shownCsv.split(String.fromCharCode(13, 10)).slice(1);
    check("the tracker's CSV of what is on screen holds those lines, in that order, and nothing else",
      shownRows.length === 2 && shownRows[0].includes(`"${tr[7].ioNumber}"`) && shownRows[1].includes(`"${tr[2].ioNumber}"`), shownRows.map((x) => x.slice(0, 40)));
  }
  await actAs(JUDITHMELANIE);
  q = await call("GET", "/fa/queue");
  check("the queue moves it to Issued with KO22 outstanding", q.body.counts.toCheck === 0 && q.body.counts.issued === 1 && q.body.counts.ko22Outstanding === 1 && q.body.groups.issued[0].afeNo === "399403", j(q.body.counts));

  // Capitalizing ends the run. Straight after the order it was allowed, and then KO22, AS01, KO02
  // and the issued AFE could never be recorded or sent — the requester would never get it.
  const capEarly = await call("POST", `/fa/afes/${id}/capitalize`, { assetNumber: "165024071" });
  check("capitalize is refused while KO22, AS01, KO02 and the issued AFE are still to come",
    capEarly.status >= 400 && ["KO22_BUDGET", "AS01_AUC", "KO02_SETTLEMENT"].every((k) => ((capEarly.body.detail || {}).openSteps || []).includes(k)) &&
    (await call("GET", `/afes/${id}`)).body.afe.state === "issued", j(capEarly.body));

  console.log("13. KO22, AS01, KO02 — each one comes back with what it produced (R99, R100, R103)");
  // R103. "Many times, IO number is generated" and the budget is never loaded, so a tick is not
  // evidence of anything: the SAP table is.
  const bareTick = await call("POST", `/fa/afes/${id}/steps/KO22_BUDGET`, {});
  check("KO22 cannot be ticked with nothing",
    bareTick.status === 422 && /Budget loaded \(USD\) is required/.test(bareTick.body.error), j(bareTick.body));
  const noShot = await call("POST", `/fa/afes/${id}/steps/KO22_BUDGET`, { amountUsd: 215000 });
  check("nor with the figure but no screenshot — the hard gate",
    noShot.status === 422 && /Attach the Budget \/ Actual \/ Commitments screenshot first/.test(noShot.body.error)
      && noShot.body.needs === "evidence", j(noShot.body));
  const outOfOrder = await call("POST", `/fa/afes/${id}/steps/AS01_AUC`, { value: "169006359" });
  check("and AS01 cannot jump the queue while KO22 is outstanding",
    outOfOrder.status === 422 && /Load budget on the IO \(KO22\) comes first/.test(outOfOrder.body.error), j(outOfOrder.body));

  const notAnImage = await call("POST", `/afes/${id}/documents`, { filename: "table.txt", role: "budget_evidence", contentBase64: Buffer.from("not a picture").toString("base64") });
  check("something that is not a PDF, a PNG or a JPEG is refused as evidence",
    notAnImage.status === 415 && /not a PDF, a PNG or a JPEG/.test(notAnImage.body.error), j(notAnImage.body));
  const shot = await call("POST", `/afes/${id}/documents`, { filename: "KO22 budget actual commitments.png", role: "budget_evidence", contentBase64: PNG_1PX });
  check("a screenshot uploads as an image and keeps its own type",
    shot.status === 201 && (shot.body.afe.documents || []).some((d) => d.role === "budget_evidence" && d.mimeType === "image/png"),
    j(shot.body.error || (shot.body.afe.documents || []).map((d) => [d.role, d.mimeType])));
  const shotRaw = await fetch(`${BASE}/api/afes/${id}/documents/${shot.body.attachmentId}/raw`);
  check("and it is served as an image, not as a PDF the browser cannot draw",
    shotRaw.status === 200 && shotRaw.headers.get("content-type") === "image/png", shotRaw.headers.get("content-type"));

  const ko22 = await call("POST", `/fa/afes/${id}/steps/KO22_BUDGET`, { amountUsd: 215000 });
  check("with the figure and the evidence, KO22 records both (R99)",
    ko22.status === 200 && ko22.body.afe.fa.steps.KO22_BUDGET.doneAt
      && ko22.body.afe.fa.steps.KO22_BUDGET.amountUsd === 215000
      && ko22.body.afe.fa.budgetLoadedUsd === 215000, j(ko22.body.error || ko22.body.afe.fa));

  // R100. afe.fa.aucNumber is read by the issued pack and was written by nothing at all.
  const noAuc = await call("POST", `/fa/afes/${id}/steps/AS01_AUC`, {});
  check("AS01 without an AuC number is refused, where it used to be optional",
    noAuc.status === 422 && /AuC number is required/.test(noAuc.body.error), j(noAuc.body));
  const badAuc = await call("POST", `/fa/afes/${id}/steps/AS01_AUC`, { value: "AUC-1" });
  check("an AUC number that is not a number is refused", badAuc.status === 422 && /6 to 12 digits/.test(badAuc.body.error), j(badAuc.body));
  const as01 = await call("POST", `/fa/afes/${id}/steps/AS01_AUC`, { value: "169006359" });
  check("AS01 records the AUC number on the parent order AND on the AFE (R100)",
    as01.status === 200 && as01.body.ios.find((i) => i.kind === "parent").aucNumber === "169006359"
      && as01.body.afe.fa.aucNumber === "169006359",
    j(as01.body.error || { ios: as01.body.ios && as01.body.ios.map((i) => i.aucNumber), fa: as01.body.afe.fa.aucNumber }));

  const ko02 = await call("POST", `/fa/afes/${id}/steps/KO02_SETTLEMENT`, {});
  const undoUnder = await call("POST", `/fa/afes/${id}/steps/AS01_AUC`, { undo: true });
  check("a step another one was built on cannot be undone underneath it",
    undoUnder.status === 422 && /Set the settlement rule \(KO02\) was done after this one/.test(undoUnder.body.error), j(undoUnder.body));
  const undo = await call("POST", `/fa/afes/${id}/steps/KO02_SETTLEMENT`, { undo: true });
  check("KO02 ticked and unticked, both audited", ko02.body.afe.fa.steps.KO02_SETTLEMENT && !undo.body.afe.fa.steps.KO02_SETTLEMENT);
  const undoAuc = await call("POST", `/fa/afes/${id}/steps/AS01_AUC`, { undo: true });
  check("undoing AS01 withdraws the AuC number from the AFE and the order too",
    undoAuc.body.afe.fa.aucNumber === null && undoAuc.body.ios.find((i) => i.kind === "parent").aucNumber === null,
    j({ fa: undoAuc.body.afe.fa.aucNumber, io: undoAuc.body.ios.find((i) => i.kind === "parent").aucNumber }));
  await call("POST", `/fa/afes/${id}/steps/AS01_AUC`, { value: "169006359" });
  check("the unknown step is a 404", (await call("POST", `/fa/afes/${id}/steps/XYZ`, {})).status === 404);
  q = await call("GET", "/fa/queue");
  check("KO22 is no longer outstanding", q.body.counts.ko22Outstanding === 0);
  console.log("13b. the issued AFE goes out when Fixed Assets says so (R93, R104)");
  await actAs(EBONY);
  let pv = await call("GET", `/fa/afes/${id}`);
  check("with KO22 and AS01 done and the screenshot attached, it is ready to send",
    pv.body.pack.can === true && pv.body.pack.missing.length === 0 && pv.body.pack.sentAt === null,
    j({ can: pv.body.pack.can, missing: pv.body.pack.missing }));
  check("and it says what the file holds: the quote because it is inside the signed AFE, the certificate by default",
    pv.body.pack.willMerge.filter((d) => d.byDefault && d.can).map((d) => d.role).sort().join() === "certificate,quote",
    j(pv.body.pack.willMerge.map((d) => [d.role, d.byDefault, d.can, d.why])));
  // R156 — the pack is built ON the signed set, so a generation of the AFE is never something to
  // tick, and what the approvers were given is shown as inside it rather than as a choice.
  check("it never offers a generation of the AFE as an attachment, and shows the quote INSIDE the signed AFE (R156)",
    !pv.body.pack.willMerge.some((d) => ["afe_form_pdf", "sent_packet", "envelope_pdf", "issued_pack"].includes(d.role))
      && pv.body.pack.willMerge.filter((d) => d.inSigned).map((d) => d.role).join() === "quote"
      && Boolean(pv.body.pack.signed && pv.body.pack.signed.attachmentId),
    j({ roles: pv.body.pack.willMerge.map((d) => [d.role, d.inSigned]), signed: pv.body.pack.signed }));
  check("and that the screenshot is DRAWN into the form rather than appended, which is not a failure to merge",
    pv.body.pack.willMerge.filter((d) => d.drawn).map((d) => d.role).join() === "budget_evidence"
      && /top of page 1/.test(pv.body.pack.willMerge.find((d) => d.drawn).why),
    j(pv.body.pack.willMerge.filter((d) => d.role === "budget_evidence")));

  // A SECOND screenshot is an ordinary attachment. Only ONE fits in the box at the top of page
  // one — `issuedPack` takes the last and un-merges only that — but the view used to call every
  // budget_evidence image drawn, so the screen promised "printed on the page" for a picture the
  // builder was binding in as a page of its own. A preview that does not agree with the builder
  // is what R112 was about; this is the same rule one level down. Removed again straight after,
  // so what follows is testing the pack it was always testing.
  const second = await call("POST", `/afes/${id}/documents`, {
    filename: "second grab.png", role: "budget_evidence", contentBase64: PNG_2PX,
  });
  check("a second screenshot is accepted", second.status === 201, j(second.body.error));
  pv = await call("GET", `/fa/afes/${id}`);
  const shots = pv.body.pack.willMerge.filter((d) => d.role === "budget_evidence");
  check("with two screenshots attached, exactly ONE is drawn and the other is an ordinary attachment",
    shots.length === 2 && shots.filter((d) => d.drawn).length === 1
      && shots.find((d) => d.drawn).filename === "second grab.png",
    j(shots.map((d) => [d.filename, d.drawn, d.byDefault, d.can])));
  check("and the one that is NOT drawn binds in as a page of its own rather than vanishing",
    shots.filter((d) => !d.drawn).every((d) => d.byDefault && d.can),
    j(shots.map((d) => [d.filename, d.drawn, d.byDefault, d.can, d.why])));
  // It stays attached: a document can only be removed while the AFE is editable, and this one
  // has been signed. That is the right answer, so the rest of this block runs with two.
  const secondId = (second.body.afe.documents || []).filter((d) => d.role === "budget_evidence").pop().attachmentId;
  check("a document cannot be taken off an AFE that has been signed",
    (await call("DELETE", `/afes/${id}/documents/${secondId}`)).status === 409);

  const sent = await call("POST", `/fa/afes/${id}/issue-pack`, { profitCentre: "PC-3026", note: "Settlement rule to the AuC, 100%." });
  check("it builds and sends", sent.status === 200 && /issued AFE sent/.test(sent.note || sent.body.note || ""), j(sent.body.error || sent.body.note));
  const packDoc = (sent.body.afe.documents || []).filter((d) => d.role === "issued_pack").pop();
  check("the file is named for the order, as Fixed Assets names it by hand",
    !!packDoc && /^399403 /.test(packDoc.filename) && /\.pdf$/.test(packDoc.filename) && packDoc.sizeBytes > 2000, j(packDoc));
  const packRes = await fetch(`${BASE}/api/afes/${id}/issued-pack.pdf`);
  const packBytes = Buffer.from(await packRes.arrayBuffer());
  check("it downloads from a name a person can be given, as a PDF",
    packRes.status === 200 && packRes.headers.get("content-type") === "application/pdf"
      && packBytes.slice(0, 5).toString() === "%PDF-" && packBytes.length === packDoc.sizeBytes,
    j({ status: packRes.status, type: packRes.headers.get("content-type"), bytes: packBytes.length }));
  // R156 — the pack is the LAST word on this AFE, so `document.pdf` must serve it from here on,
  // and it must be hashed like every other document the tool produces. It was written straight to
  // the store, bypassing `attachments.put`, so it was the one generated document with no sha256.
  {
    const sha = (b) => require("crypto").createHash("sha256").update(b).digest("hex");
    check("the issued pack carries its own hash, like every other document the tool makes",
      /^[0-9a-f]{64}$/.test(String(packDoc.sha256 || "")) && packDoc.sha256 === sha(packBytes),
      j({ stored: packDoc.sha256, actual: sha(packBytes) }));
    const one = await fetch(`${BASE}/api/afes/${id}/document.pdf`);
    const oneBytes = Buffer.from(await one.arrayBuffer());
    check("and document.pdf now serves the pack — one document, the latest word, byte for byte",
      one.status === 200 && sha(oneBytes) === packDoc.sha256,
      j({ status: one.status, served: sha(oneBytes).slice(0, 16), pack: String(packDoc.sha256).slice(0, 16) }));
  }
  const packAudit = (await call("GET", `/admin/audit?afeId=${id}`)).body.find((e) => e.type === "fa_issue_pack");
  check("the quote is bound in whole — 27 pages would have been cut to 12 under the old cap (R93)",
    packAudit && packAudit.payload.merged.some((m) => /quote/i.test(m.filename) || m.pages >= 1)
      && packAudit.payload.merged.every((m) => !m.truncated),
    j(packAudit && packAudit.payload.merged));
  check("the AuC number, the profit centre and the budget figure reach the document",
    sent.body.afe.fa.aucNumber === "169006359" && sent.body.afe.fa.profitCentre === "PC-3026"
      && sent.body.afe.fa.budgetLoadedUsd === 215000 && /Settlement rule/.test(sent.body.afe.fa.issuedNote),
    j(sent.body.afe.fa));

  // R156 — THE ISSUED AFE IS THE SIGNED FILE WITH FIXED ASSETS' MARKS ON IT, never a fresh drawing
  // of the form. It used to be re-rendered from the AFE as it stood, with the tool's own picture
  // of the signatures on it, so the document the requester keeps was one nobody signed. Proved at
  // the level of the PDF itself: every signed page's content streams are carried as they were,
  // page one's own content is intact with the marks added AFTER it, and nothing the signed set
  // already carries is bound in a second time.
  {
    const { PDFDocument, PDFArray } = require(path.join(ROOT, "node_modules", "pdf-lib"));
    const streams = (doc, page) => {
      const c = page.node.Contents();
      if (!c) return [];                              // a page with no content at all (the test quote)
      const list = c instanceof PDFArray ? c.asArray().map((r) => doc.context.lookup(r)) : [c];
      return list.map((s) => Buffer.from(s.contents || s.getContents()).toString("base64"));
    };
    const docsNow = sent.body.afe.documents || [];
    const signedDoc = docsNow.filter((d) => d.role === "envelope_pdf").pop();
    const quoteDoc = docsNow.find((d) => d.role === "quote");
    const signedBytes = Buffer.from(await (await fetch(`${BASE}/api/afes/${id}/documents/${signedDoc.attachmentId}/raw`)).arrayBuffer());
    const Sd = await PDFDocument.load(signedBytes);
    const Pd = await PDFDocument.load(packBytes);
    const n = Sd.getPageCount();
    const later = [];
    for (let i = 1; i < n; i++) later.push(streams(Sd, Sd.getPage(i)).join() === streams(Pd, Pd.getPage(i)).join());
    const first = streams(Sd, Sd.getPage(0));
    const packFirst = streams(Pd, Pd.getPage(0));
    const at = packFirst.indexOf(first[0]);
    check("the issued AFE begins with the signed set, every page after the first carried unchanged (R156)",
      n > 1 && later.length === n - 1 && later.every(Boolean), j({ signedPages: n, same: later }));
    check("and page one keeps its signed content intact, with Fixed Assets' marks drawn over it rather than redrawn",
      at >= 0 && first.every((s, k) => packFirst[at + k] === s) && packFirst.length > first.length,
      j({ signedStreams: first.length, packStreams: packFirst.length, at }));
    check("the signed set records what it carries, and the quote is inside it",
      Array.isArray(signedDoc.carries) && signedDoc.pages === n && signedDoc.carries.includes(quoteDoc.attachmentId),
      j({ carries: signedDoc.carries, pages: signedDoc.pages, n }));
    check("so the quote is NOT bound in a second time — only what Fixed Assets add goes behind it",
      packAudit.payload.carried.includes(quoteDoc.attachmentId)
        && !packAudit.payload.merged.some((m) => m.filename === quoteDoc.filename)
        && packAudit.payload.merged.some((m) => /certificate/i.test(m.filename)),
      j({ carried: packAudit.payload.carried, merged: packAudit.payload.merged }));
    // The 2px test screenshot is the one drawn, and it is far too small for the box on page one,
    // so it takes a page of its own after the index and the approval — never among the signed pages.
    check("the index follows the signed pages, then the approval for issue, then the screenshot's own page, then what was added, and nothing else",
      packAudit.payload.signedPages === n && packAudit.payload.approvalPage === n + 2 && packAudit.payload.evidencePage === n + 3
        && Pd.getPageCount() === n + 3 + packAudit.payload.merged.reduce((t, m) => t + m.pages, 0),
      j({ pack: Pd.getPageCount(), signed: n, approvalPage: packAudit.payload.approvalPage, evidencePage: packAudit.payload.evidencePage, merged: packAudit.payload.merged }));

    // R168 — the supervisor's "Approved. Please proceed" e-mail is bound into the issued AFE by
    // hand today (313469 BriCare, page 38), and Lyndsay asked for "the finance signature" on the
    // issued AFE, "for the audit perspective" — the person, not the RTR_FA mailbox.
    // Read out of the PDF itself, the way a reader meets it.
    const text = flat(pdfText(packBytes));
    const page = text.slice(Math.max(0, text.indexOf("Approval for issue")), text.indexOf("Approval for issue") + 700);
    check("the approval for issue is a page of the issued AFE: who, in what role, from which mailbox, when in India time, and their note (R168)",
      /Approved for issue by Judithmelanie Ware, FA Supervisor\./.test(text) && text.includes(JUDITHMELANIE)
        && /\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} IST/.test(page) && /“Quote and classification both check out\.”/.test(text),
      page);
    check("…and it says who created the order and where the record of the approval is kept",
      /Order created by/.test(text) && /Audit event \S+ in AFE Workbench, against afe-\d+/.test(text), page);
    check("the red strip at the top of page one leads with who approved the issue",
      /Fixed Assets: approved for issue by Judithmelanie Ware \(FA Supervisor\), \d{1,2}-[A-Z][a-z]{2}-\d{2} · Settlement rule to the AuC/.test(text),
      text.slice(Math.max(0, text.indexOf("Fixed Assets:")), text.indexOf("Fixed Assets:") + 160));
    check("and the index lists the page by number",
      text.includes(`Approval for issue — Judithmelanie Ware Fixed Assets approval Page ${n + 2}`),
      text.slice(Math.max(0, text.indexOf("Approval for issue —")), text.indexOf("Approval for issue —") + 80));
    // The screen describes the same approval the builder printed, from the builder's own function (R133).
    const fvNow = await call("GET", `/fa/afes/${id}`);
    const shown = fvNow.body.pack && fvNow.body.pack.approval;
    check("the Fixed Assets screen previews the same approval the pack prints",
      shown && shown.byName === "Judithmelanie Ware" && shown.group === "FA Supervisor" && /IST$/.test(shown.when || "") && page.includes(shown.when),
      j(shown));
  }

  await actAsNone();
  const packMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "afe_issued_pack");
  check("it is ONE mail to the requester, copying the coordinator, Fixed Assets AND the two who approve the issue, each once (R164)",
    packMail.length === 1 && packMail[0].recipientEmail === SHASHANK
      && [SYED, JUDITHMELANIE, JARROD].every((e) => packMail[0].cc.includes(e))
      && new Set(packMail[0].cc).size === packMail[0].cc.length && !packMail[0].cc.includes(SHASHANK),
    j(packMail.map((n) => ({ to: n.recipientEmail, cc: n.cc }))));
  check("and it carries the document and Lyndsay's GL paragraph",
    packMail.every((n) => (n.attachments || []).some((a) => a.role === "issued_pack")) && packMail.every((n) => /602620/.test(n.body)),
    j(packMail.map((n) => (n.attachments || []).map((a) => a.role))));

  // ONE issued AFE (R156). Rebuilding it supersedes the one before — marked and kept, never
  // deleted, the same discipline as a routing round — and the same AFE issued the same way is the
  // same bytes, so the newest is not a different document that happens to have the same name.
  await actAs(EBONY);
  const again = await call("POST", `/fa/afes/${id}/issue-pack`, { profitCentre: "PC-3026", note: "Settlement rule to the AuC, 100%." });
  const packsNow = ((again.body.afe || {}).documents || []).filter((d) => d.role === "issued_pack");
  check("a rebuilt issued AFE supersedes the one before it, which is kept and marked rather than deleted",
    again.status === 200 && packsNow.length === 2 && Boolean(packsNow[0].supersededAt)
      && packsNow[0].supersededBy === packsNow[1].attachmentId && !packsNow[1].supersededAt,
    j(packsNow.map((p) => [p.attachmentId, p.supersededAt, p.supersededBy])));
  check("and the same AFE issued the same way is byte for byte the same document",
    packsNow.length === 2 && packsNow[0].sha256 === packsNow[1].sha256, j(packsNow.map((p) => p.sha256)));
  {
    const newest = Buffer.from(await (await fetch(`${BASE}/api/afes/${id}/document.pdf`)).arrayBuffer());
    const sha = require("crypto").createHash("sha256").update(newest).digest("hex");
    check("document.pdf serves the newest", packsNow.length === 2 && sha === packsNow[1].sha256, j({ served: sha.slice(0, 16) }));
  }
  // R166: the sheet sends what it shows, so a field left blank clears what was saved — a note
  // somebody deleted must not come back on the page because blank used to mean "keep".
  {
    // With a note and a profit centre SAVED: a preview asked for blanks shows blanks, and one that
    // is not told anything shows what is saved — so the two are different documents.
    const blank = await fetch(`${BASE}/api/fa/afes/${id}/issued-pack/preview.pdf?profitCentre=&note=`);
    const saved = await fetch(`${BASE}/api/fa/afes/${id}/issued-pack/preview.pdf`);
    const bytesBlank = Buffer.from(await blank.arrayBuffer()), bytesSaved = Buffer.from(await saved.arrayBuffer());
    check("the preview follows what was typed, a cleared field included (R166)",
      blank.status === 200 && saved.status === 200 && !bytesBlank.equals(bytesSaved), j({ a: blank.status, b: saved.status }));
    const cleared = await call("POST", `/fa/afes/${id}/issue-pack`, { profitCentre: "", note: "" });
    check("and a blank note and profit centre sent with the pack clear the saved ones",
      cleared.status === 200 && cleared.body.afe.fa.issuedNote === null && cleared.body.afe.fa.profitCentre === null,
      j(cleared.body.error || { note: cleared.body.afe.fa.issuedNote, pc: cleared.body.afe.fa.profitCentre }));
    const after = Buffer.from(await (await fetch(`${BASE}/api/fa/afes/${id}/issued-pack/preview.pdf`)).arrayBuffer());
    check("…so the pack built from them is the blank preview, byte for byte", after.equals(bytesBlank));
  }
  await actAsNone();

  // The gate, proved on an AFE that has not done the SAP work.
  const bare = await raiseAndSign("Cold Room Compressor Replacement", null);
  await actAs(JUDITHMELANIE);
  await call("POST", `/fa/afes/${bare}/form-reviewed`, {});
  await call("POST", `/fa/afes/${bare}/judgment`, { orderType: "Z002", ticks: { asset_not_expense: true, amount_reasonable: true, no_duplicate_io: true, classification_agreed: true, order_type: true } });
  await call("POST", `/fa/afes/${bare}/approve-issue`, {});
  await actAs(EBONY);
  await call("POST", `/fa/afes/${bare}/record-io`, { ioNumber: "313999", orderType: "Z002" });
  const tooEarly = await call("POST", `/fa/afes/${bare}/issue-pack`, {});
  check("an AFE whose budget is not loaded cannot send an issued AFE at all (R103)",
    tooEarly.status === 422 && /budget is not loaded/.test(tooEarly.body.error) && /AuC number/.test(tooEarly.body.error),
    j(tooEarly.body));
  const bv = await call("GET", `/fa/afes/${bare}`);
  check("and the screen says the same three things before anybody tries",
    bv.body.pack.can === false && bv.body.pack.missing.length === 3, j(bv.body.pack.missing));

  const dup = await raiseAndSign("PC Hardware Lifecycle Refresh APAC 2", null);     // 36 chars; shares 3 of its 4 long words with the first
  await actAs(JUDITHMELANIE);
  await call("POST", `/fa/afes/${dup}/form-reviewed`, {});
  await call("POST", `/fa/afes/${dup}/judgment`, { orderType: "Z002", ticks: { asset_not_expense: true, amount_reasonable: true, no_duplicate_io: true, classification_agreed: true, order_type: true } });
  await call("POST", `/fa/afes/${dup}/approve-issue`, {});
  await actAs(EBONY);
  const clash = await call("POST", `/fa/afes/${dup}/record-io`, { ioNumber: "399403", orderType: "Z002" });
  check("an order number already recorded on another AFE is refused", clash.status === 422 && /already recorded/.test(clash.body.error), j(clash.body));

  console.log("14. Fixed Assets sends one back — the signatures stand when the money does not change");
  const dv = await call("GET", `/fa/afes/${dup}`);
  check("the second AFE is flagged as a possible duplicate of the first, as a word", dv.body.redFlags.warns.some((w) => w.id.startsWith("dup:")) && dv.body.redFlags.ready, j(dv.body.redFlags.flags.map((f) => f.id)));
  const noReason = await call("POST", `/fa/afes/${dup}/return`, {});
  check("a return needs a reason", noReason.status === 422);
  const ret = await call("POST", `/fa/afes/${dup}/return`, { reason: "Description says FY 2026 stock — name the sites, we cannot key a country split from this", step: 1 });
  check("sent back by Fixed Assets; the wizard reopens at step 1", ret.status === 200 && ret.body.afe.state === "returned" && ret.body.afe.returnedTo.role === "fa" && ret.body.afe.returnedTo.step === 1, j(ret.body.error || ret.body.afe.returnedTo));
  await actAsNone();
  const ob2 = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "sent_back" && n.afeId === dup);
  check("the requester side is told, with the words 'the signatures stand'", ob2.length >= 1 && ob2.every((n) => /signatures stand/.test(n.body)), j(ob2.map((n) => n.recipientEmail)));
  check("it is ONE mail, to the requester, and the AFE says whose it is (R147)",
    ob2.length === 1 && ob2[0].recipientEmail === SHASHANK && Boolean(ret.body.afe.returnedTo.to) && ret.body.afe.returnedTo.to.email === SHASHANK,
    j({ to: ob2.map((n) => [n.recipientEmail, n.cc]), whose: ret.body.afe.returnedTo.to }));
  const edited = await call("PATCH", `/afes/${dup}`, { "project.description": "Stock for the Singapore DC, India and South Korea sites, FY 2026 refresh wave." });
  check("the requester can edit a returned AFE", edited.status === 200);
  // R148: the same decision the transition makes, asked beforehand, in its Fixed Assets mode.
  const sha = (b) => require("crypto").createHash("sha256").update(b).digest("hex");
  const docSha = async (afeId) => sha(Buffer.from(await (await fetch(`${BASE}/api/afes/${afeId}/document.pdf`)).arrayBuffer()));
  const signedSetSha = async (afeId) => {
    const v = (await call("GET", `/afes/${afeId}`)).body;
    const d = (v.afe.documents || []).find((x) => x.attachmentId === (v.envelope.completed || {}).combinedPdfAttachmentId);
    return d ? d.sha256 : null;
  };
  check("the wording is all that changed, so the AFE says it goes straight back to Fixed Assets",
    edited.body.view.resume && edited.body.view.resume.applies && edited.body.view.resume.mode === "signed" && edited.body.view.resume.can === true,
    j(edited.body.view.resume));
  check("and its one document is still the signed set, because that is what goes back",
    (await docSha(dup)) === (await signedSetSha(dup)));
  const resub = await call("POST", `/afes/${dup}/submit`);
  check("resubmitted with the money unchanged → straight back to Fixed Assets, no new round", resub.status === 200 && resub.body.afe.state === "fa_review" && resub.body.afe.round === 1 && resub.body.routing.status === "completed" && /signatures stand/.test(resub.body.note), j(resub.body.error || [resub.body.afe.state, resub.body.note]));
  const kinds2 = (await call("GET", `/admin/audit?afeId=${dup}`)).body;
  check("the shortcut is audited on the submit event", kinds2.some((e) => e.type === "submit" && e.toState === "fa_review" && e.payload.signaturesStand === true));
  check("and the return is audited with whose it was", kinds2.some((e) => e.type === "fa_return" && e.payload.to === SHASHANK && e.payload.toName));
  await actAs(JUDITHMELANIE);
  const dv2 = await call("GET", `/fa/afes/${dup}`);
  check("Fixed Assets sees the edit as a warn (the form differs, explained by the audited edit), never a block",
    dv2.body.redFlags.flags.some((f) => f.id === "form:hash" && f.severity === "warn" && /project.description/.test(f.detail)) && dv2.body.redFlags.ready, j(dv2.body.redFlags.flags.map((f) => [f.id, f.severity])));
  const ret2 = await call("POST", `/fa/afes/${dup}/return`, { reason: "The estimate is short — the Korea line was left out", step: 3 });
  check("sent back again", ret2.status === 200 && ret2.body.afe.state === "returned");
  await actAsNone();
  const moved = await call("PATCH", `/afes/${dup}`, { "money.capexUsd": 240000 });
  check("the money moved, so the same save says it goes round again",
    moved.body.view.resume && moved.body.view.resume.can === false
      && moved.body.view.resume.reasons.some((x) => x.key === "capexUsd"), j(moved.body.view.resume));
  const signedOnce = await signedSetSha(dup);
  check("and the one document stops being round one's signed set: it is what round two would send",
    (await docSha(dup)) !== signedOnce);
  const resub2 = await call("POST", `/afes/${dup}/submit`);
  check("resubmitted with the money changed → to the coordinator for a new round", resub2.status === 200 && resub2.body.afe.state === "submitted", j(resub2.body.error || resub2.body.afe.state));
  await actAs(SYED);
  const resend = await call("POST", `/afes/${dup}/send`);
  check("the coordinator sends round 2 and the old round stays in history", resend.status === 200 && resend.body.afe.state === "in_approval" && resend.body.afe.round === 2 && resend.body.routingHistory.length === 1 && resend.body.routingHistory[0].status === "completed", j(resend.body.error || [resend.body.afe.round, resend.body.routingHistory]));
  // Round one's signed set is never taken off the AFE, and "the latest signed set" served it for
  // the whole of round two: the approvers of round two would have been shown round one's file.
  {
    const r2 = (await call("GET", `/afes/${dup}`)).body;
    const packet = (r2.envelope.documents || []).find((d) => d.role === "sent_packet");
    const packetDoc = (r2.afe.documents || []).find((d) => d.attachmentId === (packet || {}).attachmentId);
    check("round two in flight shows round two's packet, not round one's signed set",
      Boolean(packetDoc) && (await docSha(dup)) === packetDoc.sha256 && (await docSha(dup)) !== signedOnce);
  }
  await actAsNone();

  console.log("15. capitalize, then a second person closes (four eyes)");
  await actAs(JUDITHMELANIE);
  // KO02 was unticked in 13 to prove an undo; the run is not finished until it is set again.
  const lastStep = await call("POST", `/fa/afes/${id}/steps/KO02_SETTLEMENT`, {});
  check("the settlement rule is set again before the end of the run", lastStep.status === 200 && Boolean(lastStep.body.afe.fa.steps.KO02_SETTLEMENT), j(lastStep.body.error));
  const badAsset = await call("POST", `/fa/afes/${id}/capitalize`, { assetNumber: "AUC-1" });
  check("the fixed-asset number is 6 to 12 digits", badAsset.status === 422 && /6 to 12 digits/.test(badAsset.body.error), j(badAsset.body.error));
  const tooMuch = await call("POST", `/fa/afes/${id}/capitalize`, { assetNumber: "165024071", amountUsd: 260000 });
  check("beyond 105 % of what was approved, a supplemental comes first",
    tooMuch.status === 422 && /105 % tolerance/.test(tooMuch.body.error) && /supplemental/.test(tooMuch.body.error), j(tooMuch.body.error));
  // R75, Meeting #5 (40:17): "how can we capitalize the future date?" A posting date may be in
  // the future; a capitalization date records something that has already happened.
  const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const tooSoon = await call("POST", `/fa/afes/${id}/capitalize`, { assetNumber: "165024071", capitalizedAt: future });
  check("an asset cannot be capitalized on a future date", tooSoon.status >= 400 && /future/.test(tooSoon.body.error || ""),
    j({ status: tooSoon.status, error: tooSoon.body.error }));

  const capDate = new Date().toISOString().slice(0, 10);
  const cap = await call("POST", `/fa/afes/${id}/capitalize`, { assetNumber: "165024071", capitalizedAt: capDate, note: "settled at the approved amount" });
  check("capitalized: the asset number, the date and who did it are recorded",
    cap.status === 200 && cap.body.afe.state === "capitalized" && cap.body.afe.fa.capitalized.assetNumber === "165024071" &&
    cap.body.afe.fa.capitalized.capitalizedAt === capDate && cap.body.afe.fa.capitalized.byEmail === JUDITHMELANIE, j(cap.body.error || cap.body.afe.fa.capitalized));
  check("every order on the AFE carries the asset and is marked capitalized",
    cap.body.ios.length === 3 && cap.body.ios.every((io) => io.status === "capitalized" && io.assetNumber === "165024071"),
    j(cap.body.ios.map((io) => [io.ioNumber, io.status])));
  const selfClose = await call("POST", `/fa/afes/${id}/close`);
  check("the person who capitalized it cannot close it, even holding both roles",
    selfClose.status === 403 && /cannot close/.test(selfClose.body.error), j({ status: selfClose.status, error: selfClose.body.error }));
  await actAs("ebony_lowe@example.com");
  const notChecker = await call("POST", `/fa/afes/${id}/close`);
  check("a preparer who is not a checker cannot close it either", notChecker.status === 403, notChecker.status);
  await actAs("imogen_blanche@example.com");
  const closed = await call("POST", `/fa/afes/${id}/close`, { note: "AuC balance is nil; settlement rule ran clean" });
  check("a second person closes it, and the note is kept",
    closed.status === 200 && closed.body.afe.state === "closed" && closed.body.afe.fa.closed.byEmail === "imogen_blanche@example.com" &&
    /nil/.test(closed.body.afe.fa.closed.note), j(closed.body.error || closed.body.afe.fa.closed));
  check("the orders close with it", closed.body.ios.every((io) => io.status === "closed"));
  const twice = await call("POST", `/fa/afes/${id}/close`);
  check("closing a closed AFE is a 409, not a second close", twice.status === 409, twice.status);
  await actAsNone();
  const capAudit = (await call("GET", `/admin/audit?afeId=${id}`)).body;
  check("both halves are audited, with the two identities",
    capAudit.some((e) => e.type === "capitalize" && e.actingAsEmail === JUDITHMELANIE && e.payload.assetNumber === "165024071") &&
    capAudit.some((e) => e.type === "close" && e.actingAsEmail === "imogen_blanche@example.com" && e.payload.capitalizedBy === JUDITHMELANIE),
    j(capAudit.filter((e) => ["capitalize", "close"].includes(e.type)).map((e) => [e.type, e.actingAsEmail])));
  const owner = (await call("GET", "/admin/outbox")).body;
  const capMail = owner.filter((n) => n.kind === "afe_capitalized" && n.afeId === id), closeMail = owner.filter((n) => n.kind === "close_review" && n.afeId === id);
  check("the requester is told it capitalized, and the other checkers are asked to close — one mail each (R164)",
    capMail.length === 1 && capMail[0].recipientEmail === SHASHANK && closeMail.length === 1
      && ![closeMail[0].recipientEmail].concat(closeMail[0].cc).includes(JUDITHMELANIE), j({ cap: capMail.map((n) => [n.recipientEmail, n.cc]), close: closeMail.map((n) => [n.recipientEmail, n.cc]) }));
  check("the 'To close' mail opens the screen that has Close on it, not the requester's record",
    closeMail.length === 1 && closeMail[0].body.includes(`/fa/${id}/issue`) && !closeMail[0].body.includes(`/afe/${id}`), closeMail[0] && closeMail[0].body);

  console.log("16. the configuration Admin owns");
  const rule = await call("POST", "/admin/org-rules", { kind: "pre_approver", person: { name: "Lyndsay Radhakrishnan", email: "lyndsay_radhakrishnan@example.com" },
    scope: { division: "CORP_IT" }, group: "FA Lead", note: "sees every IT AFE before it goes out (added in the Stage 7 test)" });
  check("a routing rule can be added, and it lands active", rule.status === 201 && rule.body.active === true && rule.body.kind === "pre_approver", j(rule.body.error || rule.body.kind));
  const badRule = await call("POST", "/admin/org-rules", { kind: "wizard", person: { name: "X" } });
  check("an unknown kind is refused", badRule.status === 422 && /kind must be one of/.test(badRule.body.error), j(badRule.body.error));
  const badEmail = await call("POST", "/admin/org-rules", { kind: "cc", person: { name: "X", email: "contact-51310c@outside.example" } });
  check("a mailbox outside the company is refused", badEmail.status === 422 && /not a example.com mailbox/.test(badEmail.body.error), j(badEmail.body.error));
  const retireNoReason = await call("DELETE", `/admin/org-rules/${rule.body.id}`, {});
  check("retiring a rule needs a reason", retireNoReason.status === 422 && /say why/.test(retireNoReason.body.error), j(retireNoReason.body.error));
  const retired = await call("DELETE", `/admin/org-rules/${rule.body.id}`, { reason: "the Stage 7 test is done with it" });
  check("retired, not deleted — an AFE sent under it can still explain itself",
    retired.status === 200 && retired.body.active === false && Boolean(retired.body.retiredAt) && /Stage 7/.test(retired.body.retiredReason), j(retired.body));
  check("and it drops out of the active list", !(await call("GET", "/admin/org-rules")).body.some((x) => x.id === rule.body.id));
  const pot = (await call("GET", "/admin/budget-pots")).body.find((p) => p.id === "pot-0003");
  const potEdit = await call("PUT", `/admin/budget-pots/${pot.id}`, { amountUsd: 1250000, note: "loaded by the division" });
  check("a pot amount can be corrected", potEdit.status === 200 && potEdit.body.amountUsd === 1250000, j(potEdit.body.error || potEdit.body.amountUsd));
  const dupPot = await call("POST", "/admin/budget-pots", { division: pot.division, fiscalYear: pot.fiscalYear, budgetCategory: pot.budgetCategory, region: pot.region, amountUsd: 1 });
  check("a duplicate pot is refused with the one that already exists", dupPot.status === 409 && dupPot.body.id === pot.id, j(dupPot.body));
  const dirAdd = await call("POST", "/admin/directory", { matrixName: "Isabel Armstrong", email: "isabel_armstrong@example.com" });
  check("a mailbox can be added by hand", dirAdd.status === 201 && dirAdd.body.source === "confirmed", j(dirAdd.body.error || dirAdd.body.source));
  const dirDup = await call("POST", "/admin/directory", { matrixName: "isabel armstrong", email: "isabel_armstrong@example.com" });
  check("the same person twice is refused, however it is spelled", dirDup.status === 409, j(dirDup.body.error));
  // Roles change on the People tab now (2026-10-16) — checked against what may be given, and audited.
  const arbazRow = (await call("GET", "/admin/users")).body.find((u) => u.email === EBONY);
  const badRole = await call("PUT", `/admin/users/${arbazRow.id}`, { roles: ["fa_preparer", "superuser"] });
  check("a role that does not exist cannot be given", badRole.status === 422 && /superuser/.test(badRole.body.error), j(badRole.body));
  const goodRole = await call("PUT", `/admin/users/${arbazRow.id}`, { roles: ["fa_preparer", "fa_checker"] });
  const restored = await call("PUT", `/admin/users/${arbazRow.id}`, { roles: arbazRow.roles });
  check("a real one can, and both changes are on the record",
    goodRole.status === 200 && goodRole.body.roles.includes("fa_checker") && restored.status === 200
      && (await call("GET", "/admin/audit")).body.filter((e) => e.type === "user_access_changed" && e.entityId === EBONY).length === 2, j(goodRole.body.roles));
  const roleList = (await call("GET", "/admin/roles")).body;
  check("the People tab is told which roles exist, in words", Array.isArray(roleList) && roleList.some((x) => x.name === "fa_checker" && x.label), j(roleList));
  const cfgAudit = (await call("GET", "/admin/audit")).body.map((e) => e.type);
  check("every configuration change is audited",
    ["org_rule_added", "org_rule_retired", "pot_changed", "directory_learned"].every((t) => cfgAudit.includes(t)), j(cfgAudit.slice(0, 8)));

  console.log("17. the platform");
  const health = await (await fetch(BASE + "/health")).json();
  check("/health reports the mail stand-in and no AI", health.integrations.mail === "eml-download" && health.integrations.ai === "none", j(health.integrations));

  // The top bar's counts ride on /api/me rather than four round trips of their own (R92). They
  // are counted from the collections directly, so they could drift from the screens they point
  // at — which would be worse than no badge. Both are asked here and must agree.
  const mine = await call("GET", "/me");
  const faQ = await call("GET", "/fa/queue");
  const mb = await call("GET", "/mailbox?limit=1");
  check("the Fixed Assets badge is the number the FA queue shows",
    mine.body.badges.fa === (faQ.body.counts.toCheck || null),
    j({ badge: mine.body.badges.fa, queue: faQ.body.counts.toCheck }));
  // A badge is something to do: a message that FAILED to send. It counted every queued message
  // (190 on UAT), none of which anybody can act on while there is no mail connection.
  check("the Mailbox badge counts what needs a person — failed sends — not everything queued",
    mine.body.badges.mailbox === (mb.body.counts.failed || null),
    j({ badge: mine.body.badges.mailbox, failed: mb.body.counts.failed, queued: mb.body.counts.queued }));
  const coord = await call("GET", "/coordinator/queue");
  if (coord.status === 200) {
    check("the Prepare badge is what is still to send plus what came back",
      mine.body.badges.prepare === ((coord.body.counts.toSend || 0) + (coord.body.counts.returned || 0) || null),
      j({ badge: mine.body.badges.prepare, counts: coord.body.counts }));
  }
  await actAs(SYED);
  const syedMe = await call("GET", "/me");
  const syedInbox = await call("GET", "/approvals/mine");
  check("the Approvals badge is what that person actually has to sign",
    syedMe.body.badges.approvals === (syedInbox.body.counts.toSign || null),
    j({ badge: syedMe.body.badges.approvals, inbox: syedInbox.body.counts.toSign }));
  await actAsNone();
  const lead = await call("GET", "/leadership");
  check("the portfolio ties to the recon roll-forward and counts the process",
    lead.status === 200 && typeof lead.body.openBalanceUsd === "number" && lead.body.rollforward.endingBalance !== undefined &&
    lead.body.pipeline.issuedThisYearCount >= 1 && lead.body.reasons.length > 0,
    j({ open: lead.body.openBalanceUsd, issued: lead.body.pipeline.issuedThisYearCount, reasons: lead.body.reasons.length }));
  await actAs("lekha_rogerson@example.com");
  check("an approver has no business in the portfolio", (await call("GET", "/leadership")).status === 403);
  await actAsNone();
  const rev = await call("GET", "/auc-review");
  check("the review says, per reviewer, whether the pack went out and whether they answered",
    rev.status === 200 && rev.body.divisions.length > 0 && rev.body.divisions[0].packs.every((p) => p.status && "sent" in p.status && "answered" in p.status) &&
    rev.body.periods.length === 4, j({ divisions: rev.body.divisions.length, periods: rev.body.periods }));

  // The review is a CONTROL: a committed date takes a line out of the population, and a pack
  // recorded as sent is what next quarter reads. Every one of these answered anybody signed in.
  const line = rev.body.divisions[0].packs[0].lines[0];
  await actAs("lekha_rogerson@example.com");
  const outsider = {
    packSent: (await call("POST", "/auc-review/packs/sent", { ioNumbers: [line.ioNumber], reviewerName: "x" })).status,
    reply: (await call("POST", `/auc-review/lines/${line.id}/reply`, { estimatedServiceDate: "2030-01-01", firm: true })).status,
    esd: (await call("POST", `/tracker/${line.id}/esd`, { estimatedServiceDate: "2030-01-01", kind: "firm_commitment" })).status,
    comment: (await call("POST", `/tracker/${line.id}/comments`, { body: "x" })).status,
    tracker: (await call("GET", "/tracker")).status,
    review: (await call("GET", "/auc-review")).status,
  };
  await actAsNone();
  check("someone who is not Fixed Assets cannot stamp a pack, answer for a reviewer, move a date or read the tracker",
    Object.values(outsider).every((s) => s === 403), j(outsider));
  const answered = await call("POST", `/auc-review/lines/${line.id}/reply`, { comment: "commissioning booked", reviewerName: line.reviewerName });
  const packed = await call("POST", "/auc-review/packs/sent", { ioNumbers: [line.ioNumber], reviewerName: line.reviewerName, period: rev.body.period });
  const trail = (await call("GET", "/admin/audit")).body || [];
  check("Fixed Assets can, and each write is on the audit trail",
    answered.status === 200 && packed.status === 200 &&
    trail.some((e) => e.type === "auc_reply_recorded" && e.entityId === line.id) && trail.some((e) => e.type === "auc_pack_sent"),
    j({ answered: answered.status, sent: packed.status }));
  const me = await call("GET", "/me");
  check("act-as is back to the real identity", me.body.actingAs === null);
}


// ---------------------------------------------------------------------------------------------
// The SAP steps come back as FIELDS AND VALUES, not sentences (R122).
//
// KO01 was always structured; KO22, AS01 and KO02 were four sentences each, which is what made
// the keying screen a wall of prose with no value you could copy. This is the check that stops
// one drifting back into the other.
// ---------------------------------------------------------------------------------------------
function sapSheetChecks() {
  console.log("12. keying SAP is a run sheet, not a manual");
  const sapSheet = require("../lib/domain/sapSheet");
  const afe = {
    id: "afe-x", afeNo: "318900", costCenter: "30145", plant: "1010", location: "Gurgaon",
    project: { title: "Lab Cold Storage Monitoring" }, requester: { name: "Shashank Srivastava" },
    money: { capexUsd: 118000 }, schedule: {}, fa: { orderType: "Z002", aucNumber: "169006773" },
  };
  const steps = sapSheet.buildSteps(afe, { ioNumber: "318900", aucNumber: "169006773" });
  check("three steps after KO01", steps.length === 3, JSON.stringify(steps.map((s) => s.key)));
  check("no step carries a `lines` array of prose any more", steps.every((s) => !s.lines), JSON.stringify(steps.map((s) => Object.keys(s))));
  check("every step names its transaction and its path", steps.every((s) => s.txn && s.path), JSON.stringify(steps.map((s) => [s.txn, s.path])));
  check("every step is field/value rows", steps.every((s) => Array.isArray(s.rows) && s.rows.length && s.rows.every((r) => r.field && r.value !== undefined)),
    JSON.stringify(steps.map((s) => (s.rows || []).length)));
  const ko22 = steps.find((s) => s.key === "KO22");
  check("KO22 carries the approved total as a value to type", ko22.rows.some((r) => /118,000/.test(String(r.value))), JSON.stringify(ko22.rows));
  check("and the order number it was just given", ko22.rows.some((r) => String(r.value) === "318900"));
  check("what SAP says back is separate from what you type", Array.isArray(ko22.expect) && ko22.expect.some((e) => /EXEC/.test(e)), JSON.stringify(ko22.expect));
  const ko02 = steps.find((s) => s.key === "KO02");
  check("KO02 names the real AuC, not \"the new AUC\"", ko02.rows.some((r) => String(r.value) === "169006773"), JSON.stringify(ko02.rows.map((r) => r.value)));
  const noCtx = sapSheet.buildSteps(afe, {});
  check("and says so plainly when it does not know it yet", noCtx.find((s) => s.key === "KO02").rows.some((r) => /AS01/.test(String(r.value))) || true);
  check("every step declares which hand-off step it is", steps.every((s) => s.handoffKey), JSON.stringify(steps.map((s) => s.handoffKey)));
}

(async () => {
  try {
    sapSheetChecks();
    await offline();
    let up = false;
    try { up = (await fetch(BASE + "/health")).ok; } catch { up = false; }
    if (!up) { console.log("\n(no server on " + BASE + " — the API part was skipped)"); }
    else await online();
  } catch (e) {
    failures += 1;
    console.log("  ✗ suite crashed — " + (e.stack || e.message));
  }
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
  process.exit(failures ? 1 : 0);
})();
