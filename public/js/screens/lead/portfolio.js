// /leadership — the three questions a manager asks, in the order they ask them: how much is
// under construction, why hasn't it capitalized, and is the process moving.
//
// Read-only. The roll-forward is the recon workbook's own identity, so the number at the end
// is the one that ties to the GL. Every count is a control (design rule 3).
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { navigate } from "../../core/router.js";
import { icon } from "../../core/icons.js";
import { money, moneyCompact, since, date, plural, stateLabel } from "../../core/format.js";
import { tag, avatar, emptyState, moneyCell, tip } from "../../components/parts.js";
import { showError, sheet, opening, loadFailed } from "../../core/ui.js";

const ui = uiFor("leadership");
let L = null;
let root = null;

const REASON_TONE = {
  awaiting_isd: "yellow", awaiting_invoice: "purple", future_go_live: "green",
  budget_exhausted: "red", on_hold: "grey", no_reviewer_response: "orange", in_progress: "blue",
};

function flow() {
  const r = L.rollforward;
  const cell = (v, l, tone) => html`<div class="fl ${tone || ""}"><div class="v">${moneyCompact(v)}</div><div class="l">${l}</div></div>`;
  return html`<div class="flow" data-key="flow">
    ${cell(r.balanceForward, "Balance forward")}
    <span class="op">+</span>
    ${cell(r.additions, "Additions", "blue")}
    <span class="op">−</span>
    ${cell(r.capitalized, "Capitalized", "green")}
    <span class="op">=</span>
    <div class="fl now"><div class="v">${moneyCompact(L.openBalanceUsd)}</div><div class="l">Open AuC · ${L.openCount} ${plural(L.openCount, "line")}</div></div>
  </div>`;
}

function reasons() {
  const total = L.reasons.reduce((n, r) => n + r.count, 0) || 1;
  return html`<div class="card pad" data-key="reasons">
    <div style="display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;">
      <div style="font-size: 15.5px; font-weight: 700;">Why hasn't it capitalized?</div>
      <span class="small muted">${L.openCount} open ${plural(L.openCount, "line")} · tap a reason to see them</span>
    </div>
    <div class="segbar" style="margin-top: 16px;">${L.reasons.map((r) => html`<i class="${REASON_TONE[r.key] || "grey"}" style="width: ${(r.count / total) * 100}%" title="${r.label}: ${r.count}" data-key="${r.key}"></i>`)}</div>
    <div class="rgrid" style="margin-top: 18px;">
      ${L.reasons.map((r) => html`<button type="button" class="reason ${ui.reason === r.key ? "on" : ""}" data-reason="${r.key}" data-key="${r.key}" aria-pressed="${ui.reason === r.key ? "true" : "false"}">
        <span class="n ${REASON_TONE[r.key] || "grey"}">${r.count}</span>
        <span style="min-width: 0;"><span class="t">${r.label}</span><span class="s">${r.share}%</span></span>
      </button>`)}
    </div>
  </div>`;
}

function biggest() {
  return html`<div class="card pad" data-key="biggest">
    <div class="sect">THE LARGEST OPEN BALANCES · ${L.bigShare}% OF THE TOTAL IN THREE</div>
    <div style="display: flex; flex-direction: column; gap: 12px; margin-top: 12px;">
      ${L.biggest.length ? L.biggest.map((b) => html`<a href="/io/${b.ioNumber}?from=portfolio" class="bigrow" data-key="${b.id}">
        ${avatar(b.division, "dark", "")}
        <span style="min-width: 0;"><span class="t">${b.description || "(no description)"}</span><span class="s">${b.division} · IO ${b.ioNumber}${b.ageingDays !== null ? ` · ${b.ageingDays} days` : ""}${b.reason ? ` · ${b.reason}` : ""}</span></span>
        <span class="amt">${moneyCompact(b.balanceUsd)}</span>
      </a>`) : emptyState("Nothing open.")}
    </div>
  </div>`;
}

function pipeline() {
  const p = L.pipeline;
  return html`<div class="card pad" data-key="pipeline">
    <div class="sect">THE PROCESS, THIS YEAR</div>
    <div class="kpis" style="margin-top: 10px;">
      <div class="kpi"><div class="k">IN APPROVAL</div><div class="v blue">${p.inFlightCount}</div><div class="small muted">${moneyCompact(p.inFlightUsd)}</div></div>
      <div class="kpi"><div class="k">WITH FIXED ASSETS</div><div class="v">${p.withFaCount}</div></div>
      <div class="kpi"><div class="k">ISSUED</div><div class="v green">${p.issuedThisYearCount}</div><div class="small muted">${moneyCompact(p.issuedThisYearUsd)}</div></div>
      <div class="kpi"><div class="k">DAYS TO APPROVE</div><div class="v">${p.medianDaysToApprove === null ? "—" : p.medianDaysToApprove}</div><div class="small muted">median, send to last signature</div></div>
      <div class="kpi"><div class="k">THEN TO AN ORDER</div><div class="v">${p.medianDaysToOrder === null ? "—" : p.medianDaysToOrder}</div><div class="small muted">median days, signed to order created</div></div>
    </div>
    ${p.slowest.length ? html`<div style="margin-top: 16px;">
      <div class="sect">WAITING LONGEST</div>
      ${p.slowest.map((a) => html`<a class="check" href="/afe/${a.id}" data-key="${a.id}" style="text-decoration: none; color: inherit;">
        <span class="tick ${a.waitingOn && a.waitingOn.days >= 5 ? "bad" : "todo"}">${icon("clock", 14)}</span>
        <span style="flex: 1; min-width: 0;"><b>${a.title}</b><span class="small muted" style="display: block;">${a.waitingOn ? `with ${a.waitingOn.name} · ${a.waitingOn.level} · ${a.waitingOn.days} ${plural(a.waitingOn.days, "day")}` : stateLabel(a.state)} · ${money(a.totalUsd)}</span></span>
      </a>`)}
    </div>` : ""}
  </div>`;
}

function reviewCard() {
  const r = L.review;
  return html`<div class="card pad" style="background: var(--yellow-bg); border-color: #EFE1A6;" data-key="review">
    <div class="sect" style="color: var(--yellow);">THIS QUARTER'S REVIEW · ${L.period.toUpperCase()}</div>
    <div style="font-size: 13px; line-height: 1.55; margin-top: 8px; color: var(--ink-2);">
      <b>${r.lineCount}</b> ${plural(r.lineCount, "line")} across <b>${r.packCount}</b> ${plural(r.packCount, "reviewer")}.
      ${r.sent ? html`<b>${r.sent}</b> ${r.sent === 1 ? "pack has" : "packs have"} gone out and <b>${r.answered}</b> ${r.answered === 1 ? "has" : "have"} answered.` : "Nothing has gone out yet."}
      ${r.excludedCount ? html` <b>${r.excludedCount}</b> excluded for a go-live beyond this period.` : ""}
    </div>
    <a href="/auc-review" style="display: inline-block; margin-top: 12px; font-size: 12.5px; font-weight: 700;">Open the review →</a>
  </div>`;
}

/**
 * `pipeline()` used to sit UNDER the line list, and the line list grows to 25 rows the moment a
 * reason is tapped — so "is the process moving", which is a third of this screen's whole
 * purpose, was pushed off the fold by the act of using the screen. It goes above it.
 */
function leftColumn() {
  return html`${reasons()}${pipeline()}<div id="reason-list">${reasonList()}</div>`;
}

function markup() {
  return html`<div class="page pane">
    <div class="dec-head">
      <div style="min-width: 0; flex: 1;">
        <h1 class="h1">${moneyCompact(L.openBalanceUsd)} is still under construction. ${tip("Nothing here is typed. Every figure is joined when the page opens, from the SAP extract, the AuC recon file and the AFEs the tool carries.")}</h1>
        <div class="sub">${L.period} · company code 1000 · ties to the GL${L.extract ? `, from the extract of ${L.extract.asOfDate ? date(L.extract.asOfDate) : since(L.extract.importedAt)}` : ", no budget extract loaded yet"}.</div>
      </div>
    </div>
    ${flow()}
    <div class="split" style="margin-top: 18px; align-items: start;">
      <div style="display: flex; flex-direction: column; gap: 14px;" id="left">${leftColumn()}</div>
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${biggest()}
        ${reviewCard()}
      </div>
    </div>
  </div>`;
}

// The columns, and what each sorts by. This screen had no search, no sort, no filter and no
// period control — one click handler on the whole page — over the same population the tracker
// gives you all four on.
const PCOLS = [
  { key: "line", label: "Line", val: (x) => String(x.ioDescription || "").toLowerCase() },
  { key: "age", label: "Age", val: (x) => (x.ageingDays === null ? -1 : x.ageingDays), align: "r", num: true },
  { key: "balance", label: "Balance", val: (x) => x.endingBalance || 0, align: "r", num: true },
];
const PSORT = { key: "balance", dir: "desc" };
const PPAGE = 25;

function reasonList() {
  if (!ui.reason || !L.rows) return html``;
  const r = L.reasons.find((x) => x.key === ui.reason);
  let rows = L.rows.filter((x) => x.nonCapReason === ui.reason);
  if (ui.q) {
    const q = ui.q.toLowerCase();
    rows = rows.filter((x) => String(x.ioNumber).includes(q) || String(x.ioDescription || "").toLowerCase().includes(q) ||
      String(x.division || "").toLowerCase().includes(q) || String(x.reviewerName || "").toLowerCase().includes(q));
  }
  const srt = ui.sort || PSORT;
  const col = PCOLS.find((c) => c.key === srt.key) || PCOLS[2];
  const sign = srt.dir === "asc" ? 1 : -1;
  rows = rows.slice().sort((a, b) => {
    const x = col.val(a), y = col.val(b);
    return (col.num ? (x - y) : String(x).localeCompare(String(y))) * sign;
  });
  // It used to hard-cap at 25 and send you elsewhere for the rest. The rows are already in the
  // browser; a "show more" is cheaper than a trip to another screen and a lost filter.
  const shown = rows.slice(0, ui.limit || PPAGE);
  return html`<div class="list gridlist" data-key="rl-${ui.reason}">
    <div style="display: flex; align-items: center; gap: 12px; padding: 12px 18px 8px; flex-wrap: wrap;">
      <span class="sect ${r && r.key === "on_hold" ? "red" : "yellow"}">${icon("flag", 13)} ${(r ? r.label : ui.reason).toUpperCase()} · ${rows.length} ${plural(rows.length, "LINE")}</span>
      <input class="input" id="pq" type="search" aria-label="Search the lines" placeholder="Find a line, a division, a reviewer" value="${ui.q || ""}" style="max-width: 300px; height: 36px; margin-left: auto;" autocomplete="off">
    </div>
    <div class="ghead phead">${PCOLS.map((c) => html`<button type="button" class="sortb ${c.align === "r" ? "r" : ""} ${srt.key === c.key ? "on" : ""}" data-psort="${c.key}" data-key="${c.key}">${c.label}${srt.key === c.key ? icon(srt.dir === "asc" ? "chevD" : "chevR", 12) : ""}</button>`)}<span>In service</span><span></span></div>
    ${shown.length ? shown.map((x) => html`<a class="grow phead t-${x.estimatedServiceDate ? "grey" : "yellow"}" href="/io/${x.ioNumber}?from=portfolio" data-key="${x.id}">
      <span class="line"><span class="ttl">${x.ioDescription || "(no description)"}</span><span class="id">IO ${x.ioNumber} · ${x.division}${x.reviewerName ? ` · ${x.reviewerName}` : ""}</span></span>
      <span class="num">${x.ageingDays === null ? "—" : html`${x.ageingDays}<i>d</i>`}</span>
      ${moneyCell(x.endingBalance)}
      <span class="why">${x.estimatedServiceDate ? tag(date(x.estimatedServiceDate), "grey") : tag("no date", "yellow")}</span>
      <span class="chev">${icon("chevR", 18)}</span>
    </a>`) : emptyState("Nothing matches.", ui.q ? html`<button type="button" class="linkbtn" id="clear-pq">Clear the search</button>` : "")}
    ${rows.length > shown.length ? html`<button type="button" class="linkbtn" id="pmore" style="padding: 12px 18px; display: block;">Show ${Math.min(PPAGE, rows.length - shown.length)} more of ${rows.length - shown.length}</button>` : ""}
  </div>`;
}

export async function render(el, ctx) {
  root = el;
  const period = ctx.query.period ? `?period=${encodeURIComponent(ctx.query.period)}` : "";
  const wait = opening(el, "Opening the portfolio…");
  try {
    // Both at once: the review was fetched only after the portfolio came back.
    const [lead, rev] = await Promise.all([
      store.get(`/api/leadership${period}`, { fresh: true }),
      // The rows behind the reason counts come from the review itself, fetched once and cached.
      store.get(`/api/auc-review${period}`, { maxAge: 30000 }),
    ]);
    L = lead;
    L.rows = (rev.lines || []).concat(rev.excluded || []);
  } catch (e) { wait(); delete el.dataset.lead; loadFailed(el, e); return; }
  wait();
  if (!el.dataset.lead) { el.innerHTML = ""; el.dataset.lead = "1"; delete el.dataset.wired; }
  morph(el, markup());
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    // Selecting the selected reason deselects it (design rule 4); only the left column repaints.
    on(el, "click", "[data-reason]", (e, b) => {
      ui.reason = ui.reason === b.dataset.reason ? null : b.dataset.reason;
      morph($("#left", el), leftColumn());
    });
    // These three were registered INSIDE the reason handler, so every reason tapped added another
    // copy of each: a sort flipped twice (and so did nothing) and "Show more" added 50 or 75 rows.
    on(el, "click", "[data-psort]", (e, b) => {
      const cur = ui.sort || PSORT;
      ui.sort = cur.key === b.dataset.psort ? { key: cur.key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: b.dataset.psort, dir: b.dataset.psort === "line" ? "asc" : "desc" };
      ui.limit = PPAGE; morph($("#reason-list", el), reasonList());
    });
    on(el, "click", "#clear-pq", () => { ui.q = ""; ui.limit = PPAGE; morph($("#reason-list", el), reasonList()); const box = $("#pq", el); if (box) { box.value = ""; box.focus(); } });
    on(el, "click", "#pmore", () => { ui.limit = (ui.limit || PPAGE) + PPAGE; morph($("#reason-list", el), reasonList()); });
    // The search box lives inside the region it filters, so the caret has to be put back by hand
    // after the morph — the same dance `tracker.js` does for the same reason.
    on(el, "input", "#pq", (e, b) => {
      ui.q = b.value; ui.limit = PPAGE;
      morph($("#reason-list", el), reasonList());
      const box = $("#pq", el);
      if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
    });
  }
}
export function unmount() { if (root) { delete root.dataset.lead; delete root.dataset.wired; root.innerHTML = ""; } }
