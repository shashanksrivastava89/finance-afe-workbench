// /mailbox — the Dev Mailbox. Everything the tool has put in the outbox, read as mail.
//
// The point of the screen is that it is not a log. While there is no Graph registration nothing
// leaves the building, and the only honest way to show that is to show the message: the real
// recipients, the real subject, the `X-AFE-*` headers the FA team's workflow will trigger on,
// and the body. What is read here is what `lib/jobs/drainOutbox.js` will hand to Graph.
//
// Aggregation first (design rule 1): kinds and their counts, one open to its messages, one open
// to its body.
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { icon } from "../../core/icons.js";
import { since, plural } from "../../core/format.js";
import { tag, emptyState, tip } from "../../components/parts.js";
import { showError } from "../../core/ui.js";

const ui = uiFor("mailbox");
let M = null;
let root = null;
let body = {};                                        // message id → body, fetched when opened

const TONE = { sent: "green", queued: "blue", drafted: "yellow", failed: "red" };

function header() {
  const d = M.delivery || {};
  return html`<div class="card pad" data-key="delivery" style="border-left: 4px solid var(--${d.canSend ? "green" : "blue"});">
    <div style="display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap;">
      <div style="min-width: 0; flex: 1;">
        <div class="sect">${d.canSend ? "SENDING IS LIVE" : "NOTHING IS BEING SENT"}</div>
        <div style="margin-top: 6px; font-size: 13px;">${d.explanation || ""}</div>
        ${d.mailbox ? html`<div class="small muted" style="margin-top: 6px;">From ${d.mailbox}</div>` : ""}
      </div>
      <div class="kpis" style="margin: 0; gap: 18px;" id="statuses">${statusesMarkup()}</div>
    </div>
  </div>`;
}

// Each count is a control (design rule 3): it shows those messages, and pressing it again shows
// them all (rule 4). They used to be figures with the rows behind them out of reach.
function statusesMarkup() {
  const k = (status, label, tone) => html`<button type="button" class="kpi kbtn ${ui.status === status ? "on" : ""}" data-status="${status}" data-key="${status}" aria-pressed="${ui.status === status ? "true" : "false"}"><span class="k">${label}</span><span class="v ${tone}">${M.counts[status]}</span></button>`;
  return html`${k("queued", "WAITING", "blue")}${k("sent", "SENT", "green")}${k("drafted", "DRAFT ONLY", "")}${M.counts.failed ? k("failed", "FAILED", "red") : ""}`;
}

function kindsMarkup() {
  return html`${M.kinds.map((k) => html`<button class="cat ${ui.kind === k.kind ? "on" : ""}" data-kind="${k.kind}" data-key="${k.kind}" aria-pressed="${ui.kind === k.kind ? "true" : "false"}">
    <span class="t">${k.label}</span><span class="b">${k.count}</span>
  </button>`)}`;
}

function headerRows(m) {
  const rows = [["To", m.toName ? `${m.toName} <${m.to}>` : m.to]];
  if (m.cc && m.cc.length) rows.push(["Cc", m.cc.join(", ")]);
  rows.push(["Subject", m.subject]);
  for (const [name, value] of Object.entries(m.headers || {})) rows.push([name, String(value)]);
  return rows;
}

function messageMarkup(m) {
  const open = ui.open === m.id;
  return html`<div class="card" data-key="${m.id}" style="margin-top: 10px; overflow: hidden;">
    <button type="button" class="row" data-msg="${m.id}" style="width: 100%; border: 0; background: none; text-align: left; font: inherit; padding: 14px 18px; display: flex; gap: 14px; align-items: center; cursor: pointer;">
      <span style="min-width: 0; flex: 1;">
        <span style="display: block; font-size: 13px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${m.subject || "(no subject)"}</span>
        <span class="small muted" style="display: block; margin-top: 3px;">${m.kindLabel} · to ${m.to}${m.cc.length ? ` · cc ${m.cc.length}` : ""} · ${since(m.createdAt)}</span>
      </span>
      ${m.draftOnly ? tag("draft only", "yellow", { pad: true }) : tag(m.status, TONE[m.status] || "grey", { pad: true })}
      ${icon(open ? "chevD" : "chevR", 16)}
    </button>
    ${open ? html`<div style="border-top: 1px solid var(--line-soft); padding: 16px 18px; background: var(--card-soft);">
      <div class="sect">AS IT WILL BE SENT</div>
      <table style="margin-top: 8px; border-collapse: collapse; width: 100%;">
        ${headerRows(m).map(([k, val]) => html`<tr data-key="${k}">
          <td class="small muted" style="padding: 3px 14px 3px 0; vertical-align: top; white-space: nowrap;">${k}</td>
          <td class="small" style="padding: 3px 0; word-break: break-word;"><code>${val}</code></td></tr>`)}
      </table>
      ${m.attachments.length ? html`<div class="small muted" style="margin-top: 10px;">${plural(m.attachments.length, "attachment")}: ${m.attachments.map((a) => a.filename).join(", ")}</div>` : ""}
      <div class="sect" style="margin-top: 16px;">BODY</div>
      <pre style="margin-top: 8px; white-space: pre-wrap; font: 13.5px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--ink);">${body[m.id] === undefined ? "Loading…" : body[m.id]}</pre>
      ${m.lastError ? html`<div class="field-msg block" style="margin-top: 12px;">${icon("bang", 14)}<span>Last attempt failed (${m.sendAttempts}): ${m.lastError}</span></div>` : ""}
      ${m.afeId ? html`<a class="small" href="/afe/${m.afeId}" style="font-weight: 700; display: inline-block; margin-top: 12px;">Open ${m.afeId} →</a>` : ""}
    </div>` : ""}
  </div>`;
}

function listMarkup() {
  // The list is asked for BY KIND, so it matches the count on the kind: filtering the newest 200
  // in the browser showed fewer than the count said, or "nothing here" under a non-zero count.
  const shown = M.messages;
  if (!shown.length) return emptyState(ui.kind || ui.status ? "None like that." : "Nothing yet — every message the tool produces lands here.");
  return html`<div data-key="list-${ui.kind || "all"}">${shown.map(messageMarkup)}</div>
    ${M.matching > M.shown ? html`<button type="button" class="linkbtn" id="more-mail" style="padding: 12px 18px;">Show ${Math.min(200, M.matching - M.shown)} more of ${M.matching}</button>` : ""}`;
}
async function fetchList(limit) {
  const q = new URLSearchParams();
  if (ui.kind) q.set("kind", ui.kind);
  if (ui.status) q.set("status", ui.status);
  q.set("limit", String(limit || 200));
  M = await store.get(`/api/mailbox?${q.toString()}`, { fresh: true });
}

function markup() {
  return html`<div class="page pane">
    <h1 class="h1">Mailbox.</h1>
    <div class="sub">Every message the tool has produced, exactly as it will be sent.${tip("Nothing here was typed by anyone — each message came out of a rule. Until the shared mailbox is connected nothing leaves; the red-flag digest is a draft by policy and is never sent by the tool.")}</div>
    <div style="margin-top: 18px;">${header()}</div>
    <div class="cats" id="kinds" style="margin-top: 18px;">${kindsMarkup()}</div>
    <div id="msgs" style="margin-top: 6px;">${listMarkup()}</div>
    <div class="small muted" style="margin-top: 18px;">Showing ${M.shown} of ${M.matching}.</div>
  </div>`;
}

async function openMessage(id) {
  ui.open = ui.open === id ? null : id;
  morph($("#msgs", root), listMarkup());
  if (ui.open && body[id] === undefined) {
    try { body[id] = (await store.get(`/api/mailbox/${encodeURIComponent(id)}`, { fresh: true })).body || "(empty)"; }
    catch (e) { body[id] = `Could not load the body: ${e.message}`; }
    if (ui.open === id) morph($("#msgs", root), listMarkup());
  }
}

export async function render(el, ctx) {
  root = el;
  try { await fetchList(); }
  catch (e) { showError(e); M = { delivery: {}, counts: { queued: 0, sent: 0, drafted: 0, failed: 0 }, kinds: [], messages: [], shown: 0, matching: 0 }; }
  if (ui.kind && !M.kinds.some((k) => k.kind === ui.kind)) ui.kind = null;
  morph(el, markup());
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  on(el, "click", "[data-kind]", async (e, b) => {
    ui.kind = ui.kind === b.dataset.kind ? null : b.dataset.kind;   // design rule 4
    morph($("#kinds", el), kindsMarkup());
    try { await fetchList(); } catch (err) { showError(err); }
    morph(el, markup());
  });
  on(el, "click", "[data-status]", async (e, b) => {
    ui.status = ui.status === b.dataset.status ? null : b.dataset.status;
    try { await fetchList(); } catch (err) { showError(err); }
    morph(el, markup());
  });
  on(el, "click", "#more-mail", async () => {
    try { await fetchList(Math.min(500, M.shown + 200)); } catch (err) { showError(err); }
    morph(el, markup());
  });
  on(el, "click", "[data-msg]", (e, b) => openMessage(b.dataset.msg));
}

export function unmount() { if (root) { delete root.dataset.wired; root.innerHTML = ""; } root = null; }
