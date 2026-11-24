// /approvals — what is waiting on you. A list on the left; on a desktop the selected AFE's
// decision on the right, so signing three things is three clicks, not three pages.
import { html, morph, on, $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { store, uiFor } from "../../core/store.js";
import { session, firstName } from "../../core/session.js";
import { navigate } from "../../core/router.js";
import { setRecord, setRecordNote, refreshCounts } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, ago, plural , since } from "../../core/format.js";
import { avatar, emptyState } from "../../components/parts.js";
import { showError } from "../../core/ui.js";
import { decisionMarkup, decide } from "./decision.js";
import { postComment } from "../../core/comments.js";

const ui = uiFor("approvals");
const S = { data: null, dec: null, root: null, wiredTo: null, tab: "toSign", opening: null, done: null };
const VERB = { sign: "Approved and signed", question: "Your question is on its way", "send-back": "Sent back", decline: "Declined" };
const TABS = [["toSign", "Waiting on you"], ["onHold", "Your questions"], ["signed", "Signed"]];
const wide = () => window.matchMedia("(min-width: 900px)").matches;

function item(it, selected) {
  const r = it.recipient;
  const href = `/approve/${it.afe.id}`;
  return html`<a class="card" href="${href}" data-pick="${it.afe.id}" data-key="${it.afe.id}" style="display: flex; align-items: center; gap: 14px; padding: 16px 18px; text-decoration: none; color: inherit; font-weight: 400; ${selected ? "border: 2px solid var(--green); box-shadow: 0 8px 22px rgba(0,137,67,.10);" : ""}">
    ${avatar(it.afe.requester ? it.afe.requester.name : "?", "blue", "lg")}
    <div style="min-width: 0; flex: 1;"><div style="font-size: 13.5px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${it.afe.title}</div><div class="small muted">${it.afe.requester ? it.afe.requester.name : ""} · ${r.status === "signed" ? "signed " + since(r.signedAt) : ago(r.since) + (r.level ? " · as " + r.level : "")}${it.simulated ? " · simulated" : ""}</div></div>
    <span class="amt">${money(it.afe.totalUsd)}</span>
  </a>`;
}

function listMarkup() {
  const list = S.data[S.tab] || [];
  return html`<div style="display: flex; flex-direction: column; gap: 10px; margin-top: 22px;" data-key="list-${S.tab}">
    ${list.length ? list.map((it) => item(it, S.dec && S.dec.afe.id === it.afe.id)) : emptyState(S.tab === "toSign" ? "Nothing is waiting on you." : S.tab === "onHold" ? "No open questions." : "Nothing signed yet.")}
  </div>`;
}
function markup() {
  const n = S.data.counts.toSign;
  const head = n === 0 ? `Nothing needs you${firstName() ? ", " + firstName() : ""}.` : n === 1 ? "One needs you." : `${["", "", "Two", "Three", "Four", "Five", "Six"][n] || n} need you.`;
  const oldest = (S.data.toSign || [])[0];
  return html`<div class="page pane">
    <div class="split narrow">
      <div>
        <h1 class="h1">${head}</h1>
        <div class="sub">${oldest ? `Oldest first — the top one has waited ${ago(oldest.recipient.since)}.` : "Approvals arrive here and by email."}</div>
        <div class="chipnav" style="margin: 18px 0 0;" id="tabs" role="tablist" aria-label="Approvals">${TABS.map(([k, l]) => html`<button type="button" role="tab" aria-selected="${S.tab === k ? "true" : "false"}" class="${S.tab === k ? "on" : ""}" data-tab="${k}" data-key="${k}" style="background: ${S.tab === k ? "var(--ink)" : "none"}; color: ${S.tab === k ? "#FFF" : "var(--ink-3)"};">${l}${(S.data.counts[k] || 0) ? html`<span class="n" style="${S.tab === k ? "background: rgba(255,255,255,.18); color:#FFF;" : ""}">${S.data.counts[k]}</span>` : ""}</button>`)}</div>
        <div id="list">${listMarkup()}</div>
      </div>
      <div id="detail">${detailMarkup()}</div>
    </div>
  </div>`;
}

/**
 * The right-hand pane. It belongs to the AFE you picked from the MOMENT you pick it: while the
 * next decision loaded, the previous AFE's live "Approve and sign" stayed on screen, and the
 * press went to whatever was showing — a signature could land on the wrong AFE (found
 * 2026-10-16). And after a decision it says what you did and waits for you to choose the next
 * one, rather than swapping a new Approve into the spot your mouse is already on.
 */
function detailMarkup() {
  if (!wide()) return "";
  if (S.dec) return html`${decisionMarkup(S.dec)}`;
  if (S.opening) {
    return html`<div class="card pad" data-key="opening" style="margin-top: 22px;"><div class="small muted"><i class="spin"></i> Opening ${S.opening}…</div></div>`;
  }
  if (S.done) {
    const n = S.done.next;
    return html`<div class="card pad" data-key="done" style="margin-top: 22px;">
      <div style="display: flex; gap: 12px; align-items: center;">
        <span class="tick lg ok">${icon("tick", 15, { stroke: 2.4 })}</span>
        <div style="min-width: 0;"><div style="font-weight: 700;">${VERB[S.done.action] || "Done"}</div>
          <div class="small muted" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${S.done.title}</div></div>
      </div>
      <div style="margin-top: 18px;">${n
        ? html`<button type="button" class="cta sec" data-next="${n.id}">Next: ${n.title} ${icon("arrowR", 13)}</button>`
        : html`<span class="small muted">Nothing else is waiting on you.</span>`}</div>
    </div>`;
  }
  return "";
}
const titleOf = (id) => {
  for (const k of Object.keys(S.data || {})) {
    const hit = Array.isArray(S.data[k]) ? S.data[k].find((it) => it.afe.id === id) : null;
    if (hit) return hit.afe.title;
  }
  return "the AFE";
};
async function pick(afeId) {
  ui.picked = afeId;
  S.dec = null; S.done = null; S.opening = titleOf(afeId);
  morph($("#detail", S.root), html`${detailMarkup()}`);
  morph($("#list", S.root), listMarkup());
  let dec;
  try { dec = await api.get(`/api/afes/${afeId}/decision`); } catch (e) { S.opening = null; showError(e); morph($("#detail", S.root), html`${detailMarkup()}`); return; }
  if (ui.picked !== afeId) return;                // something else was picked while this loaded
  S.dec = dec; S.opening = null;
  morph($("#detail", S.root), html`${detailMarkup()}`);
  morph($("#list", S.root), listMarkup());
}

export async function render(root) {
  S.root = root;
  try { S.data = await store.get("/api/approvals/mine", { fresh: true }); } catch (e) { showError(e); S.data = { counts: {}, toSign: [], onHold: [], signed: [], copies: [] }; }
  S.tab = ui.tab || (S.data.toSign.length ? "toSign" : S.data.onHold.length ? "onHold" : "toSign");
  setRecord(null);
  if (!root.dataset.inbox) { root.innerHTML = ""; root.dataset.inbox = "1"; }
  S.dec = null; S.opening = null; S.done = null;
  if (wide()) {
    const list = S.data[S.tab] || [];
    const want = list.find((it) => it.afe.id === ui.picked) || list[0];
    if (want) { try { S.dec = await api.get(`/api/afes/${want.afe.id}/decision`); ui.picked = want.afe.id; } catch { S.dec = null; } }
  }
  morph(root, markup());
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "click", "[data-tab]", (e, b) => { S.tab = b.dataset.tab; ui.tab = S.tab; morph($("#tabs", root), html`${TABS.map(([k, l]) => html`<button type="button" class="${S.tab === k ? "on" : ""}" data-tab="${k}" data-key="${k}" style="background: ${S.tab === k ? "var(--ink)" : "none"}; color: ${S.tab === k ? "#FFF" : "var(--ink-3)"};">${l}${(S.data.counts[k] || 0) ? html`<span class="n" style="${S.tab === k ? "background: rgba(255,255,255,.18); color:#FFF;" : ""}">${S.data.counts[k]}</span>` : ""}</button>`)}`); morph($("#list", root), listMarkup()); });
  on(root, "click", "[data-pick]", (e, a) => { if (!wide()) return; e.preventDefault(); pick(a.dataset.pick); });
  on(root, "click", "[data-decide]", async (e, b) => {
    // The button names its AFE; a press that does not match what the pane is showing is refused.
    if (!S.dec || b.dataset.afe !== S.dec.afe.id) return;
    const acted = S.dec.afe;
    const r = await decide(acted.id, b.dataset.decide, S.dec, b);
    if (!r) return;
    S.data = await store.get("/api/approvals/mine", { fresh: true });
    if ((S.data[S.tab] || []).some((it) => it.afe.id === acted.id)) {
      S.dec = r;                                    // still on this list: show it as it is now
    } else {
      const next = (S.data[S.tab] || []).find((it) => it.afe.id !== acted.id) || null;
      S.dec = null; ui.picked = null;
      S.done = { action: b.dataset.decide, title: acted.title || titleOf(acted.id), next: next ? { id: next.afe.id, title: next.afe.title } : null };
    }
    morph(root, markup());
    refreshCounts();
  });
  on(root, "click", "[data-next]", (e, b) => pick(b.dataset.next));
  on(root, "click", "[data-thread-post]", async (e, b) => {
    if (!S.dec || !(await postComment(S.dec.afe.id, root, b))) return;
    S.dec = await api.get(`/api/afes/${S.dec.afe.id}/decision`);
    morph($("#detail", root), html`${decisionMarkup(S.dec)}`);
  });
}
export function unmount() { if (S.root) { delete S.root.dataset.inbox; S.root.innerHTML = ""; } }
