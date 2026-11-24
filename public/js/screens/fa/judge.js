// /fa/:id/judge — the form and its signatures first, then the red flags, then what only a
// person can say. Opens on three tiles and reveals one; "Key it into SAP" is off, with the
// reason, until the flags are clear, the rows are ticked and the order type is chosen. Every
// claim has a Show me.
//
// The order is Lyndsay's and Shashank's, and it is not cosmetic: "land them on the 2nd tab, not
// the checklist directly", "complete AFE form and signature review before the Judgement tab".
// The judgment is LOCKED until somebody records that they have read the form — enforced by the
// route, because a tab order is a suggestion and a refusal is a control.
import { html, morph, on, $, $$ } from "../../core/dom.js";
import { api, documentToBase64 } from "../../core/api.js";
import { store, uiFor } from "../../core/store.js";
import { navigate } from "../../core/router.js";
import { session } from "../../core/session.js";
import { setRecord, setRecordNote, refreshCounts } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, since, plural } from "../../core/format.js";
import { tag, bucket, signerRow, docRow, emptyState, CTA_ARROW, reopenPicker, when, thread, roundLine, ownDocuments, tip } from "../../components/parts.js";
import { postComment } from "../../core/comments.js";
import { bringTo } from "../../core/motion.js";
import { sheet, askText, toast, busy, showError, closeSheet } from "../../core/ui.js";
import { identityLine, chipsFor, flagRow, showMe, verifiedBadge, summaryLine, firstName, LEVEL_TITLE, canShow } from "./common.js";

const ui = uiFor("fa-judge");
// `seq` counts the presses in flight: only the latest answer is painted, because it carries every
// write before it. `pdfReady` is the document whose frame has loaded, so a repaint keeps the frame
// shown rather than stripping the attribute and hiding it again.
const S = { id: null, view: null, root: null, wiredTo: null, draft: null, seq: 0, pdfReady: null };
const afe = () => S.view.afe;
const verification = () => (S.view.envelope && S.view.envelope.completed && S.view.envelope.completed.verification) || [];

// An answer for an AFE this screen has since left is not painted: a reply arriving late used to
// put the previous AFE's tiles on the one now open.
async function load() { const id = S.id; const v = await api.get(`/api/fa/afes/${id}`); if (id === S.id) S.view = v; }

/** R98 — record (or withdraw) that the form and the signatures have been read. */
async function formReviewed(undo) {
  const btn = $(undo ? "#unreview" : "#reviewed", S.root);
  const done = btn ? busy(btn, undo ? "Undoing…" : "Recording…") : () => {};
  const id = S.id;
  try {
    const res = await api.post(`/api/fa/afes/${id}/form-reviewed`, { undo });
    if (id !== S.id) return;
    take(res);
    // Reviewing it opens the judgment — but open red flags come first, which is the screen's own
    // order (form → flags → judgment). It jumped straight to the judgment past them.
    if (!undo && ui.open) delete ui.open[S.id];
    toast(undo ? "Review withdrawn." : S.view.redFlags.ready ? "Recorded. The judgment is open." : "Recorded. Clear the red flags, then the judgment.", "ok");
    paint();
  } catch (e) { done(); showError(e); }
}
function take(res) { if (res && res.redFlags) S.view = res; }
function paint() { if (S.root && S.view) morph(S.root, markup()); }
function openKey() {
  if (ui.open && ui.open[S.id] !== undefined) return ui.open[S.id];
  // Always the form first while it is still to be reviewed. After that, whatever is outstanding.
  if (S.view.judgment.locked) return "signatures";
  const R = S.view.redFlags.summary;
  return R.openBlocks || R.openWarns ? "flags" : S.view.judgment.open ? "judgment" : "signatures";
}
function setOpen(k) { ui.open = ui.open || {}; ui.open[S.id] = k; }

// ---- the three tiles -------------------------------------------------------------------------------
function tiles() {
  const R = S.view.redFlags.summary, J = S.view.judgment, V = verification();
  const ok = V.filter((v) => v.st === "ok").length;
  const openFlags = R.openBlocks + R.openWarns;
  const first = S.view.redFlags.open[0];
  const k = openKey();
  const reviewed = J.formReviewed;
  return html`${bucket({ key: "signatures", icon: "doc", n: html`${ok} <small>of ${V.length}</small>`, title: "The form and signatures", tone: !V.length ? "red" : ok < V.length ? "red" : reviewed ? "green" : "yellow", on: k === "signatures",
      detail: !V.length ? "No completed envelope on this AFE yet."
        : ok < V.length ? `${V.length - ok} ${plural(V.length - ok, "signature does", "signatures do")} not match the approved chain.`
        // html, not a plain string: `when()` is markup, and a plain template turned it into text
        // that the tile then escaped — "Read by … <time datetime=…>" on the screen (2026-09-28).
        : reviewed ? html`Read by ${reviewed.byName} ${when(reviewed.at)}. Every signer matches the chain frozen at send.`
        : "Read the form and the signatures. The judgment opens once you record that you have." })}
    ${bucket({ key: "flags", icon: "flag", n: openFlags, title: openFlags === 1 ? "Red flag" : "Red flags", tone: R.openBlocks ? "red" : openFlags ? "yellow" : "green", on: k === "flags",
      detail: first ? first.title : R.total ? `${R.total} acknowledged or cleared. Nothing left to clear.` : "Rules still hold, the matrix is unchanged, every signature matches the chain." })}
    ${bucket({ key: "judgment", icon: "tick", n: J.locked ? html`<span style="color: var(--muted);">—</span>` : html`${J.rows.length - J.open} <small>of ${J.rows.length}</small>`, title: "Your judgment", tone: J.locked ? "grey" : J.open ? "yellow" : "green", on: k === "judgment",
      detail: J.locked ? "Opens once the form and the signatures have been reviewed."
        : J.open ? `${J.open} ${plural(J.open, "row")} still to tick${J.rows.some((r) => r.id === "order_type" && r.st !== "ok") ? ". Order type not chosen — Z002 or Z005, by the nature of the AFE." : "."} `
        : "Every row confirmed. Order type chosen." })}`;
}

// ---- red flags --------------------------------------------------------------------------------------
function flagActions(f) {
  const perms = S.view.permissions, id = afe().id;
  const show = canShow(f.showMe) ? html`<button type="button" class="pillbtn sm soft" data-show="${f.id}">Show me</button>` : "";
  if (f.cleared) return html`${f.clearedBy && f.clearedBy.attachmentId ? html`<a class="pillbtn sm soft" href="/api/afes/${id}/documents/${f.clearedBy.attachmentId}/raw" target="_blank" rel="external">Evidence ${icon("external", 12)}</a>` : ""}${show}`;
  if (!perms.canAckFlags) return show;
  if (f.source === "drift") return html`<button type="button" class="pillbtn sm dark" data-evidence="${f.level}">Attach email approval</button>${show}`;
  return html`<button type="button" class="pillbtn sm" data-ack="${f.id}">Acknowledge</button>${show}`;
}
function digestCard() {
  const a = afe();
  const drafts = (a.fa && a.fa.digests) || [];
  const d = S.draft;
  if (!d && !drafts.length) return "";
  return html`<div class="panel t-yellow" data-key="digest">
    <div class="panel-hd"><span class="ttl">${icon("mail", 14)} The red-flag email</span><span class="meta">${d ? "drafted just now" : "drafted " + since(drafts[drafts.length - 1].at)}</span><span class="right">${tag("DRAFT — never sent by the tool", "yellow", { icon: "mail" })}</span></div>
    ${d ? html`<div style="padding: 14px 20px;">
      <div class="small muted">To <b>${d.draft.toName || d.draft.to}</b> &lt;${d.draft.to}&gt;${d.draft.cc && d.draft.cc.length ? ` · cc ${d.draft.cc.join(", ")}` : ""}</div>
      <div style="font-size: 13px; font-weight: 700; margin-top: 6px;">${d.draft.subject}</div>
      <pre class="draft" style="margin-top: 10px;">${d.draft.body}</pre>
      <div style="display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; align-items: center;">
        <a class="pillbtn dark" href="${d.emlUrl}" download="${d.filename}">${icon("mail", 14)}Download the draft (.eml)</a>
        <button type="button" class="pillbtn" data-copy-draft>${icon("copy", 14)}Copy the text</button>
        <span class="small muted">Opens in Outlook as an unsent draft from the RTR_FA outbox. Check the flags again, then send it yourself.</span>
      </div>
    </div>` : ""}
    ${drafts.length ? html`<div style="padding: 10px 20px 14px; border-top: 1px solid var(--line-soft);"><div class="sect">EARLIER DRAFTS</div>
      ${drafts.slice().reverse().map((x) => html`<div class="small" style="margin-top: 6px; display: flex; gap: 10px; align-items: center;" data-key="${x.notificationId}"><span>${since(x.at)} by ${x.byName} · ${x.flagIds.length} ${plural(x.flagIds.length, "flag")} · to ${x.to}</span><a href="/api/fa/afes/${a.id}/red-flags/drafts/${x.notificationId}.eml" download style="font-weight: 700;">.eml</a></div>`)}
    </div>` : ""}
  </div>`;
}
function flagsSection() {
  const F = S.view.redFlags, perms = S.view.permissions, dg = S.view.digest;
  return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="sec-flags">
    <div class="panel t-red">
      <div class="panel-hd"><span class="ttl">${icon("flag", 14)} Red flags</span><span class="meta">clear or acknowledge before SAP</span></div>
      ${F.flags.length ? F.flags.map((f) => flagRow(f, { actions: flagActions(f) })) : emptyState("Nothing is flagged. The rules still hold, the matrix is unchanged, and every signature matches the chain frozen at send.")}
      ${F.flags.length && perms.canDraftDigest ? html`<div style="display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-top: 1px solid var(--line-soft); background: var(--card-soft); flex-wrap: wrap;">
        <button type="button" class="pillbtn dark" id="draft-digest">${icon("mail", 14)}Draft the red-flag email</button>
        <span class="small muted" style="flex: 1; min-width: 240px;">One email, every open flag, to ${dg && dg.toName ? dg.toName : "the coordinator"}${dg && dg.cc && dg.cc.length ? ` with ${afe().requester ? firstName(afe().requester.name) : "the requester"} in copy` : ""}. It lands in the RTR_FA outbox as a <b>draft</b> — the tool never sends it. You check the flags again, then send from Outlook.</span>
      </div>` : ""}
    </div>
    ${digestCard()}
  </div>`;
}

// ---- signatures ---------------------------------------------------------------------------------------
function signaturesSection() {
  const r = S.view.routing, V = verification(), drift = S.view.redFlags.drift, a = afe(), m = S.view.matrix || {};
  const signers = r ? r.recipients.filter((x) => x.role !== "cc" && ["signed", "sent", "pending", "declined", "skipped", "sod_blocked", "superseded"].includes(x.status)) : [];
  const driftFor = (rec) => { const d = drift.changed.find((x) => x.level === rec.level && rec.role === "matrix" && !rec.standInFor); return d ? html`<span class="vbadge bad">matrix now names ${d.now || "nobody"}</span>` : ""; };
  // What came with the AFE, and the evidence it was signed. The AFE itself is the frame above —
  // one document (R156) — so the generated form and the signed set are not rows here as well.
  const docs = ownDocuments(a).filter((d) => ["certificate", "email_approval"]
    .concat((session.refdata && session.refdata.supportingRoles) || ["quote", "sow", "backup"]).includes(d.role));
  const levels = (m.levels || []).filter((l) => l !== "BOARD");
  const J = S.view.judgment;
  const reviewed = J.formReviewed;
  const canReview = S.view.permissions.canJudge && a.state === "fa_review";
  // The signed form itself, on the page rather than behind a button. The src carries no clock
  // and no version, so a repaint leaves the attribute alone and the iframe never reloads --
  // which is what `data-static` would have done, except that it also freezes the node for good.
  //
  // It says it is working until the frame has painted (design rule 6). On UAT the first read of a
  // signed set comes out of Postgres and took seconds, and a white rectangle that long cannot be
  // told from a broken one — switching tiles and back "fixed" it only because the second read came
  // from memory. `data-ready` is rendered from `S.pdfReady`, not only set on the element, because
  // `morph` removes any attribute the new markup does not carry.
  const src = `/api/afes/${a.id}/document.pdf`;
  return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="sec-signatures">
    <div class="card" style="overflow: hidden;" data-key="the-form">
      <div class="tabhd" style="border-top: 0; display: flex; justify-content: space-between; align-items: center; gap: 10px;">
        <span>THE AFE FORM · AS IT WAS SIGNED</span>
        <a class="linkbtn" href="${src}" target="_blank" rel="external">Open in a new tab ${icon("external", 12)}</a>
      </div>
      <div class="pdfwrap" ${S.pdfReady === src ? "data-ready" : ""}>
        <div class="pdfbusy" style="border: 0; border-radius: 0;" aria-live="polite">
          <span class="spin"></span>
          <span><b>Opening the signed AFE</b><br>the form as it was signed, and everything bound in behind it</span>
        </div>
        <iframe class="pdf-frame" style="border: 0; border-radius: 0; display: block; height: 560px;" src="${src}" title="The signed AFE form"></iframe>
      </div>
      <div style="display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 12px 16px; border-top: 1px solid var(--line-soft); background: ${reviewed ? "var(--green-ok-bg)" : "var(--card-soft)"};">
        ${reviewed
          ? html`<span class="tick ok">${icon("tick", 12, { stroke: 2.6 })}</span>
              <span style="font-size: 13px;"><b>${reviewed.byName}</b> read the form and the signatures <span class="muted">${when(reviewed.at)}</span></span>
              ${canReview ? html`<button type="button" class="linkbtn quiet" id="unreview" style="margin-left: auto;">Undo</button>` : ""}`
          : html`<span style="font-size: 13px; color: var(--ink-2); flex: 1; min-width: 220px;">The judgment opens once you record that you have read this and the signatures below.</span>
              ${canReview ? html`<button class="cta sm" id="reviewed">Form and signatures reviewed</button>` : html`<span class="small muted">A Fixed Assets preparer or checker records this.</span>`}`}
      </div>
    </div>
    <div class="panel t-green">
      <div class="panel-hd"><span class="ttl">${icon("users", 14)} The signatures</span><span class="meta">frozen at send, checked on receipt${r ? ` · round ${r.round}` : ""}</span></div>
      ${signers.length ? signers.map((rec) => signerRow(rec, { right: html`<span style="display: flex; flex-direction: column; align-items: flex-end; gap: 3px; min-width: 0;">${rec.status === "signed" || rec.status === "declined" ? verifiedBadge(V.find((v) => v.recipientId === rec.id)) : html`<span class="vbadge soft">${rec.status === "skipped" ? "signs at a higher row" : rec.status === "sod_blocked" ? "party to this AFE" : rec.status}</span>`}${driftFor(rec)}</span>`, action: html`<span></span>` })) : emptyState("No chain on this AFE.")}
    </div>
    <div class="panel t-blue">
      <div class="panel-hd"><span class="ttl">${icon("shield", 14)} SAP approver matrix</span><span class="meta">cost centre ${a.costCenter || "?"}</span><span class="right"><button type="button" class="linkbtn" data-show-matrix>Show me</button></span></div>
      <div style="padding: 12px 20px; font-size: 12.5px;">
        ${drift.changed.length ? html`<div class="banner red" style="margin-bottom: 10px;">${icon("bang", 16)}<span>Changed since send at ${drift.changed.map((d) => d.level).join(", ")} — batch ${m.sentBatchId || "?"} → ${m.currentBatchId || "?"}.</span></div>` : m.batchChanged ? html`<div class="banner green" style="margin-bottom: 10px;">${icon("tick", 16)}<span>A newer matrix batch (${m.currentBatchId}) names the same people at every required level.</span></div>` : html`<div class="small muted">Batch ${m.currentBatchId || "?"} — unchanged since this was sent.</div>`}
        <div class="chips" style="margin-top: 6px;">${levels.map((l) => { const now = m.now && m.now[l] ? m.now[l].name : ""; const changed = drift.changed.some((d) => d.level === l); return tag(`${l} · ${now || "blank"}`, changed ? "red" : "grey", { title: LEVEL_TITLE[l] || l }); })}</div>
      </div>
    </div>
    <div class="panel t-blue">
      <div class="panel-hd"><span class="ttl">${icon("doc", 14)} The documents</span><span class="meta">what the approvers were given</span></div>
      ${docs.length ? docs.map((d) => docRow(d, a.id, { right: html`<button type="button" class="pillbtn sm" data-doc="${d.attachmentId}">Show me</button>` })) : emptyState("No documents on this AFE.")}
      ${S.view.formHash && S.view.formHash.checked ? html`<div class="small ${S.view.formHash.ok ? "muted" : ""}" style="padding: 10px 20px; border-top: 1px solid var(--line-soft); color: ${S.view.formHash.ok ? "" : "var(--yellow)"};">${S.view.formHash.ok ? "The AFE Form re-rendered today hashes to exactly what was frozen on the envelope at send." : "The form re-rendered today differs from what was signed — see the red flag."}</div>` : ""}
    </div>
  </div>`;
}

// ---- judgment -------------------------------------------------------------------------------------------
function judgmentSection() {
  const J = S.view.judgment, perms = S.view.permissions, a = afe();
  const types = S.view.ko01.orderTypes || [];
  // R98 — shut until the form and the signatures have been read, and it says who can open it
  // rather than showing rows that would be refused.
  if (J.locked) {
    return html`<div class="card pad" data-key="sec-judgment" style="text-align: center; padding: 34px 24px;">
      <div style="font-size: 15px; font-weight: 700;">The judgment opens after the form.</div>
      <div class="muted" style="font-size: 13px; margin-top: 6px; max-width: 460px; margin-left: auto; margin-right: auto; line-height: 1.5;">
        Read the AFE form as it was signed and check the signatures against the chain that was frozen at send.
        Record that you have, and these rows open.
      </div>
      <button class="cta sm" id="to-form" style="margin-top: 16px;">Take me to the form ${CTA_ARROW}</button>
    </div>`;
  }
  return html`<div class="panel t-green" data-key="sec-judgment">
    <div class="panel-hd"><span class="ttl">${icon("tick", 14)} Your judgment</span><span class="meta">what only a person can say</span><span class="right" style="color: var(--link); font-weight: 700; font-size: 12px;">${J.rows.length - J.open} of ${J.rows.length}${a.fa && (a.fa.judgedByName || a.fa.judgedByEmail) ? ` · last by ${a.fa.judgedByName || nameFor(a.fa.judgedByEmail)}` : ""}</span></div>
    ${J.rows.map((r) => html`<div class="jrow" data-key="${r.id}">
      <button type="button" class="tick lg ${r.st === "ok" ? "ok" : r.st === "ready" ? "ready" : "off"}" data-tick="${r.id}" data-on="${r.confirmed ? "1" : "0"}" ${perms.canJudge ? "" : "disabled"} aria-pressed="${r.confirmed ? "true" : "false"}" aria-label="${r.confirmed ? "Confirmed — tap to undo: " : "Confirm: "}${r.t}">${r.st === "ok" || r.st === "ready" ? icon("tick", 15, { stroke: 2.4 }) : ""}</button>
      <div style="min-width: 0;">
        <div class="t">${r.t}</div>
        <div class="s">${r.sub ? r.sub + " · " : ""}${r.confirmed ? "confirmed" : r.st === "ready" ? "the evidence agrees — tap to confirm" : r.help}</div>
        ${r.id === "order_type" ? html`<div class="chips" style="margin-top: 8px;">${types.map((t) => html`<button type="button" class="chip sm ${a.fa && a.fa.orderType === t.code ? "on" : ""}" data-order="${t.code}" data-key="${t.code}" ${perms.canJudge ? "" : "disabled"} aria-pressed="${a.fa && a.fa.orderType === t.code ? "true" : "false"}">${t.code} · ${t.label}</button>`)}<span class="small muted" style="align-self: center;">by the nature of the AFE — never guessed</span>${tip("Z002 is the Capital Investment Order. Which AFEs take Z005 is Fixed Assets' call, by the nature of the AFE — the rule is still to be written down.")}</div>` : ""}
        ${r.id === "order_type" ? fxRow(a, perms) : ""}
        ${r.id === "amount_reasonable" ? quoteFigures(a) : ""}
        ${r.id === "classification_agreed" && perms.canReclassify ? html`<div style="margin-top: 6px;"><button type="button" class="linkbtn" id="reclassify">Reclassify with a reason</button>${a.fa && a.fa.reclassified ? html` <span class="small muted">· reclassified ${a.fa.reclassified.from} → ${a.fa.reclassified.to} by ${a.fa.reclassified.byName}: “${a.fa.reclassified.reason}”</span>` : ""}</div>` : ""}
      </div>
    </div>`)}
    ${/* Who approves the issue is the next question once the rows are done — asked here, where the
          judgment ends, rather than floating under the conversation. */ ""}
    ${!J.open ? html`<div style="padding: 0 16px 16px;">${approverPicker()}</div>` : ""}
  </div>`;
}

/**
 * Where each quote total came from (R170): typed by whom, or read off the quote at what confidence
 * and confirmed by whom — and, where the reader read a total nobody used, that figure beside the
 * typed one, marked as never confirmed. Evidence for the person ticking "the amount is reasonable";
 * it raises no flag of its own, because a proposal nobody confirmed cannot count for anything
 * (non-negotiable #1). Each read figure opens the page it was read from, ringed.
 */
function quoteFigures(a) {
  const roles = (session.refdata && session.refdata.quoteRoles) || ["quote", "sow", "internal_quote"];
  const priced = (a.documents || []).filter((d) => roles.includes(d.role));
  if (!priced.length) return "";
  const pct = (c) => `${Math.round((c || 0) * 100)}%`;
  return html`<div class="qfigs" data-key="qfigs">${priced.map((d) => {
    const prov = (d.provenance || {}).amountUsd || null;
    const r = d.reading && d.reading.status === "read" ? d.reading : null;
    const read = r && r.fields && r.fields.amount ? r.fields.amount : null;
    const typedTotal = d.amountUsd === null || d.amountUsd === undefined ? "no total typed" : money(d.amountUsd);
    const how = !prov ? "" : prov.source === "read" ? ` · read off the quote at ${pct(prov.confidence)}, confirmed by ${prov.byName}` : ` · typed by ${prov.byName}`;
    const unused = read && !(prov && prov.source === "read");
    const readText = read ? (read.currency && read.currency !== "USD" ? `${read.currency} ${Number(read.value).toLocaleString("en-US")}` : money(read.value)) : "";
    return html`<div class="qfig" data-key="${d.attachmentId}">
      <span><b>${d.vendor || d.filename}</b> · ${typedTotal}${how}</span>
      ${unused ? html`<a class="airead" href="/api/afes/${a.id}/documents/${d.attachmentId}/reading/amount/show.pdf" target="_blank" rel="external" title="Show me where it was read">The reader read ${readText} at ${pct(read.confidence)} — ${!r.decision ? "never confirmed"
        : r.decision.outcome === "set_aside" ? `set aside by ${r.decision.byName}` : `used by ${r.decision.byName}, then typed over`}</a>` : ""}
    </div>`;
  })}</div>`;
}

/**
 * The rate Fixed Assets keys SAP at, on an AFE in another currency (R161). It starts as the AFE's
 * own — Global Finance's month-end from the month it was written — and Fixed Assets may set the one
 * they key at; it prints in red on the issued AFE, never on the signed page.
 */
function fxRow(a, perms) {
  const m = a.money || {};
  const code = String(m.currency || "USD").toUpperCase();
  if (code === "USD") return "";
  const set = a.fa && a.fa.fx;
  const shown = set ? set.localPerUsd : m.fx ? m.fx.localPerUsd : "";
  const month = m.fx && m.fx.month ? m.fx.month.split("-") : null;
  const monthText = month ? `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(month[1]) - 1]} ${month[0]}` : "";
  return html`<div data-key="fx" style="display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap;">
    <span class="small" style="color: var(--ink-2);">Rate for SAP: 1 USD =</span>
    <input class="input" id="fa-fx" value="${shown}" inputmode="decimal" style="width: 124px; height: 34px;" aria-label="${code} per US dollar" ${perms.canJudge ? "" : "disabled"} autocomplete="off">
    <span class="small" style="font-weight: 700;">${code}</span>
    ${perms.canJudge ? html`<button type="button" class="pillbtn sm" id="fa-fx-save">Record</button>` : ""}
    <span class="small muted">${set ? `set by ${set.byName} ${since(set.at)}` : `the AFE's own: Global Finance, ${monthText || "month-end"}`}</span>
  </div>`;
}

/**
 * Whose approval this AFE is waiting on, and Fixed Assets choosing it (R145).
 *
 * "There is some option that preparer can choose either me or Jarrod or Manaia, so that once
 * they will choose the approval, then it will go to that particular approval" (Judithmelanie,
 * Meeting #6). The reason is leave cover, so the control is a plain multi-select: pick one, or
 * pick two if either will do, or pick nobody and it stays open to all three.
 */
function approverPicker() {
  const issue = S.view.issue || {};
  if (!issue.required || issue.approval || !issue.canChoose) return "";
  const chosen = new Set((issue.chosen || []).map((x) => x.email));
  const all = issue.approvers || [];
  if (all.length < 2) return "";
  return html`<div class="panel t-blue" style="margin-top: 16px;" data-key="approver-pick">
    <div class="panel-hd"><span class="ttl">${icon("user", 14)} Who approves the issue</span>
      <span class="meta">${issue.wasChosen ? "chosen" : "open to all"}</span></div>
    <div class="panel-bd">
      <div class="chips" style="margin-top: 0;">
        ${all.map((x) => html`<button type="button" class="chip ${chosen.has(x.email) && issue.wasChosen ? "on" : ""}"
          data-approver="${x.email}" data-key="${x.email}"
          aria-pressed="${chosen.has(x.email) && issue.wasChosen ? "true" : "false"}">${x.name}<i> · ${x.group || "approver"}</i></button>`)}
      </div>
      <div class="small muted" style="margin-top: 8px;">${issue.wasChosen
        ? html`It goes to <b>${(issue.chosen || []).map((x) => x.name).join(" or ")}</b>. Tap to change, or tap again to leave it open to all ${all.length}.`
        : html`Any of the ${all.length} may approve. Tap one to send it to them — cover for leave, when somebody is out.`}</div>
    </div>
  </div>`;
}

// ---- the page -------------------------------------------------------------------------------------------
function footer() {
  const a = afe(), perms = S.view.permissions, ready = S.view.readiness;
  if (a.state === "fa_review") {
    // The one thing standing between this AFE and SAP may be THIS person's own signature, and
    // the only place that button lived was the issue screen — behind the disabled "Key it into
    // SAP" it is itself blocking. "I can't see anything for Judithmelanie and Jarrod to approve"
    // (Shashank, 2026-09-22): there was nothing. A blocker that names a person offers that
    // person the way to clear it (R142), the same rule as a block that names a field.
    const issue = S.view.issue || {};
    return html`<div class="foot" style="margin-top: 22px; justify-content: flex-start;">
      ${issue.canApprove
        ? html`<button class="cta" id="approve-issue">Approve for issue ${CTA_ARROW}</button>`
        : ready.canRecord ? html`<a class="cta" href="/fa/${a.id}/issue" id="to-issue">Key it into SAP ${CTA_ARROW}</a>`
        : html`<button class="cta off" disabled>Key it into SAP ${CTA_ARROW}</button>`}
      ${issue.canApprove
        ? html`<span class="small" style="color: var(--ink-2);">Four eyes on a new internal order: you release it, somebody else keys SAP.</span>`
        : !ready.canRecord ? html`${blockers(perms)}
            ${issue.required && !issue.approval && !issue.canApprove && S.view.redFlags.ready
              ? html`<button type="button" class="pillbtn sm" id="ask-approver" style="margin-left: 8px;">${icon("send", 13)}${afe().fa && afe().fa.issueApprovalAskedAt ? "Chase" : "Ask"} ${(issue.chosen || []).map((x) => firstName(x.name)).join(" or ") || "them"}</button>
                 ${told(issue)}` : ""}`
        : html`<a class="small" href="/fa/${a.id}/issue" style="font-weight: 700;">The KO01 sheet has every field ready to copy.</a>`}
      ${perms.canReturn ? html`<button class="cta quiet" id="return" style="margin-left: auto;">Send back to ${a.requester ? a.requester.name : "the requester"}</button>` : ""}
    </div>`;
  }
  if (["issued", "tracking"].includes(a.state)) return html`<div class="foot" style="margin-top: 22px; justify-content: flex-start;"><a class="cta" href="/fa/${a.id}/issue">Continue in SAP — the budget and the AuC ${CTA_ARROW}</a><span class="small muted">Issued as AFE ${a.afeNo}.</span></div>`;
  return html`<div class="foot" style="margin-top: 22px; justify-content: flex-start;"><a class="cta sec" href="/afe/${a.id}">Open the AFE ${CTA_ARROW}</a></div>`;
}
/**
 * What stands between this AFE and SAP, each one a button to the tile where it is cleared
 * (2026-10-16). It was one yellow sentence at the foot, under the conversation, with nothing to
 * press — "1 red flag… 3 judgment rows still open…" — so the reader had to go and find each one.
 * Decided from the same facts the tiles are drawn from; the server's own words remain when none
 * of them is the reason.
 */
function blockers(perms) {
  const v = S.view, J = v.judgment, issue = v.issue || {}, R = v.redFlags.summary || {};
  const out = [];
  if (J.locked) out.push(html`<button type="button" class="pillbtn sm" data-open-tile="signatures">${icon("doc", 13)}Review the form and signatures</button>`);
  if (!v.redFlags.ready) out.push(html`<button type="button" class="pillbtn sm" data-open-tile="flags">${icon("bang", 13)}${R.openBlocks || 1} red ${plural(R.openBlocks || 1, "flag")} to clear</button>`);
  if (!J.locked && J.open) out.push(html`<button type="button" class="pillbtn sm" data-open-tile="judgment">${icon("tick", 13)}${J.open} judgment ${plural(J.open, "row")} to tick</button>`);
  if (issue.required && !issue.approval && v.redFlags.ready) out.push(html`<span class="small" style="color: var(--ink-2);">Waiting on approval for issue.</span>`);
  if (!perms.canRecordIo && perms.canJudge) out.push(html`<span class="small muted">A Fixed Assets preparer records the order.</span>`);
  if (!out.length) out.push(html`<span class="small" style="color: var(--yellow); font-weight: 700;">${v.readiness.why.filter((w) => !/not with Fixed Assets/.test(w)).join(" ")}</span>`);
  return html`<span style="display: inline-flex; gap: 8px; flex-wrap: wrap; align-items: center;" data-key="blockers">${out}</span>`;
}
/** A person's name from their mailbox, where the tool knows them. */
function nameFor(email) {
  const u = ((session.users || [])).find((x) => String(x.email).toLowerCase() === String(email || "").toLowerCase());
  return u ? u.displayName : String(email || "").split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * "Judithmelanie was told 12 minutes ago" (R166). A Chase button says the approvers were told, and not
 * when — which is the one thing that decides whether to press it.
 */
function told(issue) {
  const at = afe().fa && afe().fa.issueApprovalAskedAt;
  if (!at) return "";
  const names = (issue.chosen || []).map((x) => firstName(x.name));
  const who = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} were` : `${names[0] || "They"} ${names.length ? "was" : "were"}`;
  return html`<span class="small muted" style="margin-left: 8px;" data-key="told">${who} told ${since(at)}.</span>`;
}

/** The open tab's section. The frame goes with its section, so leaving it means the next one loads again. */
function section(k) {
  if (k !== "signatures") S.pdfReady = null;
  return k === "flags" ? flagsSection() : k === "signatures" ? signaturesSection() : k === "judgment" ? judgmentSection() : "";
}

function markup() {
  const a = afe(), k = openKey();
  return html`<div class="page pane">
    <div class="dec-head">
      <div style="min-width: 0; flex: 1;">
        <div class="small muted"><a href="/fa" style="font-weight: 700;">‹ Fixed Assets</a> · ${identityLine(S.view)}</div>
        <h1 class="h1" style="margin-top: 4px;">${a.project.title || "(untitled)"}</h1>
        <div class="sub">${summaryLine(S.view)}</div>
      </div>
      <div class="big-amt">${money(S.view.totalUsd)}</div>
    </div>
    <div class="chips" style="margin-top: 14px;">${chipsFor(S.view)}</div>
    ${a.state === "returned" && a.returnedTo ? html`<div class="banner red" style="margin-top: 16px;">${icon("back", 16)}<span><b>${a.returnedTo.byName}</b> sent it back: “${a.returnedTo.reason}”. It is with ${a.requester ? a.requester.name : "the requester"} to fix.${S.view.resume && S.view.resume.applies ? html`<span style="display: block; margin-top: 8px;">${roundLine(S.view.resume)}</span>` : ""}</span></div>` : ""}
    <div class="buckets" id="tiles">${tiles()}</div>
    <div id="section" style="margin-top: 18px;">${section(k)}</div>
    <!-- R149: ask the requester here rather than by email, and the answer stays on the AFE.
         Outside #section, so it is there whichever tab is open. -->
    <div style="margin-top: 16px;">${thread(a.thread, { answer: S.view.permissions.answerTo, canComment: S.view.permissions.canComment, canAsk: S.view.permissions.canAsk, askWho: S.view.permissions.askWho,
      asks: S.view.asks, sides: session.refdata && session.refdata.threadSides })}</div>
    ${footer()}
  </div>`;
}

// ---- actions ----------------------------------------------------------------------------------------------
async function post(path, body, msg) {
  const id = S.id, seq = ++S.seq;
  try {
    const res = await api.post(path, body);
    store.bust("/api/fa");
    // The judgment completing tells the approvers by itself (R146). Say so, rather than let the
    // person wonder whether anybody has been told — which is the question Lyndsay asked.
    if (res && res.told) toast(res.told, "ok");
    else if (msg) toast(msg, "ok");
    refreshCounts();
    // Paint only the LATEST answer, and only on the AFE it is about. Two quick ticks are two
    // requests; painting the first answer when it lands would untick the second for a moment.
    if (id === S.id && seq === S.seq) { take(res); paint(); }
    return res;
  } catch (e) {
    showError(e);
    // A refusal puts back what the server holds: a change shown before the answer was a
    // proposal, and this is the answer.
    if (id === S.id && seq === S.seq) { try { await load(); paint(); } catch { /* keep what is shown */ } }
    return null;
  }
}

/**
 * A tick and an order type are direct manipulation, so they show at once and the server confirms
 * them — "a screen answers before the server does" (CLAUDE.md). They used to wait for the round
 * trip, and on UAT that was a second of a control that did nothing, long enough to press
 * something else and see THAT appear to load the first.
 */
function judge(body) {
  const J = S.view.judgment, a = afe();
  a.fa = Object.assign({}, a.fa);
  if (body.orderType !== undefined) a.fa.orderType = body.orderType;
  for (const r of J.rows) {
    if (!body.ticks || !(r.id in body.ticks)) continue;
    r.confirmed = body.ticks[r.id] === true;
    const unticked = r.id === "order_type" ? (a.fa.orderType ? "ready" : "open") : (r.untickedSt || "open");
    r.st = r.confirmed ? "ok" : unticked;
  }
  J.open = J.rows.filter((r) => r.st !== "ok").length;
  paint();
  return post(`/api/fa/afes/${a.id}/judgment`, body);
}
async function attachEvidence(level) {
  const a = afe();
  const existing = (a.documents || []).filter((d) => d.role === "email_approval");
  const d = S.view.redFlags.drift.changed.find((x) => x.level === level);
  const r = await sheet({
    eyebrow: `MATRIX DRIFT · ${level}`, title: `${d && d.now ? d.now + "'s" : "The new approver's"} email approval`,
    sub: `The matrix now names ${d ? d.now || "nobody" : "someone else"} at ${level}; ${d ? d.was : "the signer"} signed. Attach the email in which ${d && d.now ? firstName(d.now) : "the new approver"} approves this AFE (as a PDF), or pick one already on the AFE.`,
    body: html`
      ${existing.length ? html`<div class="sect">ALREADY ON THE AFE</div><div class="chips" style="margin: 8px 0 14px;">${existing.map((x) => html`<button type="button" class="chip sm" data-pick="${x.attachmentId}">${x.filename}</button>`)}</div>` : ""}
      <div class="sect">${existing.length ? "OR UPLOAD" : "UPLOAD"}</div>
      <input type="file" id="ev-file" accept="application/pdf" class="input" style="padding: 10px 14px; height: auto; margin-top: 8px;">
      <textarea class="input" id="ev-note" rows="2" placeholder="One line for the checker — e.g. Lekha approved by email on 4 Sep, forwarded to RTR_FA." style="margin-top: 12px;"></textarea>`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Clear the flag with this evidence", value: "ok", primary: true }],
    validate: (el) => (!$(".chip.on[data-pick]", el) && !($("#ev-file", el).files || []).length ? "Pick an email approval or upload one." : null),
    collect: (el) => ({ pick: ($(".chip.on[data-pick]", el) || { dataset: {} }).dataset.pick || null, file: ($("#ev-file", el).files || [])[0] || null, note: $("#ev-note", el).value.trim() }),
    onMount: (el) => on(el, "click", "[data-pick]", (e, b) => { for (const x of el.querySelectorAll("[data-pick]")) x.classList.toggle("on", x === b && !x.classList.contains("on")); }),
  });
  if (r.value !== "ok") return;
  try {
    let attachmentId = r.data.pick;
    if (!attachmentId && r.data.file) {
      const up = await api.post(`/api/afes/${a.id}/documents`, { filename: r.data.file.name, role: "email_approval", contentBase64: await documentToBase64(r.data.file, session.refdata && session.refdata.attachmentLimits) });
      attachmentId = up.attachmentId;
    }
    await post(`/api/fa/afes/${a.id}/drift/${level}/ack`, { attachmentId, note: r.data.note }, `Drift at ${level} cleared with evidence.`);
  } catch (e) { showError(e); }
}
async function reclassify() {
  const a = afe();
  const cur = a.money.classification;
  // Capital only (R158): an AFE that is really an expense is sent back, not reclassified.
  const opts = [["capex", "CapEx"], ["cloud_capex", "Cloud CapEx (CCA)"]].concat(cur === "none" ? [["none", "No capital spend"]] : []);
  const r = await sheet({
    eyebrow: "RECLASSIFY", title: "Change the classification?", sub: "Fixed Assets' one edit right on the AFE. Audited with before and after; the requester side sees the reason.",
    body: html`<div class="chips">${opts.map(([v, l]) => html`<button type="button" class="chip sm ${v === cur ? "on" : ""}" data-cls="${v}">${l}${v === cur ? " · now" : ""}</button>`)}</div>
      <textarea class="input" id="rc-reason" rows="3" placeholder="Why — e.g. subscription software hosted by the vendor; Acme cannot re-host it." style="margin-top: 14px;"></textarea>`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Reclassify", value: "ok", tone: "dark", primary: true }],
    validate: (el) => { const c = $(".chip.on[data-cls]", el); if (!c || c.dataset.cls === cur) return "Pick a different classification."; if (!$("#rc-reason", el).value.trim()) return "A reclassification needs a reason."; return null; },
    collect: (el) => ({ classification: ($(".chip.on[data-cls]", el) || { dataset: {} }).dataset.cls, reason: $("#rc-reason", el).value.trim() }),
    onMount: (el) => on(el, "click", "[data-cls]", (e, b) => { for (const x of el.querySelectorAll("[data-cls]")) x.classList.toggle("on", x === b); }),
  });
  if (r.value !== "ok") return;
  await post(`/api/fa/afes/${a.id}/reclassify`, r.data, "Reclassified.");
}
/** Who a send-back copies besides the requester, said once, in the sheet that sends it (R147). */
function copied(a) {
  const req = a.requester ? a.requester.email : null;
  const cc = [a.preparer, a.coordinator].filter((p, i, all) => p && p.email && p.email !== req && all.findIndex((q) => q && q.email === p.email) === i);
  return cc.length ? `${cc.map((p) => firstName(p.name)).join(" and ")} ${cc.length > 1 ? "are" : "is"} copied. ` : "";
}
async function sendBack() {
  const a = afe();
  const r = await sheet({
    eyebrow: "SEND BACK", title: `Send it back to ${a.requester ? firstName(a.requester.name) : "the requester"}?`,
    sub: `${copied(a)}The signatures stand unless the money, the budget or the case changes. For a question, use the conversation instead.`,
    body: html`<textarea class="input" id="fr-reason" rows="3" placeholder="What Fixed Assets needs changed — in their words."></textarea>
      <div class="sect red" style="margin-top: 14px;">${icon("back", 13)} REOPENS AT</div>
      ${reopenPicker(session.refdata && session.refdata.wizardSteps, 1)}`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Send back", value: "ok", tone: "dark", primary: true }],
    validate: (el) => (!$("#fr-reason", el).value.trim() ? "Say what needs to change." : null),
    collect: (el) => ({ reason: $("#fr-reason", el).value.trim(), step: Number(($(".chip.on[data-step]", el) || { dataset: { step: 1 } }).dataset.step) }),
    onMount: (el) => on(el, "click", "[data-step]", (e, b) => { for (const x of el.querySelectorAll("[data-step]")) x.classList.toggle("on", x === b); }),
    // Sent with the sheet open, so a refusal is said beside the reason rather than throwing it away.
    run: (value, data) => api.post(`/api/fa/afes/${a.id}/return`, data),
  });
  if (r.value !== "ok") return;
  store.bust("/api"); toast("Sent back.", "ok"); refreshCounts(); await navigate("/fa");
}

function wire(root) {
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  // `load` does not bubble, so it is caught on the way DOWN — the wizard's review screen does the
  // same. Remembered by src, so the next repaint renders the frame as ready.
  root.addEventListener("load", (e) => {
    const f = e.target;
    if (!f || !f.classList || !f.classList.contains("pdf-frame")) return;
    S.pdfReady = f.getAttribute("src");
    const w = f.closest(".pdfwrap");
    if (w) w.dataset.ready = "1";
  }, true);
  on(root, "click", "[data-approver]", async (e, b) => {
    const issue = S.view.issue || {};
    const email = b.dataset.approver;
    const now = issue.wasChosen ? (issue.chosen || []).map((x) => x.email) : [];
    // Tapping the one it is already with hands it back to everyone (design rule 4).
    const next = now.includes(email) ? now.filter((x) => x !== email) : now.concat([email]);
    const id = S.id;
    try {
      const res = await api.post(`/api/fa/afes/${id}/issue-approver`, { emails: next });
      store.bust("/api/fa"); toast(res.note || "Recorded.", "ok"); refreshCounts();
      if (id === S.id) { take(res); paint(); }
    } catch (err) { showError(err); }
  });
  on(root, "click", "#approve-issue", async () => {
    const issue = S.view.issue || {};
    const note = await askText({
      eyebrow: "APPROVE FOR ISSUE", title: "Release this for an internal order?",
      sub: `${(issue.approvers || []).map((x) => x.name).join(" or ")} approves; somebody else then keys SAP. Both names are on the record.`,
      placeholder: "Anything worth recording (optional)", required: false, action: "Approve", tone: "dark",
    });
    if (note === null) return;
    const id = S.id;
    try {
      const res = await api.post(`/api/fa/afes/${id}/approve-issue`, { note });
      store.bust("/api/fa"); toast(res.note || "Approved.", "ok"); refreshCounts();
      if (id === S.id) { take(res); paint(); }
    } catch (e) { showError(e); }
  });
  on(root, "click", "#ask-approver", async (e, b) => {
    const done = busy(b, "Asking\u2026");
    try {
      const res = await api.post(`/api/fa/afes/${afe().id}/ask-issue-approval`, {});
      toast(res.note || "Asked.", "ok"); done();
    } catch (err) { done(); showError(err); }
  });
  on(root, "click", "[data-thread-post]", async (e, b) => { if (await postComment(afe().id, root, b)) { await load(); paint(); } });
  on(root, "click", "#reviewed", () => formReviewed(false));
  on(root, "click", "#unreview", () => formReviewed(true));
  on(root, "click", "#to-form", () => {
    setOpen("signatures");
    paint();
    const el = $("[data-key='the-form']", root);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // A BUCKET may close — a list you opened is a list you can shut. A TAB may not: these three
  // tiles are the only way to the three halves of the screen, so deselecting one left the page
  // below them empty with nothing to press. Re-pressing the open tab is a no-op (design rule 4
  // is about selection, and a tab set has no unselected state).
  on(root, "click", "[data-bucket]", (e, b) => { setOpen(b.dataset.bucket); morph($("#tiles", root), tiles()); morph($("#section", root), html`${section(openKey())}`); });
  on(root, "click", "[data-open-tile]", (e, b) => {
    setOpen(b.dataset.openTile); paint();
    const sec = $("#section", S.root);
    if (sec) bringTo(sec);
  });
  on(root, "click", "[data-show]", (e, b) => { const f = S.view.redFlags.flags.find((x) => x.id === b.dataset.show); if (f) showMe(S.view, f.showMe || {}, { openTile: (k) => { setOpen(k); paint(); } }); });
  on(root, "click", "[data-show-matrix]", () => showMe(S.view, { kind: "matrix" }));
  on(root, "click", "[data-doc]", (e, b) => { const d = (afe().documents || []).find((x) => x.attachmentId === b.dataset.doc); if (d) showMe(S.view, { kind: "documents", role: d.role }); });
  on(root, "click", "[data-ack]", async (e, b) => {
    const f = S.view.redFlags.flags.find((x) => x.id === b.dataset.ack);
    const note = await askText({ eyebrow: "ACKNOWLEDGE", title: f ? f.title : "Acknowledge", sub: "Why this stands. Printed for the checker and audited.", placeholder: "e.g. Framework agreement — pricing per the MSA; quote not needed.", action: "Acknowledge" });
    if (!note) return;
    await post(`/api/fa/afes/${afe().id}/red-flags/${encodeURIComponent(b.dataset.ack)}/ack`, { note }, "Acknowledged.");
  });
  on(root, "click", "[data-evidence]", (e, b) => attachEvidence(b.dataset.evidence));
  on(root, "click", "#draft-digest", async (e, b) => {
    const done = busy(b, "Drafting…");
    try { S.draft = await api.post(`/api/fa/afes/${afe().id}/red-flags/draft`); await load(); toast("Drafted into the outbox — nothing was sent.", "ok"); paint(); }
    catch (err) { done(); showError(err); }
  });
  on(root, "click", "[data-copy-draft]", async () => {
    if (!S.draft) return;
    const text = `To: ${S.draft.draft.to}\n${S.draft.draft.cc && S.draft.draft.cc.length ? "Cc: " + S.draft.draft.cc.join(", ") + "\n" : ""}Subject: ${S.draft.draft.subject}\n\n${S.draft.draft.body}`;
    try { await navigator.clipboard.writeText(text); toast("Copied.", "ok"); } catch { toast("Copy failed — select the text instead.", "err"); }
  });
  on(root, "click", "[data-tick]", (e, b) => { const id = b.dataset.tick; const on_ = b.dataset.on === "1"; judge({ ticks: { [id]: !on_ } }); });
  on(root, "click", "#fa-fx-save", () => {
    const el = $("#fa-fx", S.root);
    post(`/api/fa/afes/${afe().id}/fx`, { localPerUsd: el ? el.value.trim() : "" }, "Rate recorded.");
  });
  on(root, "click", "[data-order]", (e, b) => { const cur = afe().fa && afe().fa.orderType; const code = b.dataset.order; judge({ orderType: cur === code ? null : code, ticks: { order_type: cur !== code } }); });
  on(root, "click", "#reclassify", reclassify);
  on(root, "click", "#return", sendBack);
}

/** What the screen shows while an AFE it has not got yet is on its way (design rule 6). */
function opening(id) {
  return html`<div class="page pane" data-key="opening">
    <div class="small muted"><a href="/fa" style="font-weight: 700;">‹ Fixed Assets</a></div>
    <div class="busy" style="margin-top: 18px;" aria-live="polite"><span class="spin"></span>Opening ${id}…</div>
  </div>`;
}

export async function render(root, ctx) {
  const id = ctx.params.id;
  const showing = S.view && S.view.afe ? S.view.afe.id : null;
  S.id = id; S.root = root; S.draft = null;
  if (!root.dataset.judge) { root.innerHTML = ""; root.dataset.judge = "1"; }
  wire(root);
  // A blank page, or the previous AFE's tiles under this AFE's address, until the answer lands —
  // which on UAT could be seconds. Said only if it takes long enough to notice, so a quick answer
  // does not flash a line nobody had time to read.
  const slow = !root.firstElementChild || showing !== id
    ? setTimeout(() => { if (S.id === id && S.root === root) morph(root, opening(id)); }, 200) : null;
  try { await load(); } catch (e) { clearTimeout(slow); showError(e); await navigate("/fa", { replace: true }); return; }
  clearTimeout(slow);
  if (S.id !== id) return;
  setRecord({ id: S.id, title: afe().project.title });
  paint();
}
export function unmount() { if (S.root) { delete S.root.dataset.judge; S.root.innerHTML = ""; } S.pdfReady = null; setRecord(null); }
