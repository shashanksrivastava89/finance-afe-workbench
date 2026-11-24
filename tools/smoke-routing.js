"use strict";
// Stage 2 gate: routing, sending, signing. Part 0 exercises the pure chain builder against
// the real seed data (no server). Part 1 walks two AFEs through the API the way the screens
// will: the APAC hardware refresh on cost centre 30145 through every signature into Fixed
// Assets' hands, and a second one raised by the cost-centre owner himself — the
// segregation-of-duties case — through a send-back, a second round, reminders and a decline.
//
//   node tools/smoke-routing.js      (needs a server on :8080; resets its data first)
const path = require("path");
const ROOT = path.join(__dirname, "..");
const BASE = process.env.SMOKE_BASE || "http://127.0.0.1:8080";
let failures = 0;
const check = (label, cond, detail) => {
  if (cond) console.log("  ✓ " + label);
  else { failures += 1; console.log("  ✗ " + label + (detail ? " — " + String(detail).slice(0, 300) : "")); }
};
const j = (x) => JSON.stringify(x);

// ---------------------------------------------------------------------------------------------
// Part 0 — the pure rules, offline
// ---------------------------------------------------------------------------------------------
function offline() {
  const cb = require(path.join(ROOT, "lib/domain/chainBuilder.js"));
  const people = require(path.join(ROOT, "lib/domain/people.js"));
  const rem = require(path.join(ROOT, "lib/domain/reminders.js"));
  const ds = require(path.join(ROOT, "lib/integrations/docusign.js"));
  const sim = require(path.join(ROOT, "lib/integrations/docusignSim.js"));
const envelopeSpec = require(path.join(ROOT, "lib/integrations/envelopeSpec.js"));
  const matrix = require(path.join(ROOT, "seed/approver-matrix.json")).rows;
  const m = matrix.find((r) => r.costCenter === "30145");
  const rules = require(path.join(ROOT, "seed/org-rules.json")).rules;
  const users = require(path.join(ROOT, "seed/users.json")).users;
  const directory = require(path.join(ROOT, "seed/directory.json")).entries;
  const inputs = (afe, extra) => Object.assign({ afe, matrixRow: m, orgRules: rules, users, directory, matrixBatchId: "b1" }, extra || {});
  const shashank = { name: "Shashank Srivastava", email: "shashank_srivastava@example.com" };
  const hanif = { name: "Udarsh Atwal", email: "udarsh_atwal@example.com" };
  const syed = { name: "Aiden-Mulqueeny Crilly", email: "aiden-mulqueeny_crilly@example.com" };
  const base = { id: "afe-t", costCenter: "30145", division: "CORP_IT", requester: shashank, preparer: shashank, coordinator: syed,
    money: { capexUsd: 215000 }, project: { title: "PC Hardware Lifecycle Replacement APAC" }, routingEdits: {} };
  const byName = (r, n) => r.recipients.filter((x) => x.name === n);
  const live = (r) => r.recipients.filter((x) => x.status === "pending" && x.role !== "cc").map((x) => x.name);

  console.log("0. names and mailboxes");
  check("First_Last guess runs multi-part given names together (Kai Lun Ong → kailun_ong)", people.guessEmail("Kai Lun Ong") === "kailun_ong@example.com", people.guessEmail("Kai Lun Ong"));
  check("hyphenated given names keep the hyphen (Aiden-Mulqueeny Crilly)", people.guessEmail("Aiden-Mulqueeny Crilly") === "aiden-mulqueeny_crilly@example.com");
  check("a single token is not guessed at", people.guessEmail("Board") === null);
  check("matrix and form spellings match (Kai Lun Ong / Kailun Ong)", people.normName("Kai Lun Ong") === people.normName("Kailun Ong"));
  check("accents are ignored", people.normName("Lékha Rogersón") === "lekharogerson");
  check("a name never unlocks someone else's step — only the mailbox or curated matrixNames do",
    !people.userMatches({ user: { email: "x@example.com" }, userRow: { displayName: "Vrishti Aguirre", matrixNames: [] } }, { name: "Vrishti Aguirre", email: "vrishti_aguirre@example.com" }) &&
    people.userMatches({ user: { email: "x@example.com" }, userRow: { matrixNames: ["Vrishti Aguirre"] } }, { name: "Vrishti Aguirre", email: null }));

  console.log("1. cost centre 30145 at $215,000 (R42, R43, R45, R58, R60)");
  const r1 = cb.buildRouting(inputs(base));
  const daryl = byName(r1, "Annette Sandhu")[0];
  check("levels are M1 A1 A2 A3", r1.basis.levels.join(" ") === "M1 A1 A2 A3", r1.basis.levels.join(" "));
  check("Annette Sandhu signs first, in Project Approvals row 1, with his group", daryl && daryl.order === 1 && daryl.role === "pre_approver" &&
    daryl.printRow === "project_approvals_1" && daryl.group === "Assoc. Dir Digital Workplace", j(daryl));
  const hanifRows = byName(r1, "Udarsh Atwal");
  check("Atwal is named at M1 and A1 and signs once, at A1", hanifRows.length === 2 &&
    hanifRows.find((x) => x.level === "A1").status === "pending" && hanifRows.find((x) => x.level === "M1").status === "skipped" &&
    hanifRows.find((x) => x.level === "M1").signsAs === hanifRows.find((x) => x.level === "A1").id, j(hanifRows.map((x) => [x.level, x.status, x.signsAs])));
  check("Vrishti Aguirre signs once, at A3 — the IT override adds nothing", byName(r1, "Vrishti Aguirre").length === 1 && byName(r1, "Vrishti Aguirre")[0].level === "A3" &&
    r1.explanation.some((e) => /adds nothing/.test(e.text)), j(byName(r1, "Vrishti Aguirre").map((x) => [x.level, x.role])));
  check("Erik's mailbox comes from the rule an admin typed, not a guess", byName(r1, "Vrishti Aguirre")[0].emailSource === "rule", byName(r1, "Vrishti Aguirre")[0].emailSource);
  check("signing order is Daryl, Atwal, Kai Lun Ong, Erik", live(r1).join(" | ") === "Annette Sandhu | Udarsh Atwal | Kai Lun Ong | Vrishti Aguirre", live(r1).join(" | "));
  const teck = byName(r1, "Kai Lun Ong")[0];
  check("Kai Lun Ong has no mailbox yet and that alone blocks sending", teck.emailSource === "unresolved" && teck.email === null &&
    r1.needsEmail.length === 1 && r1.needsEmail[0].name === "Kai Lun Ong" && r1.blockers.length === 1 && r1.blockers[0].code === "emails_unconfirmed",
    j({ needs: r1.needsEmail.map((x) => x.name), blockers: r1.blockers.map((b) => b.code) }));
  const ccs = r1.recipients.filter((x) => x.role === "cc");
  check("the requester and Fixed Assets receive copies, at one routing order after the last signer",
    ccs.length === 2 && ccs.every((c) => c.order === 5) && ccs.some((c) => c.email === "shashank_srivastava@example.com") && ccs.some((c) => c.email === "rtr_fa@example.com"),
    j(ccs.map((c) => [c.name, c.order])));
  check("every recipient has a one-line explanation", r1.recipients.every((x) => r1.explanation.some((e) => e.recipientId === x.id)));

  console.log("2. the coordinator adds a second A2 (Lekha Rogerson)");
  const r2 = cb.buildRouting(inputs(Object.assign({}, base, { routingEdits: { additional: [{ name: "Lekha Rogerson", level: "A2", why: "finance partner for APAC" }] } })));
  check("Lekha slots right after the matrix A2 and before A3", live(r2).join(" | ") === "Annette Sandhu | Udarsh Atwal | Kai Lun Ong | Lekha Rogerson | Vrishti Aguirre", live(r2).join(" | "));
  check("she prints on the A2 row as an additional signer with a login mailbox", byName(r2, "Lekha Rogerson")[0].printRow === "band_a2" &&
    byName(r2, "Lekha Rogerson")[0].role === "additional" && byName(r2, "Lekha Rogerson")[0].emailSource === "users");
  const r2b = cb.buildRouting(inputs(Object.assign({}, base, { routingEdits: { additional: [{ name: "Vrishti Aguirre", level: "A2" }] } })));
  check("adding someone already in the chain does not make them sign twice", byName(r2b, "Vrishti Aguirre").filter((x) => x.status === "pending").length === 1 &&
    byName(r2b, "Vrishti Aguirre").some((x) => x.status === "skipped"), j(byName(r2b, "Vrishti Aguirre").map((x) => [x.level, x.status])));

  console.log("3. $50,000 — the IT override adds Erik below his band (R43)");
  const r3 = cb.buildRouting(inputs(Object.assign({}, base, { money: { capexUsd: 50000 } })));
  const erik3 = byName(r3, "Vrishti Aguirre")[0];
  check("levels are M1 A1 A2", r3.basis.levels.join(" ") === "M1 A1 A2", r3.basis.levels.join(" "));
  check("Erik is added as the division override, printed at A3, authority $500,000 (he holds A3/A5)",
    erik3 && erik3.role === "override" && erik3.printRow === "band_a3" && erik3.authorityLimitUsd === 500000 && erik3.order === 4, j(erik3));
  const r3s = cb.buildRouting(inputs(Object.assign({}, base, { money: { capexUsd: 50000 }, routingEdits: { suppressedRules: [{ ruleId: "rule-0003", reason: "Finance withdrew the blanket review" }] } })));
  check("a rule left out for one AFE, with a reason, is honoured and noted", !byName(r3s, "Vrishti Aguirre").length && r3s.explanation.some((e) => e.kind === "rule_suppressed"));

  console.log("4. $240,000 raised by the cost-centre owner — segregation of duties (R44, Q47)");
  const r4 = cb.buildRouting(inputs(Object.assign({}, base, { requester: hanif, preparer: hanif, money: { capexUsd: 240000 } })));
  const blocked = byName(r4, "Udarsh Atwal").find((x) => x.status === "sod_blocked");
  const standIn = byName(r4, "Isabel Armstrong")[0];
  check("levels are M1 A1 A2 A3", r4.basis.levels.join(" ") === "M1 A1 A2 A3");
  check("Atwal is blocked at A1 as the requester", blocked && blocked.level === "A1" && /requester/.test(blocked.why), j(byName(r4, "Udarsh Atwal").map((x) => [x.level, x.status])));
  check("Isabel Armstrong (A4, the next higher level not already signing) stands in", standIn && standIn.level === "A4" && standIn.standInFor === blocked.id && standIn.order === 4, j(standIn));
  check("the exclusion is recorded with its stand-in for the audit", r4.sod.excluded.length === 1 && r4.sod.excluded[0].reason === "requester" && r4.sod.excluded[0].standIn === standIn.id, j(r4.sod.excluded));
  check("the stand-in's mailbox is a guess that must be confirmed", standIn.emailSource === "guessed" && standIn.email === "isabel_armstrong@example.com" && r4.needsEmail.some((n) => n.name === "Isabel Armstrong"));
  check("Atwal still receives a copy as the requester", r4.recipients.some((x) => x.role === "cc" && x.name === "Udarsh Atwal"));
  check("signing order is Daryl, Kai Lun Ong, Erik, Isabel Armstrong", live(r4).join(" | ") === "Annette Sandhu | Kai Lun Ong | Vrishti Aguirre | Isabel Armstrong", live(r4).join(" | "));

  console.log("5. edge cases the matrix produces");
  const r5 = cb.buildRouting(inputs(Object.assign({}, base, { money: { capexUsd: 1200000 } })));
  // R70, Meeting #5 (27:29-28:44): above $1M the form needs a technical accounting review the SAP
  // matrix does not carry — "no, no, it's a separate requirement" (Imogen). It is ONE signature by
  // EITHER of two named people (Shashank, 2026-09-21), so the count matters as much as the names:
  // the rule was seeded as two rows and would have collected two signatures.
  const tar = r5.recipients.filter((x) => x.role === "controllership");
  // "Reviewed by accounting first before it goes to approvers" (Aiden, Meeting #7): R159.
  check("above $1M ONE Technical Accounting Review is added, and it signs FIRST (R159)",
    tar.length === 1 && tar[0].group === "Technical Accounting Review" && tar[0].order === 1
      && r5.recipients.filter((y) => y.order && y.role !== "cc" && y.id !== tar[0].id).every((y) => y.order > 1),
    j(r5.recipients.filter((x) => x.order).map((x) => [x.order, x.role, x.name])));
  check("…ahead of the pre-approver, who is now second",
    r5.recipients.find((x) => x.role === "pre_approver" && x.order).order === 2,
    j(r5.recipients.filter((x) => x.order).map((x) => [x.order, x.role, x.name])));
  check("it is the rule's own person, and the alternate travels with the recipient",
    tar[0].name === "Janine Barad"
      && (tar[0].alternates || []).map((a) => a.name).join(" | ") === "Janine Barad | Gabriella Rafter"
      && tar[0].alternates.find((a) => a.chosen).name === "Janine Barad",
    j(tar[0].alternates));
  check("the why line names both, so nobody has to go and look who else could have signed",
    /Janine Barad or Gabriella Rafter/.test(tar[0].why), tar[0].why);
  // The coordinator's choice for THIS AFE, and still one signature.
  const r5b = cb.buildRouting(inputs(Object.assign({}, base, {
    money: { capexUsd: 1200000 }, routingEdits: { ruleChoice: { "rule-0005": 1 } },
  })));
  const tarB = r5b.recipients.filter((x) => x.role === "controllership");
  check("the coordinator can switch it to the alternate, and it is still ONE signature",
    tarB.length === 1 && tarB[0].name === "Gabriella Rafter" && /Gabriella Rafter or Janine Barad/.test(tarB[0].why),
    j(tarB.map((x) => [x.name, x.why])));
  check("a choice the rule does not offer is ignored rather than obeyed",
    cb.buildRouting(inputs(Object.assign({}, base, {
      money: { capexUsd: 1200000 }, routingEdits: { ruleChoice: { "rule-0005": 7 } },
    }))).recipients.filter((x) => x.role === "controllership")[0].name === "Janine Barad");
  // Neither mailbox has been written down anywhere, so both are a guess — and a guess blocks the
  // send until a coordinator confirms it (R60). This is the control, not the name.
  check("the reviewer's mailbox is a guess, and a guess blocks the send",
    tar[0].emailSource === "guessed" && tar[0].email === "janine_barad@example.com"
      && r5.blockers.some((b) => b.code === "emails_unconfirmed")
      && r5.needsEmail.some((n) => n.name === "Janine Barad"),
    j({ mail: [tar[0].email, tar[0].emailSource], blockers: r5.blockers.map((b) => b.code) }));
  check("below $1M the review does not apply",
    !cb.buildRouting(inputs(Object.assign({}, base, { money: { capexUsd: 999999 } }))).recipients.some((x) => x.role === "controllership"),
    j(cb.buildRouting(inputs(Object.assign({}, base, { money: { capexUsd: 999999 } }))).recipients.map((x) => x.role)));
  check("Erik at A3 and A5 signs once, at A5; Jeanne Halley at A6 and A7 signs once, at A7",
    byName(r5, "Vrishti Aguirre").find((x) => x.status === "pending").level === "A5" && byName(r5, "Jeanne Halley").find((x) => x.status === "pending").level === "A7",
    j(r5.recipients.filter((x) => x.role === "matrix").map((x) => [x.level, x.name, x.status])));
  const blank = JSON.parse(JSON.stringify(m)); blank.levels.A2 = { name: "" };
  const r6 = cb.buildRouting(inputs(base, { matrixRow: blank }));
  check("a blank matrix cell blocks sending", r6.blockers.some((b) => b.code === "blank_matrix_cell") && r6.recipients.some((x) => x.level === "A2" && x.status === "blank"));
  const r6b = cb.buildRouting(inputs(Object.assign({}, base, { routingEdits: { additional: [{ name: "Lekha Rogerson", level: "A2" }] } }), { matrixRow: blank }));
  check("…until the coordinator names a signer at that level", !r6b.blockers.some((b) => b.code === "blank_matrix_cell"));
  const r7 = cb.buildRouting(inputs(Object.assign({}, base, { costCenter: "99999" }), { matrixRow: null }));
  check("an unknown cost centre cannot be routed and says why", r7.blockers.some((b) => b.code === "no_matrix_row") && r7.recipients.filter((x) => x.role !== "cc").length === 1 /* Daryl's rule needs the owner, so only… */ || r7.blockers.some((b) => b.code === "no_matrix_row"));
  const r8 = cb.buildRouting(inputs(Object.assign({}, base, { chargeTo: { business: "GSC", costCenter: "40010", ownerName: "Caolain Sunder" } })));
  check("a charge-to owner signs right after M1 in a Project Approvals row (R47)", byName(r8, "Caolain Sunder")[0].role === "charge_to" &&
    byName(r8, "Caolain Sunder")[0].printRow === "project_approvals_2" && live(r8)[2] === "Caolain Sunder", live(r8).join(" | "));
  check("previewChain for the matrix endpoint shows the deduped ladder", cb.previewChain(m, 400000).map((x) => x.level + ":" + x.status).join(" ") === "M1:skipped A1:pending A2:pending A3:skipped A5:pending A4:pending",
    cb.previewChain(m, 400000).map((x) => x.level + ":" + x.status).join(" "));

  console.log("6. the second segregation-of-duties guard, at envelope creation");
  try { ds.assertSegregation(base, r2); check("a clean routing passes the guard", true); } catch (e) { check("a clean routing passes the guard", false, e.message); }
  const rigged = JSON.parse(JSON.stringify(r2));
  const live2 = rigged.recipients.find((x) => x.status === "pending" && x.role === "matrix");
  live2.name = "Shashank Srivastava"; live2.email = "shashank_srivastava@example.com";
  let threw = null;
  try { ds.assertSegregation(base, rigged); } catch (e) { threw = e.message; }
  check("a routing carrying the requester as a live signer is refused", threw && /Segregation of duties/.test(threw) && /requester/.test(threw), threw);

  console.log("7. the simulated envelope behaves like DocuSign");
  const anchors = r2.recipients.filter((x) => x.role !== "cc").map((x, i) => ({ recipientId: x.id, sig: `\\s${i + 1}\\`, date: `\\d${i + 1}\\` }));
  const env = sim.createEnvelope({ afe: base, routing: r2, documents: [{ attachmentId: "att-1", filename: "quote.pdf", role: "quote", sha256: "x" }], anchors, now: "2026-09-04T10:00:00.000Z" });
  check("subject is the title, first signer is `sent`, the rest `created`, copies at the end", env.emailSubject === "PC Hardware Lifecycle Replacement APAC" &&
    env.recipients[0].status === "sent" && env.recipients[1].status === "created" && env.recipients.filter((x) => x.type === "cc").length === 2 && env.provider === "simulated");
  // Nobody sets an envelope up by hand: one definition, derived from the AFE, the frozen chain
  // and refData.ENVELOPE_POLICY, carried on the envelope so the simulated one and the live one
  // cannot drift (R59, and Aiden's own configuration turned into a rule).
  const spec = env.spec;
  check("the envelope carries its full definition", Boolean(spec) &&
    spec.emailSubject === "PC Hardware Lifecycle Replacement APAC" && spec.signingOrder === "sequential" &&
    spec.status === "sent", j(spec && { subject: spec.emailSubject, order: spec.signingOrder }));
  check("every signer has Sign and Date tabs on their own row, by anchor string",
    spec.signers.length > 0 && spec.signers.every((x) => {
      const a = anchors.find((y) => y.recipientId === x.routingRecipientId);
      return x.routingOrder && x.tabs && a && x.tabs.signHere === a.sig && x.tabs.dateSigned === a.date && x.tabs.documentId === "1";
    }),
    j(spec.signers.map((x) => [x.name, x.tabs && x.tabs.signHere])));
  check("reminders and expiry come from the policy, not from account defaults",
    spec.notification.useAccountDefaults === false &&
    spec.notification.reminders.delayDays === 2 && spec.notification.reminders.frequencyDays === 3 &&
    spec.notification.expirations.afterDays === 30 && spec.notification.expirations.warnDays === 3,
    j(spec.notification));
  check("the copies ride along and the AFE id is a custom field, so a reply can be matched back",
    spec.carbonCopies.length === 2 && spec.customFields.some((f) => f.name === "afeId" && f.value === base.id),
    j({ cc: spec.carbonCopies.map((c) => c.email), fields: spec.customFields }));
  const blurb = envelopeSpec.defaultApproverNote(base);
  check("an envelope never goes out with an empty message — the note is templated when nobody wrote one",
    spec.emailBlurb.length > 0 && /cost centre 30145/.test(blurb) && /\$215,000/.test(blurb), j(blurb));
  const sigMail = envelopeSpec.signatureRequestEmail({
    afe: base, spec, recipient: r2.recipients.find((x) => x.role !== "cc"), envelope: env,
  });
  check("the approver's mail is the envelope's own: same subject, same message, DocuSign's wording",
    sigMail.subject === spec.emailSubject && sigMail.body.includes(spec.emailBlurb.split("\n")[0]) &&
    /review and sign/i.test(sigMail.body) && /expires after 30 days/.test(sigMail.body),
    j(sigMail.subject));

  const signerIds = env.recipients.filter((x) => x.type === "signer").map((x) => x.routingRecipientId);
  let step = sim.recordSigned(env, signerIds[0], "2026-09-05T10:00:00.000Z");
  check("signing hands the envelope to the next signer", step.next && step.next.routingRecipientId === signerIds[1] && step.next.status === "sent");
  let bad = null; try { sim.recordSigned(env, signerIds[3]); } catch (e) { bad = e.message; }
  check("a signer who does not hold the envelope cannot sign", /does not hold/.test(bad), bad);
  for (const id of signerIds.slice(1)) step = sim.recordSigned(env, id, "2026-09-06T10:00:00.000Z");
  check("the last signature completes the envelope and the copies go out", step.next === null && env.status === "completed" && env.recipients.filter((x) => x.type === "cc").every((x) => x.status === "completed"));
  const env2 = sim.createEnvelope({ afe: base, routing: r2, documents: [] });
  sim.recordDeclined(env2, env2.recipients[0].routingRecipientId, "not this year", "2026-09-05T10:00:00.000Z");
  check("a decline ends the envelope with the reason on record", env2.status === "declined" && /not this year/.test(env2.voidReason));

  console.log("8. reminders are due by the stamps, not by a stored flag (R54)");
  const rt = { recipients: [{ id: "r1", status: "signed", notifiedAt: "2026-09-01T00:00:00Z", remindedAt: [] },
    { id: "r2", status: "sent", notifiedAt: "2026-09-01T00:00:00Z", remindedAt: [] }, { id: "r3", status: "pending", notifiedAt: null, remindedAt: [] }] };
  check("the holder is due after three days", rem.dueRecipients(rt, "2026-09-04T00:00:01Z", 3).map((x) => x.id).join() === "r2");
  check("…and not after one", rem.dueRecipients(rt, "2026-09-02T00:00:00Z", 3).length === 0);
  rt.recipients[1].remindedAt.push("2026-09-04T00:00:01Z");
  check("a reminder resets the clock", rem.dueRecipients(rt, "2026-09-05T00:00:00Z", 3).length === 0 && rem.dueRecipients(rt, "2026-09-07T00:00:02Z", 3).length === 1);

  console.log("8b. who reviews and who sends (R157)");
  // The demo of Meeting #7: an AFE raised by somebody who also coordinates CORP_IT went straight
  // to the signers, and Aiden — the coordinator the rule names — only met it once it was out.
  const co = require(path.join(ROOT, "lib/domain/coordination.js"));
  const who = (u) => ({ user: { email: u.email }, roles: u.roles, coordinatorFor: u.coordinatorFor || [] });
  const shashankCtx = who(Object.assign({}, shashank, { roles: ["admin", "coordinator"], coordinatorFor: ["CORP_IT"] }));
  const syedCtx = who(Object.assign({}, syed, { roles: ["coordinator"], coordinatorFor: ["CORP_IT"] }));
  const hanifCtx = who(Object.assign({}, hanif, { roles: ["approver"] }));
  const mine = Object.assign({}, base, { state: "draft" });
  check("a requester who also coordinates the division does not review his own AFE", !co.coordinates(shashankCtx, mine) && !co.maySend(shashankCtx, mine));
  check("…and cannot send it once submitted either", !co.maySend(shashankCtx, Object.assign({}, mine, { state: "submitted" })));
  check("the assigned coordinator reviews it and sends it once it is submitted",
    co.coordinates(syedCtx, mine) && !co.maySend(syedCtx, mine) && co.maySend(syedCtx, Object.assign({}, mine, { state: "submitted" })));
  const hanifs = Object.assign({}, base, { requester: hanif, preparer: hanif, state: "submitted" });
  check("another coordinator of the division stands in on somebody else's AFE (leave cover)", co.coordinates(shashankCtx, hanifs) && co.maySend(shashankCtx, hanifs));
  const syeds = Object.assign({}, base, { requester: syed, preparer: syed, state: "draft" });
  check("the assigned coordinator's own AFE he sends himself, from the draft", co.maySend(syedCtx, syeds));
  check("with no coordinator for the division, the owner sends (R41)",
    co.maySend(hanifCtx, Object.assign({}, hanifs, { coordinator: null, state: "draft" })) && !co.maySend(hanifCtx, hanifs));
  check("an address in another case is the same person",
    co.coordinates(who(Object.assign({}, syed, { email: "Aiden-Mulqueeny_Crilly@example.com", roles: ["coordinator"], coordinatorFor: ["MFG"] })), mine));
}

// ---------------------------------------------------------------------------------------------
// Part 1 — the API, end to end
// ---------------------------------------------------------------------------------------------
async function call(method, p, body) {
  const res = await fetch(BASE + "/api" + p, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let out = null;
  try { out = JSON.parse(text); } catch { out = text; }
  return { status: res.status, body: out };
}
const patch = (id, obj) => call("PATCH", `/afes/${id}`, obj);
async function rawBytes(p) {
  const res = await fetch(BASE + "/api" + p);
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}
/** The document the AFE's own screens show, and the packet its current envelope went out with. */
async function documentAndPacket(id) {
  const v = (await call("GET", `/afes/${id}`)).body;
  const packet = ((v.envelope && v.envelope.documents) || []).find((d) => d.role === "sent_packet");
  const doc = await rawBytes(`/afes/${id}/document.pdf`);
  const sent = packet ? await rawBytes(`/afes/${id}/documents/${packet.attachmentId}/raw`) : { bytes: Buffer.alloc(0) };
  return { doc: doc.bytes, packet: sent.bytes, same: doc.bytes.length > 0 && doc.bytes.equals(sent.bytes) };
}
const actAs = (email) => call("POST", "/admin/act-as", { email });
const actAsNone = () => call("DELETE", "/admin/act-as");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
  "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");

/** A complete, sendable AFE on cost centre 30145 — the wizard's work, done by API. */
async function readyAfe(title, total, marker) {
  const created = await call("POST", "/afes");
  const id = created.body.afe.id;
  const start = new Date(Date.now() + 30 * 86400000), finish = new Date(Date.now() + 150 * 86400000);
  await patch(id, {
    "project.title": title, costCenter: "30145", "money.classification": "capex", "money.capexUsd": total,
    "money.lines": [{ site: "Singapore DC", country: "SG", amountUsd: total }],
    location: "SGP_Singapore_Site 5", region: "APAC",
    "project.projectType": "Office Equip/Furniture",
    "project.description": `${marker} — laptops, desktops and monitors past their lifecycle, replaced across the APAC sites.`,
    "project.justification": "Devices out of warranty fail more often and cannot run the current security baseline.",
    "project.surplusChecked": "Yes", "project.buyVsLease": "N/A", "project.assistAsset": "No",
    "schedule.startDate": start.toISOString().slice(0, 10), "schedule.finishDate": finish.toISOString().slice(0, 10),
    "schedule.fiscalYear": start.getUTCFullYear(), "budget.budgeted": "Yes", "budget.potId": "pot-0003",
  });
  await call("POST", `/afes/${id}/documents`, { filename: `${marker}.pdf`, role: "quote", contentBase64: Buffer.from(PDF, "base64").toString("base64").replace("JVBERi0xLjQK", "JVBERi0xLjQK"), vendor: "Multiple vendors", amountUsd: total });
  return id;
}
async function ensureUser(email, displayName) {
  const all = await call("GET", "/admin/users");
  if (all.body.some((u) => u.email === email)) return;
  await call("POST", "/admin/users", { email, displayName, roles: ["approver"], matrixNames: [displayName] });
}
const rid = (decision, name) => (decision.chain.find((r) => r.name === name && r.order !== null) || {}).id;
const outboxHas = async (kind, to, afeId) => (await call("GET", "/admin/outbox")).body.some((n) => n.kind === kind && n.recipientEmail === to && (!afeId || n.afeId === afeId));
const auditTypes = async (afeId) => (await call("GET", `/admin/audit?afeId=${afeId}`)).body.map((e) => e.type);

async function online() {
  console.log("9. a clean slate");
  const reset = await call("POST", "/admin/reset");
  check("the store resets to reference data", reset.status === 200 && reset.body.ok === true, j(reset.body).slice(0, 120));
  await actAsNone();

  console.log("10. the requester submits; the coordinator shapes the chain and confirms mailboxes (AFE A)");
  const A = await readyAfe("PC Hardware Lifecycle Replacement APAC", 215000, "APAC refresh quote");
  // Shashank holds `coordinator` for CORP_IT — which is exactly how the Meeting #7 demo AFE went
  // out without Aiden seeing it. His own AFE is Aiden's to review (R157).
  const ownA = (await call("GET", `/afes/${A}`)).body.permissions;
  check("Shashank also coordinates CORP_IT, and still cannot send his own AFE past Aiden (R157)",
    ownA.canSend === false && ownA.canCoordinate === false && (await call("POST", `/afes/${A}/send`)).status === 403, j(ownA));
  check("…nor shape its chain", (await call("PUT", `/afes/${A}/routing/recipients`, { additional: [] })).status === 403);
  const subA = await call("POST", `/afes/${A}/submit`);
  check("he submits it and it waits for Aiden", subA.status === 200 && subA.body.afe.state === "submitted", j(subA.body.error || subA.body.afe.state));
  check("Aiden is told it is his to review", await outboxHas("afe_submitted", "aiden-mulqueeny_crilly@example.com", A));
  check("once it is with Aiden, Shashank cannot edit it, send it or send it back",
    (await patch(A, { "project.title": "changed by the requester" })).status === 409
      && (await call("POST", `/afes/${A}/send`)).status === 403
      && (await call("POST", `/afes/${A}/send-back`, { reason: "x" })).status === 403);
  check("…and it is not in his own Prepare queue — it is Aiden's",
    !(await call("GET", "/coordinator/queue")).body.groups.toSend.some((x) => x.id === A));
  await actAs("aiden-mulqueeny_crilly@example.com");
  const syedA = await call("GET", `/afes/${A}`);
  check("Aiden has it to send, and may edit it first",
    syedA.body.permissions.canSend === true && syedA.body.permissions.canEdit === true
      && (await call("GET", "/coordinator/queue")).body.groups.toSend.some((x) => x.id === A), j(syedA.body.permissions));
  // Two saves on two steps, the way the wizard saves: one line in the history, naming both.
  const fin = await patch(A, { "financials.startYear": 2026 });
  const why = await patch(A, { "project.justification": "Devices out of warranty fail more often and cannot run the current security baseline, which changes in January." });
  const editsA = (await call("GET", `/afes/${A}/history`)).body.timeline.filter((e) => e.type === "afe_edited");
  check("his edits are saved, and the history says who changed which steps, in one line",
    fin.status === 200 && why.status === 200 && editsA.length === 1 && editsA[0].text === "Edited the Why and Financials steps"
      && editsA[0].byName === "Aiden-Mulqueeny Crilly", j(editsA));

  // While it is with the coordinator, the coordinator ASKS the requester — the KT walkthrough's
  // "Please fill the financials" (afe-0032, 15 Oct), which could only be a comment that told
  // nobody. On an AFE of its own, so A's conversation stays the question and answer below.
  {
    await actAsNone();
    const K = await readyAfe("Coordinator asks the requester", 3000, "ask-quote");
    await call("POST", `/afes/${K}/submit`);
    await actAs("aiden-mulqueeny_crilly@example.com");
    const mailK = async () => (await call("GET", "/admin/outbox")).body.filter((n) => n.afeId === K && ["ask", "ask_answered"].includes(n.kind));
    const briefK = async () => { const b = (await call("GET", "/afes?mine=1")).body; return (Array.isArray(b) ? b : b.afes || []).find((x) => x.id === K); };
    const permsSyed = (await call("GET", `/afes/${K}`)).body.permissions;
    check("the coordinator is offered an Ask, and it names the requester", permsSyed.canAsk === true && permsSyed.askWho === "Shashank", j(permsSyed.askWho));
    const quiet = await call("POST", `/afes/${K}/comment`, { text: "Looked at the quote." });
    check("a plain comment from the coordinator still tells nobody", quiet.status === 200 && (await mailK()).length === 0);
    const asked = await call("POST", `/afes/${K}/comment`, { text: "Please fill in the financials before I send it.", ask: true });
    const asks1 = await mailK();
    check("his Ask is ONE mail to the requester, and the coordinator is not mailed",
      asked.status === 200 && asked.body.afe.state === "submitted" && asks1.length === 1 && asks1[0].kind === "ask"
        && asks1[0].recipientEmail === "shashank_srivastava@example.com"
        && ![asks1[0].recipientEmail].concat(asks1[0].cc || []).includes("aiden-mulqueeny_crilly@example.com"), j(asks1.map((n) => [n.recipientEmail, n.cc])));
    await actAsNone();
    const open = await briefK();
    check("it is open, and it is what puts the AFE in the requester's Needs you",
      open && open.openAsk && open.openAsk.askedOf === "requester", j(open && open.openAsk));
    const permsOwn = (await call("GET", `/afes/${K}`)).body.permissions;
    check("the requester can Ask the coordinator back", permsOwn.canAsk === true && permsOwn.askWho === "Aiden-Mulqueeny", j(permsOwn.askWho));
    check("…and the composer's main button answers Aiden (a comment does, for an ask)",
      permsOwn.answerTo && permsOwn.answerTo.mode === "ask" && /Aiden/.test(permsOwn.answerTo.byName), j(permsOwn.answerTo));
    const reply = await call("POST", `/afes/${K}/comment`, { text: "Done — the case is on the Financials step." });
    const asks2 = await mailK();
    const closed = await briefK();
    check("his plain reply answers it: Aiden is told once, and the ask is closed",
      reply.status === 200 && asks2.filter((n) => n.kind === "ask_answered" && n.recipientEmail === "aiden-mulqueeny_crilly@example.com").length === 1
        && !(closed && closed.openAsk), j(asks2.map((n) => [n.kind, n.recipientEmail])));
    const back = await call("POST", `/afes/${K}/comment`, { text: "Does the warranty go in OpEx or in the quote?", ask: true });
    const newest = (await mailK()).filter((n) => n.kind === "ask")[0];              // the outbox lists newest first
    check("the requester's Ask goes to the coordinator reviewing it",
      back.status === 200 && newest && newest.recipientEmail === "aiden-mulqueeny_crilly@example.com", j(newest));
    await actAs("aiden-mulqueeny_crilly@example.com");
  }
  let pv = await call("GET", `/afes/${A}/routing/preview`);
  check("the preview cannot be sent yet: Kai Lun Ong needs a mailbox", pv.status === 200 && pv.body.canSend === false &&
    pv.body.needsEmail.some((n) => n.name === "Kai Lun Ong") && pv.body.blockers.some((b) => b.code === "emails_unconfirmed"), j(pv.body.blockers));
  let send = await call("POST", `/afes/${A}/send`);
  check("send is refused with the missing mailbox named", send.status === 422 && /Kai Lun Ong/.test(send.body.error), j(send.body).slice(0, 200));
  let put = await call("PUT", `/afes/${A}/routing/recipients`, {
    additional: [{ name: "Lekha Rogerson", level: "A2", why: "finance partner for APAC" }],
    cc: [{ name: "Jarrod Dane", email: "jarrod_dane@example.com" }],
    approverNote: "Budgeted under Life Cycle Refresh APAC FY26; quotes cover the full estimate; ships before December.",
  });
  const order = (r) => r.recipients.filter((x) => x.status === "pending" && x.role !== "cc").map((x) => x.name).join(" | ");
  check("Lekha is a second A2 between Kai Lun Ong and Erik; Jarrod receives a copy", put.status === 200 &&
    order(put.body.routing) === "Annette Sandhu | Udarsh Atwal | Kai Lun Ong | Lekha Rogerson | Vrishti Aguirre" &&
    put.body.routing.recipients.some((x) => x.role === "cc" && x.email === "jarrod_dane@example.com"), order(put.body.routing || { recipients: [] }));
  const badPut = await call("PUT", `/afes/${A}/routing/recipients`, { additional: [{ name: "Someone Else", email: "contact-4f6cf3@outside.example" }] });
  check("an outside mailbox is refused", badPut.status === 422 && /example\.com/.test(badPut.body.error), j(badPut.body));
  const badConfirm = await call("POST", `/afes/${A}/routing/confirm-emails`, { confirmations: [{ name: "Kai Lun Ong", email: "contact-0027cc@outside.example" }] });
  check("confirming an outside mailbox is refused too", badConfirm.status === 422, j(badConfirm.body));
  const confirm = await call("POST", `/afes/${A}/routing/confirm-emails`, { confirmations: [{ name: "Kai Lun Ong", email: "kailun_ong@example.com" }] });
  check("typing Kai Lun Ong's mailbox makes the chain sendable", confirm.status === 200 && confirm.body.routing.canSend === true && confirm.body.routing.emailsConfirmed === true &&
    confirm.body.learned[0].source === "typed", j(confirm.body).slice(0, 200));
  const dir = await call("GET", "/admin/directory");
  const teckDir = dir.body.find((d) => d.matrixName === "Kai Lun Ong");
  check("…and the directory learned it for the next AFE (R60)", teckDir && teckDir.email === "kailun_ong@example.com" && teckDir.source === "confirmed" && teckDir.learnedFromAfeId === A, j(teckDir));
  check("the learning is audited", (await auditTypes(A)).includes("directory_learned") && (await auditTypes(A)).includes("emails_confirmed"));

  console.log("11. send: the chain freezes and the first signer is asked");
  send = await call("POST", `/afes/${A}/send`);
  check("send succeeds and the AFE is in approval", send.status === 200 && send.body.afe.state === "in_approval", j(send.body).slice(0, 200));
  const rtA = send.body.routing;
  check("the routing is frozen: active, round 1, matrix batch and rules recorded", rtA && rtA.status === "active" && rtA.round === 1 && rtA.basis.matrixBatchId && rtA.basis.orgRuleIds.includes("rule-0002"), j(rtA && rtA.basis));
  check("the envelope is simulated and says so", send.body.envelope && send.body.envelope.provider === "simulated" && /^SIM-/.test(send.body.envelope.envelopeId) && send.body.envelope.status === "sent", j(send.body.envelope).slice(0, 160));
  check("Daryl holds it; everyone else waits", rtA.recipients.find((x) => x.name === "Annette Sandhu").status === "sent" && rtA.recipients.filter((x) => x.status === "pending" && x.role !== "cc").length === 4);
  check("Daryl is told, with the coordinator's note", await outboxHas("approval_needed", "annette_sandhu@example.com", A));
  check("the preview is now the frozen routing", (await call("GET", `/afes/${A}/routing/preview`)).body.frozen === true);
  const locked = await patch(A, { "project.title": "changed after send" });
  check("the AFE cannot be edited once sent", locked.status === 409, j(locked.body));
  check("it cannot be sent twice", (await call("POST", `/afes/${A}/send`)).status === 409);
  check("send is audited", (await auditTypes(A)).includes("send"));
  const histA = (await call("GET", `/afes/${A}/history`)).body.timeline;
  check("the history names who did it: Shashank submitted, Aiden edited and sent",
    histA.find((e) => e.type === "submit").byName === "Shashank Srivastava" && histA.find((e) => e.type === "send").byName === "Aiden-Mulqueeny Crilly"
      && histA.filter((e) => e.type === "afe_edited").length === 1, j(histA.map((e) => [e.type, e.byName])));

  console.log("12. the approvers: inbox, decision context, a question and its answer, five signatures");
  await actAs("annette_sandhu@example.com");
  let mine = await call("GET", "/approvals/mine");
  check("Daryl's inbox shows the AFE to sign, flagged simulated", mine.status === 200 && mine.body.toSign.some((i) => i.afe.id === A && i.simulated === true), j(mine.body.counts));
  let dec = await call("GET", `/afes/${A}/decision`);
  check("the decision view carries the approver's context (R55)", dec.status === 200 && dec.body.me.canSign === true && dec.body.quote.coveragePct === 100 &&
    dec.body.band.label === "$100,001 – $300,000" && dec.body.budget.budgeted === "Yes" && dec.body.budget.pot && dec.body.budget.pot.region === "APAC" &&
    /Life Cycle Refresh/.test(dec.body.approverNote) && dec.body.chain.filter((r) => r.order).length === 5 && dec.body.chain.find((r) => r.isYou).name === "Annette Sandhu",
    j({ me: dec.body.me, quote: dec.body.quote, band: dec.body.band && dec.body.band.label }));
  // "Why the mismatch in quotes???" (an approver, 15 Oct): the page gave a percentage and nothing
  // else. It carries the amounts, the gap and who typed the figure, with the figure.
  check("the approver gets the amounts behind the coverage, the gap, and the figure that was typed",
    dec.body.quote.afeTotalUsd === 215000 && dec.body.quote.gapUsd === 0 && "note" in dec.body.quote
      && /\$215,000 typed by /.test(dec.body.quote.provenance || ""), j({ q: dec.body.quote }));
  // A requester no longer sees what a pot has left; somebody deciding whether to spend it does (R167).
  check("…and what the pot has left, because they are the one deciding to spend it",
    Number.isFinite(dec.body.budget.pot.remainingUsd), j(dec.body.budget.pot));
  let sign = await call("POST", `/afes/${A}/recipients/${rid(dec.body, "Annette Sandhu")}/sign`);
  check("Daryl signs; the envelope moves to Atwal", sign.status === 200 && sign.body.decision.chain.find((r) => r.name === "Annette Sandhu").status === "signed" &&
    sign.body.decision.chain.find((r) => r.isCurrent).name === "Udarsh Atwal", j(sign.body).slice(0, 200));
  const again = await call("POST", `/afes/${A}/recipients/${rid(dec.body, "Annette Sandhu")}/sign`);
  check("he cannot sign again", again.status === 403 || again.status === 409 || again.status === 422, j(again.body));
  check("Daryl is told his part is done — the AFE moves out of his to-sign list", !(await call("GET", "/approvals/mine")).body.toSign.some((i) => i.afe.id === A));

  await actAs("judithmelanie_ware@example.com");
  const notMine = await call("POST", `/afes/${A}/recipients/${rid(dec.body, "Udarsh Atwal")}/sign`);
  check("someone who is not the recipient cannot sign for them", notMine.status === 403, j(notMine.body));

  await actAs("udarsh_atwal@example.com");
  dec = await call("GET", `/afes/${A}/decision`);
  const q = await call("POST", `/afes/${A}/recipients/${rid(dec.body, "Udarsh Atwal")}/question`, { text: "Does this include the Japan monitors we discussed?" });
  check("Atwal asks a question; the AFE goes on hold", q.status === 200 && q.body.decision.state === "on_hold" && q.body.decision.thread.length === 1, j(q.body).slice(0, 200));
  check("the requester is told", await outboxHas("question", "shashank_srivastava@example.com", A));
  await actAsNone();
  const heldPerms = (await call("GET", `/afes/${A}`)).body.permissions;
  // A comment does NOT release a pausing question; the composer's main button is the answer.
  check("on the requester's record the conversation's main button answers Atwal's question",
    heldPerms.answerTo && heldPerms.answerTo.mode === "question" && /Atwal/.test(heldPerms.answerTo.byName), j(heldPerms.answerTo));
  await actAs("udarsh_atwal@example.com");
  const qMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "question" && n.afeId === A);
  check("…in ONE mail, the coordinator copied, not one each (R164)",
    qMail.length === 1 && qMail[0].cc.includes("aiden-mulqueeny_crilly@example.com"), j(qMail.map((n) => [n.recipientEmail, n.cc])));
  mine = await call("GET", "/approvals/mine");
  check("his inbox shows it under on hold, not to sign", mine.body.onHold.some((i) => i.afe.id === A) && !mine.body.toSign.some((i) => i.afe.id === A));
  const signOnHold = await call("POST", `/afes/${A}/recipients/${rid(dec.body, "Udarsh Atwal")}/sign`);
  check("nothing is signed while on hold", signOnHold.status === 409, j(signOnHold.body));

  await actAsNone();
  const ans = await call("POST", `/afes/${A}/answer`, { text: "Yes — 30 monitors for Japan are in the Japan line." });
  check("the requester answers; the AFE is back in approval with the question resolved", ans.status === 200 && ans.body.afe.state === "in_approval" &&
    ans.body.thread.length === 2 && ans.body.thread[0].resolvedAt, j(ans.body.thread));
  check("Atwal is told the answer", await outboxHas("answer", "udarsh_atwal@example.com", A));

  await ensureUser("kailun_ong@example.com", "Kai Lun Ong");
  await ensureUser("vrishti_aguirre@example.com", "Vrishti Aguirre");
  for (const who of ["udarsh_atwal@example.com", "kailun_ong@example.com", "lekha_rogerson@example.com", "vrishti_aguirre@example.com"]) {
    await actAs(who);
    const d = await call("GET", `/afes/${A}/decision`);
    const me = d.body.me;
    const s = await call("POST", `/afes/${A}/recipients/${me.recipientId}/sign`);
    check(`${who.split("@")[0]} signs`, s.status === 200, j(s.body).slice(0, 200));
  }
  await actAsNone();
  const done = await call("GET", `/afes/${A}`);
  check("with the last signature the AFE is with Fixed Assets", done.body.afe.state === "fa_review" && done.body.afe.approvedAt && done.body.afe.fa.receivedAt, done.body.afe.state);
  check("the routing and envelope are completed; copies went out", done.body.routing.status === "completed" && done.body.envelope.status === "completed" &&
    done.body.routing.recipients.filter((x) => x.role === "cc").every((x) => x.status === "sent"));
  // The hand-off: ONE mail to the shared AFE mailbox, the requester in copy, under a subject
  // the FA team's own workflow can trigger on without reading the body.
  const handoff = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "afe_approved" && n.afeId === A);
  check("one hand-off mail, to the shared AFE mailbox, with the requester in copy",
    handoff.length === 1 && handoff[0].recipientEmail === "rtr_fa@example.com" &&
    (handoff[0].cc || []).includes("shashank_srivastava@example.com"),
    j(handoff.map((n) => [n.recipientEmail, n.cc])));
  check("its subject is the standard trigger line, and the same facts are on X-AFE headers",
    handoff.length === 1 && /^AFE APPROVED \| 30145 \| USD [\d,]+ \| .+ \| afe-/.test(handoff[0].subject) &&
    handoff[0].headers && handoff[0].headers["X-AFE-Workbench"] === "afe-approved" && handoff[0].headers["X-AFE-Id"] === A,
    j(handoff.length ? [handoff[0].subject, handoff[0].headers] : null));
  check("it tells Fixed Assets what to do next", handoff.length === 1 && /internal order \(KO01\)/.test(handoff[0].body) && /signatures are in/.test(handoff[0].body));
  // R164: the copy on the hand-off IS the owner side's "fully signed". A separate note to each of
  // them made the same news three mails, and the Fixed Assets mailbox — a routing copy too — got
  // the completed set as well as the hand-off.
  const doneMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.afeId === A && ["afe_approved", "afe_approved_owner", "copy_completed"].includes(n.kind));
  check("the requester side hears it from the hand-off's copy line, and gets no second mail",
    handoff.length === 1 && handoff[0].cc.includes("aiden-mulqueeny_crilly@example.com") && !doneMail.some((n) => n.kind === "afe_approved_owner")
      && !doneMail.some((n) => n.kind === "copy_completed" && ["shashank_srivastava@example.com", "aiden-mulqueeny_crilly@example.com"].includes(n.recipientEmail)),
    j(doneMail.map((n) => [n.kind, n.recipientEmail, n.cc])));
  check("Fixed Assets gets the hand-off once — not a completed-set copy on top of it",
    doneMail.filter((n) => [n.recipientEmail].concat(n.cc || []).includes("rtr_fa@example.com")).length === 1, j(doneMail.map((n) => [n.kind, n.recipientEmail])));
  check("the extra copy recipient gets the completed set", await outboxHas("copy_completed", "jarrod_dane@example.com", A));
  const typesA = await auditTypes(A);
  check("five signatures and the handover are audited", typesA.filter((t) => t === "recipient_signed").length === 5 && typesA.includes("fa_handover") && typesA.includes("question") && typesA.includes("answer"), j(typesA));

  console.log("13. the owner raises his own AFE: submitted, segregation of duties, a send-back, round two (AFE B)");
  await actAs("udarsh_atwal@example.com");
  const B = await readyAfe("PC Hardware Lifecycle Replacement SG", 240000, "Singapore refresh quote");
  pv = await call("GET", `/afes/${B}/routing/preview`);
  const hanifRow = pv.body.recipients.find((x) => x.name === "Udarsh Atwal" && x.status === "sod_blocked");
  const mike = pv.body.recipients.find((x) => x.name === "Isabel Armstrong");
  check("Atwal is excluded from his own AFE and Isabel Armstrong stands in", hanifRow && mike && mike.standInFor === hanifRow.id && mike.emailSource === "guessed", j(pv.body.recipients.map((x) => [x.name, x.status])));
  check("Kai Lun Ong's mailbox is already known from AFE A — no confirmation needed twice",
    ["directory", "users"].includes(pv.body.recipients.find((x) => x.name === "Kai Lun Ong").emailSource) && !pv.body.needsEmail.some((n) => n.name === "Kai Lun Ong"),
    pv.body.recipients.find((x) => x.name === "Kai Lun Ong").emailSource);
  const submit = await call("POST", `/afes/${B}/submit`);
  check("Atwal submits; the AFE waits for the coordinator", submit.status === 200 && submit.body.afe.state === "submitted", j(submit.body).slice(0, 200));
  check("the coordinator is told", await outboxHas("afe_submitted", "aiden-mulqueeny_crilly@example.com", B));
  check("the requester cannot edit while the coordinator has it", (await patch(B, { "project.title": "x" })).status === 409);
  check("the requester cannot send it himself — the division has a coordinator", (await call("POST", `/afes/${B}/send`)).status === 403);
  await actAsNone();
  const standIn = (await call("GET", `/afes/${B}`)).body.permissions;
  check("another CORP_IT coordinator who did not raise it may stand in for Aiden (leave cover, R157)",
    standIn.canSend === true && standIn.canCoordinate === true
      && (await call("GET", "/coordinator/queue")).body.groups.toSend.some((x) => x.id === B), j(standIn));

  await actAs("aiden-mulqueeny_crilly@example.com");
  const note = await patch(B, { approverNote: "Owner-raised; A4 stands in for the owner's own level." });
  check("the coordinator can still edit in submitted", note.status === 200, j(note.body).slice(0, 160));
  const queue = await call("GET", "/coordinator/queue");
  check("Aiden's queue shows it under to-send", queue.status === 200 && queue.body.groups.toSend.some((x) => x.id === B), j(queue.body.counts));

  // R147 — "at any workflow, if it gets rejected, it should go back to the project manager's
  // bucket, whoever raised the initial AFE" (Jarrod, Meeting #6). The coordinator's send-back is
  // the first of the three: the requester is addressed, and nobody is mailed about their own action.
  const csb = await call("POST", `/afes/${B}/send-back`, { reason: "Name the two Singapore sites on the lines.", step: 3 });
  check("the coordinator sends it back, and it is the requester's to fix",
    csb.status === 200 && csb.body.afe.state === "returned" && csb.body.afe.returnedTo.role === "coordinator"
      && Boolean(csb.body.afe.returnedTo.to) && csb.body.afe.returnedTo.to.email === "udarsh_atwal@example.com",
    j(csb.body.error || csb.body.afe.returnedTo));
  const csbMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "sent_back" && n.afeId === B);
  check("one mail, to the requester by name, and the coordinator is not mailed about their own send-back",
    csbMail.length === 1 && csbMail[0].recipientEmail === "udarsh_atwal@example.com" && !csbMail[0].cc.includes("aiden-mulqueeny_crilly@example.com")
      && csbMail[0].body.includes("Udarsh Atwal"),
    j(csbMail.map((n) => [n.recipientEmail, n.cc])));
  await actAs("udarsh_atwal@example.com");
  const hanifsOwn = (await call("GET", "/afes?mine=1")).body.find((x) => x.id === B);
  check("it lands in Atwal's own list as sent back to him",
    hanifsOwn && hanifsOwn.state === "returned" && hanifsOwn.returnedTo && hanifsOwn.returnedTo.to.email === "udarsh_atwal@example.com",
    j(hanifsOwn && hanifsOwn.returnedTo));
  check("he fixes nothing and resubmits; it is back with the coordinator", (await call("POST", `/afes/${B}/submit`)).body.afe.state === "submitted");
  await actAs("aiden-mulqueeny_crilly@example.com");
  const confirmB = await call("POST", `/afes/${B}/routing/confirm-emails`, { confirmations: [{ name: "Isabel Armstrong" }] });
  check("confirming the guess as-is is enough", confirmB.status === 200 && confirmB.body.learned[0].source === "confirmed" && confirmB.body.routing.canSend === true, j(confirmB.body).slice(0, 200));
  const sendB = await call("POST", `/afes/${B}/send`);
  check("the coordinator sends; the frozen routing records the exclusion", sendB.status === 200 && sendB.body.afe.state === "in_approval" &&
    sendB.body.routing.sod.excluded.length === 1 && sendB.body.routing.sod.excluded[0].name === "Udarsh Atwal", j(sendB.body).slice(0, 200));
  check("the exclusion is audited (CLAUDE.md non-negotiable 4)", (await auditTypes(B)).includes("sod_excluded"));
  check("signing order is Daryl, Kai Lun Ong, Erik, Isabel Armstrong", order(sendB.body.routing).replace(/ \| /g, ",") === "Annette Sandhu,Kai Lun Ong,Vrishti Aguirre,Isabel Armstrong" ||
    sendB.body.routing.recipients.filter((x) => x.role !== "cc" && x.order).map((x) => x.name).join(",") === "Annette Sandhu,Kai Lun Ong,Vrishti Aguirre,Isabel Armstrong",
    sendB.body.routing.recipients.filter((x) => x.role !== "cc" && x.order).map((x) => x.name).join(","));

  await actAs("annette_sandhu@example.com");
  dec = await call("GET", `/afes/${B}/decision`);
  check("Daryl signs round one", (await call("POST", `/afes/${B}/recipients/${dec.body.me.recipientId}/sign`)).status === 200);
  await actAs("kailun_ong@example.com");
  dec = await call("GET", `/afes/${B}/decision`);
  const back = await call("POST", `/afes/${B}/recipients/${dec.body.me.recipientId}/send-back`, { reason: "The Singapore DC line should be split from GCO.", step: 3 });
  check("Kai Lun Ong sends it back to step 3", back.status === 200 && back.body.decision.state === "returned" && back.body.decision.returnedTo.step === 3 &&
    /split/.test(back.body.decision.returnedTo.reason), j(back.body).slice(0, 200));
  await actAsNone();
  let viewB = await call("GET", `/afes/${B}`);
  // R148 answers Q38. A send-back PAUSES the round: the envelope stays out, Daryl's signature is
  // still on it, and whether it resumes is decided when it is resubmitted.
  check("the round is paused, not voided: the envelope stays out and Daryl's signature is kept (R148)",
    viewB.body.envelope.status === "sent" && viewB.body.routing.status === "returned"
      && viewB.body.routing.recipients.find((x) => x.name === "Annette Sandhu").status === "signed"
      && viewB.body.routing.recipients.find((x) => x.name === "Kai Lun Ong").status === "returned"
      && viewB.body.routing.recipients.find((x) => x.name === "Vrishti Aguirre").status === "pending",
    j({ env: viewB.body.envelope.status, rt: viewB.body.routing.status, who: viewB.body.routing.recipients.map((x) => [x.name, x.status]) }));
  check("and the AFE says a resubmission would go straight back to Kai Lun Ong with Daryl's signature",
    viewB.body.resume && viewB.body.resume.applies && viewB.body.resume.mode === "paused" && viewB.body.resume.can === true
      && viewB.body.resume.holder.name === "Kai Lun Ong" && viewB.body.resume.signed.map((x) => x.name).join() === "Annette Sandhu",
    j(viewB.body.resume));
  check("the one document is still the packet that went out, because that is what Kai Lun Ong will sign",
    (await documentAndPacket(B)).same);
  check("the requester is told what to change", await outboxHas("sent_back", "udarsh_atwal@example.com", B));
  const apMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "sent_back" && n.afeId === B && /split/.test(n.body));
  check("an approver's send-back is ONE mail to the requester, copying the coordinator (R147)",
    apMail.length === 1 && apMail[0].recipientEmail === "udarsh_atwal@example.com" && apMail[0].cc.includes("aiden-mulqueeny_crilly@example.com"),
    j(apMail.map((n) => [n.recipientEmail, n.cc])));
  check("and the AFE says whose it is as well as who sent it",
    viewB.body.afe.returnedTo.role === "approver" && viewB.body.afe.returnedTo.byName === "Kai Lun Ong"
      && Boolean(viewB.body.afe.returnedTo.to) && viewB.body.afe.returnedTo.to.email === "udarsh_atwal@example.com",
    j(viewB.body.afe.returnedTo));
  check("a fresh preview for round two is offered", viewB.body.routingPreview && viewB.body.routingPreview.round === 2 && viewB.body.routingPreview.canSend === true);

  await actAs("udarsh_atwal@example.com");
  const edit = await patch(B, { "money.capexUsd": 250000, "money.lines": [{ site: "Singapore DC", country: "SG", amountUsd: 150000 }, { site: "Singapore GCO", country: "SG", amountUsd: 100000 }] });
  check("the requester reopens and changes the money", edit.status === 200 && edit.body.validation.ok === true, j(edit.body.validation && edit.body.validation.blocks));
  const keys = ((edit.body.view.resume && edit.body.view.resume.reasons) || []).map((r) => r.key);
  check("the same save says it will now go round again, and why (R148)",
    edit.body.view.resume && edit.body.view.resume.can === false && keys.includes("capexUsd") && keys.includes("lines"), j(edit.body.view.resume));
  check("and the one document stops being the old packet: it is the one the new round would send",
    !(await documentAndPacket(B)).same);
  const resubB = await call("POST", `/afes/${B}/submit`);
  check("he resubmits; it goes to the coordinator for a new round", resubB.body.afe.state === "submitted", j(resubB.body.error || resubB.body.afe.state));
  viewB = await call("GET", `/afes/${B}`);
  check("only now is the paused round closed: the envelope void, the round superseded, the signatures gone (Q38)",
    viewB.body.envelope.status === "voided" && viewB.body.routing.status === "superseded"
      && viewB.body.routing.recipients.find((x) => x.name === "Annette Sandhu").status === "signed"
      && viewB.body.routing.recipients.find((x) => x.name === "Vrishti Aguirre").status === "superseded"
      && viewB.body.routing.recipients.find((x) => x.name === "Kai Lun Ong").status === "superseded",
    j({ env: viewB.body.envelope.status, rt: viewB.body.routing.status }));
  check("the submit is audited as round again, with the reason",
    (await call("GET", `/admin/audit?afeId=${B}`)).body.some((e) => e.type === "submit" && e.payload.roundAgain === true
      && (e.payload.because || []).some((b) => /CapEx/.test(b))));
  await actAs("aiden-mulqueeny_crilly@example.com");
  const sendB2 = await call("POST", `/afes/${B}/send`);
  check("round two goes out on a new routing and envelope", sendB2.status === 200 && sendB2.body.afe.round === 2 && sendB2.body.routing.round === 2 && sendB2.body.routing.status === "active" &&
    /-R2$/.test(sendB2.body.envelope.envelopeId) && sendB2.body.routingHistory.length === 1 && sendB2.body.routingHistory[0].status === "superseded", j(sendB2.body).slice(0, 200));

  console.log("13b. a send-back that changes nothing that decides it keeps the signatures (R148, AFE D)");
  // "If they need to redo this entire approval workflow, it would be a real challenge for the
  // requester" (Judithmelanie, Meeting #6). Imogen: the amount, the cost centre and the budget matter;
  // the dates and the description do not.
  await actAsNone();
  const D = await readyAfe("Conference Room Display Refresh APAC", 215000, "Room displays quote");
  await call("POST", `/afes/${D}/submit`);
  await actAs("aiden-mulqueeny_crilly@example.com");
  const sendD = await call("POST", `/afes/${D}/send`);
  check("D goes out", sendD.status === 200 && sendD.body.afe.state === "in_approval", j(sendD.body.error || sendD.body.afe.state));
  const envD = sendD.body.envelope.envelopeId;
  const signersD = sendD.body.routing.recipients.filter((x) => x.role !== "cc" && x.order).sort((a, b) => a.order - b.order);
  const [firstD, secondD, thirdD] = signersD;
  check("with at least three to sign", signersD.length >= 3, signersD.map((x) => x.name).join(", "));
  await actAs(firstD.email);
  check(`${firstD.name} signs`, (await call("POST", `/afes/${D}/recipients/${firstD.id}/sign`)).status === 200);
  await actAs(secondD.email);
  const backD = await call("POST", `/afes/${D}/recipients/${secondD.id}/send-back`, { reason: "Say which rooms get a display.", step: 4 });
  check(`${secondD.name} sends it back for the wording`, backD.status === 200 && backD.body.decision.state === "returned", j(backD.body.error));
  await actAsNone();
  const auditD = (await call("GET", `/admin/audit?afeId=${D}`)).body;
  check("the send-back is audited as a pause, with the signature it kept",
    auditD.some((e) => e.type === "send_back" && e.payload.paused === true && e.payload.kept === 1));

  // What a resubmission would do, asked beforehand. Each of these must turn it into a new round.
  const canNow = async () => ((await call("GET", `/afes/${D}`)).body.resume || {});
  const fy = (await call("GET", `/afes/${D}`)).body.afe.schedule.fiscalYear;
  await patch(D, { "schedule.fiscalYear": fy + 1 });
  let r = await canNow();
  check("a different fiscal year is a different budget: round again", r.can === false && r.reasons.some((x) => x.key === "fiscalYear"), j(r.reasons));
  await patch(D, { "schedule.fiscalYear": fy });
  await actAs("aiden-mulqueeny_crilly@example.com");
  await call("PUT", `/afes/${D}/routing/recipients`, { additional: [{ name: "Lekha Rogerson", level: "A2" }] });
  r = await canNow();
  check("a signer the coordinator added while it was back has to sign: round again",
    r.can === false && r.reasons.some((x) => x.key === "chain" && /Lekha Rogerson/.test(x.text)), j(r.reasons));
  await call("PUT", `/afes/${D}/routing/recipients`, { additional: [] });
  await actAsNone();
  // A different file from the quote, or the upload is refused as the same one.
  const plan = Buffer.from("%PDF-1.4\n% room plan, level 3\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n").toString("base64");
  const extra = await call("POST", `/afes/${D}/documents`, { filename: "room-plan.pdf", role: "backup", contentBase64: plan });
  r = await canNow();
  check("a document added while it was back is one nobody signed over: round again",
    extra.status === 201 && r.can === false && r.reasons.some((x) => x.key === "documents" && /room-plan\.pdf/.test(x.text)),
    j({ st: extra.status, err: extra.body && extra.body.error, reasons: r.reasons }));
  const gone = await call("DELETE", `/afes/${D}/documents/${extra.body.attachmentId}`);
  r = await canNow();
  check("and taking it off again puts it back as it was", gone.status === 200 && r.can === true, j(r.reasons));
  const wording = await patch(D, { "project.description": "Room displays quote — displays for the six meeting rooms on level 3 and the two training rooms, replacing units past their lifecycle." });
  check("the wording is all that changed, and the same save says it goes straight back",
    wording.status === 200 && wording.body.view.resume && wording.body.view.resume.can === true
      && wording.body.view.resume.holder.name === secondD.name, j(wording.body.view.resume));

  const resubD = await call("POST", `/afes/${D}/submit`);
  check(`resubmitted: straight back to ${secondD.name}, on the same envelope, in the same round`,
    resubD.status === 200 && resubD.body.afe.state === "in_approval" && resubD.body.afe.round === 1
      && resubD.body.envelope.envelopeId === envD && resubD.body.routing.status === "active",
    j(resubD.body.error || [resubD.body.afe.state, resubD.body.afe.round, resubD.body.envelope && resubD.body.envelope.envelopeId]));
  const whoD = (name) => resubD.body.routing.recipients.find((x) => x.name === name && x.order);
  check(`${firstD.name}'s signature stands and ${secondD.name} holds it again`,
    whoD(firstD.name).status === "signed" && whoD(secondD.name).status === "sent", j(resubD.body.routing.recipients.map((x) => [x.name, x.status])));
  const resumedRow = (await call("GET", `/admin/audit?afeId=${D}`)).body.find((e) => e.type === "submit" && e.payload.resumed === true);
  check("the resubmission is audited as a resume: who holds it, how many signatures stood, what changed",
    resumedRow && resumedRow.toState === "in_approval" && resumedRow.payload.kept === 1 && resumedRow.payload.holder === secondD.name
      && resumedRow.payload.changed.includes("Project description"), j(resumedRow && resumedRow.payload));
  const backMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "approval_resumed" && n.afeId === D);
  check(`${secondD.name} is told it is back, and the requester side is copied`,
    backMail.length === 1 && backMail[0].recipientEmail === secondD.email && backMail[0].cc.length >= 1, j(backMail.map((n) => [n.recipientEmail, n.cc])));
  await actAs(secondD.email);
  const decD = (await call("GET", `/afes/${D}/decision`)).body;
  check("the next signer is shown what changed and whose signature stood",
    decD.round && decD.round.resumed && decD.round.resumed.kept === 1 && decD.round.resumed.changed.includes("Project description")
      && decD.me && decD.me.isCurrent === true, j(decD.round));
  check(`${secondD.name} signs the same envelope`, (await call("POST", `/afes/${D}/recipients/${secondD.id}/sign`)).status === 200);

  // The coordinator's Send decides the same way as the requester's Submit.
  await actAs(thirdD.email);
  const back2 = await call("POST", `/afes/${D}/recipients/${thirdD.id}/send-back`, { reason: "Confirm the delivery window.", step: 4 });
  check(`${thirdD.name} sends it back too`, back2.status === 200, j(back2.body.error));
  await actAs("aiden-mulqueeny_crilly@example.com");
  const sendAgain = await call("POST", `/afes/${D}/send`);
  check("the coordinator presses Send with nothing changed: back to them, same envelope, two signatures standing",
    sendAgain.status === 200 && sendAgain.body.afe.state === "in_approval" && sendAgain.body.envelope.envelopeId === envD
      && sendAgain.body.routing.recipients.filter((x) => x.status === "signed").length === 2
      && sendAgain.body.routing.pauses.length === 2 && sendAgain.body.routing.pauses.every((p) => p.resumedAt),
    j(sendAgain.body.error || sendAgain.body.routing && sendAgain.body.routing.pauses));
  for (let i = 0; i < 6; i++) {
    const cur = (await call("GET", `/afes/${D}`)).body;
    if (cur.afe.state !== "in_approval") break;
    const h = cur.routing.recipients.find((x) => x.status === "sent");
    await actAs(h.email);
    await call("POST", `/afes/${D}/recipients/${h.id}/sign`);
  }
  await actAsNone();
  const doneD = (await call("GET", `/afes/${D}`)).body;
  check("it completes on the one envelope, and every signature on it checks against the frozen chain",
    doneD.afe.state === "fa_review" && doneD.envelope.envelopeId === envD
      && (doneD.envelope.completed.verification || []).length > 0 && doneD.envelope.completed.verification.every((x) => x.st === "ok"),
    j({ st: doneD.afe.state, v: doneD.envelope.completed && doneD.envelope.completed.verification }));

  console.log("13c. the conversation: quiet comments, and an Ask that is answered (R149, R163, AFE D)");
  // "Instead of hard rejection— let's use the comment section only— it will have the audit
  // trail, what we asked and what they responded" (Jarrod, Meeting #6). And "too noisy" (Judithmelanie,
  // Meeting #7): a comment e-mails nobody now; an Ask is the one line that tells the other side.
  const JUDITHMELANIE = "judithmelanie_ware@example.com";
  const dNow = (await call("GET", `/afes/${D}`)).body;
  const requesterD = dNow.afe.requester.email;
  const coordinatorD = dNow.afe.coordinator.email;
  const approversD = dNow.routing.recipients.filter((x) => x.role !== "cc").map((x) => x.email).filter(Boolean);
  const talkMail = async () => (await call("GET", "/admin/outbox")).body.filter((n) => n.afeId === D && ["comment", "ask", "ask_answered"].includes(n.kind));
  await actAs(JUDITHMELANIE);
  const permsK = (await call("GET", `/afes/${D}`)).body.permissions;
  check("Fixed Assets may comment on an AFE it holds, and may ask its requester",
    permsK.canComment === true && permsK.canAsk === true && permsK.askWho === "Shashank", j(permsK));
  const empty = await call("POST", `/afes/${D}/comment`, { text: "  " });
  check("an empty comment is refused", empty.status === 422, j(empty.body));
  const noted = await call("POST", `/afes/${D}/comment`, { text: "Checked the quote against the form: it matches." });
  check("Fixed Assets comments and the AFE does not move", noted.status === 200 && noted.body.afe.state === "fa_review", j(noted.body.error || noted.body.afe.state));
  check("the line is on the record as a comment, from Fixed Assets",
    (noted.body.afe.thread.slice(-1)[0] || {}).kind === "comment" && noted.body.afe.thread.slice(-1)[0].side === "fa");
  check("and a plain comment e-mails nobody (R163)", (await talkMail()).length === 0, j(await talkMail()));
  const asked = await call("POST", `/afes/${D}/comment`, { text: "Which six rooms? We need the site split before KO01.", ask: true });
  const askLine = asked.body.afe && asked.body.afe.thread.slice(-1)[0];
  check("Fixed Assets ASKS, and the AFE still does not move", asked.status === 200 && asked.body.afe.state === "fa_review" && askLine.kind === "ask" && askLine.side === "fa",
    j(asked.body.error || askLine));
  const more = await call("POST", `/afes/${D}/comment`, { text: "And which of them need a ceiling mount." });
  check("a second line from Fixed Assets does not answer Fixed Assets' own ask",
    more.status === 200 && more.body.asks.filter((x) => x.open).length === 1, j(more.body.asks));
  await actAsNone();
  let mailD = await talkMail();
  check("the ask is ONE mail, to the requester, the coordinator copied, and no approver",
    mailD.length === 1 && mailD[0].kind === "ask" && mailD[0].recipientEmail === requesterD && mailD[0].cc.includes(coordinatorD)
      && !approversD.some((e) => [mailD[0].recipientEmail].concat(mailD[0].cc).includes(e)),
    j(mailD.map((n) => [n.kind, n.recipientEmail, n.cc])));
  let listD = (await call("GET", "/afes?mine=1")).body.find((x) => x.id === D);
  check("the requester's own list carries the open ask, which is what puts it in Needs you",
    listD && listD.openAsk && listD.openAsk.side === "fa" && listD.openAsk.id === askLine.id, j(listD && listD.openAsk));

  const reply = await call("POST", `/afes/${D}/comment`, { text: "Level 3: rooms 3.01 to 3.06, all at the Singapore ICON site." });
  check("the requester answers with a plain comment, and nothing moves",
    reply.status === 200 && reply.body.afe.state === "fa_review" && reply.body.afe.thread.slice(-1)[0].side === "requester", j(reply.body.error));
  check("the ask is answered — derived from the thread, by the requester",
    reply.body.asks.length === 1 && reply.body.asks[0].open === false && reply.body.asks[0].answeredByName === "Shashank Srivastava", j(reply.body.asks));
  mailD = await talkMail();
  const answeredMail = mailD.filter((n) => n.kind === "ask_answered");
  check("Judithmelanie is told it is answered, once, and nobody else is mailed about the reply",
    answeredMail.length === 1 && answeredMail[0].recipientEmail === JUDITHMELANIE && mailD.filter((n) => n.kind === "comment").length === 0
      && /rooms 3\.01/.test(answeredMail[0].body), j(mailD.map((n) => [n.kind, n.recipientEmail])));
  listD = (await call("GET", "/afes?mine=1")).body.find((x) => x.id === D);
  check("and it leaves the requester's Needs you", listD && listD.openAsk === null, j(listD && listD.openAsk));
  const auditD2 = (await call("GET", `/admin/audit?afeId=${D}`)).body.filter((e) => e.type === "comment");
  check("every line is in the audit trail, word for word, the ask marked, the answer naming what it answered, and none changed the state",
    auditD2.length === 4 && auditD2.every((e) => e.fromState === "fa_review" && e.toState === "fa_review")
      && auditD2.some((e) => e.payload.ask === true) && auditD2.some((e) => /rooms 3\.01/.test(e.payload.text) && (e.payload.answered || []).includes(askLine.id)),
    j(auditD2.map((e) => [e.payload.ask, e.payload.answered])));
  const histD = (await call("GET", `/afes/${D}/history`)).body.timeline.filter((e) => e.type === "comment");
  check("and in the history, where the ask reads as one", histD.length === 4 && histD.some((e) => / asked: Which six rooms/.test(e.text)), j(histD.map((e) => e.text)));
  // Nobody on the other side yet: an owner's ask on a draft has nobody to reach.
  const lonely = (await call("POST", "/afes")).body.afe.id;
  await patch(lonely, { "project.title": "Nobody to ask" });
  const lonelyPerms = (await call("GET", `/afes/${lonely}`)).body.permissions;
  const lonelyAsk = await call("POST", `/afes/${lonely}/comment`, { text: "Anyone?", ask: true });
  check("on a draft there is nobody to ask: no Ask offered, and one sent anyway is refused",
    lonelyPerms.canAsk === false && lonelyAsk.status === 422 && /nobody on the other side/i.test(lonelyAsk.body.error), j(lonelyAsk.body));
  await call("DELETE", `/afes/${lonely}`);

  console.log("14. reminders, a decline, a withdrawal");
  await actAsNone();
  const job = await call("POST", "/admin/jobs/reminders", { olderThanDays: 0 });
  check("the reminders job nudges whoever holds an AFE today", job.status === 200 && job.body.result.reminded >= 1 && job.body.result.details.some((d) => d.afeId === B && d.name === "Annette Sandhu"), j(job.body));
  check("the nudge is in the outbox", await outboxHas("reminder", "annette_sandhu@example.com", B));
  const job2 = await call("POST", "/admin/jobs/reminders");
  check("running it again at the normal cadence nudges nobody", job2.status === 200 && job2.body.result.reminded === 0, j(job2.body.result));
  check("the last run is on record", (await call("GET", "/admin/jobs")).body.jobs.some((x) => x.name === "reminders" && x.runs >= 2));

  await actAs("annette_sandhu@example.com");
  dec = await call("GET", `/afes/${B}/decision`);
  const noReason = await call("POST", `/afes/${B}/recipients/${dec.body.me.recipientId}/decline`, {});
  check("a decline needs a reason", noReason.status === 422);
  const decl = await call("POST", `/afes/${B}/recipients/${dec.body.me.recipientId}/decline`, { reason: "Not this fiscal year." });
  check("Daryl declines; the AFE is rejected and the envelope declined", decl.status === 200 && decl.body.decision.state === "rejected" && decl.body.decision.envelope.status === "declined", j(decl.body).slice(0, 200));
  await actAsNone();
  check("the requester is told", await outboxHas("declined", "udarsh_atwal@example.com", B));
  const dMail = (await call("GET", "/admin/outbox")).body.filter((n) => n.kind === "declined" && n.afeId === B);
  check("a decline is told the same way: one mail to the requester, the coordinator copied",
    dMail.length === 1 && dMail[0].recipientEmail === "udarsh_atwal@example.com" && dMail[0].cc.includes("aiden-mulqueeny_crilly@example.com"),
    j(dMail.map((n) => [n.recipientEmail, n.cc])));

  const C = (await call("POST", "/afes")).body.afe.id;
  const wd = await call("POST", `/afes/${C}/withdraw`, { reason: "raised by mistake" });
  check("a draft can be withdrawn", wd.status === 200 && wd.body.afe.state === "withdrawn");
  check("…once", (await call("POST", `/afes/${C}/withdraw`)).status === 409);

  // A paused round is still an envelope that is out (R148): withdrawing the AFE closes it at once.
  const E = await readyAfe("Warehouse Scanner Refresh APAC", 215000, "Scanner quote");
  await call("POST", `/afes/${E}/submit`);
  await actAs("aiden-mulqueeny_crilly@example.com");
  const sendE = await call("POST", `/afes/${E}/send`);
  const firstE = sendE.body.routing.recipients.filter((x) => x.role !== "cc" && x.order).sort((a, b) => a.order - b.order);
  await actAs(firstE[0].email);
  await call("POST", `/afes/${E}/recipients/${firstE[0].id}/sign`);
  await actAs(firstE[1].email);
  await call("POST", `/afes/${E}/recipients/${firstE[1].id}/send-back`, { reason: "Wrong site.", step: 2 });
  await actAsNone();
  const wdE = await call("POST", `/afes/${E}/withdraw`, { reason: "the project was cancelled" });
  check("withdrawing a paused AFE voids the envelope that was still out, and nobody is left holding it",
    wdE.status === 200 && wdE.body.afe.state === "withdrawn" && wdE.body.envelope.status === "voided"
      && wdE.body.routing.status === "voided" && !wdE.body.routing.recipients.some((x) => ["sent", "pending", "returned"].includes(x.status)),
    j(wdE.body.error || { env: wdE.body.envelope && wdE.body.envelope.status, rt: wdE.body.routing && wdE.body.routing.status }));
  const onDead = await call("POST", `/afes/${E}/comment`, { text: "anything" });
  check("a withdrawn AFE takes no more comments (R149)", onDead.status === 409, j(onDead.body));

  console.log("15. the surfaces around it");
  await actAs("aiden-mulqueeny_crilly@example.com");
  const q2 = await call("GET", "/coordinator/queue");
  check("the coordinator's queue aggregates by where things stand", q2.body.counts.withFa >= 1 && q2.body.groups.withFa.some((x) => x.id === A) && q2.body.counts.rejected >= 1, j(q2.body.counts));
  const F = await readyAfe("Coordinator Laptop Docks CORP_IT", 30000, "Docks quote");
  const ownF = (await call("GET", `/afes/${F}`)).body.permissions;
  const sendF = await call("POST", `/afes/${F}/send`);
  check("the assigned coordinator's own AFE he sends himself, from the draft (R157)",
    ownF.canSend === true && sendF.status === 200 && sendF.body.afe.state === "in_approval", j(sendF.body.error || ownF));
  await call("POST", `/afes/${F}/withdraw`, { reason: "only here to prove the send" });
  await actAsNone();

  // R159, end to end: above $1M technical accounting holds the envelope first, and its signer
  // opens on what they are there to check.
  const G = await readyAfe("Data Centre Cooling Upgrade APAC", 1200000, "Cooling quote");
  await call("POST", `/afes/${G}/submit`);
  await actAs("aiden-mulqueeny_crilly@example.com");
  const pvG = (await call("GET", `/afes/${G}/routing/preview`)).body;
  await call("POST", `/afes/${G}/routing/confirm-emails`, {
    confirmations: pvG.needsEmail.map((n) => ({ recipientId: n.recipientId, email: n.email || `${n.name.toLowerCase().replace(/\s+/g, "_")}@example.com` })),
  });
  const sendG = await call("POST", `/afes/${G}/send`);
  const firstG = sendG.body.routing && sendG.body.routing.recipients.find((x) => x.status === "sent");
  check("above $1M the technical accounting review holds the envelope first (R159)",
    sendG.status === 200 && firstG && firstG.role === "controllership" && firstG.order === 1, j(sendG.body.error || firstG));
  await ensureUser(firstG.email, firstG.name);
  await actAs(firstG.email);
  const accG = (await call("GET", `/afes/${G}/decision`)).body;
  check("…and the reviewer's page carries what they check: the classification, labour against the total, the quote",
    accG.accounting && accG.accounting.classification === "capex" && accG.accounting.because === "total"
      && accG.accounting.totalUsd === 1200000 && accG.accounting.documents.length === 1 && accG.me.isCurrent === true,
    j(accG.accounting));
  await actAs("annette_sandhu@example.com");
  check("an approver further down does not get the reviewer's panel", (await call("GET", `/afes/${G}/decision`)).body.accounting === null);
  await actAsNone();
  await call("POST", `/afes/${G}/withdraw`, { reason: "only here to prove the order" });
  const tick = await fetch(BASE + "/api/jobs/tick", { method: "POST" });
  check("the machine tick is off until JOBS_SECRET is configured", tick.status === 503 || tick.status === 401, String(tick.status));
  const mx = await call("GET", "/matrix/30145?tpc=215000");
  check("the matrix preview shows the deduped ladder", mx.body.chainPreview && mx.body.chainPreview.some((x) => x.level === "M1" && x.status === "skipped") && mx.body.chainPreview.some((x) => x.level === "A1" && x.status === "pending"), j(mx.body.chainPreview));
  const health = await (await fetch(BASE + "/health")).json();
  check("/health reports the DocuSign stand-in and the scheduler mode", health.integrations.docusign === "simulated" && ["manual", "tick", "interval"].includes(health.integrations.scheduler), j(health.integrations));
}

(async () => {
  offline();
  await online();
  console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nsmoke-routing could not run:", e.stack || e.message);
  console.error(`(is the server up on ${BASE}? start it with: npm start)`);
  process.exit(1);
});
