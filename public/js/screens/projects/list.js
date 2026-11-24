// /projects — every AFE that has an internal order, in the queue vocabulary the coordinator and
// Fixed Assets already use. Four buckets; a row is a project, and its number is the money SAP
// reports against it. Nothing here is typed.
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { icon } from "../../core/icons.js";
import { money, moneyCompact, since, plural, pct, date } from "../../core/format.js";
import { bucket, tag, avatar, emptyState } from "../../components/parts.js";
import { showError } from "../../core/ui.js";
import { can } from "../../core/session.js";

const BUCKETS = [
  { key: "running", title: "Running", tone: "green", icon: "trend" },
  { key: "awaitingBudget", title: "Awaiting budget", tone: "yellow", icon: "coins" },
  { key: "capitalized", title: "Capitalized", tone: "blue", icon: "tick" },
  { key: "closed", title: "Closed", tone: "grey", icon: "lock" },
];
const ui = uiFor("projects");
const EXTRACT_NAME = { matrix: "The approver matrix", io_budget: "The order budgets", io_master: "The order master", po_lines: "The purchase-order lines" };
let P = null;
let root = null;

function detail(key, list) {
  if (!list.length) return { running: "Nothing is running.", awaitingBudget: "Every order has its budget posted.", capitalized: "Nothing capitalized yet.", closed: "Nothing closed." }[key];
  if (key === "running") {
    const spent = list.reduce((n, p) => n + p.totals.actualUsd + p.totals.commitmentUsd, 0);
    const budget = list.reduce((n, p) => n + p.totals.budgetUsd, 0);
    return budget ? `${moneyCompact(spent)} of ${moneyCompact(budget)} used or committed across ${list.length} ${plural(list.length, "project")}.` : `${list.length} ${plural(list.length, "project")} with orders; the SAP figures arrive with the next extract.`;
  }
  if (key === "awaitingBudget") return `The budget is still to load in SAP (KO22) on ${list.length} ${plural(list.length, "order")}. Until it does, SAP shows no budget against them.`;
  if (key === "capitalized") return "Settled to an asset. The quarterly AuC review covers what is still open.";
  return "Closed out.";
}

function bar(p) {
  const b = p.totals.budgetUsd;
  const a = b ? Math.min(100, Math.round((p.totals.actualUsd / b) * 100)) : 0;
  const c = b ? Math.min(100 - a, Math.round((p.totals.commitmentUsd / b) * 100)) : 0;
  return html`<span class="bar" title="${money(p.totals.actualUsd)} spent · ${money(p.totals.commitmentUsd)} committed of ${money(b)}"><i class="al" style="width: ${a}%"></i><i class="cr" style="width: ${c}%"></i></span>`;
}

// "At quarter end I open fifty AFEs to find the fifteen that are internal— if I can apply a
// filter, that can ease out my work" (Imogen, Meeting #6). Where the equipment comes from is a chip,
// and the search reads the title, the order, the requester and the cost centre.
function applyFilters(list) {
  let out = list;
  if (ui.sourcing) out = out.filter((p) => p.sourcing === ui.sourcing);
  if (ui.q) {
    const q = ui.q.toLowerCase();
    out = out.filter((p) => String(p.title || "").toLowerCase().includes(q) || String(p.ioNumber || "").includes(q)
      || String(p.costCenter || "").includes(q) || String((p.requester && p.requester.name) || "").toLowerCase().includes(q)
      || (p.sourcing === "internal" && "acme inventory".includes(q)));
  }
  return out;
}

function row(p) {
  const used = p.totals.budgetUsd ? pct(p.totals.actualUsd + p.totals.commitmentUsd, p.totals.budgetUsd) : null;
  return html`<a class="lrow" href="${p.ioNumber ? `/io/${p.ioNumber}` : `/afe/${p.id}`}" data-key="${p.id}" style="--cols: 44px minmax(0, 1fr) 120px 200px 150px 28px;">
    ${avatar(p.requester ? p.requester.name : "?", p.state === "capitalized" ? "blue" : "", "lg")}
    <span style="min-width: 0;"><span class="ttl">${p.title}</span><span class="id">${p.sourcing === "internal" ? html`<b class="srcmark">${icon("box", 12)}Acme inventory</b> · ` : ""}${p.ioNumber ? `IO ${p.ioNumber}` : "no order"}${p.children ? ` +${p.children} child` : ""}${p.requester ? " · " + p.requester.name : ""}${p.costCenter ? " · cost centre " + p.costCenter : ""}${p.issuedAt ? " · issued " + since(p.issuedAt) : ""}</span></span>
    <span class="amt">${money(p.totals.budgetUsd || p.totalUsd)}</span>
    <span class="wideonly" style="min-width: 0; display: flex; align-items: center; gap: 10px;">${bar(p)}<span class="small muted" style="flex: none;">${used === null ? "—" : used + "%"}</span></span>
    <span class="tagcol" style="min-width: 0;">${!p.steps.KO22_BUDGET ? tag("Budget to load (KO22)", "yellow", { icon: "clock" }) : !p.inExtract ? tag("not in the extract yet", "grey", { icon: "clock" }) : tag(`${money(p.totals.availableUsd)} left`, p.totals.availableUsd < 0 ? "red" : "", { icon: "tick" })}</span>
    <span class="chev">${icon("chevR", 18)}</span>
  </a>`;
}

function bucketsMarkup() {
  return html`${BUCKETS.map((b) => bucket({ key: b.key, n: P.groups[b.key].length, title: b.title, detail: detail(b.key, P.groups[b.key]), tone: b.tone, icon: b.icon, on: ui.open === b.key }))}`;
}
function listMarkup() {
  const b = BUCKETS.find((x) => x.key === ui.open);
  if (!b) return html``;
  const all = P.groups[b.key];
  const L = applyFilters(all);
  const n = (s) => all.filter((p) => p.sourcing === s).length;
  return html`<div class="list" data-key="list-${b.key}">
    <div style="display: flex; align-items: center; gap: 12px; padding: 14px 20px 8px; flex-wrap: wrap;">
      <span class="sect" style="padding: 0;">${b.title.toUpperCase()} · ${L.length} · NEWEST FIRST</span>
      <input class="input" id="pq" type="search" aria-label="Search the projects" placeholder="Title, order, requester, cost centre" value="${ui.q || ""}" style="max-width: 320px; height: 40px; margin-left: auto;" autocomplete="off">
    </div>
    <div class="chips" style="padding: 0 20px 12px;">
      <button type="button" class="chip sm ${ui.sourcing ? "" : "on"}" data-sourcing="" data-key="__all">All · ${all.length}</button>
      <button type="button" class="chip sm ${ui.sourcing === "internal" ? "on" : ""}" data-sourcing="internal" data-key="internal">${icon("box", 13)}Acme inventory · ${n("internal")}</button>
      <button type="button" class="chip sm ${ui.sourcing === "vendor" ? "on" : ""}" data-sourcing="vendor" data-key="vendor">An outside vendor · ${n("vendor")}</button>
    </div>
    ${L.length ? L.map(row) : emptyState(all.length ? "Nothing matches." : "Nothing here right now.")}
  </div>`;
}
function markup() {
  // The budget extract this page's figures come from. It read `P.extract`, which the route never
  // sent, so the page said "no budget extract has been loaded yet" whatever had been loaded.
  const t = P.totals, x = (P.extracts || []).find((e) => e.kind === "io_budget" && e.batchId) || null;
  const stale = (P.extracts || []).filter((e) => e.stale);
  const canExport = can("projects.read");
  return html`<div class="page pane">
    <div style="display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;">
      <div style="min-width: 0;">
        <h1 class="h1">${P.counts.projects ? `${P.counts.projects} ${plural(P.counts.projects, "project")}, ${P.counts.orders} ${plural(P.counts.orders, "order")}.` : "No projects yet."}</h1>
        <div class="sub">An AFE becomes a project when Fixed Assets records its internal order. Budget, actual and commitment are what SAP reports${x ? ` — the extract of ${x.asOfDate ? date(x.asOfDate) : since(x.importedAt)}` : "; no budget extract has been loaded yet"}.</div>
      </div>
      ${canExport ? html`<a class="pillbtn" href="/api/projects/export.csv" download style="margin-left: auto;">${icon("doc", 14)}Export the tracker (CSV)</a>` : ""}
    </div>
    ${stale.length ? html`<div class="banner yellow" style="margin-top: 16px;">${icon("clock", 16)}<span>${stale.map((e) => `${EXTRACT_NAME[e.kind] || e.kind} ${e.batchId ? `is ${e.ageDays} days old` : "has never been loaded"}`).join("; ")}. The figures below are as of the last one that arrived.</span></div>` : ""}
    <div class="kpis">
      <div class="kpi"><div class="k">BUDGET ON THE ORDERS</div><div class="v">${moneyCompact(t.budgetUsd)}</div></div>
      <div class="kpi"><div class="k">SPENT</div><div class="v green">${moneyCompact(t.actualUsd)}</div></div>
      <div class="kpi"><div class="k">COMMITTED</div><div class="v blue">${moneyCompact(t.commitmentUsd)}</div></div>
      <div class="kpi"><div class="k">AVAILABLE</div><div class="v">${moneyCompact(t.availableUsd)}</div></div>
    </div>
    <div class="buckets four" id="buckets">${bucketsMarkup()}</div>
    <div id="bucket-list">${listMarkup()}</div>
  </div>`;
}

export async function render(el) {
  root = el;
    // Paint from what we already have, then correct it when the server answers (R92).
  try {
    P = await store.get("/api/projects", {
      swr: true, onFresh: (d) => { P = d; if (root === el) morph(el, markup()); },
    });
  }
  catch (e) { showError(e); P = { counts: { projects: 0, orders: 0 }, groups: { running: [], awaitingBudget: [], capitalized: [], closed: [] }, totals: { budgetUsd: 0, actualUsd: 0, commitmentUsd: 0, availableUsd: 0 }, extracts: [] }; }
  if (ui.open === undefined) ui.open = P.groups.running.length ? "running" : P.groups.awaitingBudget.length ? "awaitingBudget" : "running";
  if (!el.dataset.projects) { el.innerHTML = ""; el.dataset.projects = "1"; delete el.dataset.wired; }
  morph(el, markup());
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    on(el, "click", "[data-bucket]", (e, b) => { ui.open = ui.open === b.dataset.bucket ? null : b.dataset.bucket; morph($("#buckets", el), bucketsMarkup()); morph($("#bucket-list", el), listMarkup()); });
    // Selecting the selected chip deselects it (rule 4); "All" clears it.
    on(el, "click", "[data-sourcing]", (e, b) => { const s = b.dataset.sourcing || null; ui.sourcing = ui.sourcing === s ? null : s; morph($("#bucket-list", el), listMarkup()); });
    on(el, "input", "#pq", (e, input) => {
      ui.q = input.value.trim();
      const at = input.selectionStart;
      morph($("#bucket-list", el), listMarkup());
      const again = $("#pq", el);
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch { /* fine */ } }
    });
  }
}
export function unmount() { if (root) { delete root.dataset.projects; delete root.dataset.wired; root.innerHTML = ""; } }
