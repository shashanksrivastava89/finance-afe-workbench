// /pots — the coordinator's budget pots: category cards, one open to its regions. Every figure
// is derived from the AFEs; nothing on this screen is typed (R53).
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { icon } from "../../core/icons.js";
import { money, moneyCompact, pct, plural } from "../../core/format.js";
import { tag, emptyState, tip } from "../../components/parts.js";
import { showError } from "../../core/ui.js";

const ui = uiFor("pots");
let P = null;
let root = null;

function bar(row) {
  const c = row.amountUsd ? Math.min(100, Math.round((row.createdUsd / row.amountUsd) * 100)) : 0;
  const a = row.amountUsd ? Math.min(100 - c, Math.round((row.allottedUsd / row.amountUsd) * 100)) : 0;
  return html`<span class="bar"><i class="al" style="width: ${a}%"></i><i class="cr" style="width: ${c}%"></i></span>`;
}
// A pot with AFEs against it is a live pot, and that is worth seeing before it is read: it takes
// the blue ground and the coins glyph, an untouched one stays grey (R109).
function catsMarkup() {
  return html`${P.categories.map((c) => html`<button class="cat ${c.createdUsd ? "blue" : ""} ${ui.open === c.budgetCategory ? "on" : ""}" data-cat="${c.budgetCategory}" data-key="${c.budgetCategory}" aria-pressed="${ui.open === c.budgetCategory ? "true" : "false"}">
    <span class="t">${icon(c.createdUsd ? "coins" : "box", 13)}${c.budgetCategory}</span><span class="b">${moneyCompact(c.amountUsd)}</span>${bar(c)}
    <span class="s">${c.createdUsd ? `${moneyCompact(c.createdUsd)} created · ${moneyCompact(c.availableUsd)} left` : c.regions.length === 1 ? `${c.regions[0].region} only` : "nothing created yet"}</span>
  </button>`)}`;
}
function listMarkup() {
  const c = P.categories.find((x) => x.budgetCategory === ui.open);
  if (!c) return html``;
  return html`<div class="list" data-key="list-${c.budgetCategory}">
    <div class="prow hd"><span>REGION</span><span>${c.budgetCategory.toUpperCase()}</span><span>BUDGET</span><span>AFE CREATED</span><span>ALLOTTED</span><span>AVAILABLE</span><span></span></div>
    ${c.regions.map((r) => html`<div class="prow" data-key="${r.id}" style="${r.createdUsd ? "background: #E3F2F8; box-shadow: inset 3px 0 0 var(--edge-blue);" : ""}">
      <span class="reg">${r.region}</span>
      <span style="display: flex; align-items: center; gap: 12px; min-width: 0; flex-wrap: wrap;"><span style="width: 180px; flex: none;">${bar(r)}</span>${r.afes.map((a) => html`<a href="/afe/${a.id}" class="tag blue pad" style="font-size: 12px;" data-key="${a.id}"><span class="txt">${a.title}</span></a>`)}</span>
      <span class="num">${money(r.amountUsd)}</span>
      <span class="num ${r.createdUsd ? "blue" : "soft"}">${r.createdUsd ? money(r.createdUsd) : "—"}</span>
      <span class="num ${r.allottedUsd ? "green" : "soft"}">${r.allottedUsd ? money(r.allottedUsd) : "—"}</span>
      <span class="num ${r.createdUsd ? "green" : ""}">${money(r.availableUsd)}</span>
      <span></span>
    </div>`)}
  </div>`;
}
function markup() {
  const t = P.totals;
  return html`<div class="page pane">
    <div style="display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;">
      <div style="min-width: 0;"><h1 class="h1">${(P.divisions || []).join(", ") || "Capital"} budget${P.fiscalYear ? `, FY${P.fiscalYear}` : ""}. ${tip("AFE created = sent or beyond. Allotted = issued with an internal order. Actual and commitment arrive with the SAP extracts.")}</h1>
      <div class="sub">What AFEs have spoken for, and what is left.${P.placeholders ? ` ${P.placeholders === (P.pots || []).length ? "Every figure here is a placeholder" : `${P.placeholders} of these figures are placeholders`} until the division loads its own.` : ""}</div></div>
      ${(P.canChoose || []).length > 1 ? html`<div class="subnav" style="margin-left: auto;" id="divs">${P.canChoose.map((d) => html`<a href="/pots?division=${encodeURIComponent(d)}${P.fiscalYear ? `&fy=${P.fiscalYear}` : ""}" class="${(P.divisions || []).length === 1 && P.divisions[0] === d ? "on" : ""}" data-key="d${d}">${icon("coins", 13)}<span>${d}</span></a>`)}</div>` : ""}
      <div class="chipnav" style="${(P.canChoose || []).length > 1 ? "" : "margin-left: auto;"}" id="fy">${(P.fiscalYears || []).map((y) => html`<a href="/pots?fy=${y}${(P.canChoose || []).length > 1 && (P.divisions || []).length === 1 ? `&division=${encodeURIComponent(P.divisions[0])}` : ""}" class="${P.fiscalYear === y || (!P.fiscalYear && y === Math.max(...P.fiscalYears)) ? "on" : ""}" data-key="fy${y}">FY${y}</a>`)}</div>
    </div>
    <div class="kpis">
      <div class="kpi"><div class="k">BUDGET</div><div class="v">${money(t.amountUsd)}</div></div>
      <div class="kpi"><div class="k">AFE CREATED</div><div class="v blue">${money(t.createdUsd)}</div></div>
      <div class="kpi"><div class="k">ALLOTTED (ISSUED)</div><div class="v green">${money(t.allottedUsd)}</div></div>
      <div class="kpi"><div class="k">AVAILABLE</div><div class="v ${t.availableUsd < 0 ? "red" : ""}">${money(t.availableUsd)}</div></div>
      <div class="kpi" style="margin-left: auto; text-align: right;"><div class="k">AFES THIS YEAR</div><div class="v">${t.afes}</div></div>
    </div>
    <div class="cats" id="cats">${catsMarkup()}</div>
    <div id="cat-list">${listMarkup()}</div>
  </div>`;
}

export async function render(el, ctx) {
  root = el;
  const qs = new URLSearchParams();
  if (ctx.query.fy) qs.set("fy", ctx.query.fy);
  if (ctx.query.division) qs.set("division", ctx.query.division);
  const q = qs.toString() ? `?${qs}` : "";
  try { P = await store.get(`/api/pots${q}`, { fresh: true }); }
  catch (e) { showError(e); P = { divisions: [], categories: [], totals: { amountUsd: 0, createdUsd: 0, allottedUsd: 0, availableUsd: 0, afes: 0 }, fiscalYears: [] }; }
  if (!P.categories) P.categories = [];
  if (ui.open === undefined || !P.categories.some((c) => c.budgetCategory === ui.open)) ui.open = (P.categories.find((c) => c.createdUsd) || P.categories[0] || {}).budgetCategory || null;
  if (!el.dataset.pots) { el.innerHTML = ""; el.dataset.pots = "1"; delete el.dataset.wired; }
  morph(el, markup());
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    on(el, "click", "[data-cat]", (e, b) => { ui.open = ui.open === b.dataset.cat ? null : b.dataset.cat; morph($("#cats", el), catsMarkup()); morph($("#cat-list", el), listMarkup()); });
  }
}
export function unmount() { if (root) { delete root.dataset.pots; delete root.dataset.wired; root.innerHTML = ""; } }
