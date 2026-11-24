// /prepare — the coordinator's queue. Four buckets; the chip on each row is the ONE thing standing
// between that AFE and Send.
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { session } from "../../core/session.js";
import { icon } from "../../core/icons.js";
import { money, ago, plural , since } from "../../core/format.js";
import { bucket, tag, avatar, progress, emptyState, tip } from "../../components/parts.js";
import { showError } from "../../core/ui.js";

const BUCKETS = [
  { key: "toSend", title: "To send", tone: "yellow", icon: "send" },
  { key: "inApproval", title: "In approval", tone: "blue", icon: "clock" },
  { key: "returned", title: "Returned", tone: "red", icon: "back" },
  { key: "withFa", title: "With Fixed Assets", tone: "green", icon: "shield" },
];
const ui = uiFor("prepare");
let Q = null;
let root = null;

function detail(key, list) {
  if (!list.length) return { toSend: "Nothing is waiting for you to send.", inApproval: "Nothing is out for signature.", returned: "Nothing has come back.", withFa: "Nothing is with Fixed Assets." }[key];
  if (key === "toSend") { const ready = list.filter((a) => a.readiness && a.readiness.canSend).length; return `${ready} ready to send now${list.length - ready ? `, ${list.length - ready} with something to sort out first` : ""}.`; }
  if (key === "inApproval") { const oldest = list.slice().sort((a, b) => String(a.waitingOn && a.waitingOn.since || "").localeCompare(String(b.waitingOn && b.waitingOn.since || "")))[0]; return oldest && oldest.waitingOn ? `Oldest is with ${oldest.waitingOn.name}, ${ago(oldest.waitingOn.since)}${oldest.waitingOn.reminders ? ` · ${oldest.waitingOn.reminders} ${plural(oldest.waitingOn.reminders, "reminder")} sent` : ""}.` : "Out for signature."; }
  if (key === "returned") { const r = list[0]; return r.returnedTo ? `${r.returnedTo.byName} sent “${r.title}” back: ${r.returnedTo.reason}` : "Sent back to the requester."; }
  return "Fully signed. You'll be told the AFE number when it is keyed.";
}

function oneThing(a) {
  const r = a.readiness;
  if (!r) return "";
  if (r.blocks) return tag(`${r.blocks} ${plural(r.blocks, "thing")} to fix on the form`, "red", { icon: "bang" });
  if (r.needsEmail) return tag(`${r.needsEmail} ${plural(r.needsEmail, "mailbox", "mailboxes")} to confirm`, "yellow", { icon: "mail" });
  const other = r.blockers.filter((b) => b.code !== "emails_unconfirmed");
  if (other.length) return tag(other[0].message.split(" — ")[0].slice(0, 60), "red", { icon: "bang" });
  if (r.pending) return tag(`${r.pending} ${plural(r.pending, "fact")} still to come`, "yellow", { icon: "clock" });
  if (r.sodExcluded && r.sodExcluded.length) return tag(`${r.sodExcluded[0].standIn || "a stand-in"} stands in for ${r.sodExcluded[0].name.split(" ").pop()}`, "blue", { icon: "shield" });
  return tag("Chain ready", "", { icon: "tick" });
}

function row(a) {
  const w = a.waitingOn;
  return html`<a class="lrow" href="/afe/${a.id}/coordinate" data-key="${a.id}" style="--cols: 44px minmax(0, 1fr) 130px minmax(0, 300px) 110px 28px;">
    ${avatar(w ? w.name : a.requester ? a.requester.name : "?", w ? "blue" : "", "lg")}
    <span style="min-width: 0;"><span class="ttl">${a.title}</span><span class="id">${a.requester ? a.requester.name : ""}${a.costCenter ? " · cost centre " + a.costCenter : ""}${a.submittedAt && a.state === "submitted" ? " · submitted " + since(a.submittedAt) : a.sentAt ? " · sent " + since(a.sentAt) : ""}</span></span>
    <span class="amt">${money(a.totalUsd)}</span>
    <span class="tagcol" style="min-width: 0; display: flex; gap: 8px; flex-wrap: wrap;">
      ${a.state === "in_approval" || a.state === "on_hold" ? (w ? tag(`with ${w.name} · ${w.level || w.role} · ${ago(w.since)}`, a.state === "on_hold" ? "yellow" : "blue", { avatar: w.name, avatarTone: "blue" }) : tag("in approval", "blue")) : ""}
      ${a.state === "submitted" ? oneThing(a) : ""}
      ${a.openAsk && a.openAsk.askedOf === "coordinator" ? tag(`${String(a.openAsk.byName || "The requester").split(" ")[0]} asked you`, "yellow", { icon: "question" })
        : a.openAsk && a.openAsk.askedOf === "requester" ? tag(`you asked ${a.requester ? a.requester.name.split(" ")[0] : "the requester"}`, "grey", { icon: "question" }) : ""}
      ${a.state === "returned" && a.returnedTo ? tag(`sent back by ${a.returnedTo.byName}`, "red", { icon: "back" }) : ""}
      ${["approved", "fa_review"].includes(a.state) ? tag("fully signed", "", { icon: "shield" }) : ""}
    </span>
    <span class="wideonly">${a.progress ? progress(a.progress.signed, a.progress.of) : a.readiness ? html`<span class="small muted">${a.band || ""}${a.readiness.signers ? ` · ${a.readiness.signers} ${plural(a.readiness.signers, "signer")}` : ""}</span>` : ""}</span>
    <span class="chev">${icon("chevR", 18)}</span>
  </a>`;
}

function lists() {
  return {
    toSend: Q.groups.toSend, inApproval: Q.groups.inApproval.concat(Q.groups.onHold), returned: Q.groups.returned, withFa: Q.groups.withFa,
  };
}
function bucketsMarkup() {
  const L = lists();
  return html`${BUCKETS.map((b) => bucket({ key: b.key, n: L[b.key].length, title: b.title, detail: detail(b.key, L[b.key]), tone: b.tone, icon: b.icon, on: ui.open === b.key }))}`;
}
function listMarkup() {
  const b = BUCKETS.find((x) => x.key === ui.open);
  if (!b) return html``;
  const L = lists()[b.key];
  return html`<div class="list" data-key="list-${b.key}"><div class="sect">${b.title.toUpperCase()} · OLDEST FIRST</div>${L.length ? L.slice().reverse().map(row) : emptyState(({
      toSend: "Nothing to send. An AFE a requester submits lands here for you to review.",
      inApproval: "Nothing with approvers.",
      returned: "Nothing sent back.",
      withFa: "Nothing with Fixed Assets yet. An AFE lands there with its last signature.",
    })[b.key] || "Nothing here right now.")}</div>`;
}
function markup() {
  const L = lists();
  const toSend = L.toSend.length, returned = L.returned.length;
  const head = toSend && returned ? `${toSend} to send. ${returned} came back.` : toSend ? `${toSend} to send.` : returned ? `${returned} came back.` : L.inApproval.length ? "Everything is out for signature." : "Nothing is waiting on you.";
  return html`<div class="page pane">
    <h1 class="h1">${head} ${tip("The chip says the one thing that stands between an AFE and Send. “Chain ready” means nothing does.")}</h1>
    <div class="sub">${(Q.divisions || []).join(", ") || "Your divisions"} — every AFE passes through you before signature.${Q.groups.drafts.length ? ` ${Q.groups.drafts.length} ${plural(Q.groups.drafts.length, "draft")} of your own ${Q.groups.drafts.length === 1 ? "is" : "are"} on your requests page.` : ""}</div>
    <div class="buckets four" id="buckets">${bucketsMarkup()}</div>
    <div id="bucket-list">${listMarkup()}</div>
  </div>`;
}

export async function render(el) {
  root = el;
    // Paint from what we already have, then correct it when the server answers (R92).
  try {
    Q = await store.get("/api/coordinator/queue", {
      swr: true, onFresh: (d) => { Q = d; if (root === el) morph(el, markup()); },
    });
  }
  catch (e) { showError(e); Q = { divisions: [], counts: {}, groups: { toSend: [], drafts: [], inApproval: [], onHold: [], returned: [], withFa: [], issued: [], rejected: [] } }; }
  if (ui.open === undefined) ui.open = Q.groups.toSend.length ? "toSend" : Q.groups.returned.length ? "returned" : "inApproval";
  if (!el.dataset.prepare) { el.innerHTML = ""; el.dataset.prepare = "1"; delete el.dataset.wired; }
  morph(el, markup());
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    on(el, "click", "[data-bucket]", (e, b) => { ui.open = ui.open === b.dataset.bucket ? null : b.dataset.bucket; morph($("#buckets", el), bucketsMarkup()); morph($("#bucket-list", el), listMarkup()); });
  }
}
export function unmount() { if (root) { delete root.dataset.prepare; delete root.dataset.wired; root.innerHTML = ""; } }
