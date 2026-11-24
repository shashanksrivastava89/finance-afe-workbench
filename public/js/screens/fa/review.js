// /auc-review — the quarterly AUC review, the control Judithmelanie named first.
//
// The population rules are the workbook's own, printed on the screen so nobody has to trust the
// tool's arithmetic: spent ≥ 80 %, aged ≥ 6 months, over $100K, less anything with a confirmed
// go-live beyond the period. The work is grouped per reviewer, because that is who answers —
// one pack per person, not one email per line.
import { html, morph, on, $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { store, uiFor } from "../../core/store.js";
import { icon } from "../../core/icons.js";
import { money, moneyCompact, date, since, plural } from "../../core/format.js";
import { tag, avatar, bucket, emptyState, tip } from "../../components/parts.js";
import { session } from "../../core/session.js";
import { sheet, closeSheet, toast, showError, opening, loadFailed } from "../../core/ui.js";
import { navigate } from "../../core/router.js";
import { faNav } from "./common.js";

const ui = uiFor("auc-review");
const S = { data: null, root: null, wiredTo: null };
const R = () => S.data;
// Running the review is Fixed Assets'. Leadership reads it from the portfolio and changes nothing,
// so it gets no FA sub-nav (whose "To check" refused it) and no Draft or "Mark it sent".
const canRun = () => ((session.me && session.me.capabilities) || []).includes("aucreview.run");

async function load(period) {
  S.data = await api.get(`/api/auc-review${period ? `?period=${encodeURIComponent(period)}` : ""}`);
}
function paint() { if (S.root && S.data) morph(S.root, markup()); }

function tiles() {
  const d = R();
  const packs = d.divisions.flatMap((x) => x.packs);
  const sent = packs.filter((p) => p.status && p.status.sent).length;
  const answered = packs.filter((p) => p.status && p.status.answered).length;
  const waiting = packs.filter((p) => p.status && p.status.sent && !p.status.answered);
  const oldest = waiting.map((p) => p.status.waitingDays).filter((n) => n !== null).sort((a, b) => b - a)[0];
  return html`<div class="buckets four" data-key="tiles">
    ${bucket({ key: "toSend", icon: "send", n: packs.length - sent, title: "Packs to send", tone: packs.length - sent ? "yellow" : "green", on: ui.open === "toSend",
      detail: packs.length - sent ? `${packs.length} reviewers in this period; ${packs.length - sent} have not been written to yet.` : "Every reviewer has their pack." })}
    ${bucket({ key: "waiting", icon: "clock", n: waiting.length, title: "Waiting on a reply", tone: waiting.length ? "blue" : "green", on: ui.open === "waiting",
      detail: waiting.length ? `Oldest has waited ${oldest === undefined ? "a while" : oldest + " " + plural(oldest, "day")}.` : "Nothing outstanding." })}
    ${bucket({ key: "answered", icon: "tick", n: answered, title: "Answered", tone: "green", on: ui.open === "answered",
      detail: answered ? "Dates and comments are recorded against the lines." : "No replies yet this period." })}
    ${bucket({ key: "excluded", icon: "minus", n: d.excluded.length, title: "Excluded", tone: "grey", on: ui.open === "excluded",
      detail: "Go-live confirmed beyond this period — rule 4 of the workbook's own four." })}
  </div>`;
}

function divisionRow(div) {
  const sent = div.packs.filter((p) => p.status && p.status.sent).length;
  const answered = div.packs.filter((p) => p.status && p.status.answered).length;
  const open = ui.division === div.division;
  return html`<div data-key="${div.division}">
    <button type="button" class="drow ${open ? "on" : ""}" data-division="${div.division}" aria-expanded="${open ? "true" : "false"}">
      <span style="min-width: 0;"><span class="t">${div.division}</span><span class="s">${div.lineCount} ${plural(div.lineCount, "line")} · ${moneyCompact(div.balanceUsd)}</span></span>
      <span class="stack">${div.packs.slice(0, 4).map((p) => avatar(p.reviewerName === "(no responsible reviewer named)" ? "?" : p.reviewerName, p.status && p.status.answered ? "" : "blue", ""))}${div.packs.length > 4 ? html`<span class="av grey">+${div.packs.length - 4}</span>` : ""}</span>
      <span class="tagcol">${answered === div.packs.length ? tag(`all ${div.packs.length} answered`, "", { icon: "tick" }) : sent ? tag(`${answered} of ${div.packs.length} answered`, "yellow") : tag(`${div.packs.length} ${plural(div.packs.length, "pack")} to send`, "grey")}</span>
      <span class="chev">${icon(open ? "chevD" : "chevR", 18)}</span>
    </button>
    ${open ? html`<div class="list" style="margin-top: 0; border-radius: 0 0 18px 18px;">${div.packs.map((p) => packRow(div, p))}</div>` : ""}
  </div>`;
}

function packRow(div, p) {
  const st = p.status || {};
  return html`<div class="signer" data-key="${div.division}-${p.reviewerName}">
    <span class="num ${st.answered ? "done" : st.sent ? "now" : "off"}">${st.answered ? icon("tick", 16, { stroke: 2.4 }) : p.lineCount}</span>
    ${avatar(p.named ? p.reviewerName : "?", st.answered ? "" : "blue", "lg")}
    <span style="min-width: 0;">
      <span class="nm">${p.named ? p.reviewerName : "No responsible reviewer named"}</span>
      <span class="why" style="display: block;">${p.lineCount} ${plural(p.lineCount, "line")} · ${money(p.balanceUsd)}${st.sent ? ` · sent ${since(st.sentAt)}` : ""}${st.answered ? ` · answered ${since(st.answeredAt)}` : st.sent ? ` · waiting ${st.waitingDays} ${plural(st.waitingDays, "day")}` : ""}</span>
    </span>
    <span class="mail ${st.answered ? "" : "todo"}"><span class="txt">${st.answered ? "answered" : st.sent ? "waiting" : "not sent"}</span></span>
    <button type="button" class="pillbtn sm ${st.sent || !canRun() ? "" : "dark"}" data-pack="${div.division}::${p.reviewerName}">${st.sent || !canRun() ? "Open" : "Draft"}</button>
  </div>`;
}

function listFor(key) {
  const d = R();
  if (key === "excluded") {
    return html`<div class="list" data-key="l-excluded"><div class="sect">EXCLUDED · GO-LIVE BEYOND ${d.period.toUpperCase()}</div>
      ${d.excluded.length ? d.excluded.slice(0, ui.allExcluded ? d.excluded.length : 30).map((x) => html`<a class="lrow" href="/io/${x.ioNumber}?from=review" data-key="${x.id}" style="grid-template-columns: minmax(0, 1fr) 120px 170px 28px;">
        <span style="min-width: 0;"><span class="ttl">${x.ioDescription || "(no description)"}</span><span class="id">IO ${x.ioNumber} · ${x.division}${x.reviewerName ? ` · ${x.reviewerName}` : ""}</span></span>
        <span class="amt">${money(x.endingBalance)}</span>
        <span class="tagcol">${tag(`go-live ${date(x.goLive)}`, x.goLiveConfirmed ? "" : "yellow", { icon: "clock" })}</span>
        <span class="chev">${icon("chevR", 18)}</span>
      </a>`) : emptyState("Nothing was excluded this period.")}
      ${d.excluded.length > 30 && !ui.allExcluded ? html`<button type="button" class="linkbtn" id="all-excluded" style="padding: 10px 18px;">Show all ${d.excluded.length}</button>` : ""}
    </div>`;
  }
  const packs = d.divisions.flatMap((x) => x.packs.map((p) => Object.assign({ division: x.division }, p)));
  const rows = key === "toSend" ? packs.filter((p) => !(p.status && p.status.sent))
    : key === "waiting" ? packs.filter((p) => p.status && p.status.sent && !p.status.answered)
    : packs.filter((p) => p.status && p.status.answered);
  const title = { toSend: "TO SEND", waiting: "WAITING ON A REPLY", answered: "ANSWERED" }[key];
  return html`<div class="list" data-key="l-${key}"><div class="sect">${title} · ${rows.length} ${plural(rows.length, "REVIEWER")}</div>
    ${rows.length ? rows.map((p) => packRow({ division: p.division }, p)) : emptyState("Nothing here.")}
  </div>`;
}

function markup() {
  const d = R();
  const packs = d.divisions.flatMap((x) => x.packs);
  const toSend = packs.filter((p) => !(p.status && p.status.sent)).length;
  return html`<div class="page pane">
    <div style="margin-bottom: 14px;">${canRun() ? faNav("review") : html`<a href="/leadership" class="small" style="font-weight: 700;">‹ Portfolio</a>`}</div>
    <div class="dec-head">
      <div style="min-width: 0; flex: 1;">
        <h1 class="h1">${d.lines.length ? `${d.lines.length} ${plural(d.lines.length, "project")} need a word from their owners.` : "Nothing needs chasing this quarter."}</h1>
        <div class="sub">Spent ≥ 80% · aged ≥ 6 months · over $100K — the workbook's own rules. ${d.excluded.length} excluded for a confirmed future go-live. ${d.period}, as of ${date(d.asOf)}.${tip("A pack is one e-mail per person, not one per line. Marking it sent records a dated note on every line it covered — the entry the workbook keeps by hand — and a reply recorded against a line is what marks it answered.")}</div>
      </div>
      <div class="chipnav periods" id="periods">${(d.periods || [d.period]).map((p) => html`<a href="/auc-review?period=${encodeURIComponent(p)}" class="${p === d.period ? "on" : ""}" data-key="${p}">${p}</a>`)}</div>
    </div>
    ${tiles()}
    <div id="bucket-list">${ui.open ? listFor(ui.open) : ""}</div>
    <div class="sect" style="margin-top: 26px;">BY DIVISION · ${d.divisions.length} ${plural(d.divisions.length, "DIVISION")}, ${packs.length} ${plural(packs.length, "REVIEWER")}</div>
    <div class="card" style="overflow: hidden; margin-top: 10px;" id="divisions">${d.divisions.length ? d.divisions.map(divisionRow) : emptyState("No lines in the population this period.")}</div>
    ${toSend && canRun() ? html`<div class="small muted" style="margin-top: 16px;">${toSend} still to go out.</div>` : ""}
  </div>`;
}

// ---- the pack ------------------------------------------------------------------------------------
/**
 * What the email claims, shown (design rule 5). Each line opens its own order, because the
 * reply the reviewer eventually gives is recorded against a line, never against the pack.
 */
function packLines(lines) {
  if (!lines.length) return "";
  return html`<div class="sect" style="margin-top: 18px;">THE ${lines.length} ${plural(lines.length, "LINE")} IT COVERS</div>
    <div class="list" style="margin-top: 8px;">
      ${lines.map((l) => html`<button type="button" class="lrow" data-line-io="${l.ioNumber}" data-key="${l.id}" style="grid-template-columns: minmax(0, 1fr) 110px 28px; width: 100%; text-align: left; background: none; border-width: 0 0 1px; font: inherit; cursor: pointer;">
        <span style="min-width: 0;"><span class="ttl">${l.ioDescription || "(no description)"}</span><span class="id">IO ${l.ioNumber}${l.consumedPct !== null && l.consumedPct !== undefined ? ` · ${Math.round(l.consumedPct * 100)}% consumed` : ""}${l.ageingDays ? ` · ${l.ageingDays} days old` : ""}${l.estimatedServiceDate ? ` · in service ${date(l.estimatedServiceDate)}` : ""}</span></span>
        <span class="amt">${money(l.endingBalance)}</span>
        <span class="chev">${icon("chevR", 18)}</span>
      </button>`)}
    </div>`;
}

async function openPack(division, reviewerName) {
  let pack;
  try { pack = await api.get(`/api/auc-review/packs/${encodeURIComponent(division)}/${encodeURIComponent(reviewerName)}?period=${encodeURIComponent(R().period)}`); }
  catch (e) { showError(e); return; }
  const d = pack.draft;
  const r = await sheet({
    eyebrow: `${division.toUpperCase()} · ${d.lineCount || pack.lineCount} ${plural(pack.lineCount, "LINE")}`,
    title: d.reviewerName === "(no responsible reviewer named)" ? "No reviewer is named for these" : d.reviewerName,
    sub: d.to ? `To ${d.to}` : "The recon file holds names, not mailboxes — type the address in Outlook before sending.",
    body: html`<div style="font-size: 13px; font-weight: 700;">${d.subj}</div>
      <pre class="draft" style="margin-top: 10px;">${d.body}</pre>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 10px;">
        <button type="button" class="pillbtn sm" data-copy-pack>${icon("copy", 13)}Copy the text</button>
        ${pack.csv ? html`<button type="button" class="pillbtn sm" data-csv-pack>${icon("doc", 13)}Download the CSV</button>` : ""}
        ${tip("The same lines produce the same words every quarter. The CSV is the table the reviewer answers on — attach it to the e-mail.")}
      </div>
      ${packLines(pack.lines || [])}`,
    // Copy and the CSV keep the sheet open — closing it on Copy meant reopening it to mark it sent.
    actions: canRun() ? [{ label: "Close", value: null, tone: "sec" }, { label: "Mark it sent", value: "sent", primary: true }] : [{ label: "Close", value: null, tone: "sec" }],
    collect: () => ({ draft: d, csv: pack.csv, ioNumbers: d.ioNumbers }),
    onMount: (el) => {
      on(el, "click", "[data-line-io]", (e, b) => { closeSheet(null); navigate(`/io/${b.dataset.lineIo}?from=review`); });
      on(el, "click", "[data-copy-pack]", async () => {
        try { await navigator.clipboard.writeText(`Subject: ${d.subj}\n\n${d.body}`); toast("Copied.", "ok"); } catch { toast("Copy failed — select the text instead.", "err"); }
      });
      on(el, "click", "[data-csv-pack]", () => {
        const url = URL.createObjectURL(new Blob([pack.csv], { type: "text/csv" }));
        const link = document.createElement("a");
        link.href = url; link.download = `auc-review-${division}-${d.reviewerName}.csv`.replace(/[^\w.-]+/g, "-");
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
    },
  });
  if (r.value !== "sent") return;
  const n = (d.ioNumbers || []).length;
  const sure = await sheet({ eyebrow: "MARK IT SENT", title: `Mark ${n} ${plural(n, "line")} sent to ${d.reviewerName}?`,
    sub: "A dated note goes on every line it covers, and next quarter reads it as chased. Do this once you have sent the e-mail.",
    actions: [{ label: "Not yet", value: null, tone: "sec" }, { label: "Mark it sent", value: "ok", primary: true }] });
  if (sure.value !== "ok") return;
  try {
    // "(simulated)" only where nothing real was sent — a demonstration. The e-mail goes from
    // Outlook, so in real use the note says sent, plainly.
    await api.post("/api/auc-review/packs/sent", { ioNumbers: d.ioNumbers, period: R().period, reviewerName: d.reviewerName, simulated: Boolean(session.me && session.me.demoMode) });
    store.bust("/api/auc-review");
    toast(`Recorded as sent to ${d.reviewerName}.`, "ok");
    await load(R().period);
    paint();
  } catch (e) { showError(e); }
}

export async function render(root, ctx) {
  S.root = root;
  const wait = opening(root, "Opening the quarterly review…");
  try { await load(ctx.query.period); } catch (e) { wait(); delete root.dataset.review; loadFailed(root, e); return; }
  wait();
  if (ui.open === undefined) ui.open = null;
  if (!root.dataset.review) { root.innerHTML = ""; root.dataset.review = "1"; }
  paint();
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "click", "[data-bucket]", (e, b) => { ui.open = ui.open === b.dataset.bucket ? null : b.dataset.bucket; paint(); });
  on(root, "click", "[data-division]", (e, b) => { ui.division = ui.division === b.dataset.division ? null : b.dataset.division; paint(); });
  on(root, "click", "[data-pack]", (e, b) => { const [div, rev] = b.dataset.pack.split("::"); openPack(div, rev); });
  on(root, "click", "#all-excluded", () => { ui.allExcluded = true; paint(); });
}
export function unmount() { if (S.root) { delete S.root.dataset.review; S.root.innerHTML = ""; } }
