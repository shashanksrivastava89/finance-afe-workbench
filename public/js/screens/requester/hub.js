// /requests — the hub. Opens on three buckets and reveals rows for the one you tap; tapping it
// again closes it (design rules 1 and 4). Every row says who raised it and where it is.
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { session, firstName } from "../../core/session.js";
import { icon } from "../../core/icons.js";
import { bucket, afeRow, emptyState, tip } from "../../components/parts.js";
import { showError } from "../../core/ui.js";

// What each bucket holds when it holds nothing — "Nothing here right now" told nobody what would.
const EMPTY = {
  needsYou: "Nothing needs you right now.",
  inApproval: "Nothing is with approvers. An AFE you send waits here until the last signature.",
  done: "Nothing finished yet. An AFE that is signed, issued, withdrawn or declined ends up here.",
};
const newAfe = () => html`<a href="/afe/new" style="font-weight: 700;">Raise a new AFE</a>`;
const BUCKETS = [
  { key: "needsYou", title: "Needs you", tone: "yellow", icon: "pen" },
  { key: "inApproval", title: "In approval", tone: "blue", icon: "clock" },
  { key: "done", title: "Done", tone: "green", icon: "tick" },
];
// Something ASKED of you by Fixed Assets, an approver or — while it is with them — your
// coordinator waits in "Needs you" until somebody on your side answers it (R149, R163, and the
// coordinator's ask from the KT walkthrough). A plain comment moves nothing: it is a note on the
// record, and a note is not a job. Each AFE is in exactly one bucket.
const OWNER_SIDES = ["requester", "preparer", "coordinator"];
const askedYou = (a) => Boolean(a.openAsk && (a.openAsk.askedOf === "requester" || (a.openAsk.side && !OWNER_SIDES.includes(a.openAsk.side))))
  && !["closed", "rejected", "withdrawn"].includes(a.state);
function bucketOf(a) {
  if (["draft", "returned", "on_hold"].includes(a.state) || askedYou(a)) return "needsYou";
  if (["submitted", "in_approval"].includes(a.state)) return "inApproval";
  return "done";
}
const ui = uiFor("hub");
let rows = [];
let root = null;

// What is waiting for THIS person's signature, from /api/me's own count (R154). An approver who
// raises nothing lands here and used to meet "Nothing yet" while an envelope waited on them.
const waiting = () => Number((session.me && session.me.badges && session.me.badges.approvals) || 0);

function detail(key, list) {
  if (!list.length) return { needsYou: "Nothing is waiting on you.", inApproval: "Nothing is out for signature.", done: "Nothing has come back yet." }[key];
  if (key === "needsYou") {
    const returned = list.filter((a) => a.state === "returned").length, drafts = list.filter((a) => a.state === "draft").length, held = list.filter((a) => a.state === "on_hold").length;
    const asked = list.filter((a) => !["draft", "returned", "on_hold"].includes(a.state) && askedYou(a)).length;
    return [returned ? `${returned} sent back` : "", held ? `${held} with a question for you` : "", asked ? `${asked} asked something of you` : "", drafts ? `${drafts} still a draft` : ""].filter(Boolean).join(" · ") + ".";
  }
  if (key === "inApproval") {
    const withCoord = list.filter((a) => a.state === "submitted").length;
    const holders = list.filter((a) => a.routing && a.routing.holder).map((a) => a.routing.holder.name);
    return [withCoord ? `${withCoord} with the coordinator` : "", holders.length ? `with ${Array.from(new Set(holders)).slice(0, 2).join(" and ")}${holders.length > 2 ? " and others" : ""}` : ""].filter(Boolean).join(" · ") + ".";
  }
  const issued = list.filter((a) => ["issued", "tracking", "capitalized", "closed"].includes(a.state)).length;
  const fa = list.filter((a) => ["approved", "fa_review"].includes(a.state)).length;
  const dead = list.filter((a) => ["rejected", "withdrawn"].includes(a.state)).length;
  return [issued ? `${issued} issued with an AFE number` : "", fa ? `${fa} with Fixed Assets, fully signed` : "", dead ? `${dead} declined or withdrawn` : ""].filter(Boolean).join(" · ") + ".";
}

function hrefFor(a) {
  if (askedYou(a) && !["draft", "returned"].includes(a.state)) return `/afe/${a.id}`;
  if (a.state === "draft") return `/afe/${a.id}/edit/resume`;
  if (a.state === "returned") return `/afe/${a.id}/edit/${(a.returnedTo && a.returnedTo.step) || 1}`;
  return `/afe/${a.id}`;
}

function markup() {
  const groups = BUCKETS.map((b) => Object.assign({}, b, { list: rows.filter((a) => bucketOf(a) === b.key) }));
  const open = groups.find((g) => g.key === ui.open);
  const needs = groups[0].list.length, inApp = groups[1].list.length;
  // Counted the way the bucket splits it: "5 are with approvers" sat above a bucket saying one of
  // the five was still with the coordinator (2026-10-16).
  const withCoord = groups[1].list.filter((a) => a.state === "submitted").length;
  const withSigners = inApp - withCoord;
  const sub = rows.length === 0 ? "Nothing yet. A request takes about four minutes — one question at a time."
    : `${needs ? `${needs} need${needs === 1 ? "s" : ""} you. ` : ""}${withSigners ? `${withSigners} ${withSigners === 1 ? "is" : "are"} with approvers. ` : ""}${withCoord ? `${withCoord} ${withCoord === 1 ? "is" : "are"} with the coordinator. ` : ""}${!needs && !inApp ? "Everything is moving without you." : ""}`;
  return html`
    <div class="page pane">
      <div style="display: flex; align-items: flex-end; gap: 18px; flex-wrap: wrap;">
        <div style="min-width: 0;"><h1 class="h1">${firstName() ? firstName() + ", your requests." : "Your requests."} ${tip("Every row carries who raised it, the division and the cost centre. Tap a bucket to open it; tap it again to close it.")}</h1><div class="sub">${sub}</div></div>
        <a class="cta" href="/afe/new" style="margin-left: auto;">${icon("plus", 16, { stroke: 2.2 })}New AFE</a>
      </div>
      ${waiting() ? html`<a class="banner yellow" href="/approvals" style="margin-top: 16px; text-decoration: none;" data-key="waiting">${icon("pen", 16)}<span><b>${waiting()} ${waiting() === 1 ? "AFE is" : "AFEs are"} waiting for your signature.</b> Open Approvals ${icon("chevR", 14)}</span></a>` : ""}
      <div class="buckets" id="buckets">${groups.map((g) => bucket({ key: g.key, n: g.list.length, title: g.title, detail: detail(g.key, g.list), tone: g.tone, icon: g.icon, on: g.key === ui.open }))}</div>
      <div id="bucket-list">${open ? html`<div class="list" data-key="list-${open.key}">
        <div class="sect">${open.title.toUpperCase()} · ${open.key === "done" ? "NEWEST FIRST" : "OLDEST FIRST"}</div>
        ${open.list.length ? open.list.map((a) => afeRow(a, hrefFor(a), { mine: true })) : emptyState(EMPTY[open.key] || "Nothing here right now.", open.key === "needsYou" ? newAfe() : "")}
      </div>` : ""}</div>
    </div>`;
}

export async function render(el) {
  root = el;
  try {
    // Paint from what we already have, then correct it when the server answers (R92).
    rows = await store.get("/api/afes?mine=1", {
      swr: true,
      onFresh: (d) => { rows = d.slice().sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))); if (root === el) morph(el, markup()); },
    });
  } catch (e) { showError(e); rows = []; }
  // Newest first for done; oldest first (longest waiting) for the rest.
  rows.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
  if (!ui.open) ui.open = rows.some((a) => bucketOf(a) === "needsYou") ? "needsYou" : rows.some((a) => bucketOf(a) === "inApproval") ? "inApproval" : "needsYou";
  // morph diffs against what is there. Emptying the element first left it nothing to diff, so
  // every repaint rebuilt the whole hub — the one screen in the app that did (R92).
  morph(el, markup());
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    on(el, "click", "[data-bucket]", (e, b) => {
      ui.open = ui.open === b.dataset.bucket ? null : b.dataset.bucket;
      // Patch the two regions only — the header and the CTA stay put (rule 2).
      morph($("#buckets", el), markupBuckets());
      morph($("#bucket-list", el), markupList());
    });
  }
}

function markupBuckets() {
  const groups = BUCKETS.map((b) => Object.assign({}, b, { list: rows.filter((a) => bucketOf(a) === b.key) }));
  return html`${groups.map((g) => bucket({ key: g.key, n: g.list.length, title: g.title, detail: detail(g.key, g.list), tone: g.tone, icon: g.icon, on: g.key === ui.open }))}`;
}
function markupList() {
  const g = BUCKETS.find((b) => b.key === ui.open);
  if (!g) return html``;
  let list = rows.filter((a) => bucketOf(a) === g.key);
  if (g.key === "done") list = list.slice().reverse();
  return html`<div class="list" data-key="list-${g.key}">
    <div class="sect">${g.title.toUpperCase()} · ${g.key === "done" ? "NEWEST FIRST" : "OLDEST FIRST"}</div>
    ${list.length ? list.map((a) => afeRow(a, hrefFor(a), { mine: true })) : emptyState(EMPTY[g.key] || "Nothing here right now.", g.key === "needsYou" ? newAfe() : "")}
  </div>`;
}

export function unmount() { if (root) { delete root.dataset.wired; root.innerHTML = ""; } }
