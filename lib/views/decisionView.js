"use strict";
// What an approver sees before signing (R55): is it budgeted, from which pot and year,
// when it starts, how much of it the quotes cover, why it is needed, who else signs and
// where they are in the chain — plus the note the coordinator wrote. This is the same
// information Aiden types into the DocuSign message today, laid out once, server-side.
const afeRules = require("../domain/afeRules");
const cloudTree = require("../domain/cloudTree");
const refData = require("../domain/refData");
const people = require("../domain/people");
const conversation = require("../domain/conversation");
const reminders = require("../domain/reminders");
const { afeView, afeBrief } = require("./afeView");

async function decisionView(repos, afe, ctx) {
  const v = await afeView(repos, afe, ctx, { full: true });
  const routing = v.routing;
  const envelope = v.envelope;
  const now = new Date().toISOString();
  const recipients = (routing && routing.recipients) || [];
  // A person named at two levels has two rows; "me" is the one that matters right now —
  // the row holding the envelope, else the one still to sign, else the one already signed.
  // `returned` is the row a send-back paused (R148): it is theirs again the moment it comes back.
  const RANK = { sent: 0, returned: 1, pending: 2, signed: 3, declined: 4, sod_blocked: 5, superseded: 6, skipped: 7 };
  const me = recipients
    .filter((r) => r.role !== "cc" && people.userMatches(ctx, r))
    .sort((a, b) => (RANK[a.status] === undefined ? 9 : RANK[a.status]) - (RANK[b.status] === undefined ? 9 : RANK[b.status]))[0] || null;
  const current = routing && routing.status === "active" ? recipients.find((r) => r.status === "sent") || null : null;
  const total = afeRules.total(afe);
  const quotes = afeRules.quotes(afe);
  const quoteTotal = afeRules.quoteTotal(afe);
  const schedule = afe.schedule || {};
  const start = schedule.startDate ? new Date(schedule.startDate) : null;

  const row = (r) => ({
    id: r.id, order: r.order, name: r.name, level: r.level, role: r.role, group: r.group, printRow: r.printRow,
    status: r.status, signedAt: r.signedAt, since: r.notifiedAt, why: r.why,
    isYou: Boolean(me) && me.id === r.id, isCurrent: Boolean(current) && current.id === r.id,
    signsAs: r.signsAs, standInFor: r.standInFor,
  });

  return {
    afe: Object.assign(afeBrief(afe), {
      location: afe.location, plant: afe.plant, companyCode: afe.companyCode,
      description: afe.project && afe.project.description,
    }),
    state: afe.state,
    hold: afe.hold || null,
    returnedTo: afe.returnedTo || null,
    money: {
      currency: "USD", totalUsd: total,
      classification: afe.money && afe.money.classification,
      capexUsd: afeRules.toNum(afe.money && afe.money.capexUsd), cloudCapexUsd: afeRules.toNum(afe.money && afe.money.cloudCapexUsd),
      opexUsd: afeRules.toNum(afe.money && afe.money.opexUsd), laborUsd: afeRules.toNum(afe.money && afe.money.laborUsd),
      lines: (afe.money && afe.money.lines) || [],
    },
    band: { label: v.band.label, levels: v.band.levels, basisKind: v.band.basisKind, basisUsd: v.band.totalUsd },
    budget: {
      budgeted: afe.budget && afe.budget.budgeted,
      unbudgetedReason: (afe.budget && afe.budget.unbudgetedReason) || "",
      budgetCategory: afe.budget && afe.budget.budgetCategory,
      afeCategory: afe.budget && afe.budget.afeCategory,
      // A budget that is not one of the pots, in the requester's words (R167).
      otherBudget: afe.budget && (afe.budget.potId === afeRules.OTHER_POT || !afe.budget.potId)
        ? String(afe.budget.otherBudget || "").trim() : "",
      pot: v.pot ? {
        id: v.pot.id, budgetCategory: v.pot.budgetCategory, region: v.pot.region, fiscalYear: v.pot.fiscalYear,
        amountUsd: v.pot.amountUsd, committedUsd: v.pot.committedUsd, remainingUsd: v.pot.remainingUsd,
        thisAfeUsd: v.pot.thisAfeUsd, remainingAfterThisUsd: v.pot.remainingAfterThisUsd,
      } : null,
    },
    timing: {
      startDate: schedule.startDate || null, finishDate: schedule.finishDate || null, fiscalYear: schedule.fiscalYear || null,
      daysToStart: start ? Math.round((start.getTime() - Date.now()) / 86400000) : null,
      startInPast: v.validation.warns.some((w) => w.rule === "start_not_past"),
      multiYear: v.validation.warns.some((w) => w.rule === "single_year_span"),
    },
    quote: {
      count: quotes.length,
      vendors: Array.from(new Set(quotes.map((q) => q.vendor).filter(Boolean))),
      totalUsd: quoteTotal,
      coveragePct: total ? Math.round((quoteTotal / total) * 100) : null,
      // What the quotes leave out, and what the requester said covers it. Two approvers asked
      // "why the mismatch in quotes" on one afternoon (15 Oct): the screen gave them a percentage
      // and nothing else. The note is the flag note on quote_covers_estimate, which may be written
      // whether or not the warning is raised — below the minimum it also prints as an exception.
      afeTotalUsd: total,
      gapUsd: total ? Math.round((total - quoteTotal) * 100) / 100 : null,
      note: (() => { const n = afeRules.notesByRule(afe).quote_covers_estimate; return n ? { text: n.note, byName: n.byName || n.by || null } : null; })(),
      waived: (afe.waivers || []).some((w) => w.ruleId === "quote_covers_estimate"),
      // Where each total came from (R170): typed by whom, or read off the quote at what confidence
      // and confirmed by whom. A total nobody confirmed is not a total, so there is no third case.
      provenance: quotes.map((q) => {
        const p = (q.provenance || {}).amountUsd;
        if (!p) return null;
        // The figure itself, not just who wrote it down ("total typed by Aiden" said nothing).
        const amount = Number.isFinite(Number(q.amountUsd)) && q.amountUsd !== null ? "$" + Number(q.amountUsd).toLocaleString("en-US") : "total";
        return `${q.vendor || q.filename}: ${amount} ${p.source === "read"
          ? `read off the quote at ${Math.round((p.confidence || 0) * 100)}%, confirmed by ${p.byName}` : `typed by ${p.byName}`}`;
      }).filter(Boolean).join(" · ") || null,
    },
    why: {
      description: afe.project && afe.project.description, justification: afe.project && afe.project.justification,
      alternatives: afe.project && afe.project.alternatives, scope: afe.project && afe.project.scope,
      ehsImpact: afe.project && afe.project.ehsImpact, projectType: afe.project && afe.project.projectType,
    },
    cloud: v.cloud,
    // What the technical accounting review is there to check (R159), for the review's own signer.
    accounting: me && me.role === "controllership" ? accountingFacts(afe) : null,
    warnings: v.validation.warns,
    // A check that did not pass, and the reason it was accepted anyway (R69). Read from the
    // FROZEN routing where there is one — these are the words the requester wrote before this
    // went out, and they are what was printed on the page this approver is being asked to sign.
    exceptions: (v.routing && v.routing.basis && v.routing.basis.exceptions)
      || v.validation.exceptions || [],
    // A round a send-back paused, and one that came back (R148). The next signer is told what
    // changed and whose signatures stood, because the document they are about to sign is the one
    // first sent: the fix is on the AFE, not in the file.
    round: roundStory(routing, afe, ctx),
    chain: recipients.filter((r) => r.role !== "cc").map(row),
    copies: recipients.filter((r) => r.role === "cc").map(row),
    sod: routing ? routing.sod : null,
    approverNote: afe.approverNote || "",
    thread: afe.thread || [],
    asks: conversation.asks(afe.thread),
    documents: (afe.documents || []).map((d) => ({
      attachmentId: d.attachmentId, filename: d.filename, role: d.role, vendor: d.vendor || null, amountUsd: d.amountUsd,
      url: `/api/afes/${afe.id}/documents/${d.attachmentId}/raw`,
    })),
    envelope: envelope ? {
      provider: envelope.provider, simulated: envelope.provider === "simulated", status: envelope.status,
      envelopeId: envelope.envelopeId, sentAt: envelope.sentAt, completedAt: envelope.completedAt,
      emailSubject: envelope.emailSubject,
    } : null,
    me: me ? {
      recipientId: me.id, status: me.status, level: me.level, role: me.role, isCurrent: Boolean(current) && current.id === me.id,
      waitingDays: current && current.id === me.id ? reminders.daysWaiting(current, now) : null,
      canSign: v.permissions.canSign, canQuestion: v.permissions.canQuestion,
      canSendBack: v.permissions.canSendBack, canDecline: v.permissions.canDecline,
    } : null,
    permissions: v.permissions,
  };
}

/** The four Cloud CapEx questions in as few words as the panel needs; the full text is on the form. */
const TREE_SHORT = {
  q1Software: "Software", q2ExternallyHosted: "Hosted outside Acme",
  q3Subscription: "Perpetual or subscription", q4CanChangeHost: "Host can move at no significant cost",
};

/**
 * What technical accounting checks above $1M (R159): "the scope against the decision tree, the
 * right GL, the SOW matching the AFE" (Aiden, Meeting #7, 00:21:47). Every fact was already on
 * the AFE; the reviewer had to assemble them from four places, and one of them — whether the
 * tree the requester answered actually lands on the classification the AFE carries — was not
 * said anywhere at all.
 */
function accountingFacts(afe) {
  const m = afe.money || {};
  const totalUsd = afeRules.total(afe);
  const laborUsd = afeRules.toNum(m.laborUsd) || 0;
  const limit = refData.CONTROLLERSHIP_THRESHOLD_USD;
  const tree = cloudTree.evaluate(afe.cloud || {});
  return {
    classification: m.classification || null,
    tree: tree.path.length ? {
      outcome: tree.outcome, label: tree.label || null, classification: tree.classification || null,
      complete: Boolean(tree.outcome),
      // A tree that lands on regular CapEx under an AFE that says Cloud CapEx — or the other way
      // round — is the one thing on this page that is certainly wrong.
      agrees: !tree.outcome || !tree.classification || tree.classification === m.classification,
      steps: tree.path.map((s) => ({ id: s.id, label: TREE_SHORT[s.id] || s.id, answer: s.answer })),
    } : null,
    scope: (afe.project && afe.project.scope) || "",
    totalUsd, laborUsd, thresholdUsd: limit,
    because: laborUsd > limit ? (totalUsd > limit ? "both" : "labour") : "total",
    documents: (afe.documents || []).filter((d) => refData.QUOTE_ROLES.includes(d.role)).map((d) => ({
      attachmentId: d.attachmentId, filename: d.filename, role: d.role, vendor: d.vendor || null, amountUsd: d.amountUsd,
      url: `/api/afes/${afe.id}/documents/${d.attachmentId}/raw`,
    })),
  };
}

/** The pause this round is in, or the one it came back from, in words the screen can use. */
function roundStory(routing, afe, ctx) {
  const pauses = (routing && routing.pauses) || [];
  const last = pauses[pauses.length - 1];
  if (!last) return null;
  if (!last.resumedAt && !last.closedAt && afe.state === "returned") {
    return { paused: { at: last.at, byName: last.byName, reason: last.reason }, resumed: null };
  }
  if (last.resumedAt && ["in_approval", "on_hold"].includes(afe.state)) {
    // Whose signatures stood, by name: they signed before it was sent back.
    const stood = ((routing && routing.recipients) || [])
      .filter((r) => r.role !== "cc" && r.status === "signed" && r.signedAt && String(r.signedAt) <= String(last.at))
      .map((r) => r.name);
    return { paused: null, resumed: { at: last.resumedAt, byName: last.resumedByName, sentBackBy: last.byName,
      sentBackByYou: Boolean(ctx) && people.userMatches(ctx, { email: last.byEmail, name: last.byName }),
      reason: last.reason, changed: last.changed || [], kept: last.kept || 0, stood } };
  }
  return null;
}

module.exports = { decisionView };
