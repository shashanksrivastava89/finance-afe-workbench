// /afe/:id/supplemental — the project has outgrown its approval.
//
// One question, in the wizard's idiom: how much more? The consequence appears under the answer —
// the new cumulative total, the band it lands in, and that the chain is rebuilt on that total,
// not on the increment. The AFE that was signed is never edited: this creates a new one.
import { html, morph, on, $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { store } from "../../core/store.js";
import { session } from "../../core/session.js";
import { navigate } from "../../core/router.js";
import { setRecord, setRecordNote } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, parseMoney, plural } from "../../core/format.js";
import { reveal, tag, CTA_ARROW } from "../../components/parts.js";
import { toast, busy, showError } from "../../core/ui.js";

const S = { id: null, view: null, root: null, wiredTo: null, extra: null, io: null };
const afe = () => S.view.afe;

/**
 * "The Corporate or Group Controller and the Senior Vice President" — in ladder order, by title.
 * It said "A4 and A5", which only the people who keep the matrix can read.
 */
const cap = (x) => (x ? x.charAt(0).toUpperCase() + x.slice(1) : x);
function levelList(levels) {
  const ladder = (session.refdata && session.refdata.levelLadder) || [];
  const titles = (session.refdata && session.refdata.levelTitles) || {};
  const sorted = levels.slice().sort((a, b) => ladder.indexOf(a) - ladder.indexOf(b)).map((l) => (titles[l] ? `the ${titles[l]}` : l));
  if (sorted.length <= 1) return sorted.join("");
  return sorted.slice(0, -1).join(", ") + " and " + sorted[sorted.length - 1];
}

function bandFor(total) {
  const bands = (session.refdata && session.refdata.bands) || [];
  let levels = [];
  for (const b of bands) {
    levels = levels.concat(b.levels);
    if (b.maxUsd === null || total <= b.maxUsd) return { label: b.label, levels: levels.filter((l, i) => levels.indexOf(l) === i) };
  }
  const last = bands[bands.length - 1] || { label: "", levels: [] };
  return { label: last.label, levels: levels.filter((l, i) => levels.indexOf(l) === i) };
}

function markup() {
  const a = afe(), approved = S.view.totalUsd;
  const orders = a.ioNumbers && a.ioNumbers.length ? a.ioNumbers : (a.afeNo ? [a.afeNo] : []);
  const io = S.io || orders[0] || null;
  const extra = S.extra;
  const total = approved + (extra || 0);
  const wasBand = bandFor(approved), nowBand = bandFor(total);
  const added = nowBand.levels.filter((l) => !wasBand.levels.includes(l));
  return html`<div class="wrap pane">
    <div class="small muted"><a href="/afe/${a.id}" style="font-weight: 700;">‹ ${a.project.title}</a> · ${a.costCenter ? "cost centre " + a.costCenter : ""}${a.division ? " · " + a.division : ""}</div>
    <h1 class="q" style="margin-top: 10px;">How much more does it need?</h1>
    <p class="hint">“${a.project.title}” was approved at <b>${money(approved)}</b>${io ? ` and issued as internal order ${io}` : ""}. A supplemental tops that order up — the AFE that was signed is never edited.</p>

    ${orders.length > 1 ? html`<div style="margin-top: 22px;"><div class="sect">WHICH ORDER</div>
      <div class="chips" style="margin-top: 10px;">${orders.map((n) => html`<button type="button" class="chip ${n === io ? "on" : ""}" data-io="${n}" data-key="${n}">${n}</button>`)}</div></div>` : ""}

    <div class="money-row" style="margin-top: 26px;">
      <span class="cur">$</span>
      <input class="big money" id="extra" inputmode="decimal" placeholder="0" value="${extra === null ? "" : String(extra)}" autocomplete="off" aria-label="How much more, in US dollars">
    </div>

    <div class="chips" style="margin-top: 20px; flex-direction: column; align-items: flex-start; gap: 10px;">
      ${extra ? reveal(`New cumulative total ${money(total)} — ${money(approved)} approved plus ${money(extra)}`, { icon: "plus", tone: "blue", key: "total" }) : ""}
      ${extra ? reveal(`${nowBand.label} — ${nowBand.levels.filter((l) => l !== "BOARD").length} levels sign`, { icon: "shield", tone: added.length ? "yellow" : "", key: "band" }) : ""}
      ${extra && added.length ? reveal(`${cap(levelList(added.filter((l) => l !== "BOARD")))} ${plural(added.length, "signs", "sign")} this time — the chain is rebuilt on the whole ${money(total)}, not on the ${money(extra)}`, { icon: "users", tone: "yellow", key: "added" }) : ""}
      ${extra && !added.length ? reveal("The same levels sign as before — the chain is still rebuilt on the cumulative total", { icon: "users", key: "same" }) : ""}
    </div>

    <div class="foot">
      <button class="cta ${extra ? "" : "off"}" id="raise" ${extra ? "" : "disabled"}>Raise the supplemental ${CTA_ARROW}</button>
      <a class="back" href="/afe/${a.id}">Not now</a>
      ${!extra ? html`<span class="small muted">Enter the extra amount first.</span>` : ""}
    </div>
    <div class="small muted" style="margin-top: 26px;">You will land in the wizard with the cost centre, the category and the description already filled in from the original. Fixed Assets links the new AFE to order ${io || "the original"} when it is issued.</div>
  </div>`;
}
function paint() { if (S.root && S.view) morph(S.root, markup()); }

export async function render(root, ctx) {
  S.id = ctx.params.id; S.root = root; S.extra = null; S.io = null;
  try { S.view = await api.get(`/api/afes/${S.id}`); } catch (e) { showError(e); await navigate("/requests", { replace: true }); return; }
  const a = afe();
  if (!["issued", "tracking", "capitalized"].includes(a.state)) {
    toast("A supplemental tops up an AFE that already has its internal order.", "err");
    await navigate(`/afe/${S.id}`, { replace: true });
    return;
  }
  S.io = (a.ioNumbers && a.ioNumbers[0]) || a.afeNo || null;
  setRecord(null);
  if (!root.dataset.supp) { root.innerHTML = ""; root.dataset.supp = "1"; }
  paint();
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "input", "#extra", (e, el) => {
    const n = parseMoney(el.value);
    S.extra = n && n > 0 ? n : null;
    const focus = document.activeElement === el ? el.selectionStart : null;
    paint();
    const again = $("#extra", root);
    if (again && focus !== null) { again.focus(); try { again.setSelectionRange(focus, focus); } catch { /* number inputs */ } }
  });
  on(root, "click", "[data-io]", (e, b) => { S.io = b.dataset.io; paint(); });
  on(root, "click", "#raise", async (e, b) => {
    if (!S.extra) return;
    const done = busy(b, "Creating…");
    try {
      const created = await api.post(`/api/afes/${S.id}/supplemental`, { ioNumber: S.io });
      const id = created.afe.id;
      await api.patch(`/api/afes/${id}`, { "money.capexUsd": S.extra, "money.classification": created.afe.money.classification || "capex" });
      store.bust("/api");
      toast(created.note || "Supplemental raised.", "ok");
      await navigate(`/afe/${id}/edit/1`);
    } catch (err) { done(); showError(err); }
  });
}
export function unmount() { if (S.root) { delete S.root.dataset.supp; S.root.innerHTML = ""; } }
