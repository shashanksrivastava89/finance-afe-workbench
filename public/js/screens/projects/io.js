// /io/:ioNumber — one internal order. The four numbers, what is behind each of them, the other
// orders on the same AFE, and how it got here.
//
// Every figure is SAP's, joined at read time; the tool's own contribution is the allocation and
// the moves. A number with rows behind it is a control (design rule 3): the tiles open the
// purchase orders, the sibling orders open their own page.
import { html, morph, on, $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { store, uiFor } from "../../core/store.js";
import { navigate } from "../../core/router.js";
import { setRecord, setRecordNote, setActive } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, moneyCompact, date, since, plural } from "../../core/format.js";
import { tag, emptyState, panel, spine, slipChart, moneyCell, when, avatar } from "../../components/parts.js";
import { sheet, toast, showError, opening, loadFailed } from "../../core/ui.js";
import { bringTo } from "../../core/motion.js";

const ui = uiFor("io");
const S = { number: null, data: null, root: null, wiredTo: null };
const io = () => S.data.io;
const project = () => S.data.project;
const perms = () => (S.data.project && S.data.project.permissions) || {};
const isFa = () => Boolean(perms().isFa);
const FLAG_AT = 0.8;                       // the AUC review's own 80 % population rule

async function load() { S.data = await api.get(`/api/io/${encodeURIComponent(S.number)}`); }
function paint() { if (S.root && S.data) morph(S.root, markup()); }

// ---- the numbers ------------------------------------------------------------------------------
function tiles() {
  const f = S.data.figures;
  if (!f) return html`<div class="card pad" data-key="no-figures"><span class="muted">SAP has not reported on this order yet. The tool allocated ${money((io() || {}).allocatedBudgetUsd)} to it; budget, actual and commitment arrive with the next extract.</span></div>`;
  const open = ui.open || null;
  // A figure with rows behind it is a button; one without is drawn as a figure (design rule 3).
  // "Budget" and "Still available" were buttons that opened nothing.
  const t = (key, value, label, tone, sub, glyph, live) => {
    const inner = html`<span class="thead"><span class="ico">${icon(glyph || "coins", 13)}</span><span class="tv">${moneyCompact(value)}</span></span>
    <span class="tl">${label}</span>${sub ? html`<span class="ts">${sub}</span>` : ""}`;
    return live
      ? html`<button class="tile ${open === key ? "on" : ""} ${tone || ""}" data-tile="${key}" data-key="${key}" aria-pressed="${open === key ? "true" : "false"}">${inner}</button>`
      : html`<div class="tile static ${tone || ""}" data-key="${key}">${inner}</div>`;
  };
  const invoiced = S.data.poLines.filter((p) => p.invoicedUsd > 0).length;
  const openPos = S.data.poLines.filter((p) => p.stillToInvoiceUsd > 0).length;
  const p = project();
  const moves = (p ? p.moves : S.data.moves) || [];
  return html`<div class="tiles four" id="tiles">
    ${moves.length
      ? html`<button class="tile" data-jump="moves" data-key="budget"><span class="thead"><span class="ico">${icon("coins", 13)}</span><span class="tv">${moneyCompact(f.budgetUsd)}</span></span><span class="tl">Budget on the order</span><span class="ts">${moves.length} ${plural(moves.length, "move")} — show them</span></button>`
      : t("budget", f.budgetUsd, "Budget on the order", "", f.inExtract ? "" : "allocated here, not in SAP yet", "coins", false)}
    ${t("spent", f.actualUsd, `Spent${invoiced ? ` · ${invoiced} invoiced ${plural(invoiced, "PO")}` : ""}`, "green", invoiced ? "open the invoices" : "", "doc", invoiced > 0)}
    ${t("committed", f.commitmentUsd, `Committed${openPos ? ` · ${openPos} open ${plural(openPos, "PO")}` : ""}`, "blue", openPos ? "open the orders" : "", "clock", openPos > 0)}
    ${t("available", f.availableUsd, "Still available", f.availableUsd < 0 ? "red" : "", f.availableUsd < 0 ? "budget less spent and committed — over" : "budget less spent and committed", f.availableUsd < 0 ? "bang" : "trend", false)}
  </div>`;
}
function progress() {
  const f = S.data.figures;
  if (!f || !f.budgetUsd) return "";
  const used = Math.min(100, Math.round(((f.actualUsd + f.commitmentUsd) / f.budgetUsd) * 100));
  return html`<div class="card pad" data-key="progress">
    <div style="display: flex; justify-content: space-between; align-items: baseline; font-size: 12.5px; color: var(--muted); margin-bottom: 10px; gap: 16px; flex-wrap: wrap;">
      <span><b style="color: var(--ink); font-size: 14.5px;">${used}%</b> used or committed</span>
      <span>At <b style="color: var(--red);">${Math.round(FLAG_AT * 100)}%</b> Fixed Assets asks for the in-service date — the AuC review's own rule, one email, a link back here.</span>
    </div>
    <div class="track"><i style="width: ${used}%"></i><span class="mark" style="left: ${Math.round(FLAG_AT * 100)}%"></span></div>
  </div>`;
}
function poCard() {
  const key = ui.open;
  const all = S.data.poLines;
  if (!key || !["spent", "committed"].includes(key)) return "";
  const lines = key === "spent" ? all.filter((p) => p.invoicedUsd > 0) : all.filter((p) => p.stillToInvoiceUsd > 0);
  return html`<div class="card" style="overflow: hidden;" data-key="po-${key}">
    <div class="tabhd" style="border-top: 0; display: flex; justify-content: space-between;"><span>${key === "spent" ? "SPENT · INVOICED PURCHASE ORDERS" : "COMMITTED · OPEN PURCHASE ORDERS"}</span><span>${lines.length ? `${lines.length} ${plural(lines.length, "line")}` : ""}</span></div>
    ${lines.length ? lines.map((p) => html`<div class="po" data-key="${p.poNumber}-${p.item || ""}">
      <span class="mono">${p.poNumber}${p.item ? `/${p.item}` : ""}</span>
      <span style="min-width: 0;"><b>${p.vendor || "(no vendor)"}</b>${p.description ? ` — ${p.description}` : ""}</span>
      <span class="num">${money(key === "spent" ? p.invoicedUsd : p.stillToInvoiceUsd, { cents: true })}</span>
      <span class="small muted">${p.docDate ? date(p.docDate) : ""}</span>
    </div>`) : emptyState(key === "spent" ? "Nothing invoiced against this order yet." : "No open purchase orders.")}
  </div>`;
}

// ---- the other orders on the same AFE -----------------------------------------------------------
function familyCard() {
  const p = project();
  if (!p) return "";
  const rows = p.ios;
  const plan = p.plan.filter((l) => !l.recorded);
  return panel({ tone: "grey", icon: "box", title: "The orders on this AFE", key: "family",
    meta: p.allocation.balanced ? `${money(p.allocation.allocatedUsd)} allocated` : `${money(p.allocation.unallocatedUsd)} unallocated`,
    flush: true, children: html`
${rows.map((r) => { const here = r.ioNumber === S.number;
      // THE DEAD CLICK. This row was an `<a href>` to the page you are already on, chevron and
      // all: the router intercepted it, re-rendered byte-identical markup and pushed a junk
      // history entry. It looked like a destination and was a no-op. The row you are on is a
      // row, not a link — no chevron, `aria-current`, and it says so.
      const inner = html`<span class="tick ${here ? "ok" : "off"}">${here ? icon("tick", 15, { stroke: 2.4 }) : ""}</span>
      <span class="fv"><span class="f">${r.kind === "parent" ? "Parent" : r.site || r.country || "child"}${here ? html`<i class="hererow">you are here</i>` : ""}</span><span class="v">${r.ioNumber}<span class="note">${money(r.allocatedBudgetUsd)} allocated${r.figures.inExtract ? ` · ${money(r.figures.actualUsd)} spent · ${money(r.figures.availableUsd)} left` : " · not in the extract yet"}${r.moves ? ` · ${r.moves} ${plural(r.moves, "move")}` : ""}</span></span></span>
      ${here ? html`<span></span>` : html`<span class="chev">${icon("chevR", 16)}</span>`}`;
      return here
        ? html`<div class="korow copied" data-key="${r.ioNumber}" aria-current="page">${inner}</div>`
        : html`<a class="korow" href="/io/${r.ioNumber}" data-key="${r.ioNumber}" style="text-decoration: none; color: inherit;">${inner}</a>`;
    })}
    ${plan.length ? html`<div style="padding: 12px 18px; border-top: 1px solid var(--line-soft); font-size: 12.5px; color: var(--ink-2);">
      ${plan.length} cost ${plural(plan.length, "line")} without an order: ${plan.map((l) => `${l.site} (${money(l.amountUsd)})`).join(", ")}.
      ${isFa() ? html` <button type="button" class="linkbtn" id="add-child">Give one its own order</button>` : ""}
    </div>` : ""}
    ${isFa() && rows.length > 1 ? html`<div style="padding: 12px 18px; border-top: 1px solid var(--line-soft);"><button type="button" class="linkbtn" id="move-budget">Move budget between these orders</button></div>` : ""}
  ` });
}
function movesCard() {
  const p = project();
  const moves = p ? p.moves : S.data.moves;
  if (!moves || !moves.length) return "";
  return panel({ tone: "grey", icon: "swap", title: "Budget moved", meta: "± pairs — the total never changes", key: "moves", flush: true, children: html`
    ${moves.map((m, i) => html`<div class="korow" data-key="m${i}">
      <span class="tick off">${icon("swap", 14)}</span>
      <span class="fv"><span class="f">${m.fromIo} → ${m.toIo}</span><span class="v">${money(m.amountUsd)}<span class="note">${m.note} · ${m.byName} · ${when(m.at)}</span></span></span>
      <span></span>
    </div>`)}
  ` });
}
/**
 * The recon lines for this order, grouped by the AuC they belong to (R132).
 *
 * The extract carries ONE ROW PER GL ACCOUNT, so an order can appear several times under a single
 * AuC number: 310480 has three — CIP_Furniture & Fixtures at $12,277,040, Manual Furniture &
 * Fixtures at $0, and Manual CIP-Machinery at −$24,123. The screen drew each as a full block, so
 * the number, status, age, reviewer and owner — identical on all three — were repeated three times;
 * the date history and the follow-up thread were drawn three times over, because they are
 * byte-identical across the lines of one AuC; and the one thing that actually DIFFERED, the
 * balance, appeared as three separate facts with no total. The AuC's real balance,
 * $12,252,917.45, was nowhere on the screen, and a negative GL line sat in the middle of it where
 * nobody would look twice.
 *
 * Identity once, the GL lines as rows, and the total they come to.
 */
function aucGroups() {
  const rows = S.data.auc || [];
  const by = new Map();
  for (const t of rows) {
    const key = t.aucNumber || "(none)";
    if (!by.has(key)) by.set(key, { aucNumber: t.aucNumber, head: t, lines: [] });
    const g = by.get(key);
    // The head carries the age, reviewer and owner, so take it from the line with the most
    // substance behind it rather than from whichever happened to sort first.
    if (Math.abs(Number(t.endingBalance) || 0) > Math.abs(Number(g.head.endingBalance) || 0)) g.head = t;
    g.lines.push(t);
  }
  return Array.from(by.values()).map((g) => Object.assign(g, {
    total: g.lines.reduce((n, t) => n + (Number(t.endingBalance) || 0), 0),
  }));
}

/** The identifying facts of the AuC — short, and therefore fine in the rail. */
function aucFactsCard() {
  const groups = aucGroups();
  if (!groups.length) return "";
  return html`${groups.map((g) => { const t = g.head;
    return panel({ tone: "grey", icon: "box", title: "Asset under construction", key: "auc-" + (g.aucNumber || "x"),
      meta: g.lines.length > 1 ? `${g.lines.length} GL lines` : "",
      children: html`<div class="aucfacts" data-key="${g.aucNumber}">
    <div class="row"><span>Number</span><b>${g.aucNumber || "(none yet)"}</b></div>
    <div class="row"><span>Status</span><b>${t.aucStatus || t.openClosed}</b></div>
    ${g.lines.length > 1
      ? html`<div class="glset">
          <div class="glhd">Balance by GL account</div>
          ${g.lines.slice().sort((a, b) => (Number(b.endingBalance) || 0) - (Number(a.endingBalance) || 0)).map((l) => html`<div class="glrow ${(Number(l.endingBalance) || 0) < 0 ? "neg" : ""}" data-key="${l.id}">
            <span class="g">${l.glAccount || ""}<i>${l.glDescription || ""}</i></span>${moneyCell(l.endingBalance)}
          </div>`)}
          <div class="glrow tot"><span class="g">Total on this AuC</span>${moneyCell(g.total)}</div>
        </div>`
      : html`<div class="row"><span>Balance</span>${moneyCell(g.total)}</div>`}
    ${t.flags.consumedPct !== null ? html`<div class="row"><span>Consumed</span><b>${Math.round(t.flags.consumedPct * 100)}%</b></div>` : ""}
    ${t.flags.ageingDays !== null ? html`<div class="row"><span>Age</span><b>${t.flags.ageingDays} days</b></div>` : ""}
    ${t.reviewerName ? html`<div class="row"><span>Reviewer</span><b>${t.reviewerName}</b></div>` : ""}
    ${t.contactPersonName ? html`<div class="row"><span>Owner</span><b>${t.contactPersonName}</b></div>` : ""}
    ${g.lines.some((l) => l.flags.followUpNeeded) ? html`<div style="margin-top: 8px;">${tag(`In the ${S.data.reviewPeriod || "current"} review`, "yellow", { icon: "flag", title: "The quarterly AuC review covers lines that are ≥ 80% consumed, aged ≥ 6 months, or over $100K — unless a go-live is confirmed beyond the period." })}</div>` : ""}
  </div>` });
  })}`;
}

/**
 * The story of the line: how the date has moved, and what everyone has said about it.
 *
 * This is what the main pane was missing. It used to be two things crushed into a 380px rail —
 * the last of 22 re-forecasts as one chip, and up to 3,249 characters of follow-up history as a
 * single collapsed paragraph. Both are conversations with a shape, and both get the wide column.
 */
function storyCards() {
  const groups = aucGroups();
  if (!groups.length) return "";
  // ONE chart and ONE thread per AuC. They were drawn per GL LINE and the history is identical
  // across the lines of an AuC, so 310480 rendered the same 7-point chart three times and the
  // same 14-entry thread three times, one after another.
  return html`${groups.map((g) => { const t = g.head;
    const th = t.thread || [];
    const all = ui.thread === t.id;
    const shown = all ? th : th.slice(-6);
    return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="story-${t.id}">
      ${(t.esdHistory || []).length > 1 ? panel({ tone: "yellow", icon: "calendar", title: "When it was meant to be in service",
        meta: (t.esdHistory || []).slice(-1).map((e) => `latest: ${date(e.estimatedServiceDate)}`)[0],
        key: "slip-" + t.id,
        children: slipChart(t.esdHistory, { issueDate: t.issueDate, jump: (t.thread || []).length > 0 }) }) : ""}
      ${panel({ tone: "grey", icon: "mail", title: "The follow-up history", meta: `${th.length} ${plural(th.length, "entry", "entries")}`,
        key: "thread-" + t.id,
        right: t.canReply ? html`<button type="button" class="pillbtn sm" data-esd="${t.id}">${icon("pen", 13)}Record an update</button>` : "",
        children: th.length ? html`<div class="thread">${shown.map((e, i) => html`<div class="tmsg ${e.kind === "reviewer_note" ? "reviewer" : ""} ${e.dated ? "" : "undated"}" data-key="m${e.seq}" data-mid="${t.id}:${e.seq}">
            ${avatar(e.author || "?", e.kind === "reviewer_note" ? "blue" : "grey")}
            <div style="min-width: 0;"><div class="who">${e.author || (e.kind === "reviewer_note" ? "Reviewer" : "Fixed Assets")}<span class="at">${e.dated ? date(e.at) : "undated"}</span></div><div class="body">${e.text}</div></div>
          </div>`)}</div>
          ${th.length > 6 ? html`<button type="button" class="linkbtn threadmore" data-thread="${t.id}">${all ? "Show the last six" : `Show all ${th.length}`}</button>` : ""}`
          : emptyState("Nothing has been recorded against this line yet.") })}
    </div>`;
  })}`;
}
/**
 * Go to the follow-up entry nearest a promised date, and ring it.
 *
 * Prefers an entry that actually NAMES the date — the workbook often writes "Est. 3/31/2026" —
 * and otherwise takes the nearest in time. The thread is expanded first when the target is
 * outside the last six, because scrolling to something that is not rendered does nothing.
 */
function jumpToThread(iso) {
  const when = Date.parse(iso);
  if (!isFinite(when)) return;
  const groups = aucGroups();
  let best = null;
  for (const g of groups) {
    const th = g.head.thread || [];
    for (const entry of th) {
      const named = namesTheDate(entry.text, iso);
      const at = Date.parse(entry.at);
      const gap = isFinite(at) ? Math.abs(at - when) : Number.MAX_SAFE_INTEGER;
      const score = named ? -1 : gap;                    // a named date beats any proximity
      if (!best || score < best.score) best = { score, id: `${g.head.id}:${entry.seq}`, group: g.head.id, idx: th.indexOf(entry), n: th.length };
    }
  }
  if (!best) return;
  // Expand when the target is outside the last six the panel shows by default.
  // `paint()` is synchronous — `morph` has finished by the time it returns — so the element is
  // there to be found straight away. It was behind a `requestAnimationFrame`, which is the
  // reflex and the wrong one here: rAF does not fire at all in a hidden tab, so the jump did
  // nothing whenever the document was not being painted.
  if (best.idx < best.n - 6 && ui.thread !== best.group) { ui.thread = best.group; paint(); }
  const el = $(`[data-mid="${best.id}"]`, S.root || document);
  if (el) bringTo(el);
}

/** Does this entry's text name that date? The workbook writes it half a dozen ways. */
function namesTheDate(text, iso) {
  const d = new Date(iso);
  if (!isFinite(d)) return false;
  const M = d.getUTCMonth() + 1, D = d.getUTCDate(), Y = d.getUTCFullYear();
  const pad = (n) => String(n).padStart(2, "0");
  const forms = [`${M}/${D}/${Y}`, `${M}/${D}/${String(Y).slice(2)}`, `${pad(M)}/${pad(D)}/${Y}`,
    `${pad(M)}/${pad(D)}/${String(Y).slice(2)}`, `${M}/${D}`, `${pad(M)}/${pad(D)}`];
  return forms.some((f) => String(text || "").includes(f));
}

/** The reviewer's answer, recorded against the line it is about. */
async function recordUpdate(lineId) {
  const line = (S.data.auc || []).find((t) => t.id === lineId);
  const r = await sheet({
    eyebrow: "IN-SERVICE DATE", title: line && line.ioDescription ? line.ioDescription : `Internal order ${S.number}`,
    sub: "What the project owner said. It is kept as a dated comment, the way the recon workbook keeps it.",
    body: html`<label class="small muted">Expected in service<input class="input" id="esd-date" type="date" value="${(line && (line.esdHistory || []).slice(-1)[0] || {}).estimatedServiceDate ? String((line.esdHistory.slice(-1)[0]).estimatedServiceDate).slice(0, 10) : ""}" style="margin-top: 4px;"></label>
      <textarea class="input" id="esd-note" rows="3" placeholder="What they said — e.g. commissioning booked for the week of 25 Aug; in service by 15 Sep." style="margin-top: 12px;"></textarea>
      <label style="display: flex; gap: 10px; align-items: flex-start; margin-top: 12px; font-size: 12.5px;"><input type="checkbox" id="esd-firm" style="margin-top: 3px;"><span>They committed to this date. <span class="muted">A committed date beyond this period takes the line out of the review; an estimate does not.</span></span></label>`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Save the update", value: "ok", primary: true }],
    validate: (el) => (!$("#esd-date", el).value && !$("#esd-note", el).value.trim() ? "A date or a comment, at least." : null),
    collect: (el) => ({ estimatedServiceDate: $("#esd-date", el).value || null, comment: $("#esd-note", el).value.trim(), firm: $("#esd-firm", el).checked }),
  });
  if (r.value !== "ok") return;
  try {
    await api.post(`/api/auc-review/lines/${lineId}/reply`, Object.assign({ reviewerName: (line && line.reviewerName) || null }, r.data));
    store.bust("/api/auc-review"); store.bust("/api/tracker");
    toast(r.data.firm ? "Recorded — the line leaves this quarter's review." : "Recorded.", "ok");
    await load(); paint();
  } catch (e) { showError(e); }
}
function timelineCard() {
  const p = project();
  if (!p || !p.timeline || !p.timeline.length) return "";
  const rows = p.timeline.slice().reverse();
  return panel({ tone: "green", icon: "clock", title: "How it got here", meta: `${rows.length} ${plural(rows.length, "event")}`, key: "timeline",
    children: spine(rows) });
}

// `findingsBanner()` lived here and read `p.findings`, which THIS route has never set — only the
// by-AFE project route does. It rendered "" on every visit since the day it was written. Deleted
// rather than wired, because nothing asked for it.

function markup() {
  const p = project(), row = io(), f = S.data.figures, m = S.data.master;
  const a = p ? p.afe : null;
  const issued = row ? row.issuedAt : (m && m.createdOn) || null;
  const daysIn = issued ? Math.floor((Date.now() - new Date(issued).getTime()) / 86400000) : null;
  const title = (a && a.title) || (row && row.description) || (m && m.description) || (S.data.auc[0] && S.data.auc[0].ioDescription) || `Internal order ${S.number}`;
  return html`<div class="page pane">
    <div class="dec-head">
      <div style="min-width: 0; flex: 1;">
        <div class="small muted"><a href="${S.back.href}" style="font-weight: 700;">‹ ${S.back.label}</a> · ${a && a.requester ? a.requester.name + " · " : ""}${row && row.division ? row.division + " · " : ""}${(row && row.costCenter) || (m && m.costCenter) ? `cost centre ${(row && row.costCenter) || m.costCenter}` : ""}</div>
        <div class="chips" style="margin-top: 8px;">
          ${tag(`IO ${S.number}`, "blue")}
          ${row && row.kind === "child" ? tag(`child of ${row.parentIoNumber}${row.site ? ` · ${row.site}` : ""}`, "grey") : row ? tag("parent order", "grey") : ""}
          ${(row && row.orderType) || (m && m.orderType) ? tag((row && row.orderType) || m.orderType, "grey") : ""}
          ${daysIn !== null ? tag(`day ${daysIn}`, daysIn > 180 ? "yellow" : "grey") : ""}
          ${row && row.aucNumber ? tag(`AuC ${row.aucNumber}`, "") : ""}
          ${!p ? tag("predates the workbench", "grey", { icon: "clock" }) : ""}
        </div>
        <h1 class="h1" style="margin-top: 10px;">${title}</h1>
        ${a ? html`<div class="sub">${a.description || ""}</div>` : ""}
      </div>
      ${a ? html`<div style="text-align: right;"><div class="big-amt">${money(f ? f.budgetUsd : (row && row.allocatedBudgetUsd) || 0)}</div><a class="small" href="/afe/${a.id}" style="font-weight: 700;">Open the AFE →</a></div>` : ""}
    </div>
    <div style="margin-top: 18px; display: flex; flex-direction: column; gap: 14px;">
      ${tiles()}
      ${poCard()}
      ${progress()}
      <div class="split" style="align-items: start;">
        <div style="display: flex; flex-direction: column; gap: 14px;">
          ${storyCards()}
          ${familyCard()}
          ${movesCard()}
        </div>
        <div style="display: flex; flex-direction: column; gap: 14px;">
          ${aucFactsCard()}
          ${timelineCard()}
          ${p && p.afe.steps ? panel({ tone: "blue", icon: "cog", title: "SAP steps", key: "steps", children: html`<div style="display: flex; flex-direction: column; gap: 8px; font-size: 12.5px;">
              ${[["KO01_IO", "Order created"], ["KO22_BUDGET", "Budget loaded"], ["AS01_AUC", "Asset under construction"], ["KO02_SETTLEMENT", "Settlement rule"]].map(([k, l]) => html`<div style="display: flex; gap: 10px; align-items: center;" data-key="${k}"><span class="tick ${p.afe.steps[k] ? "ok" : "off"}" style="width: 22px; height: 22px;">${p.afe.steps[k] ? icon("tick", 12, { stroke: 2.6 }) : ""}</span><span>${l}${p.afe.steps[k] && p.afe.steps[k].value ? ` · ${p.afe.steps[k].value}` : ""}</span></div>`)}
            </div>
            ${isFa() ? html`<a class="small" href="/fa/${p.afe.id}/issue" style="font-weight: 700; display: inline-block; margin-top: 10px;">Continue in SAP →</a>` : ""}` }) : ""}
          ${p && p.extract ? html`<div class="small muted" style="padding: 0 4px;">SAP extract ${p.extract.asOfDate || p.extract.batchId}${p.extract.importedAt ? html`, loaded ${when(p.extract.importedAt)}` : ""}. The tool never writes to SAP.</div>` : ""}
        </div>
      </div>
    </div>
  </div>`;
}

// ---- what Fixed Assets can do from here ------------------------------------------------------------
async function addChild() {
  const p = project();
  const plan = p.plan.filter((l) => !l.recorded);
  const r = await sheet({
    eyebrow: "A COST LINE GETS ITS OWN ORDER", title: "Which line, and what number did SAP give it?",
    sub: "The budget moves out of the parent order as a ± pair, so the approved total never changes.",
    body: html`<div class="chips">${plan.map((l) => html`<button type="button" class="chip sm ${plan.length === 1 ? "on" : ""}" data-seq="${l.seq}">${l.site} · ${money(l.amountUsd)}</button>`)}</div>
      <input class="input" id="child-io" inputmode="numeric" placeholder="Order number SAP assigned — e.g. 313406" autocomplete="off" style="margin-top: 14px; height: 52px; font-size: 15.5px; font-weight: 700;">`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Record the order", value: "ok", primary: true }],
    validate: (el) => { if (!$(".chip.on[data-seq]", el)) return "Pick the cost line."; if (!/^\d{6,10}$/.test($("#child-io", el).value.trim())) return "The order number is 6 to 10 digits."; return null; },
    collect: (el) => ({ seq: Number(($(".chip.on[data-seq]", el) || { dataset: {} }).dataset.seq), ioNumber: $("#child-io", el).value.trim() }),
    onMount: (el) => on(el, "click", "[data-seq]", (e, b) => { for (const x of el.querySelectorAll("[data-seq]")) x.classList.toggle("on", x === b); }),
  });
  if (r.value !== "ok") return;
  try {
    const out = await api.post(`/api/projects/${p.afe.id}/ios`, r.data);
    store.bust("/api"); toast(out.note || "Order recorded.", "ok");
    await navigate(`/io/${r.data.ioNumber}`);
  } catch (e) { showError(e); }
}
async function moveBudget() {
  const p = project();
  const rows = p.ios;
  const r = await sheet({
    eyebrow: "MOVE BUDGET", title: "Between which orders?",
    sub: "Recorded as a reduction on one and an addition on the other, the way the tracker does it. Post the matching KO22 changes in SAP.",
    body: html`<div class="sect">FROM</div><div class="chips" style="margin-top: 8px;">${rows.map((x) => html`<button type="button" class="chip sm ${x.ioNumber === S.number ? "on" : ""}" data-from="${x.ioNumber}">${x.ioNumber} · ${money(x.allocatedBudgetUsd)}</button>`)}</div>
      <div class="sect" style="margin-top: 14px;">TO</div><div class="chips" style="margin-top: 8px;">${rows.map((x) => html`<button type="button" class="chip sm" data-to="${x.ioNumber}">${x.ioNumber} · ${x.site || "parent"}</button>`)}</div>
      <input class="input" id="mv-amount" inputmode="decimal" placeholder="How much? e.g. 15000" autocomplete="off" style="margin-top: 14px;">
      <input class="input" id="mv-note" placeholder="Why — printed on both orders and audited" style="margin-top: 10px;">`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Move it", value: "ok", primary: true }],
    validate: (el) => {
      const f = $(".chip.on[data-from]", el), t = $(".chip.on[data-to]", el);
      if (!f || !t) return "Pick both orders.";
      if (f.dataset.from === t.dataset.to) return "Pick two different orders.";
      if (!(Number(String($("#mv-amount", el).value).replace(/[^0-9.]/g, "")) > 0)) return "How much is moving?";
      if (!$("#mv-note", el).value.trim()) return "Say why — it is audited.";
      return null;
    },
    collect: (el) => ({ fromIo: ($(".chip.on[data-from]", el) || { dataset: {} }).dataset.from, toIo: ($(".chip.on[data-to]", el) || { dataset: {} }).dataset.to,
      amountUsd: Number(String($("#mv-amount", el).value).replace(/[^0-9.]/g, "")), note: $("#mv-note", el).value.trim() }),
    onMount: (el) => {
      on(el, "click", "[data-from]", (e, b) => { for (const x of el.querySelectorAll("[data-from]")) x.classList.toggle("on", x === b); });
      on(el, "click", "[data-to]", (e, b) => { for (const x of el.querySelectorAll("[data-to]")) x.classList.toggle("on", x === b); });
    },
  });
  if (r.value !== "ok") return;
  try {
    const out = await api.post(`/api/projects/${p.afe.id}/budget-moves`, r.data);
    store.bust("/api"); toast(out.note || "Moved.", "ok");
    await load(); paint();
  } catch (e) { showError(e); }
}

/**
 * Where the reader came from, so the way back goes there and the top bar stays on that section
 * (2026-10-16). An order opened from the tracker, the quarterly review or the portfolio switched
 * the nav to Projects and offered only "‹ Projects" — both branches of the old link were the
 * same — and Fixed Assets or leadership lost their place in a long, filtered list.
 */
const FROM = {
  tracker: { href: "/tracker", label: "AuC tracker", section: "fa" },
  review: { href: "/auc-review", label: "Quarterly review", section: "fa" },
  portfolio: { href: "/leadership", label: "Portfolio", section: "leadership" },
  fa: { href: "/fa", label: "Fixed Assets", section: "fa" },
};
function back(ctx) {
  const f = FROM[(ctx && ctx.query && ctx.query.from) || ""];
  return f ? { href: f.href, label: f.label, section: f.section } : { href: "/projects", label: "Projects", section: "projects" };
}

export async function render(root, ctx) {
  S.number = ctx.params.ioNumber; S.root = root; S.back = back(ctx);
  setActive(S.back.section);
  const wait = opening(root, `Opening order ${S.number}…`, back(ctx));
  try { await load(); } catch (e) { wait(); delete root.dataset.io; loadFailed(root, e, back(ctx)); return; }
  wait();
  setRecord({ id: `IO ${S.number}` });
  if (!root.dataset.io) { root.innerHTML = ""; root.dataset.io = "1"; }
  if (S.wiredTo !== root) {
    S.wiredTo = root;
    on(root, "click", "[data-tile]", (e, b) => { ui.open = ui.open === b.dataset.tile ? null : b.dataset.tile; paint(); });
    on(root, "click", "[data-jump]", (e, b) => bringTo($(`[data-key="${b.dataset.jump}"]`, root)));
    on(root, "click", "[data-esd]", (e, b) => recordUpdate(b.dataset.esd));
    on(root, "click", "[data-thread]", (e, b) => { ui.thread = ui.thread === b.dataset.thread ? null : b.dataset.thread; paint(); });
    // CLICKING A NODE ON THE DATE CHART GOES TO WHAT WAS BEING SAID THEN.
    //
    // It is TEMPORAL navigation, not a causal claim, and the distinction matters: the estimated
    // service date and the follow-up notes come from different columns of the workbook, and only
    // 8% of promises are even mentioned in an entry's text. So where the date IS named we go to
    // that entry, and otherwise to the nearest one in time — which is what "show me what was
    // happening around then" honestly means. Nothing claims the entry caused the change.
    on(root, "click", "[data-jump]", (e, b) => jumpToThread(b.getAttribute("data-jump")));
    on(root, "keydown", "[data-jump]", (e, b) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault(); jumpToThread(b.getAttribute("data-jump"));
    });
    on(root, "click", "#add-child", addChild);
    on(root, "click", "#move-budget", moveBudget);
  }
  paint();
}
export function unmount() { if (S.root) { delete S.root.dataset.io; S.root.innerHTML = ""; } setRecord(null); }
