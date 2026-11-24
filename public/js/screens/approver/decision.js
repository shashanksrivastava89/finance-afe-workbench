// /approve/:id — what an approver sees before signing (R55): is it budgeted, from which pot, when
// it starts, how much the quotes cover, why it is needed, who else signs — and the note the
// coordinator wrote. Four things to do: sign (in the tool while the envelope is simulated), ask,
// send back, decline.
import { html, morph, on, $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { store } from "../../core/store.js";
import { session } from "../../core/session.js";
import { navigate } from "../../core/router.js";
import { setRecord, setRecordNote, refreshCounts } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, ago, date, plural, since, stateLabel } from "../../core/format.js";
import { tag, avatar, docRow, reopenPicker, tip, thread, roleName } from "../../components/parts.js";
import { postComment } from "../../core/comments.js";
import { sheet, askText, toast, busy, showError } from "../../core/ui.js";

const S = { id: null, dec: null, root: null, wiredTo: null, embedded: false, onChange: null };

const fixture = () => S.dec;

/** The files attached in support, by the server's own list of what that means (R150). */
const supporting = (d) => (d.documents || []).filter((x) => ((session.refdata && session.refdata.supportingRoles) || ["quote", "sow", "backup"]).includes(x.role));

/** "Chakradev Connaghy's signature stands", "A's and B's signatures stand", "the 3 signatures already given stand". */
const stoodLine = (names) => (names.length === 1 ? `${names[0]}'s signature stands`
  : names.length === 2 ? `${names[0]}'s and ${names[1]}'s signatures stand` : `the ${names.length} signatures already given stand`);

const CLASS_LABEL = { capex: "CapEx", cloud_capex: "Cloud CapEx", none: "OpEx only" };

/**
 * What the technical accounting review checks (R159), laid out for the one person on the chain
 * who is there to check it: the classification against the decision tree, the scope, labour
 * against the total, and the quote or SOW it all has to match. It sits above the detail,
 * because for this signer it IS the detail.
 */
function accountingCard(d) {
  const x = d.accounting;
  if (!x) return "";
  const why = x.because === "labour" ? "the labour is over" : x.because === "both" ? "the total and the labour are over" : "the total is over";
  return html`<div class="card pad soft" style="margin-top: 16px;" data-key="accounting">
    <div class="sect">${icon("shield", 13)} WHAT YOU ARE CHECKING <span class="muted" style="font-weight: 400;">· on the chain because ${why} ${money(x.thresholdUsd)}</span></div>
    <div class="chips" style="margin-top: 10px;">
      ${tag(`Raised as ${CLASS_LABEL[x.classification] || "—"}`, "blue")}
      ${!x.tree ? tag("Decision tree not answered", "yellow", { icon: "bang" })
        : !x.tree.complete ? tag("Decision tree not finished", "yellow", { icon: "bang" })
        : tag(`The decision tree says ${x.tree.label}`, x.tree.agrees ? "" : "red", { icon: x.tree.agrees ? "tick" : "bang" })}
      ${tag(`Labour ${money(x.laborUsd)} of ${money(x.totalUsd)}`, x.because === "total" ? "grey" : "yellow")}
    </div>
    ${x.tree ? html`<div class="chips" style="margin-top: 8px;">${x.tree.steps.map((s) => tag(`${s.label}: ${s.answer}`, "grey"))}</div>` : ""}
    <div style="font-size: 13px; line-height: 1.55; margin-top: 12px;"><b>Scope</b> ${x.scope || html`<span class="muted">— none written.</span>`}</div>
    <div style="display: flex; gap: 14px; margin-top: 10px; flex-wrap: wrap;">
      ${x.documents.length ? x.documents.map((f) => html`<a href="${f.url}" target="_blank" rel="external" style="font-size: 12.5px;" data-key="acc-${f.attachmentId}">${f.filename}${f.amountUsd ? ` · ${money(f.amountUsd)}` : ""} ${icon("external", 14)}</a>`)
        : html`<span class="small muted">No quote or SOW attached.</span>`}
    </div>
  </div>`;
}

/** The decision body — also rendered inside the inbox's right pane on a desktop. */
export function decisionMarkup(d, opts) {
  const o = opts || {};
  const me = d.me;
  const mine = me && me.isCurrent;
  const first = d.afe.requester ? d.afe.requester.name.split(" ")[0] : "";
  const myRow = d.chain.find((r) => r.isYou) || {};
  const asWhat = me ? (me.level ? `${me.level}${d.levelTitles && d.levelTitles[me.level] ? " · " + d.levelTitles[me.level] : ""}` : myRow.group ? `${myRow.group} (${String(me.role).replace(/_/g, "-")})` : String(me.role).replace(/_/g, "-")) : "";
  const eyebrow = mine ? `Yours to sign as ${asWhat}` : me ? (me.status === "signed" ? `You signed ${since(me.signedAt || myRow.signedAt)}` : me.status === "returned" ? `You sent it back — it is with ${first || "the requester"} to fix` : `Signer ${me.order || ""} — it is with ${(d.chain.find((r) => r.isCurrent) || {}).name || "someone else"} first`) : d.state === "fa_review" ? "Fully signed — with Fixed Assets" : stateLabel(d.state);
  // It came back from a send-back and nothing that decides it changed (R148). The document is the
  // one first sent, so what changed is said here, where the next signer is deciding.
  const back = d.round && d.round.resumed;
  const current = d.chain.find((r) => r.isCurrent);
  const signed = d.chain.filter((r) => r.status === "signed").length, of = d.chain.filter((r) => r.order).length;
  return html`<div class="card" style="padding: 28px 32px;" data-key="decision-${d.afe.id}">
    <div class="dec-head">
      <div style="min-width: 0; flex: 1;">
        <div class="small muted">${eyebrow}${d.envelope && d.envelope.simulated ? html` · <span style="color: var(--yellow); font-weight: 700;">SIMULATED</span>` : ""}</div>
        <h1 class="h1" style="margin-top: 6px;">${d.afe.title}</h1>
      </div>
      <div class="big-amt" style="flex: none;">${money(d.money.totalUsd, { cents: true })}</div>
    </div>
    <div class="chips" style="margin-top: 16px;">
      ${tag(`${d.afe.requester ? d.afe.requester.name : ""}${d.afe.division ? " · " + d.afe.division : ""}`, "", { avatar: d.afe.requester ? d.afe.requester.name : "?" })}
      ${tag(`cost centre ${d.afe.costCenter}${d.afe.location ? " · " + d.afe.location.split(",")[0] : ""}`, "blue")}
      ${tag(`${{ capex: "CapEx", cloud_capex: "Cloud CapEx", none: "OpEx only" }[d.money.classification] || "—"} · ${d.budget.budgeted === "Yes" ? "budgeted" : d.budget.budgeted === "No" ? "unbudgeted" : "budget not stated"}`, d.budget.budgeted === "No" ? "yellow" : "blue")}
      ${d.budget.pot ? tag(`${d.budget.pot.budgetCategory} · ${d.budget.pot.region} · FY${d.budget.pot.fiscalYear}${Number.isFinite(d.budget.pot.remainingUsd) ? (d.budget.pot.remainingUsd < 0 ? ` · ${money(-d.budget.pot.remainingUsd)} over` : ` · ${money(d.budget.pot.remainingUsd)} left`) : ""}`, Number.isFinite(d.budget.pot.remainingUsd) && d.budget.pot.remainingUsd < 0 ? "red" : "grey")
        : d.budget.otherBudget ? tag(`Budget: ${d.budget.otherBudget}`, "grey") : ""}
      ${d.quote.count ? tag(`Quoted ${money(d.quote.totalUsd)} of ${money(d.money.totalUsd)}${d.quote.coveragePct !== null ? ` (${d.quote.coveragePct}%)` : ""}${d.quote.waived ? " · waived" : ""}`, d.quote.coveragePct >= Math.round(((session.refdata && session.refdata.quoteCoverageMin) || 0.7) * 100) ? "" : "yellow", { icon: "doc" }) : tag("No quote", "yellow")}
      ${d.timing.startDate ? tag(`${date(d.timing.startDate)} → ${date(d.timing.finishDate)}${d.timing.startInPast ? " · start has passed" : ""}`, d.timing.startInPast ? "yellow" : "grey") : ""}
      ${d.band ? tag(d.band.label, "grey") : ""}
      ${d.afe.sourcing === "internal" ? tag("From Acme inventory", "blue", { icon: "box" }) : ""}
    </div>
    ${back ? html`<div class="banner green" style="margin-top: 16px; align-items: flex-start;" data-key="resumed">${icon("refresh", 16)}<span><b>Back from ${back.byName || "the requester"}</b> after ${back.sentBackByYou ? "you" : back.sentBackBy || "an approver"} sent it back: “${back.reason}”.
      ${back.changed.length ? `Changed: ${back.changed.join(", ")}.` : "Nothing on the form was edited."} Nothing that decides it changed${back.stood.length ? `, so ${stoodLine(back.stood)}` : ""}.${tip("It is the envelope that was first sent, so its document keeps the wording it went out with. The changes are on the AFE, and Fixed Assets sees them.")}</span></div>` : ""}
    ${d.approverNote ? html`<div class="banner blue" style="margin-top: 16px; align-items: flex-start;">${icon("info", 16)}<span><b>${d.afe.coordinator ? d.afe.coordinator.name : "The coordinator"}:</b> ${d.approverNote}</span></div>` : ""}
    <!-- A check that did not pass, with the reason the requester gave. Euan's point at 24:46:
         an approver who meets an exception either sends it back or starts a conversation, and
         this is what saves them both. It sits above the detail because it is the thing most
         likely to change the answer. -->
    ${(d.exceptions || []).map((e) => html`<div class="banner yellow" data-key="exc-${e.rule}" style="margin-top: 12px; align-items: flex-start;">
      ${icon("bang", 16)}
      <span><b>${e.label}</b><br><span style="display: inline-block; margin-top: 4px;">${e.note}</span>
      <span class="small muted" style="display: block; margin-top: 4px;">${[e.by, e.at ? ago(e.at) : ""].filter(Boolean).join(" · ")}</span></span>
    </div>`)}
    ${accountingCard(d)}
    <div class="split dec" style="margin-top: 22px;">
      <div class="card pad soft">
        <div class="sect">WHY</div>
        <div style="font-size: 13px; line-height: 1.55; margin-top: 8px;">${d.why.description || ""}</div>
        ${d.why.justification ? html`<div style="font-size: 13px; line-height: 1.55; margin-top: 10px; color: var(--ink-2);">${d.why.justification}</div>` : ""}
        ${d.money.lines && d.money.lines.length ? html`<div class="small muted" style="margin-top: 10px;">${d.money.lines.length} sites: ${d.money.lines.map((l) => `${l.site} ${money(l.amountUsd)}`).join(" · ")}</div>` : ""}
        ${d.budget.budgeted === "No" && d.budget.unbudgetedReason ? html`<div class="small" style="margin-top: 10px; color: var(--yellow); font-weight: 700;">Unbudgeted: ${d.budget.unbudgetedReason}</div>` : ""}
      </div>
      <div class="card pad soft">
        <div class="sect">THE DOCUMENT</div>
        <div style="display: flex; align-items: center; gap: 12px; margin-top: 10px;">
          <span class="av lg dark" style="font-size: 10px;">AFE</span>
          <div style="min-width: 0;"><div style="font-size: 12.5px; font-weight: 700;">AFE Form${supporting(d).length ? ` + ${supporting(d).length} ${plural(supporting(d).length, "attachment")}` : ""}</div><div class="small muted">${d.quote.vendors.join(", ") || "no quote attached"}</div>${d.quote.provenance ? html`<div class="small muted" data-key="provenance">${d.quote.provenance}</div>` : ""}</div>
        </div>
        ${d.quote.count && d.quote.gapUsd > 0 ? html`<div class="small" style="margin-top: 10px;" data-key="gap"><b>${money(d.quote.gapUsd)} of the ${money(d.money.totalUsd)} is not in a quote.</b>
          ${d.quote.note ? html`<span style="display: block; margin-top: 3px;">“${d.quote.note.text}”${d.quote.note.byName ? html` <span class="muted">— ${d.quote.note.byName}</span>` : ""}</span>` : html`<span class="muted"> Nobody has said what covers it.</span>`}</div>` : ""}
        <div style="display: flex; gap: 14px; margin-top: 12px; flex-wrap: wrap;">
          <a href="/api/afes/${d.afe.id}/document.pdf" target="_blank" rel="external" style="font-size: 12.5px;">Read it — form and attachments ${icon("external", 14)}</a>
          ${supporting(d).map((x) => html`<a href="${x.url}" target="_blank" rel="external" style="font-size: 12.5px;" data-key="${x.attachmentId}" title="${x.filename}"><b>${roleName(x.role)}</b> <span class="muted">${x.filename}</span> ${icon("external", 14)}</a>`)}
        </div>
      </div>
    </div>
    <div class="card" style="margin-top: 16px; overflow: hidden;">
      <div class="tabhd" style="border-top: 0; display: flex; justify-content: space-between;"><span>WHO SIGNS · ${signed} OF ${of}</span><span>${current ? `with ${current.name}` : d.state === "fa_review" ? "complete" : ""}</span></div>
      ${d.chain.filter((r) => r.order || r.isYou).map((r) => html`<div style="display: flex; align-items: center; gap: 12px; padding: 10px 18px; border-bottom: 1px solid var(--line-soft); ${r.isCurrent ? "background: #FFFDF3;" : ""}" data-key="${r.id}">
        <span class="num ${r.status === "signed" ? "done" : r.isCurrent ? "now" : ""}" style="width: 32px; height: 32px; border-radius: var(--r-sm); display: inline-flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; ${r.status === "signed" ? "background: var(--green); color: #FFF;" : r.isCurrent ? "border: 3px solid #E5A93B; color: var(--warn);" : "background: #F0F2E6; color: var(--ink-2);"}">${r.status === "signed" ? icon("tick", 14, { stroke: 2.4 }) : r.order || "–"}</span>
        <span style="min-width: 0; flex: 1;"><b>${r.name}</b>${r.isYou ? html` <span class="tag pad" style="font-size: 10.5px; padding: 2px 8px;">you</span>` : ""} <span class="muted small">· ${r.level || r.group || r.role}</span></span>
        <span class="small muted">${r.status === "signed" ? "signed " + since(r.signedAt) : r.isCurrent ? (d.state === "on_hold" ? "asked a question" : "has it now") : r.status === "returned" ? "sent it back" : r.status === "sod_blocked" ? "cannot sign — involved in it" : r.status === "skipped" ? "signs above" : "waiting"}</span>
      </div>`)}
    </div>
    <div style="margin-top: 16px;">${thread(d.thread, { answer: d.permissions && d.permissions.answerTo, canComment: d.permissions && d.permissions.canComment, asks: d.asks,
      sides: session.refdata && session.refdata.threadSides, placeholder: "A note on the record — to stop the clock, use Ask a question" })}</div>
    <div class="decbar" data-key="actions">
      ${mine && d.state === "in_approval" ? html`
        ${/* The button names the DECISION, not the gesture (R172): with "Sign" beside "Send back", a
              tester looking for "Approve" sent it back with the reason "Approve" (afe-0031). */ ""}
        ${me.canSign ? html`<button class="cta" data-decide="sign" data-afe="${d.afe.id}">${icon("pen", 16)}Approve and sign</button>` : html`<span class="banner blue" data-key="docusign">${icon("mail", 16)}<span>Approve and sign in the DocuSign e-mail sent to you${myRow.since ? ` on ${date(myRow.since)}` : ""}. It comes from DocuSign, not from this tool.</span></span>`}
        ${me.canQuestion ? html`<button class="cta sec" data-decide="question" data-afe="${d.afe.id}">Ask a question</button>` : ""}
        ${me.canSendBack ? html`<button class="cta sec" data-decide="send-back" data-afe="${d.afe.id}">Send back</button>` : ""}
        ${me.canDecline ? html`<button class="cta quiet" data-decide="decline" data-afe="${d.afe.id}">Decline</button>` : ""}` : ""}
      ${mine && d.state === "on_hold" ? html`<span class="banner yellow">${icon("question", 16)}Your question is with ${first || "the requester"}.</span>${me.canSendBack ? html`<button class="cta sec sm" data-decide="send-back" data-afe="${d.afe.id}">Send back instead</button>` : ""}` : ""}
      <span class="decnote" style="margin-left: auto; font-size: 12px; color: var(--muted); max-width: 300px; text-align: right; line-height: 1.45;">${mine ? (of === 1 ? "Only your signature is needed at this amount." : `${signed} of ${of} signed.`) + " Fixed Assets creates the internal order after the last." : ""}</span>
    </div>
  </div>`;
}

export async function decide(afeId, action, dec, button) {
  const me = dec.me;
  let payload = {};
  if (action === "question") { const text = await askText({ eyebrow: "ASK", title: "What do you need to know?", sub: `Goes to ${dec.afe.requester ? dec.afe.requester.name : "the requester"}${dec.afe.coordinator ? " and " + dec.afe.coordinator.name : ""}. The envelope waits with you until they answer.`, action: "Ask" }); if (!text) return false; payload = { text }; }
  if (action === "decline") { const text = await askText({ eyebrow: "DECLINE", title: "Decline this AFE?", sub: "This ends it. A new AFE is needed if the project goes ahead.", placeholder: "Why — they need to know.", action: "Decline", tone: "dark" }); if (!text) return false; payload = { reason: text }; }
  if (action === "send-back") {
    const req = dec.afe.requester, coord = dec.afe.coordinator;
    const kept = (dec.chain || []).filter((x) => x.status === "signed").length;
    const r = await sheet({ eyebrow: "SEND BACK", title: `Send it back to ${req ? req.name.split(" ")[0] : "the requester"}?`,
      sub: `${coord && (!req || coord.email !== req.email) ? `${coord.name.split(" ")[0]} is copied. ` : ""}If nothing that decides it changes, it comes straight back to you${kept ? ` and ${kept === 1 ? "the signature" : `the ${kept} signatures`} so far stand${kept === 1 ? "s" : ""}` : ""}.`,
      body: html`<textarea class="input" id="sb-reason" rows="3" placeholder="What needs to change — in their words."></textarea>
        <div class="sect red" style="margin-top: 14px;">${icon("back", 13)} REOPENS AT</div>
        ${reopenPicker(session.refdata && session.refdata.wizardSteps, 3)}`,
      actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Send back", value: "ok", tone: "dark", primary: true }],
      validate: (el) => (!$("#sb-reason", el).value.trim() ? "Say what needs to change." : null),
      collect: (el) => ({ reason: $("#sb-reason", el).value.trim(), step: Number(($(".chip.on[data-step]", el) || { dataset: { step: 3 } }).dataset.step) }),
      onMount: (el) => on(el, "click", "[data-step]", (e, b) => { for (const x of el.querySelectorAll("[data-step]")) x.classList.toggle("on", x === b); }),
      // Sent with the sheet open, so a refusal keeps the reason that was typed.
      run: (value, data) => api.post(`/api/afes/${afeId}/recipients/${me.recipientId}/send-back`, data) });
    if (r.value !== "ok") return false;
    store.bust("/api");
    toast((r.result && r.result.note) || "Sent back.", "ok");
    refreshCounts();
    return r.result && r.result.decision;
  }
  const done = busy(button, action === "sign" ? "Approving…" : "Sending…");
  try {
    const r = await api.post(`/api/afes/${afeId}/recipients/${me.recipientId}/${action}`, payload);
    store.bust("/api");
    toast(r.note || "Done", "ok");
    refreshCounts();
    return r.decision;
  } catch (e) { done(); showError(e); return false; }
}

export async function render(root, ctx) {
  S.id = ctx.params.id; S.root = root;
  try { S.dec = await api.get(`/api/afes/${S.id}/decision`); } catch (e) { showError(e); await navigate("/approvals", { replace: true }); return; }
  setRecord({ id: S.id, title: S.dec.afe && S.dec.afe.title });
  const paint = () => morph(root, html`<div class="page pane" style="max-width: 1100px;"><div class="small muted" style="margin-bottom: 12px;"><a href="/approvals">${icon("chevL", 12, { stroke: 2.2 })} Approvals</a></div>${decisionMarkup(S.dec)}</div>`);
  if (!root.dataset.decision) { root.innerHTML = ""; root.dataset.decision = "1"; }
  paint();
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "click", "[data-decide]", async (e, b) => {
    const r = await decide(S.id, b.dataset.decide, S.dec, b);
    if (!r) return;
    S.dec = r;
    paint();
  });
  on(root, "click", "[data-thread-post]", async (e, b) => {
    if (!(await postComment(S.id, root, b))) return;
    S.dec = await api.get(`/api/afes/${S.id}/decision`);
    paint();
  });
}
export function unmount() { if (S.root) { delete S.root.dataset.decision; S.root.innerHTML = ""; } }
