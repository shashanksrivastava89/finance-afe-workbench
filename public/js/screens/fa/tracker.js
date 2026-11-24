// /tracker — every AuC line, the way Fixed Assets keeps it: what is open, what is flagged for
// this quarter's review, and what has been capitalized.
//
// The flags are the review's own three rules, so a line here reads the same as it does in the
// review. Filters are chips, not a form, and the list is windowed because 528 rows is a lot of
// DOM for a question that is usually about ten of them.
import { html, morph, on, $ } from "../../core/dom.js";
import { store, uiFor } from "../../core/store.js";
import { icon } from "../../core/icons.js";
import { money, moneyCompact, date, plural, pct } from "../../core/format.js";
import { tag, bucket, emptyState, tip, moneyCell } from "../../components/parts.js";
import { showError } from "../../core/ui.js";
import { faNav } from "./common.js";

const ui = uiFor("tracker");
const PAGE = 60;
let T = null;
let root = null;

const BUCKETS = [
  { key: "flagged", title: "In this review", tone: "yellow", icon: "flag" },
  { key: "open", title: "Open", tone: "blue", icon: "clock" },
  { key: "capitalized", title: "Capitalized", tone: "green", icon: "tick" },
  { key: "all", title: "Everything", tone: "grey", icon: "filter" },
];

const isOpen = (i) => (i.openClosed || "Open").toLowerCase() === "open" && (i.aucStatus || "").toLowerCase() !== "capitalized";
function rows(key) {
  const all = T.items;
  if (key === "flagged") return all.filter((i) => i.flags.followUpNeeded);
  if (key === "open") return all.filter(isOpen);
  if (key === "capitalized") return all.filter((i) => (i.aucStatus || "").toLowerCase() === "capitalized");
  return all;
}
/**
 * The columns, and what each one sorts by.
 *
 * 528 rows and no way to order them by anything but balance, which was hardcoded in a single
 * line — and ageing is a RULE of the review ("aged ≥ 6 months"), so the one number the
 * population is defined by could not be sorted on at all.
 */
const COLS = [
  { key: "line", label: "Line", val: (i) => String(i.ioDescription || "").toLowerCase(), align: "l" },
  // What the AFE says it is for (R165) — blank on a line from before the tool, sorted last.
  { key: "afe", label: "The AFE", val: (i) => (i.afeTitle ? String(i.afeTitle).toLowerCase() : "~"), align: "l" },
  { key: "owner", label: "Owner", val: (i) => String(i.contactPersonName || "").toLowerCase(), align: "l" },
  { key: "age", label: "Age", val: (i) => (i.flags.ageingDays === null ? -1 : i.flags.ageingDays), align: "r", num: true },
  { key: "consumed", label: "Consumed", val: (i) => (i.flags.consumedPct === null ? -1 : i.flags.consumedPct), align: "r", num: true },
  { key: "balance", label: "Balance", val: (i) => i.endingBalance || 0, align: "r", num: true },
];
const DEFAULT_SORT = { key: "balance", dir: "desc" };

function filtered(key) {
  let list = rows(key);
  if (ui.division) list = list.filter((i) => (i.division || "(unassigned)") === ui.division);
  // Where the equipment came from (R152): known for every order the tool issued, not guessed for
  // a line from the recon workbook that predates it.
  if (ui.sourcing) list = list.filter((i) => i.sourcing === ui.sourcing);
  if (ui.q) {
    const q = ui.q.toLowerCase();
    // The owner and the reviewer are who you CHASE, and neither was searchable; the GL is how
    // the workbook is filed. The CSV export already carried all three.
    list = list.filter((i) => String(i.ioNumber).includes(q) || String(i.ioDescription || "").toLowerCase().includes(q) ||
      String(i.costCenter || "").includes(q) || String(i.aucNumber || "").includes(q) ||
      String(i.contactPersonName || "").toLowerCase().includes(q) || String(i.reviewerName || "").toLowerCase().includes(q) ||
      String(i.glAccount || "").includes(q) || (i.sourcing === "internal" && "acme inventory".includes(q)) ||
      String(i.afeTitle || "").toLowerCase().includes(q) || String(i.afeDescription || "").toLowerCase().includes(q));
  }
  const srt = ui.sort || DEFAULT_SORT;
  const col = COLS.find((c) => c.key === srt.key) || COLS[COLS.length - 1];
  const sign = srt.dir === "asc" ? 1 : -1;
  return list.slice().sort((a, b) => {
    const x = col.val(a), y = col.val(b);
    return (col.num ? (x - y) : String(x).localeCompare(String(y))) * sign;
  });
}

/** The CSV of what is listed — the bucket, division, inventory chip, search and sort as they stand. */
async function exportShown() {
  const ids = filtered(ui.open || "flagged").map((i) => i.id);
  try {
    const res = await fetch("/api/tracker/export.csv", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }), credentials: "same-origin" });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The export failed (${res.status}).`);
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url; a.download = "auc-tracker.csv"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { showError(e); }
}

function detail(key, list) {
  const bal = list.reduce((n, i) => n + (i.endingBalance || 0), 0);
  if (key === "flagged") return list.length ? `${moneyCompact(bal)} — spent ≥ 80%, aged ≥ 6 months, or over $100K.` : "Nothing meets the review's rules right now.";
  if (key === "open") return `${moneyCompact(bal)} still under construction.`;
  if (key === "capitalized") return `${list.length} settled to a fixed asset.`;
  return `${T.items.length} lines in the recon extract${T.asOf ? `, as of ${date(T.asOf)}` : ""}.`;
}

/**
 * WHY this line is in the review, as one marker rather than three chips.
 *
 * Every row carried up to four chips — "82% consumed", "1197 days", "over $100K" — the same
 * three phrases repeated down 227 rows, which is a great deal of reading for a fact the eye
 * should take at a glance. The reason is a SPINE colour plus one short word now; the numbers
 * behind it are columns, where they line up and can be sorted.
 */
function severity(i) {
  const f = i.flags;
  if (!f.followUpNeeded) return f.firmDateOnFile ? { tone: "green", word: "date on file" } : { tone: "grey", word: "" };
  if (f.reasons.includes("consumed80") && f.reasons.includes("aged180")) return { tone: "red", word: "spent and aged" };
  if (f.reasons.includes("aged180")) return { tone: "yellow", word: "aged" };
  if (f.reasons.includes("consumed80")) return { tone: "yellow", word: "spent" };
  return { tone: "blue", word: "over $100K" };
}

function row(i) {
  const s = severity(i);
  return html`<a class="grow t-${s.tone}" href="/io/${i.ioNumber}?from=tracker" data-key="${i.id}">
    <span class="line"><span class="ttl">${i.ioDescription || "(no description)"}</span><span class="id">${i.sourcing === "internal" ? html`<b class="srcmark">${icon("box", 12)}Acme inventory</b> · ` : ""}IO ${i.ioNumber}${i.division ? " · " + i.division : ""}${i.costCenter ? " · cc " + i.costCenter : ""}${i.aucNumber ? " · AuC " + i.aucNumber : ""}</span></span>
    <span class="afe">${i.afeTitle ? html`<span class="nm">${i.afeTitle}</span><span class="id" title="${i.afeDescription || ""}">${i.afeDescription || ""}</span>` : html`<span class="id">—</span>`}</span>
    <span class="owner"><span class="nm">${i.contactPersonName || "—"}</span><span class="id">${i.reviewerName ? "rev. " + i.reviewerName : isOpen(i) ? "no reviewer" : i.aucStatus || ""}</span></span>
    <span class="num">${i.flags.ageingDays === null ? "—" : html`${i.flags.ageingDays}<i>d</i>`}</span>
    <span class="num">${i.flags.consumedPct === null ? "—" : html`${Math.round(i.flags.consumedPct * 100)}<i>%</i>`}</span>
    ${moneyCell(i.endingBalance)}
    <span class="why">${s.word ? tag(s.word, s.tone === "grey" ? "grey" : s.tone, s.tone === "green" ? { icon: "tick" } : {}) : ""}</span>
    <span class="chev">${icon("chevR", 18)}</span>
  </a>`;
}

function bucketsMarkup() {
  return html`${BUCKETS.map((b) => bucket({ key: b.key, n: rows(b.key).length, title: b.title, detail: detail(b.key, rows(b.key)), tone: b.tone, icon: b.icon, on: ui.open === b.key }))}`;
}
function listMarkup() {
  const key = ui.open || "flagged";
  const srt = ui.sort || DEFAULT_SORT;
  const list = filtered(key);
  const shown = list.slice(0, ui.limit || PAGE);
  const divisions = Array.from(new Set(T.items.map((i) => i.division || "(unassigned)"))).sort();
  return html`<div class="list gridlist" data-key="list-${key}">
    <div style="display: flex; align-items: center; gap: 12px; padding: 14px 20px 8px; flex-wrap: wrap;">
      <span class="sect">${(BUCKETS.find((b) => b.key === key) || {}).title.toUpperCase()} · ${list.length} ${plural(list.length, "LINE")}</span>
      <input class="input" id="q" type="search" aria-label="Search the lines" placeholder="Order, AFE, owner, reviewer, cost centre, GL, inventory" value="${ui.q || ""}" style="max-width: 360px; height: 40px; margin-left: auto;" autocomplete="off">
      <button type="button" class="pillbtn sm" id="csv" ${list.length ? "" : "disabled"}>${icon("doc", 14)}CSV · ${list.length} ${plural(list.length, "line")}</button>
    </div>
    <div class="chips" style="padding: 0 20px 12px;">
      <button type="button" class="chip sm ${ui.division ? "" : "on"}" data-division="" data-key="__all">All · ${rows(key).length}</button>
      ${divisions.map((d) => { const n = rows(key).filter((i) => (i.division || "(unassigned)") === d).length; return n ? html`<button type="button" class="chip sm ${ui.division === d ? "on" : ""}" data-division="${d}" data-key="${d}">${d} · ${n}</button>` : ""; })}
      <span class="chipsep" aria-hidden="true"></span>
      <button type="button" class="chip sm ${ui.sourcing === "internal" ? "on" : ""}" data-sourcing="internal" data-key="src-internal">${icon("box", 13)}Acme inventory · ${rows(key).filter((i) => i.sourcing === "internal").length}</button>
    </div>
    ${shown.length ? html`<div class="ghead">${COLS.map((c) => html`<button type="button" class="sortb ${c.align === "r" ? "r" : ""} ${srt.key === c.key ? "on" : ""}" data-sort="${c.key}" data-key="${c.key}" aria-label="${c.label}${srt.key === c.key ? (srt.dir === "asc" ? ", sorted ascending" : ", sorted descending") : ", sort by this"}">${c.label}${srt.key === c.key ? icon(srt.dir === "asc" ? "chevD" : "chevR", 12) : ""}</button>`)}<span>Why</span><span></span></div>` : ""}
    ${shown.length ? shown.map(row) : emptyState("Nothing matches.", ui.q || ui.division || ui.sourcing ? html`<button type="button" class="linkbtn" id="clear-filters">Clear the search and filters</button>` : "")}
    ${list.length > shown.length ? html`<button type="button" class="linkbtn" id="more" style="padding: 14px 20px; display: block;">Show ${Math.min(PAGE, list.length - shown.length)} more of ${list.length - shown.length}</button>` : ""}
  </div>`;
}
function markup() {
  const flagged = rows("flagged");
  return html`<div class="page pane">
    <h1 class="h1">${flagged.length ? `${flagged.length} ${plural(flagged.length, "line")} ${flagged.length === 1 ? "needs" : "need"} a word this quarter.` : "Nothing needs chasing."} ${tip("The workbook's own four rules. In the quarterly review: spent ≥ 80% of budget, aged ≥ 6 months from the order's issue date, or over $100K — less anything with a go-live confirmed beyond the period.")}</h1>
    <div class="sub">The AuC recon extract, with the review's rules on every line${T.asOf ? ` · as of ${date(T.asOf)}` : ""}. A line opens its order.</div>
    <div style="margin-top: 14px;">${faNav("tracker")}</div>
    <div class="buckets four" id="buckets">${bucketsMarkup()}</div>
    <div id="bucket-list">${listMarkup()}</div>
  </div>`;
}

export async function render(el) {
  root = el;
  try { T = await store.get("/api/tracker", { maxAge: 15000 }); }
  catch (e) { showError(e); T = { items: [], asOf: null }; }
  if (ui.open === undefined) ui.open = "flagged";
  if (!ui.limit) ui.limit = PAGE;
  if (!el.dataset.tracker) { el.innerHTML = ""; el.dataset.tracker = "1"; delete el.dataset.wired; }
  morph(el, markup());
  if (!el.dataset.wired) {
    el.dataset.wired = "1";
    const repaint = () => { morph($("#buckets", el), bucketsMarkup()); morph($("#bucket-list", el), listMarkup()); };
    on(el, "click", "[data-bucket]", (e, b) => { ui.open = ui.open === b.dataset.bucket ? null : b.dataset.bucket; ui.limit = PAGE; repaint(); });
    on(el, "click", "[data-division]", (e, b) => { ui.division = ui.division === b.dataset.division ? null : b.dataset.division; ui.limit = PAGE; repaint(); });
    on(el, "click", "#csv", () => exportShown());
    on(el, "click", "[data-sourcing]", (e, b) => { ui.sourcing = ui.sourcing === b.dataset.sourcing ? null : b.dataset.sourcing; ui.limit = PAGE; repaint(); });
    // Clicking the sorted column flips it; a new one starts on the sensible end — biggest
    // money and oldest line first, because that is what you are looking for.
    on(el, "click", "[data-sort]", (e, b) => {
      const cur = ui.sort || DEFAULT_SORT;
      ui.sort = cur.key === b.dataset.sort ? { key: cur.key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key: b.dataset.sort, dir: b.dataset.sort === "line" || b.dataset.sort === "owner" ? "asc" : "desc" };
      ui.limit = PAGE; morph($("#bucket-list", el), listMarkup());
    });
    // morph keeps a field's live value (so a repaint never eats a keystroke), so the box is emptied by hand.
    on(el, "click", "#clear-filters", () => { ui.q = ""; ui.division = null; ui.sourcing = null; ui.limit = PAGE; morph($("#bucket-list", el), listMarkup()); const box = $("#q", el); if (box) { box.value = ""; box.focus(); } });
    on(el, "click", "#more", () => { ui.limit = (ui.limit || PAGE) + PAGE; morph($("#bucket-list", el), listMarkup()); });
    on(el, "input", "#q", (e, input) => {
      ui.q = input.value.trim();
      ui.limit = PAGE;
      const at = input.selectionStart;
      morph($("#bucket-list", el), listMarkup());
      const again = $("#q", el);
      if (again) { again.focus(); try { again.setSelectionRange(at, at); } catch { /* fine */ } }
    });
  }
}
export function unmount() { if (root) { delete root.dataset.tracker; delete root.dataset.wired; root.innerHTML = ""; } }
