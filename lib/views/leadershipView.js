"use strict";
// What leadership asks, in the order they ask it: how much is sitting in Assets under
// Construction, why hasn't it capitalized, and is the process moving.
//
// The first two come from the AuC recon extract, which is the file that ties to the GL — the
// roll-forward here is the workbook's own identity (forward + additions − capitalized + other
// = ending), not a number we invented. The third comes from the AFEs the tool now carries,
// which is new: before this, nobody could say how long an approval actually takes.
//
// Read-only and derived. Every count is a control: the screens drill into the rows behind it.
const afeRules = require("../domain/afeRules");
const aucReview = require("../domain/aucReview");
const { latestBudgetByIo } = require("../domain/budget");
const { afeBrief } = require("./afeView");

const IN_FLIGHT = ["submitted", "in_approval", "on_hold"];
const days = (from, to) => (from && to ? Math.round((new Date(to).getTime() - new Date(from).getTime()) / 86400000) : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round(((s[m - 1] + s[m]) / 2) * 10) / 10;
};

async function leadershipView(repos, ctx, opts) {
  const o = opts || {};
  const period = o.period || aucReview.periodOf(new Date());
  const { map, batch } = await latestBudgetByIo(repos);
  const tracker = await repos.tracker.all();
  const review = aucReview.buildReview(tracker, map, { period });

  // ---- why hasn't it capitalized? one row per reason, biggest first --------------------------
  const reasons = Object.entries(review.reasonCounts)
    .map(([key, count]) => ({ key, label: review.reasonLabels[key] || key, count }))
    .sort((a, b) => b.count - a.count);
  const totalReasons = reasons.reduce((n, r) => n + r.count, 0) || 1;
  for (const r of reasons) r.share = Math.round((r.count / totalReasons) * 1000) / 10;

  // ---- the largest open balances, which is where the money actually is -----------------------
  const open = tracker.filter((t) => (t.openClosed || "Open").toLowerCase() === "open" && (t.aucStatus || "").toLowerCase() !== "capitalized");
  const biggest = open.slice().sort((a, b) => (b.endingBalance || 0) - (a.endingBalance || 0)).slice(0, 6).map((t) => {
    const line = review.lines.concat(review.excluded).find((l) => l.id === t.id) || null;
    return {
      id: t.id, ioNumber: t.ioNumber, description: t.ioDescription, division: t.division || "(unassigned)",
      balanceUsd: t.endingBalance || 0, ageingDays: line ? line.ageingDays : null,
      reason: line ? line.nonCapReasonLabel : null, goLive: line ? line.goLive || line.estimatedServiceDate : null,
      reviewerName: t.reviewerName || "",
    };
  });
  const openBalance = review.openBalanceUsd || 0;
  const bigShare = openBalance ? Math.round((biggest.slice(0, 3).reduce((n, b) => n + b.balanceUsd, 0) / openBalance) * 100) : 0;

  // ---- the process, from the AFEs the tool carries ---------------------------------------------
  const afes = await repos.afes.all((a) => a.state !== "draft");
  const inFlight = afes.filter((a) => IN_FLIGHT.includes(a.state));
  const approved = afes.filter((a) => a.approvedAt && a.sentAt);
  const cycle = approved.map((a) => days(a.sentAt, a.approvedAt)).filter((n) => n !== null);
  const issued = afes.filter((a) => a.fa && a.fa.issuedAt && a.approvedAt);
  const toIo = issued.map((a) => days(a.approvedAt, a.fa.issuedAt)).filter((n) => n !== null);
  const withFa = afes.filter((a) => ["approved", "fa_review"].includes(a.state));
  const routings = new Map();
  for (const a of inFlight) if (a.routingId) routings.set(a.id, await repos.routings.get(a.routingId));
  const waiting = inFlight.map((a) => {
    const rt = routings.get(a.id);
    const holder = rt ? (rt.recipients || []).find((r) => r.status === "sent") : null;
    return Object.assign(afeBrief(a), {
      waitingOn: holder ? { name: holder.name, level: holder.level || holder.role, since: holder.notifiedAt,
        days: days(holder.notifiedAt, new Date().toISOString()) } : null,
    });
  }).sort((a, b) => (b.waitingOn ? b.waitingOn.days || 0 : 0) - (a.waitingOn ? a.waitingOn.days || 0 : 0));

  const pipeline = {
    inFlightCount: inFlight.length,
    inFlightUsd: inFlight.reduce((n, a) => n + afeRules.total(a), 0),
    withFaCount: withFa.length,
    issuedThisYearCount: issued.length,
    issuedThisYearUsd: issued.reduce((n, a) => n + afeRules.total(a), 0),
    medianDaysToApprove: median(cycle),
    medianDaysToOrder: median(toIo),
    slowest: waiting.slice(0, 5),
  };

  // ---- this quarter's review, as a sentence leadership can repeat --------------------------------
  const packs = review.divisions.flatMap((d) => d.packs.map((p) => Object.assign({ division: d.division }, aucReview.packStatus(p, period))));
  const sent = packs.filter((p) => p.sent).length;
  const answered = packs.filter((p) => p.answered).length;

  return {
    period, asOf: review.asOf,
    extract: batch ? { batchId: batch.id, asOfDate: batch.asOfDate, importedAt: batch.importedAt } : null,
    rollforward: review.rollforward,
    openCount: review.openCount, openBalanceUsd: openBalance,
    reasons, biggest, bigShare,
    review: {
      lineCount: review.lines.length, excludedCount: review.excluded.length,
      divisions: review.divisions.map((d) => ({ division: d.division, lineCount: d.lineCount, balanceUsd: d.balanceUsd,
        packs: d.packs.length, sent: d.packs.filter((p) => aucReview.packStatus(p, period).sent).length,
        answered: d.packs.filter((p) => aucReview.packStatus(p, period).answered).length })),
      packCount: packs.length, sent, answered,
    },
    pipeline,
  };
}

module.exports = { leadershipView };
