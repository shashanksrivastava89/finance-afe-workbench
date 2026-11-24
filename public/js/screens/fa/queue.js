// /fa — Fixed Assets' queue. Four buckets; a row's red chip is a red flag, green says the
// signatures were verified against the chain frozen at send. Nothing on this screen is typed.
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { icon } from "../../core/icons.js";
import { money, plural, since, stateLabel, date } from "../../core/format.js";
import { bucket, tag, avatar, emptyState, tip, when, moneyCell } from "../../components/parts.js";
import { showError } from "../../core/ui.js";
import { faNav } from "./common.js";

// "To close" is work — a second person still has to close it — and "Closed" is not, so they are
// two buckets. They were one, titled "Capitalized", holding closed AFEs under a lock (2026-10-16).
const BUCKETS = [
  { key: "toCheck", title: "To check", tone: "yellow", icon: "search" },
  { key: "issued", title: "Issued", tone: "green", icon: "box" },
  { key: "toClose", title: "To close", tone: "yellow", icon: "shield" },
  { key: "sentBack", title: "Sent back", tone: "red", icon: "back" },
  { key: "closed", title: "Closed", tone: "grey", icon: "lock" },
];
/** The server's "done" group, split into what still needs a second person and what does not. */
function split(q) {
  const done = (q.groups && q.groups.done) || [];
  q.groups.toClose = done.filter((a) => a.state === "capitalized");
  q.groups.closed = done.filter((a) => a.state !== "capitalized");
  return q;
}
const ui = uiFor("fa");
let Q = null;
let root = null;

function detail(key, list) {
  if (!list.length) return { toCheck: "Nothing is waiting for your judgment.", issued: "No internal orders recorded yet.", toClose: "Nothing waiting for a second person.", sentBack: "Nothing is back with a requester.", closed: "Nothing closed this year." }[key];
  if (key === "toClose") return `Capitalized — somebody other than whoever did it closes ${list.length === 1 ? "it" : "them"}.`;
  if (key === "toCheck") {
    const flagged = list.filter((a) => a.flags.openBlocks).length;
    const mine = list.filter((a) => a.canApproveIssue).length;
    if (mine) return `${mine} ${mine === 1 ? "is" : "are"} checked and waiting on your approval to issue.`;
    if (flagged) return `Signed and verified. ${flagged} ${flagged === 1 ? "carries" : "carry"} a red flag to clear before SAP.`;
    return "Signed and verified. No red flags.";
  }
  if (key === "issued") { const ko22 = list.filter((a) => !(a.steps && a.steps.KO22_BUDGET)).length; return ko22 ? `Budget still to load (KO22) on ${ko22}.` : "Orders recorded, budgets posted."; }
  if (key === "sentBack") { const r = list[0]; return r.returnedTo ? `“${r.title}” is with ${r.requester ? r.requester.name : "the requester"}: ${r.returnedTo.reason}` : "With the requester to fix."; }
  return "Closed out. The quarterly review covers what is still open.";
}

function chipsFor(a) {
  const out = [];
  // The requester side has ASKED Fixed Assets something and is waiting (R163); or it has written
  // the last line, which is worth a word and nothing more (R149).
  const own = ["requester", "preparer", "coordinator"];
  if (a.openAsk && own.includes(a.openAsk.side)) {
    out.push(tag(`${String(a.openAsk.byName || "The requester").split(" ")[0]} asked`, "yellow", { icon: "question" }));
  } else if (a.talk && ["comment", "ask"].includes(a.talk.kind) && own.includes(a.talk.side)) {
    out.push(tag(`${String(a.talk.byName || "The requester").split(" ")[0]} wrote`, "blue", { icon: "chat" }));
  }
  if (a.state === "fa_review" || a.state === "approved") {
    if (a.flags.openBlocks) out.push(tag(a.flags.drift && a.flags.driftCleared < a.flags.drift ? `Matrix changed since send` : `${a.flags.openBlocks} red ${plural(a.flags.openBlocks, "flag")}`, "red", { icon: "bang" }));
    else if (a.flags.openWarns) out.push(tag(`${a.flags.openWarns} to note`, "yellow", { icon: "clock" }));
    out.push(tag(`${a.verified.ok} of ${a.verified.of} ${plural(a.verified.of, "signature")} verified`, a.verified.ok === a.verified.of && a.verified.of ? "" : "red", { icon: "shield" }));
    if (!a.flags.openBlocks && a.judgment.open) out.push(tag(`judgment ${a.judgment.of - a.judgment.open} of ${a.judgment.of}`, "grey"));
    // Four eyes on a new internal order only works if the two people can SEE what is waiting
    // for them. Nothing anywhere said so, on any screen (R142).
    if (a.canApproveIssue) out.push(tag("wants YOUR approval", "yellow", { icon: "pen" }));
    else if (a.needsIssueApproval) out.push(tag(`waiting on ${(a.issueApprovers || []).map((x) => x.name.split(" ")[0]).join(" or ") || "an approver"}`, "yellow", { icon: "clock" }));
  } else if (a.state === "issued" || a.state === "tracking") {
    out.push(tag(`AFE ${a.afeNo}${a.ioNumbers.length > 1 ? ` + ${a.ioNumbers.length - 1} child ${a.ioNumbers.length - 1 === 1 ? "order" : "orders"}` : ""}`, "", { icon: "tick" }));
    // What comes next, all the way to Close — the chips used to stop at "AS01 to create".
    const st = a.steps || {};
    const next = !st.KO22_BUDGET ? "Budget to load (KO22)" : !st.AS01_AUC ? "AuC to create (AS01)" : !st.KO02_SETTLEMENT ? "Settlement rule to set (KO02)"
      : !a.packSentAt ? "Issued AFE to send" : "To capitalize";
    out.push(tag(next, a.packSentAt && st.KO02_SETTLEMENT ? "blue" : "yellow", { icon: "clock" }));
  } else if (a.state === "capitalized") {
    out.push(tag(`To close${a.capitalizedBy ? ` — not by ${a.capitalizedBy.split(" ")[0]}` : ""}`, "yellow", { icon: "shield" }));
  } else if (a.state === "returned" && a.returnedTo) {
    out.push(tag(`sent back by ${a.returnedTo.byName.split(" ")[0]}`, "red", { icon: "back" }));
  } else out.push(tag(stateLabel(a.state), "grey"));
  return html`${out}`;
}

function row(a) {
  // A capitalized AFE is closed on the issue screen, so that is where its row goes — it went to
  // the requester's record page, which has no Close, and the second half of four eyes had no road.
  const href = ["fa_review", "approved"].includes(a.state) ? `/fa/${a.id}/judge` : ["issued", "tracking", "capitalized", "closed"].includes(a.state) ? `/fa/${a.id}/issue` : `/afe/${a.id}`;
  // Named `stamp`, not `when`: a local `const when` shadows the imported helper AND is read in
  // its own initialiser, which is a temporal-dead-zone ReferenceError that throws the whole
  // row away. `node --check` cannot see it — only running the screen does.
  const stamp = a.state === "fa_review" || a.state === "approved" ? (a.receivedAt ? html` · fully signed ${when(a.receivedAt)}` : "")
    : a.state === "issued" ? (a.updatedAt ? html` · issued ${when(a.updatedAt)}` : "")
    : a.updatedAt ? html` · ${when(a.updatedAt)}` : "";
  return html`<a class="lrow" href="${href}" data-key="${a.id}" style="--cols: 44px minmax(0, 1fr) 130px minmax(0, 420px) 28px;">
    ${avatar(a.requester ? a.requester.name : "?", a.state === "fa_review" ? "" : "grey", "lg")}
    <span style="min-width: 0;"><span class="ttl">${a.title}</span><span class="id">${a.requester ? a.requester.name : ""}${a.division ? " · " + a.division : ""}${a.costCenter ? " · cost centre " + a.costCenter : ""}${stamp}${a.days !== null && a.days !== undefined && a.state === "fa_review" ? ` · with you ${a.days} ${plural(a.days, "day")}` : ""}</span></span>
    ${moneyCell(a.totalUsd)}
    <span class="tagcol" style="min-width: 0; display: flex; gap: 8px; flex-wrap: wrap;">${chipsFor(a)}</span>
    <span class="chev">${icon("chevR", 18)}</span>
  </a>`;
}

function bucketsMarkup() {
  return html`${BUCKETS.map((b) => bucket({ key: b.key, n: Q.groups[b.key].length, title: b.title, detail: detail(b.key, Q.groups[b.key]), tone: b.tone, icon: b.icon, on: ui.open === b.key }))}`;
}
function listMarkup() {
  const b = BUCKETS.find((x) => x.key === ui.open);
  if (!b) return html``;
  const L = Q.groups[b.key];
  return html`<div class="list" data-key="list-${b.key}"><div class="sect">${b.title.toUpperCase()} · ${b.key === "toCheck" ? "OLDEST FIRST" : "LATEST FIRST"}</div>${L.length ? L.map(row) : emptyState(({
      toCheck: "Nothing to check. An AFE lands here with its last signature.",
      issued: "No order is waiting on a SAP step.",
      toClose: "Nothing to close. A capitalized AFE waits here for the second pair of eyes.",
      sentBack: "Nothing sent back.",
      closed: "Nothing closed yet.",
    })[b.key] || "Nothing here right now.")}</div>`;
}
function markup() {
  const n = Q.counts.toCheck, f = Q.counts.flagged;
  const words = ["Nothing", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
  const mine = Q.counts.myIssueApproval || 0;
  const head = n === 0 ? "Nothing to check." : `${words[n] || n} to check.${f ? ` ${f === 1 ? "One is" : (words[f] || f) + " are"} flagged.` : ""}${mine ? ` ${mine === 1 ? "One wants" : (words[mine] || mine) + " want"} your approval.` : ""}`;
  return html`<div class="page pane">
    <h1 class="h1">${head} ${tip("A red chip is something to clear or acknowledge before an internal order exists; green says the signatures match the approved chain. Nothing here is typed — it is derived from the AFE, the frozen chain and today's matrix.")}</h1>
    <div class="sub">Every signature is checked against the chain frozen at send. Your judgment, then SAP.${Q.matrixBatch ? ` Today's approver matrix is the SAP report of ${date(Q.matrixBatch.reportDate || Q.matrixBatch.importedAt) || "an unknown day"}${Q.matrixBatch.simulated ? " (a simulated extract)" : ""}.` : ""}</div>
    <div style="margin-top: 14px;">${faNav("queue")}</div>
    <div class="buckets five" id="buckets">${bucketsMarkup()}</div>
    <div id="bucket-list">${listMarkup()}</div>
  </div>`;
}

export async function render(el) {
  root = el;
    // Paint from what we already have, then correct it when the server answers (R92).
  try {
    Q = await store.get("/api/fa/queue", {
      swr: true, onFresh: (d) => { Q = split(d); if (root === el) morph(el, markup()); },
    });
    split(Q);
  }
  catch (e) { showError(e); Q = split({ counts: { toCheck: 0, flagged: 0 }, groups: { toCheck: [], issued: [], sentBack: [], done: [] }, matrixBatch: null }); }
  if (ui.open === "done") ui.open = "toClose";
  if (ui.open === undefined) ui.open = Q.groups.toCheck.length ? "toCheck" : Q.groups.issued.length ? "issued" : "toCheck";
  if (!el.dataset.fa) { el.innerHTML = ""; el.dataset.fa = "1"; delete el.dataset.wired; }
  morph(el, markup());
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    on(el, "click", "[data-bucket]", (e, b) => { ui.open = ui.open === b.dataset.bucket ? null : b.dataset.bucket; morph($("#buckets", el), bucketsMarkup()); morph($("#bucket-list", el), listMarkup()); });
  }
}
export function unmount() { if (root) { delete root.dataset.fa; delete root.dataset.wired; root.innerHTML = ""; } }
