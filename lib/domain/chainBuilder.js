"use strict";
// The approval chain — who signs, in what order, and why — as a pure function of the AFE,
// its SAP matrix row, the org rules, the people registry and the name→mailbox directory.
//
// Plain objects in, a routing document out. Until the envelope is sent the result is
// derived on every read (the requester's chips, the coordinator's routing review); at send
// the route freezes it into the `routings` collection and it becomes SOX evidence that no
// later matrix change can touch (CLAUDE.md: snapshots, not references).
//
// The algorithm is docs/v0.4-blueprint.md §5.2, step for step:
//   1 basis  2 levels  3 pre-approvers  4 the ladder (M1 · charge-to · A-levels · additional
//   · controllership · override)  5 one person, one signature  6 segregation of duties
//   7 mailboxes  8 copies  9 explanation
// Signing order: the technical accounting review above $1M FIRST (R159), then the
// pre-approvers, the ladder and the overrides.
const {
  BANDS, LEVEL_TITLES, LEVEL_LADDER, PROJECT_APPROVAL_ROWS,
  CONTROLLERSHIP_THRESHOLD_USD, CONFIRMED_EMAIL_SOURCES,
} = require("./refData");
const afeRules = require("./afeRules");
const people = require("./people");
const fx = require("./fx");

const ROLE_LABEL = {
  pre_approver: "pre-approver", matrix: "matrix", additional: "additional signer",
  override: "division override", controllership: "Controllership Review", charge_to: "charge-to owner", cc: "copy",
};
const money = (n) => (n === null || n === undefined ? "—" : "$" + Math.round(n).toLocaleString("en-US"));
const levelIndex = (level) => LEVEL_LADDER.indexOf(level);
const bandRow = (level) => `band_${String(level).toLowerCase()}`;

/** The levels a total requires, in signing order — every band up to the one it falls in. */
function requiredLevels(totalUsd) {
  const seq = [];
  for (const band of BANDS) {
    for (const l of band.levels) if (!seq.includes(l)) seq.push(l);
    if (totalUsd <= band.maxUsd) break;
  }
  return seq;
}

function bandMaxFor(level) {
  const b = BANDS.find((x) => x.levels.includes(level));
  return b ? b.maxUsd : null;
}

/** Which matrix levels name this person on this cost centre, e.g. ["A3", "A5"]. */
function levelsHeldBy(matrixRow, person) {
  if (!matrixRow || !matrixRow.levels || !person) return [];
  return LEVEL_LADDER.filter((l) => {
    const cell = matrixRow.levels[l];
    return cell && cell.name && people.samePerson({ name: cell.name }, { name: person.name });
  });
}

/** The highest band ceiling among the levels held; null when unlimited or none. */
function authorityFor(levels) {
  let max = null;
  for (const l of levels) {
    const m = bandMaxFor(l);
    if (m === Infinity) return null;
    if (m !== null && (max === null || m > max)) max = m;
  }
  return max;
}

function ruleApplies(rule, afe, matrixRow, totalUsd) {
  const s = rule.scope || {};
  if (s.division && s.division !== afe.division) return false;
  if (s.costCenter && String(s.costCenter) !== String(afe.costCenter || "")) return false;
  if (s.ownerName) {
    const owner = matrixRow && matrixRow.levels && matrixRow.levels.M1 && matrixRow.levels.M1.name;
    if (!owner || people.normName(owner) !== people.normName(s.ownerName)) return false;
  }
  if (s.projectType && s.projectType !== afeRules.get(afe, "project.projectType")) return false;
  const c = rule.conditions || {};
  if (c.minTotalUsd != null && totalUsd < c.minTotalUsd) return false;
  if (c.maxTotalUsd != null && totalUsd > c.maxTotalUsd) return false;
  return true;
}

function scopeText(rule) {
  const s = rule.scope || {};
  if (s.costCenter) return `cost centre ${s.costCenter}`;
  if (s.ownerName) return `${s.ownerName}'s cost centres`;
  if (s.division) return `${s.division}`;
  if (s.projectType) return `${s.projectType} projects`;
  return "every AFE";
}

/**
 * Step 7 — a mailbox for a name, most trusted source first:
 *   typed/confirmed on this AFE → a login identity → a confirmed directory entry →
 *   the address an admin typed into the rule → a guessed directory entry → the
 *   First_Last pattern → unresolved.
 * Everything below "rule" must be confirmed by the coordinator before sending.
 */
function resolveEmail(rec, ctx) {
  const key = people.normName(rec.name);
  const edit = key && ctx.edits ? ctx.edits[key] : null;
  if (edit && edit.email) {
    rec.email = edit.email;
    rec.emailSource = edit.source === "typed" ? "typed" : "confirmed";
    return rec;
  }

  const user = (ctx.users || []).find((u) => u.active !== false && key &&
    (people.normName(u.displayName) === key || (u.matrixNames || []).some((n) => people.normName(n) === key)));
  if (user && user.email) { rec.email = user.email; rec.emailSource = "users"; return rec; }

  const dir = (ctx.directory || []).find((d) => key &&
    (people.normName(d.matrixName) === key || people.normName(d.displayName) === key));
  if (dir && dir.email && dir.source === "confirmed") { rec.email = dir.email; rec.emailSource = "directory"; return rec; }

  if (rec.email && rec.emailSource) return rec;                       // "rule" or "typed", given by the caller

  // an org rule naming the same person carries an address an admin typed — matrix
  // recipients inherit it (Vrishti Aguirre at A3 is the Vrishti Aguirre of the IT override)
  const rulePerson = (ctx.rulePersons || []).find((p) => key && people.normName(p.name) === key);
  if (rulePerson && rulePerson.email) { rec.email = rulePerson.email; rec.emailSource = "rule"; return rec; }

  if (dir && dir.email) { rec.email = dir.email; rec.emailSource = "guessed"; return rec; }
  if (dir && !dir.email) { rec.email = null; rec.emailSource = "unresolved"; return rec; } // someone already decided it is unknown

  const guess = people.guessEmail(rec.name);
  if (guess) { rec.email = guess; rec.emailSource = "guessed"; return rec; }
  rec.email = null;
  rec.emailSource = "unresolved";
  return rec;
}

/**
 * Build the routing for an AFE.
 * @param {object} input { afe, matrixRow, orgRules, users, directory, matrixBatchId, round, now }
 * @returns the routing document with status "preview" (see docs/v0.4-blueprint.md §4.3)
 */
function buildRouting(input) {
  const afe = input.afe || {};
  const matrixRow = input.matrixRow || null;
  const users = input.users || [];
  const directory = input.directory || [];
  const rules = (input.orgRules || []).filter((r) => r.active !== false && !r.retiredAt);
  const edits = afe.routingEdits || {};
  const emailCtx = { edits: edits.emails || {}, users, directory,
    rulePersons: rules.filter((r) => r.person && r.person.email).map((r) => r.person) };
  const suppressed = new Map((edits.suppressedRules || []).map((s) => [s.ruleId, s.reason || "no reason given"]));

  // 1 · basis and 2 · levels — the same engine the wizard's band chip uses
  const band = afeRules.bandFor(afe);
  const totalUsd = band.totalUsd;
  const laborUsd = afeRules.toNum(afeRules.get(afe, "money.laborUsd")) || 0;
  const cc = afe.costCenter ? String(afe.costCenter) : null;

  const notes = [], warnings = [], blockers = [], orgRuleIds = [];
  let seq = 0;
  const mk = (o) => Object.assign({
    id: "r" + (++seq), order: null, role: "matrix", level: null, printRow: "none", group: null,
    name: null, email: null, emailSource: null, authorityLimitUsd: null, sourceRuleId: null, why: "",
    status: "pending", signedAt: null, evidence: null, docusignRecipientId: null,
    notifiedAt: null, remindedAt: [], signsAs: null, standInFor: null,
  }, o);
  const applies = (r) => ruleApplies(r, afe, matrixRow, totalUsd);
  const note = (kind, text, recipientId) => notes.push({ recipientId: recipientId || null, kind, text });
  const suppressedNote = (r) => {
    if (!suppressed.has(r.id)) return false;
    note("rule_suppressed", `${r.person ? r.person.name : r.kind} is left out of this AFE by the coordinator — ${suppressed.get(r.id)}.`);
    return true;
  };

  if (!cc) blockers.push({ code: "no_cost_centre", message: "Pick the cost centre first — the chain comes from it." });
  else if (!matrixRow) blockers.push({ code: "no_matrix_row",
    message: `Cost centre ${cc} is not in the SAP approver matrix — no chain can be built until Fixed Assets confirms it.` });

  let paRows = 0;
  const projectApprovalsRow = () => { paRows += 1; return paRows <= PROJECT_APPROVAL_ROWS ? `project_approvals_${paRows}` : "none"; };

  // 3 · pre-approvers — printed in the Project Approvals rows, sign first (R42)
  const front = [];
  for (const r of rules.filter((x) => x.kind === "pre_approver" && applies(x))) {
    if (suppressedNote(r)) continue;
    orgRuleIds.push(r.id);
    front.push(mk({ role: "pre_approver", printRow: projectApprovalsRow(), group: r.group || null,
      name: r.person.name, email: r.person.email || null, emailSource: r.person.email ? "rule" : null, sourceRuleId: r.id,
      why: `signs first — ${r.group ? r.group + ", " : ""}pre-approver for ${scopeText(r)}` }));
  }
  for (const p of edits.preApprovers || []) {
    if (!p || !p.name) continue;
    front.push(mk({ role: "pre_approver", printRow: projectApprovalsRow(), group: p.group || null,
      name: p.name, email: p.email || null, emailSource: p.email ? "typed" : null,
      why: `signs first — added by the coordinator${p.why ? " (" + p.why + ")" : ""}` }));
  }

  // 4 · the ladder — M1, charge-to, the A-levels in band order
  const ladder = [];
  for (const level of band.levels) {
    if (level === "BOARD") {
      ladder.push(mk({ level, printRow: bandRow(level), name: "Board of Directors", status: "external",
        why: "over $20,000,000 — Board approval is evidenced outside DocuSign" }));
      blockers.push({ code: "board_approval", message: "Over $20,000,000 the Board approves — outside the pilot; Fixed Assets routes this by hand." });
      continue;
    }
    const cell = matrixRow && matrixRow.levels ? matrixRow.levels[level] : null;
    const name = cell && cell.name ? String(cell.name).trim() : "";
    if (!name) {
      ladder.push(mk({ level, printRow: bandRow(level), name: null, status: "blank",
        why: `${LEVEL_TITLES[level]} (${level}) is blank in the SAP matrix for cost centre ${cc}` }));
      continue;
    }
    ladder.push(mk({ level, printRow: bandRow(level), name,
      why: `${LEVEL_TITLES[level]} (${level}) for cost centre ${cc} — ${band.label}` }));
  }

  // The charge-to owner (R47) is built now so mailboxes, dedupe and SoD see them, but is
  // slotted into the ladder only after dedupe — "right after the cost-centre owner" means the
  // row the owner actually signs at, which is A1 rather than M1 when they are named at both.
  const floating = [];
  const chargeTo = afe.chargeTo;
  if (chargeTo && chargeTo.ownerName) {
    const where = chargeTo.business ? ` (${chargeTo.business}${chargeTo.costCenter ? `, cost centre ${chargeTo.costCenter}` : ""})` : "";
    floating.push(mk({ role: "charge_to", printRow: projectApprovalsRow(),
      group: chargeTo.business ? `Charge to: ${chargeTo.business}` : "Charge-to business owner",
      name: chargeTo.ownerName, email: chargeTo.ownerEmail || null, emailSource: chargeTo.ownerEmail ? "typed" : null,
      why: `owns the business being charged${where} — signs after the cost-centre owner as evidence for the cost transfer` }));
  }

  // additional signers the coordinator names — a second A2, a finance partner the matrix omits (R43)
  for (const a of edits.additional || []) {
    if (!a || !a.name) continue;
    const level = a.level && LEVEL_LADDER.includes(a.level) && a.level !== "BOARD" ? a.level : null;
    const rec = mk({ role: "additional", level, printRow: level ? bandRow(level) : projectApprovalsRow(), group: a.group || null,
      name: a.name, email: a.email || null, emailSource: a.email ? "typed" : null,
      why: level ? `added by the coordinator as a second ${level} (${LEVEL_TITLES[level]})${a.why ? " — " + a.why : ""}`
        : `added by the coordinator${a.why ? " — " + a.why : ""}` });
    let pos = ladder.length;
    if (level) {
      pos = 0;
      for (let i = 0; i < ladder.length; i++) if (ladder[i].level && levelIndex(ladder[i].level) <= levelIndex(level)) pos = i + 1;
    }
    ladder.splice(pos, 0, rec);
  }

  // controllership above $1M (R57), then the division override (R43)
  //
  // The review SIGNS FIRST (R159): "reviewed by accounting first before it goes to approvers"
  // (Aiden, Meeting #7). What it checks — the classification against the decision tree, the GL,
  // the SOW against the AFE — decides whether the AFE is right to approve at all, so a signer
  // who approves before it has been looked at approves something that may yet change. The form
  // prints it in its own block wherever it sits, and a routing already frozen keeps its order.
  const control = [];
  const tail = [];
  if (totalUsd > CONTROLLERSHIP_THRESHOLD_USD || laborUsd > CONTROLLERSHIP_THRESHOLD_USD) {
    const crs = rules.filter((x) => x.kind === "controllership" && applies(x));
    if (!crs.length) blockers.push({ code: "controllership_unconfigured",
      message: `Above ${money(CONTROLLERSHIP_THRESHOLD_USD)} the form requires a Controllership Review signer and none is configured for ${afe.division || "this division"} — ask Admin to add the controllership rule.` });
    for (const r of crs) {
      if (suppressedNote(r)) continue;
      orgRuleIds.push(r.id);
      // "EITHER Janine Barad or Gabriella Rafter" is ONE signature from a named pair, not two
      // signatures (Shashank, 2026-09-21). The rule carries the alternates, the coordinator's
      // choice for this AFE is `edits.ruleChoice[ruleId]`, and with no choice made the rule's
      // own person stands. Everyone who could have signed travels on the recipient, so the
      // approver screen and Fixed Assets can both see it was a choice and who else was offered.
      const pool = [r.person].concat(r.alternates || []).filter((x) => x && x.name);
      const asked = Number((edits.ruleChoice || {})[r.id]);
      const picked = Number.isInteger(asked) && asked >= 0 && asked < pool.length ? asked : 0;
      const who = pool[picked] || r.person;
      const others = pool.filter((_, i) => i !== picked).map((x) => x.name);
      control.push(mk({ role: "controllership", printRow: "controllership", group: r.group || "Controllership Review",
        name: who.name, email: who.email || null, emailSource: who.email ? "rule" : null, sourceRuleId: r.id,
        alternates: pool.length > 1 ? pool.map((x, i) => ({ index: i, name: x.name, chosen: i === picked })) : null,
        why: `capital project value above ${money(CONTROLLERSHIP_THRESHOLD_USD)} — ${r.group || "Controllership"}`
          + (others.length ? `, by ${who.name} or ${others.join(" or ")}` : "") }));
    }
  }

  const all = () => control.concat(front, ladder, floating, tail);
  const lastBandLevel = band.levels.filter((l) => l !== "BOARD").slice(-1)[0] || null;
  for (const r of rules.filter((x) => x.kind === "override" && applies(x))) {
    if (suppressedNote(r)) continue;
    orgRuleIds.push(r.id);
    const p = r.person;
    const held = levelsHeldBy(matrixRow, p);
    const authority = authorityFor(held);
    const already = all().find((x) => x.name && people.samePerson(x, p));
    if (already) {
      note("rule_noop", `${p.name} already signs at ${already.level || ROLE_LABEL[already.role]} — the ${scopeText(r)} rule adds nothing here.`, already.id);
      continue;
    }
    const above = authority !== null && totalUsd > authority;
    if (above && r.aboveLimit === "skip") {
      note("rule_skipped", `${p.name} is not added: ${money(totalUsd)} is above the ${money(authority)} authority they hold on this cost centre, and the rule skips above the limit.`);
      continue;
    }
    // print at the lowest level they hold above the band — the most modest true row
    const printLevel = held.find((l) => !lastBandLevel || levelIndex(l) > levelIndex(lastBandLevel)) || held[held.length - 1] || null;
    tail.push(mk({ role: "override", level: printLevel, printRow: printLevel ? bandRow(printLevel) : projectApprovalsRow(),
      group: r.group || null, name: p.name, email: p.email || null, emailSource: p.email ? "rule" : null,
      authorityLimitUsd: authority, sourceRuleId: r.id,
      why: above
        ? `signs for visibility — the ${scopeText(r)} rule sends every AFE to ${p.name}; ${money(totalUsd)} is above the ${money(authority)} they hold here`
        : `the ${scopeText(r)} rule sends every AFE to ${p.name}${held.length ? ` (holds ${held.join("/")} here, authority ${money(authority)})` : ""}` }));
  }

  // 7 · mailboxes — before dedupe and SoD, both of which compare people by mailbox first
  for (const rec of all()) if (rec.status === "pending" && rec.name) resolveEmail(rec, emailCtx);

  // 5 · one person, one signature (R45): the higher row keeps the signature
  const live = all().filter((x) => x.status === "pending" && x.name);
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    for (let j = i + 1; j < live.length && a.status === "pending"; j++) {
      const b = live[j];
      if (b.status !== "pending" || !people.samePerson(a, b)) continue;
      const ra = a.level ? levelIndex(a.level) : -1, rb = b.level ? levelIndex(b.level) : -1;
      const keep = rb > ra ? b : a, drop = keep === a ? b : a;
      const keepRow = keep.level || ROLE_LABEL[keep.role];
      drop.status = "skipped";
      drop.signsAs = keep.id;
      drop.why = `${keep.name} signs once, at ${keepRow}` + (drop.level ? ` — the ${drop.level} row prints "(signs at ${keepRow})"` : "");
      note("dedupe", `${keep.name} is named at ${drop.level || ROLE_LABEL[drop.role]} and ${keepRow} — signs once, at ${keepRow}.`, keep.id);
    }
  }

  // now the owner's real row is known, the charge-to owner goes right after it (Q46)
  for (const rec of floating.splice(0)) {
    const m1 = ladder.find((x) => x.level === "M1") || null;
    const anchor = m1 && m1.status === "skipped" ? (ladder.find((x) => x.id === m1.signsAs) || m1) : m1;
    ladder.splice(anchor ? ladder.indexOf(anchor) + 1 : 0, 0, rec);
  }

  // 6 · segregation of duties (R44): requester, preparer and coordinator never sign
  const parties = [];
  const addParty = (p, reason) => {
    if (!p || (!p.email && !p.name)) return;
    const u = users.find((x) => x.email && p.email && x.email.toLowerCase() === String(p.email).toLowerCase());
    parties.push({ name: p.name || (u && u.displayName) || null, email: p.email || null, reason, matrixNames: (u && u.matrixNames) || [] });
  };
  addParty(afe.requester, "requester");
  addParty(afe.preparer, "preparer");
  addParty(afe.coordinator, "coordinator");
  const partyFor = (rec) => parties.find((p) => people.samePerson(rec, p) ||
    (rec.name && p.matrixNames.some((n) => people.normName(n) === people.normName(rec.name))));

  const excluded = [];
  for (const rec of all()) {
    if (rec.status !== "pending" || !rec.name) continue;
    const party = partyFor(rec);
    if (!party) continue;
    rec.status = "sod_blocked";
    rec.why = `${rec.name} is the ${party.reason} of this AFE and cannot approve it (segregation of duties)`;
    const ex = { recipientId: rec.id, name: rec.name, email: rec.email, reason: party.reason, wouldHaveBeen: rec.level || rec.role, standIn: null };
    if (rec.role === "matrix" && rec.level && matrixRow && matrixRow.levels) {
      for (const lvl of LEVEL_LADDER.slice(levelIndex(rec.level) + 1)) {
        if (lvl === "BOARD") break;
        const cell = matrixRow.levels[lvl];
        const nm = cell && cell.name ? String(cell.name).trim() : "";
        if (!nm) continue;
        const cand = { name: nm };
        if (all().some((x) => x.status === "pending" && people.samePerson(x, cand))) continue;   // already signs
        if (partyFor(cand)) continue;                                                            // also a party
        const standIn = mk({ role: "matrix", level: lvl, printRow: bandRow(lvl), name: nm, standInFor: rec.id,
          why: `${LEVEL_TITLES[lvl]} (${lvl}) stands in — ${rec.name} (${rec.level}) is the ${party.reason} of this AFE, so the next level up signs instead` });
        resolveEmail(standIn, emailCtx);
        let pos = ladder.indexOf(rec) + 1;
        for (let i = 0; i < ladder.length; i++) if (ladder[i].level && levelIndex(ladder[i].level) <= levelIndex(lvl)) pos = i + 1;
        ladder.splice(pos, 0, standIn);
        ex.standIn = standIn.id;
        note("sod", `${rec.name} is excluded as the ${party.reason} — ${nm} (${lvl}) stands in.`, rec.id);
        break;
      }
      if (!ex.standIn) {
        blockers.push({ code: "sod_no_stand_in",
          message: `${rec.name} (${rec.level}) cannot approve their own AFE and no higher level in the matrix can stand in — Fixed Assets must route this by hand.` });
        note("sod", `${rec.name} is excluded as the ${party.reason}; no stand-in is available.`, rec.id);
      }
    } else {
      note("sod", `${rec.name} is excluded as the ${party.reason} of this AFE.`, rec.id);
    }
    excluded.push(ex);
  }

  // blank matrix cells block unless the coordinator has named a signer at that level
  for (const rec of ladder.filter((x) => x.status === "blank")) {
    const covered = all().some((x) => x.status === "pending" && x.level === rec.level && x.role === "additional");
    if (covered) { rec.why += " — covered by the signer the coordinator added at that level"; continue; }
    warnings.push(rec.why + ".");
    blockers.push({ code: "blank_matrix_cell",
      message: `${rec.level} is blank in the matrix for cost centre ${cc} — add a signer for that level or ask Fixed Assets to fix the matrix.` });
  }
  if (paRows > PROJECT_APPROVAL_ROWS) {
    warnings.push(`${paRows} people print in the Project Approvals block, which has ${PROJECT_APPROVAL_ROWS} rows — the rest sign without a printed row.`);
  }

  // 8 · copies (R58): the requester, Fixed Assets, whoever the coordinator adds
  const copies = [];
  const addCopy = (p, why, source) => {
    if (!p || !(p.email || p.name)) return;
    if (all().some((x) => x.status === "pending" && people.samePerson(x, p))) return;   // signers receive the set anyway
    if (copies.some((x) => people.samePerson(x, p))) return;
    const rec = mk({ role: "cc", printRow: "none", name: p.name || p.email, email: p.email || null, emailSource: p.email ? source : null, why });
    if (!rec.email) resolveEmail(rec, emailCtx);
    copies.push(rec);
  };
  addCopy(afe.requester, "raised the request — receives the completed set", "users");
  for (const r of rules.filter((x) => x.kind === "cc" && applies(x))) {
    if (suppressedNote(r)) continue;
    orgRuleIds.push(r.id);
    addCopy(r.person, `receives the completed set (${scopeText(r)} rule)`, "rule");
  }
  for (const c of afe.ccRecipients || []) addCopy(c, `receives a copy — added by the coordinator${c.why ? " (" + c.why + ")" : ""}`, "typed");

  // order: signers 1..n in chain order; every copy at n+1 (DocuSign carbon-copy semantics)
  const chain = all();
  let order = 0;
  for (const rec of chain) if (rec.status === "pending") rec.order = ++order;
  for (const rec of copies) rec.order = order + 1;
  if (order === 0 && cc && matrixRow) blockers.push({ code: "no_signers", message: "No one is left to sign this AFE." });

  const needsEmail = chain.concat(copies)
    .filter((x) => x.status === "pending" && !(x.email && CONFIRMED_EMAIL_SOURCES.includes(x.emailSource)))
    .map((x) => ({ recipientId: x.id, name: x.name, level: x.level, role: x.role, email: x.email, emailSource: x.emailSource }));
  if (needsEmail.length) {
    blockers.push({ code: "emails_unconfirmed",
      message: `${needsEmail.length} mailbox${needsEmail.length > 1 ? "es" : ""} to confirm before sending: ` +
        needsEmail.map((x) => x.name + (x.email ? ` (${x.email}?)` : " (no address)")).join(", ") + "." });
  }

  // 9 · one line per recipient, then the rule notes
  const explanation = chain.concat(copies).map((rec) => ({
    recipientId: rec.id, kind: rec.status,
    text: (rec.order && rec.status === "pending" ? rec.order + ". " : "") + (rec.name || "(blank)") +
      (rec.level ? " · " + rec.level : "") + (rec.role !== "matrix" ? " · " + ROLE_LABEL[rec.role] : "") + " — " + rec.why,
  })).concat(notes);

  return {
    status: "preview",
    afeId: afe.id || null,
    round: input.round || 1,
    basis: {
      totalUsd, laborUsd, basisKind: band.basisKind, band: band.label, levels: band.levels,
      matrixBatchId: input.matrixBatchId || null,
      matrixRow: matrixRow ? { costCenter: matrixRow.costCenter, description: matrixRow.description, plant: matrixRow.plant,
        status: matrixRow.status, levels: matrixRow.levels } : null,
      orgRuleIds,
      // The local currency and Global Finance's rate, frozen with the chain at send (R161): the
      // form reads THIS, so a signed page keeps printing the rate it was signed with. Null for a
      // US-dollar AFE, and absent on every routing sent before it existed — both read as USD.
      fx: fx.basisFx(afe),
    },
    recipients: chain.concat(copies),
    sod: { parties: parties.map((p) => ({ name: p.name, email: p.email, reason: p.reason })), excluded },
    explanation, warnings, blockers,
    needsEmail,
    emailsConfirmed: needsEmail.length === 0,
    canSend: blockers.length === 0,
    createdAt: input.now || null,
  };
}

/** The matrix endpoint's preview: the chain a total would need on a cost centre, no AFE yet. */
function previewChain(matrixRow, totalUsd) {
  const fake = { id: "preview", costCenter: matrixRow.costCenter, money: { capexUsd: totalUsd }, routingEdits: {} };
  return buildRouting({ afe: fake, matrixRow }).recipients
    .filter((r) => r.role !== "cc")
    .map((r) => ({ order: r.order, level: r.level, levelTitle: r.level ? LEVEL_TITLES[r.level] : null,
      approverName: r.name, status: r.status, printRow: r.printRow, signsAs: r.signsAs }));
}

module.exports = { buildRouting, previewChain, requiredLevels, levelsHeldBy, authorityFor, ruleApplies, resolveEmail, ROLE_LABEL };
