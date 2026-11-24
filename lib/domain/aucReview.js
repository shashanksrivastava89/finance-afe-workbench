"use strict";
// The AUC quarterly review — the FA team's periodic control over open AUC balances,
// and the thing Judithmelanie named first when asked what to automate outside SAP:
// "you can cover the AUC confirmation and that AUC email can be sent automatically.
//  That is also challenging for us."
//
// Today it is manual: filter the AuC Recon tab, copy the rows into a per-division tab
// (the workbook still carries `AuC Review_2025.12_Facilities` as evidence), email that
// tab to a named reviewer, and paste replies back as dated comments.
//
// The population rules are NOT ours — they are printed in the workbook's own header:
//   Included in the AuC Quarterly review
//   1) AuC spent is equal or greater than 80% of budgeted amount
//   2) Is aged 6 months or older from the IO issue date
//   3) Greater than $100K
//   4) Excluded - AuC assets/projects previously confirmed with future go-live dates
//      beyond the current reviewed period.
// Rules 1-3 are `flags.computeFlags().reasons`. Rule 4 needs more care than
// `flags.firmDateOnFile` gives us on legacy data — see goLiveBeyondPeriod below.
const { computeFlags } = require("./flags");
const { AUC_ACTIONS, CAPITALIZATION_TOLERANCE } = require("./refData");
const rbac = require("./rbac");
const people = require("./people");

const REASON_LABELS = {
  budget_exhausted: "Budget exhausted — supplemental AFE needed",
  awaiting_isd: "Awaiting in-service date",
  awaiting_invoice: "Spend complete — awaiting final invoice / capitalization",
  on_hold: "Project on hold",
  future_go_live: "Go-live date on file beyond this period",
  no_reviewer_response: "Chased, no reply from the reviewer",
  in_progress: "In progress — within budget and age",
};

const parseDate = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Quarter label for a date — the review runs quarterly, so this is how a period is named.
function periodOf(date) {
  const d = date || new Date();
  return "Q" + (Math.floor(d.getUTCMonth() / 3) + 1) + " " + d.getUTCFullYear();
}
function periodEnd(label) {
  const m = /^Q([1-4])\s+(\d{4})$/.exec(String(label || "").trim());
  if (!m) return null;
  return new Date(Date.UTC(Number(m[2]), Number(m[1]) * 3, 0, 23, 59, 59));
}

/**
 * Rule 4 — "previously confirmed with future go-live dates beyond the current reviewed
 * period." `flags.firmDateOnFile` only counts an explicit `firm_commitment`, which the
 * legacy import never produces: the recon file's Estimated Service Date column is where
 * the FA writes the date the owner gave them, without recording that provenance. So for
 * the review we accept the latest date on file when it falls beyond the period end, and
 * report how confident that is, rather than excluding nothing at all.
 */
function goLiveBeyondPeriod(item, asOf) {
  const hist = item.esdHistory || [];
  let latest = null, kind = null;
  for (const h of hist) {
    const d = parseDate(h.estimatedServiceDate);
    if (d && (!latest || d > latest)) { latest = d; kind = h.kind; }
  }
  if (!latest || latest <= asOf) return null;
  return { date: latest.toISOString().slice(0, 10), confirmed: kind === "firm_commitment" };
}

const latestEsd = (item) => {
  const hist = item.esdHistory || [];
  for (let i = hist.length - 1; i >= 0; i -= 1) {
    const d = parseDate(hist[i].estimatedServiceDate);
    if (d) return d;
  }
  return null;
};

/**
 * Why has this line not been capitalized? This is what leadership asks for —
 * Judithmelanie: "They just want to see why there is no capitalization. What is the reason
 * behind no capitalization?" Deterministic, first match wins, so the answer is always
 * explainable back to the data rather than being a model's opinion.
 */
function nonCapitalizationReason(item, flags, asOf) {
  const text = ((item.comments || []).map((c) => c.body).join(" ") + " " +
    (item.esdHistory || []).map((h) => h.estimatedServiceDate + " " + (h.note || "")).join(" ")).toLowerCase();

  if (/on hold|onhold/.test(text)) return "on_hold";
  if (flags.consumedPct !== null && flags.consumedPct >= CAPITALIZATION_TOLERANCE) return "budget_exhausted";
  if (goLiveBeyondPeriod(item, asOf)) return "future_go_live";

  const esd = latestEsd(item);
  const esdPassed = esd && esd <= asOf;

  // Sent for confirmation but nothing came back — the failure mode the recon file's own
  // comment log records over and over ("AUC File Sent for Quarterly Control but no
  // comment received on this AFE").
  const sent = (item.comments || []).some((c) => /sent for|file sent|quarterly control/i.test(c.body || ""));
  const replied = (item.comments || []).some((c) => c.kind === "reviewer_note");
  if (sent && !replied) return "no_reviewer_response";

  if (esdPassed && flags.consumedPct !== null && flags.consumedPct >= 0.8) return "awaiting_invoice";
  if (!esd || esdPassed) return "awaiting_isd";
  return "in_progress";
}

/** What this line's inclusion actually asks the reviewer for. */
function askFor(reasons) {
  // Aging drives the in-service-date question; >$100K adds priority, not a question of
  // its own; 80% drives the monthly chase.
  if (reasons.indexOf("aged180") >= 0) return AUC_ACTIONS.aged180.ask;
  if (reasons.indexOf("consumed80") >= 0) return AUC_ACTIONS.consumed80.ask;
  if (reasons.indexOf("over100k") >= 0) return AUC_ACTIONS.over100k.ask;
  return "";
}

/**
 * Build the review population for a period.
 * items: tracker rows · budgetByIo: Map(ioNumber -> latest budget row)
 */
function buildReview(items, budgetByIo, opts) {
  opts = opts || {};
  const period = opts.period || periodOf(new Date());
  const asOf = periodEnd(period) || new Date();

  const lines = [];
  const excluded = [];
  const reasonCounts = {};
  let openCount = 0, openBalance = 0;

  // The recon file's Summary tab is a roll-forward that must tie to the GL:
  //   Balance forward + Additions - Capitalized (AuC->FA) - Other = Ending balance.
  // "We are matching the figure from SAP to Excel" - this is the reconciliation the
  // whole workbook exists for, so the screen leads with it.
  const roll = { balanceForward: 0, additions: 0, capitalized: 0, other: 0, endingBalance: 0, commitment: 0 };
  for (const item of items) {
    roll.balanceForward += item.balanceForward || 0;
    roll.additions += item.additionsConsumed || 0;
    roll.capitalized += item.transferToAsset || 0;
    roll.other += item.otherExpense || 0;
    roll.endingBalance += item.endingBalance || 0;
    roll.commitment += item.commitment || 0;
  }
  // The file posts AuC->FA transfers as negatives (they reduce the balance); the
  // roll-forward reads better as a positive "capitalized" magnitude. Identity kept:
  // fwd + additions - capitalized + other = ending.
  roll.capitalized = -roll.capitalized;
  for (const k of Object.keys(roll)) roll[k] = Math.round(roll[k] * 100) / 100;

  for (const item of items) {
    const isOpen = (item.openClosed || "Open").toLowerCase() === "open"
      && (item.aucStatus || "").toLowerCase() !== "capitalized";
    if (!isOpen) continue;
    openCount += 1;
    openBalance += item.endingBalance || 0;

    const flags = computeFlags(item, budgetByIo.get(item.ioNumber) || null, item.esdHistory, asOf);
    const reason = nonCapitalizationReason(item, flags, asOf);
    reasonCounts[reason] = (reasonCounts[reason] || 0) + 1;

    const row = {
      id: item.id,
      ioNumber: item.ioNumber,
      ioDescription: item.ioDescription,
      division: item.division || "(unassigned)",
      costCenter: item.costCenter,
      aucNumber: item.aucNumber,
      contactPersonName: item.contactPersonName || "",
      reviewerName: (item.reviewerName || "").trim(),
      endingBalance: item.endingBalance || 0,
      openAfeAmount: item.openAfeAmount || 0,
      consumedPct: flags.consumedPct,
      ageingDays: flags.ageingDays,
      issueDate: item.issueDate,
      estimatedServiceDate: latestEsd(item) ? latestEsd(item).toISOString().slice(0, 10) : null,
      includeReasons: flags.reasons,
      nonCapReason: reason,
      nonCapReasonLabel: REASON_LABELS[reason],
      ask: askFor(flags.reasons),
      lastComment: (item.comments || []).length ? item.comments[item.comments.length - 1].body : "",
    };

    // Rules 1-3 include; rule 4 excludes. An excluded line is still reported, so the
    // control can show what it deliberately left out rather than silently dropping it.
    if (!flags.reasons.length) continue;
    const future = goLiveBeyondPeriod(item, asOf);
    if (future) {
      row.goLive = future.date;
      row.goLiveConfirmed = future.confirmed;
      excluded.push(row);
      continue;
    }
    lines.push(row);
  }

  return {
    period, asOf: asOf.toISOString().slice(0, 10),
    rollforward: roll,
    openCount, openBalanceUsd: Math.round(openBalance * 100) / 100,
    lines, excluded,
    reasonCounts,
    reasonLabels: REASON_LABELS,
    divisions: groupByDivision(lines),
  };
}

/** Division → reviewer → lines. This is exactly how the per-division tabs are cut today. */
function groupByDivision(lines) {
  const byDiv = new Map();
  for (const l of lines) {
    if (!byDiv.has(l.division)) byDiv.set(l.division, new Map());
    const byRev = byDiv.get(l.division);
    const key = l.reviewerName || "(no responsible reviewer named)";
    if (!byRev.has(key)) byRev.set(key, []);
    byRev.get(key).push(l);
  }
  return [...byDiv.entries()].map(([division, byRev]) => ({
    division,
    lineCount: [...byRev.values()].reduce((n, a) => n + a.length, 0),
    balanceUsd: Math.round([...byRev.values()].flat().reduce((n, l) => n + l.endingBalance, 0) * 100) / 100,
    packs: [...byRev.entries()].map(([reviewerName, rows]) => ({
      reviewerName,
      // The column often carries a cc list ("Shakira Cashman, cc Denise Karnik-Pennington");
      // we keep the string intact rather than guessing how to split a person from a cc.
      named: reviewerName !== "(no responsible reviewer named)",
      lineCount: rows.length,
      balanceUsd: Math.round(rows.reduce((n, l) => n + l.endingBalance, 0) * 100) / 100,
      lines: rows,
    })).sort((a, b) => b.lineCount - a.lineCount),
  })).sort((a, b) => b.lineCount - a.lineCount);
}

const money = (n) => "$" + Math.round(n || 0).toLocaleString("en-US");

/**
 * The confirmation pack a reviewer receives. Deterministic — no model — so it opens
 * instantly and reads the same every quarter, which is what a recurring control wants.
 * `to` is deliberately blank: the recon file holds names, not mailboxes (PRD Q26).
 */
function buildPack(division, pack, period) {
  const lines = pack.lines;
  const body = [];
  body.push("Hi" + (pack.named ? " " + pack.reviewerName.split(/[,(]/)[0].trim() : "") + ",");
  body.push("");
  body.push("We are running the " + period + " AUC review for " + division + ". The " +
    lines.length + " project" + (lines.length === 1 ? "" : "s") + " below " +
    (lines.length === 1 ? "is" : "are") + " still sitting in Assets Under Construction, " +
    "totalling " + money(pack.balanceUsd) + ".");
  body.push("");
  body.push("For each one, could you confirm the in-service (put-to-use) date, and whether any");
  body.push("further cost is expected? If a project is complete, say so and we will capitalize it.");
  body.push("");
  lines.forEach((l) => {
    body.push("IO " + l.ioNumber + " — " + (l.ioDescription || "(no description)"));
    body.push("   Balance " + money(l.endingBalance) +
      (l.consumedPct !== null ? " · " + Math.round(l.consumedPct * 100) + "% of budget consumed" : "") +
      (l.ageingDays !== null ? " · " + l.ageingDays + " days old" : ""));
    body.push("   Currently: " + l.nonCapReasonLabel +
      (l.estimatedServiceDate ? " (last estimate " + l.estimatedServiceDate + ")" : ""));
    body.push("   " + l.ask);
    body.push("");
  });
  body.push("Thanks,");
  body.push("Fixed Assets · Acme FSSC");

  return {
    to: "",
    cc: "",
    subj: period + " AUC review — " + division + " · " + lines.length +
      " open project" + (lines.length === 1 ? "" : "s") + " (" + money(pack.balanceUsd) + ")",
    body: body.join("\n"),
    division,
    reviewerName: pack.reviewerName,
    ioNumbers: lines.map((l) => l.ioNumber),
  };
}

/** The pack's line list as CSV, so the reviewer gets the same table they get today. */
function packCsv(pack, period) {
  const head = ["IO", "Description", "Cost Center", "AUC", "Balance USD", "Consumed %",
    "Ageing days", "Issue date", "Estimated service date", "Why not capitalized", "Confirmed in-service date", "Comment"];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const rows = pack.lines.map((l) => [l.ioNumber, l.ioDescription, l.costCenter, l.aucNumber,
    l.endingBalance, l.consumedPct === null ? "" : Math.round(l.consumedPct * 100),
    l.ageingDays, l.issueDate, l.estimatedServiceDate, l.nonCapReasonLabel, "", ""].map(esc).join(","));
  return [("# " + period + " AUC review · " + pack.division + " · " + pack.reviewerName),
    head.join(","), ...rows].join("\n");
}

/**
 * Has this reviewer's pack gone out this period, and have they answered?
 *
 * Derived, not stored: sending a pack writes a dated preparer note on every line it covered
 * (the same entry the recon workbook keeps by hand), and an answer is a reviewer note or a new
 * estimated service date that arrives afterwards. So the screen can say "2 of 4 answered"
 * without a second copy of the truth to keep in step.
 */
function packStatus(pack, period) {
  const lines = pack.lines || [];
  let sentAt = null, answeredAt = null;
  for (const line of lines) {
    for (const c of line.comments || []) {
      if (c.kind === "preparer_note" && String(c.body || "").includes(period) && /review pack sent/i.test(c.body)) {
        if (!sentAt || c.createdAt > sentAt) sentAt = c.createdAt;
      }
    }
  }
  // An answer only counts against the pack that asked for it. Without a send this period, a
  // reviewer note from an earlier quarter is history, not a reply — the legacy import is full
  // of them, and counting those would report a control as done that has not run.
  if (sentAt) {
    for (const line of lines) {
      for (const c of line.comments || []) {
        if (c.kind !== "reviewer_note" || c.createdAt < sentAt) continue;
        if (!answeredAt || c.createdAt > answeredAt) answeredAt = c.createdAt;
      }
      for (const e of line.esdHistory || []) {
        const at = e.enteredAt || null;
        if (!at || at < sentAt || e.kind === "initial") continue;
        if (!answeredAt || at > answeredAt) answeredAt = at;
      }
    }
  }
  return { reviewerName: pack.reviewerName, lineCount: pack.lineCount, balanceUsd: pack.balanceUsd,
    sent: Boolean(sentAt), sentAt, answered: Boolean(answeredAt), answeredAt,
    waitingDays: sentAt && !answeredAt ? Math.floor((Date.now() - new Date(sentAt).getTime()) / 86400000) : null };
}

/**
 * Who may write what a reviewer answered against a recon line: Fixed Assets, who run the review
 * and key the replies that come back by mail, or the reviewer the line names, answering for
 * themselves. Nobody else — a committed in-service date takes the line OUT of the review
 * population (the workbook's fourth rule), so letting anyone signed in write one was letting
 * anyone remove a line from a control. Reviewers are named, never mailed, in the recon, so the
 * match is the name against the person's own name and the matrix spellings they carry.
 */
function mayAnswerFor(ctx, line) {
  if (rbac.can(ctx, "aucreview.run")) return true;
  const name = line && String(line.reviewerName || "").trim();
  if (!name || !ctx || !ctx.user) return false;
  if (people.normName(ctx.userRow && ctx.userRow.displayName) === people.normName(name)) return true;
  return people.userMatches(ctx, { name });
}

module.exports = { buildReview, buildPack, packCsv, packStatus, periodOf, periodEnd, REASON_LABELS, nonCapitalizationReason, mayAnswerFor };
