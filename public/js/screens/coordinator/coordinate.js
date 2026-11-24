// /afe/:id/coordinate — the chain is the screen. Before send: numbered people in signing order,
// each with a mailbox state; add a signer or a copy, leave a rule out with a reason, write the
// note, and Send — which is never hidden, only off, with the reason underneath. After send: the
// frozen chain with where it is, and the things a coordinator may still do.
import { html, morph, on, $, debounce, settleDebounces } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { store } from "../../core/store.js";
import { session } from "../../core/session.js";
import { navigate } from "../../core/router.js";
import { setRecord } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, ago, pct, plural, since, coverage } from "../../core/format.js";
import { tag, avatar, signerRow, mailbox, docRow, progress, chips, reopenPicker, roundLine, thread, theAfeRow, ownDocuments } from "../../components/parts.js";
import { postComment } from "../../core/comments.js";
import { sheet, askText, toast, busy, showError, closeSheet } from "../../core/ui.js";

const S = { id: null, view: null, root: null, wiredTo: null, rules: null, undo: null };
const afe = () => S.view.afe;
const chain = () => S.view.routing && !["draft", "submitted", "returned"].includes(afe().state) ? S.view.routing : S.view.routingPreview;
const frozen = () => Boolean(S.view.routing) && !["draft", "submitted", "returned"].includes(afe().state);
const LEVELS = ["M1", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"];

async function load() {
  S.view = await api.get(`/api/afes/${S.id}`);
  if (!S.rules) { try { S.rules = await store.get("/api/admin/org-rules", { maxAge: 60000 }); } catch { S.rules = []; } }
}
async function putEdits(patch, keepUndo) {
  if (!keepUndo) S.undo = null;              // any other change makes the old list stale
  try {
    await api.put(`/api/afes/${S.id}/routing/recipients`, patch);
    await load(); paint(); store.bust("/api/coordinator");
  } catch (e) { showError(e); }
}

// ---- the chain -------------------------------------------------------------------------------
function rightFor(rec) {
  const live = ["pending", "sent", "signed"].includes(rec.status);
  if (frozen() || rec.role === "cc" || !live) return mailbox(rec);
  const ok = rec.email && ["users", "directory", "rule", "typed", "confirmed"].includes(rec.emailSource);
  if (ok) return mailbox(rec);
  // guessed or unresolved: confirm or type, right here on the row
  return html`<span class="typebox" data-key="type-${rec.id}">
    <input class="input" data-mail="${rec.id}" value="${rec.email || ""}" placeholder="first_last@example.com" aria-label="Mailbox for ${rec.name}" autocomplete="off">
    <button type="button" class="pillbtn dark" data-confirm="${rec.id}" style="height: 42px;">${rec.emailSource === "guessed" ? "Confirm" : "Save"}</button>
  </span>`;
}
function actionFor(rec) {
  if (frozen()) return html`<span></span>`;
  if (rec.role === "additional" || (rec.role === "pre_approver" && !rec.sourceRuleId) || rec.role === "cc" && rec.emailSource === "typed") {
    return html`<button type="button" class="x" data-remove="${rec.id}" data-role="${rec.role}" data-name="${rec.name}" title="Remove ${rec.name}">${icon("x", 12)}</button>`;
  }
  return html`<span></span>`;
}
/**
 * The chain, with the DUPLICATES folded away.
 *
 * A person named at several matrix levels signs ONCE, at the highest row; the lower rows come
 * back as `skipped` with `signsAs` pointing at the live one. They were drawn as full rows — so
 * Udarsh Atwal appeared twice and Vrishti Aguirre appeared twice, and two of the seven rows on
 * this screen were saying "this row is not a row". That is most of what made it cluttered.
 * The fact still travels: the row that DOES sign says which other levels that person holds, which
 * is the thing a coordinator actually needs to know, in one line instead of two.
 *
 * And what every matrix row has in common — the cost centre and the band — is said once above
 * the list, as it is on the review screen. It was the back half of every `why`.
 */
function chainCard() {
  const c = chain();
  if (!c) return html`<div class="card pad"><span class="muted">Pick a cost centre and an amount first — the chain comes from them.</span></div>`;
  const all = c.recipients.filter((r) => r.role !== "cc");
  const copies = c.recipients.filter((r) => r.role === "cc");
  const folded = all.filter((r) => r.status === "skipped" && r.signsAs);
  const titles = (session.refdata && session.refdata.levelTitles) || {};
  const a = afe();
  const signers = all.filter((r) => !(r.status === "skipped" && r.signsAs)).map((r) => {
    const also = folded.filter((f) => f.signsAs === r.id).map((f) => f.level).filter(Boolean);
    // A row whose reason is the plain matrix rule says the title; anything else — a stand-in, a
    // coordinator's addition, a rule — keeps its own sentence, because there the reason IS the
    // information.
    const plain = r.role === "matrix" && !r.standInFor && r.level && titles[r.level];
    const why = [plain ? titles[r.level] : r.why, also.length ? `also holds ${also.join(" and ")}` : ""]
      .filter(Boolean).join(" · ");
    return Object.assign({}, r, { why });
  });
  const appliedRules = (S.rules || []).filter((r) => (c.basis.orgRuleIds || []).includes(r.id) && ["pre_approver", "override", "controllership", "cc"].includes(r.kind));
  const suppressed = ((afe().routingEdits || {}).suppressedRules || []);
  // `basis.band` is the label itself on the preview and an object on a frozen routing — take
  // whichever came, rather than picking one and being right half the time.
  const rawBand = c.basis && c.basis.band;
  const band = (rawBand && typeof rawBand === "object" ? rawBand.label : rawBand) || "";
  return html`<div class="card" style="overflow: hidden;" data-key="chain">
    <div class="tabhd">${[a.costCenter ? `all for cost centre ${a.costCenter}` : "", band].filter(Boolean).join(" · ") || "WHO SIGNS"}</div>
    ${signers.map((rec) => signerRow(rec, { right: rightFor(rec), action: actionFor(rec), canChoose: true }))}
    <div class="tabhd">RECEIVES A COPY</div>
    ${copies.map((rec) => signerRow(rec, { right: mailbox(rec), action: actionFor(rec), hideWhy: false }))}
    ${S.undo && !frozen() ? html`<div class="banner grey" data-key="undo" style="margin: 0; border-radius: 0; border-left: 0; border-right: 0;">${icon("x", 14)}<span>Took ${S.undo.name} off the ${S.undo.role === "cc" ? "copies" : "chain"}. <button type="button" class="linkbtn" id="undo-remove">Undo</button></span></div>` : ""}
    ${!frozen() ? html`<div style="display: flex; gap: 18px; padding: 14px 18px; border-top: 1px solid var(--line-soft); font-size: 12.5px; flex-wrap: wrap;">
      <button type="button" class="linkbtn" id="add-signer">+ Add a signer</button>
      <button type="button" class="linkbtn" id="add-copy">+ Add a copy</button>
      ${appliedRules.length || suppressed.length ? html`<button type="button" class="linkbtn" id="rules" style="color: var(--ink-3);">${suppressed.length ? `${suppressed.length} ${plural(suppressed.length, "rule")} left out…` : "Leave a rule out…"}</button>` : ""}
    </div>` : ""}
  </div>`;
}

// ---- before it goes --------------------------------------------------------------------------
function readiness() {
  const c = chain(), val = S.view.validation, a = afe();
  const rows = [];
  const ok = (t) => rows.push({ st: "ok", t }), todo = (t) => rows.push({ st: "todo", t }), bad = (t) => rows.push({ st: "bad", t });
  if (val.blocks.length) bad(html`<b>${val.blocks.length} ${plural(val.blocks.length, "thing")} on the form</b> — ${val.blocks[0].message}${val.blocks.length > 1 ? " …" : ""} <a href="/afe/${a.id}/edit/${val.blocks[0].step || 1}">Open the form →</a>`);
  else ok("The form is complete.");
  // Worth doing and deciding nothing — a capital AFE with no financial case (the KT walkthrough).
  for (const h of val.hints || []) todo(html`${h.message} <a href="/afe/${a.id}/edit/${h.step}">Open the Financials →</a>`);
  if (val.pending.length) todo(html`<b>${val.pending.length} ${plural(val.pending.length, "fact")} still to come</b> — ${val.pending[0].message}${val.pending[0].step ? html` <a href="/afe/${a.id}/edit/${val.pending[0].step}">Open →</a>` : ""}`);
  if (c) {
    if (c.needsEmail.length) todo(html`<b>${c.needsEmail.length} ${plural(c.needsEmail.length, "mailbox", "mailboxes")} to confirm</b> — ${c.needsEmail.map((n) => n.name).join(", ")}. Send is off until ${c.needsEmail.length === 1 ? "it is" : "they are"} confirmed.`);
    else ok("Every signer has a confirmed mailbox.");
    for (const b of c.blockers.filter((x) => x.code !== "emails_unconfirmed")) bad(b.message);
    if (c.sod.excluded.length) ok(html`${c.sod.excluded.map((x) => `${x.name} cannot sign as the ${x.reason}${x.standIn ? ` — ${(c.recipients.find((r) => r.id === x.standIn) || {}).name} stands in` : ""}`).join("; ")}.`);
    else ok(`${c.recipients.filter((r) => r.role !== "cc" && r.order !== null).length} ${plural(c.recipients.filter((r) => r.role !== "cc" && r.order !== null).length, "signature")}, ${c.recipients.filter((r) => r.role === "cc").length} ${plural(c.recipients.filter((r) => r.role === "cc").length, "copy", "copies")} — and nobody signs their own AFE.`);
  }
  const t = S.view.totalUsd, q = S.view.quoteTotalUsd;
  const cov = t ? pct(q, t) : null;
  // Coverage is a WARNING since R67, so it was never in `blocks` and this row always ticked green
  // — "Quotes cover 35% of $120,000." with a tick. Below the minimum it is a yellow row now, with
  // the requester's reason when there is one; a waiver from before R67 still reads as one.
  const quoteWarn = (val.warns || []).find((x) => x.rule === "quote_covers_estimate");
  const waived = (a.waivers || []).some((w) => w.ruleId === "quote_covers_estimate");
  if (cov !== null && q) (quoteWarn && !waived ? todo : ok)(html`${coverage(q, t).text}.${waived ? " Waived before send." : ""}${quoteWarn && !waived
    ? (quoteWarn.note ? html` <span class="muted">“${quoteWarn.note}”</span>` : html` <b>Below the minimum, and nobody has said why.</b>`) : ""}`);
  return rows;
}
function sideColumn() {
  const a = afe(), c = chain(), perms = S.view.permissions;
  if (frozen()) return frozenSide();
  const rows = readiness();
  const canSend = perms.canSend && S.view.validation.sendable && c && c.canSend;
  // Send on a returned AFE decides exactly as Submit does (R148): back into its round if it can.
  const goesOn = S.view.resume && S.view.resume.applies && S.view.resume.can ? S.view.resume : null;
  const val = S.view.validation;
  const firstOf = (p) => (p && p.name ? p.name.split(" ")[0] : "");
  // Say whose it is rather than "not yours" (R157): somebody else's draft comes to the
  // coordinator when they send it, and an AFE reviewed by a colleague is theirs to send.
  const why = canSend ? "" : !perms.canSend
    ? (a.state === "draft" ? `Still ${firstOf(a.requester) || "the requester"}'s draft: it comes to you when they send it.`
      : a.coordinator ? `With ${a.coordinator.name} to send.` : "Not yours to send.")
    : val.blocks.length ? `Fix the form first — ${val.blocks[0].message}`
    : c && c.needsEmail.length ? `Confirm ${c.needsEmail.map((n) => n.name).join(" and ")}'s mailbox first.`
    : c && c.blockers.length ? c.blockers[0].message
    : val.pending.length ? `Waiting on: ${val.pending[0].message}` : "Fix what is marked above.";
  // THE REVIEW SYED ASKED FOR (R157): "they or I… should be able to make those modifications
  // before it is going to approve us." The server always allowed the coordinator to edit an AFE
  // in their review; nothing on this screen led there. The wizard's own steps, from the server's
  // list, each opening the step itself — the Financials included, which is where the finance
  // partner completes a case the requester skipped.
  const steps = (session.refdata && session.refdata.wizardSteps) || [];
  const editCard = perms.canEdit && a.state === "submitted" && steps.length
    ? html`<div class="card pad" data-key="edit"><div class="sect">${icon("pen", 13)} EDIT THE AFE</div>
        <div class="small muted" style="margin-top: 4px;">Correct anything before it goes, the Financials included. ${firstOf(a.requester) || "The requester"} sees what you changed in the history.</div>
        <div class="chips" style="margin-top: 8px;">${steps.map((s) => html`<a class="chip sm" href="/afe/${a.id}/edit/${s.n}" data-key="step-${s.n}">${s.label}</a>`)}</div>
      </div>`
    : "";
  return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="side">
    ${editCard}
    <div class="card pad"><div class="sect">BEFORE IT GOES</div>
      ${rows.map((r, i) => html`<div class="check" data-key="c${i}"><span class="tick ${r.st}">${icon(r.st === "ok" ? "tick" : r.st === "todo" ? "bang" : "x", 14, { stroke: 2.4 })}</span><span>${r.t}</span></div>`)}
    </div>
    <div class="card pad"><div class="sect">NOTE TO APPROVERS</div>
      <textarea class="input" id="note" rows="3" placeholder="Budgeted under…; quotes cover…; ships before…" style="margin-top: 10px;">${a.approverNote || ""}</textarea>
      <div class="small muted" style="margin-top: 6px; display: flex; gap: 10px; align-items: center;"><span style="flex: 1;">Goes into the DocuSign message and onto each approver's screen.</span><span id="note-state" class="savestate" aria-live="polite"></span></div>
    </div>
    <a href="/api/afes/${a.id}/document.pdf" target="_blank" rel="external" style="font-size: 12.5px;">Show me the file they will sign ${icon("external", 14)}</a>
    ${/* The conversation was drawn only AFTER send, so a coordinator reviewing an AFE could not
          read what the requester wrote, or ask them anything, without leaving the screen — and a
          quick question cost a full send-back. While it is with them, Ask reaches the requester. */ ""}
    ${thread(a.thread, { canComment: perms.canComment, canAsk: perms.canAsk, askWho: perms.askWho, answer: perms.answerTo, asks: S.view.asks, sides: session.refdata && session.refdata.threadSides })}
    <button class="cta ${canSend ? "" : "off"}" id="send" ${canSend ? "" : "disabled"}>${icon("pen", 16)}${goesOn ? `Resubmit to ${goesOn.mode === "signed" ? "Fixed Assets" : goesOn.holder ? goesOn.holder.name.split(" ")[0] : "the approver"}` : "Send for signature"}</button>
    ${!canSend ? html`<div class="small" style="color: var(--yellow); font-weight: 700; margin-top: -6px;">${why}</div>` : html`<div class="small muted" style="margin-top: -6px;">Nothing is sent until you press this.</div>`}
    ${perms.canSendBack && a.state === "submitted" ? html`<button class="cta quiet" id="send-back" style="align-self: flex-start;">Send back to ${a.requester ? a.requester.name.split(" ")[0] : "the requester"}</button>` : ""}
  </div>`;
}
function frozenSide() {
  const a = afe(), r = S.view.routing, env = S.view.envelope, perms = S.view.permissions;
  const holder = r.recipients.find((x) => x.status === "sent");
  // The AFE once, whichever generation is current, then the certificate and what was attached
  // (R156) — not the generated form, the sent file and the signed set as three rows.
  const docs = ownDocuments(a);
  return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="side-frozen">
    <div class="card pad">
      <div class="sect">WHERE IT IS</div>
      <div style="margin-top: 8px; font-size: 13.5px; font-weight: 700;">${a.state === "on_hold" && holder ? `${holder.name} asked a question` : holder ? `With ${holder.name} · ${holder.level || holder.group || String(holder.role).replace(/_/g, "-")}` : r.status === "completed" ? "Fully signed" : a.state === "returned" ? "Sent back" : a.state}</div>
      <div class="small muted" style="margin-top: 4px;">${holder && holder.notifiedAt ? `Has had it ${ago(holder.notifiedAt)}${(holder.remindedAt || []).length ? ` · ${holder.remindedAt.length} ${plural(holder.remindedAt.length, "reminder")} sent` : ""}.` : ""} Round ${r.round}.</div>
      <div style="margin-top: 10px;">${progress(r.recipients.filter((x) => x.status === "signed").length, r.recipients.filter((x) => x.role !== "cc" && x.order !== null).length)}</div>
      ${env ? html`<div class="chips" style="margin-top: 12px;">${tag(env.provider === "simulated" ? "SIMULATED envelope — signed in the tool" : `DocuSign · ${env.status}`, env.provider === "simulated" ? "yellow" : "grey", { icon: "pen" })}</div>` : ""}
    </div>
    <div class="card" style="overflow: hidden;"><div class="tabhd" style="border-top: 0;">DOCUMENTS</div>${theAfeRow(S.view)}${docs.map((d) => docRow(d, a.id))}</div>
    ${a.approverNote ? html`<div class="card pad soft"><div class="sect">NOTE TO APPROVERS</div><div style="margin-top: 8px; font-size: 13px;">${a.approverNote}</div></div>` : ""}
    ${thread(a.thread, { canComment: S.view.permissions.canComment, canAsk: S.view.permissions.canAsk, askWho: S.view.permissions.askWho, answer: S.view.permissions.answerTo, asks: S.view.asks, sides: session.refdata && session.refdata.threadSides })}
    <div style="display: flex; gap: 10px; flex-wrap: wrap;">
      ${perms.canAnswer ? html`<button class="cta sm" id="answer">${icon("question", 14)}Answer</button>` : ""}
      ${perms.canSendBack ? html`<button class="cta sm sec" id="send-back">Send back</button>` : ""}
      ${perms.canWithdraw ? html`<button class="cta quiet" id="withdraw">Withdraw</button>` : ""}
    </div>
  </div>`;
}

function markup() {
  const a = afe(), c = chain();
  const t = S.view.totalUsd, q = S.view.quoteTotalUsd, cov = t ? pct(q, t) : null;
  return html`<div class="page pane">
    <div style="display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;">
      <div style="min-width: 0;">
        <div class="small muted"><a href="/prepare">Prepare</a> · ${a.requester ? a.requester.name : ""}${a.costCenter ? " · cost centre " + a.costCenter : ""}</div>
        <h1 class="h1" style="margin-top: 4px;">${frozen() ? "Where it is." : "Who signs, in what order."}</h1>
        <div class="sub">${frozen() ? `“${a.project.title}” — the chain was frozen when it was sent; only its status changes now.` : `Built from cost centre ${a.costCenter || "—"} and the ${a.division || ""} rules. Change what you need — the form redraws.`}</div>
      </div>
      <div class="big-amt" style="margin-left: auto;">${money(t)}</div>
    </div>
    <div class="chips" style="margin-top: 14px;">
      ${a.requester ? tag(`${a.requester.name} · raised it`, "", { avatar: a.requester.name }) : ""}
      ${S.view.costCentre ? tag(`CC ${S.view.costCentre.costCenter} · ${S.view.costCentre.description}`, "blue") : ""}
      ${c && c.basis ? tag(`${c.basis.band} · ${c.basis.levels.filter((l) => l !== "BOARD").join(" ")}`, "blue") : ""}
      ${cov !== null && q ? tag(`Quote covers ${cov}%`, cov >= Math.round(session.refdata.quoteCoverageMin * 100) ? "" : "yellow") : tag("No quote total yet", "yellow")}
      ${S.view.pot ? tag(`${S.view.pot.budgetCategory} · ${S.view.pot.region} · FY${S.view.pot.fiscalYear}`, "grey")
        : a.budget && a.budget.otherBudget && (!a.budget.potId || a.budget.potId === "other") ? tag(`Budget: ${a.budget.otherBudget}`, "grey") : ""}
      ${a.state !== "submitted" && a.state !== "draft" ? tag(a.state.replace("_", " "), "grey") : ""}
    </div>
    ${a.state === "returned" && a.returnedTo ? html`<div class="banner red" style="margin-top: 16px;">${icon("back", 16)}<span><b>${a.returnedTo.byName}</b> sent it back: “${a.returnedTo.reason}”. ${a.requester ? a.requester.name : "The requester"} has it to fix${S.view.permissions.canEdit ? html`, or <a href="/afe/${a.id}/edit/${a.returnedTo.step || 1}">open the form yourself</a>` : ""}.${S.view.resume && S.view.resume.applies ? html`<span style="display: block; margin-top: 8px;">${roundLine(S.view.resume)}</span>` : ""}</span></div>` : ""}
    <div class="split" style="margin-top: 18px;">
      ${chainCard()}
      ${sideColumn()}
    </div>
  </div>`;
}
function paint() { if (S.root && S.view) morph(S.root, markup()); }

// ---- sheets ------------------------------------------------------------------------------------
async function addSigner() {
  const r = await sheet({
    // Said out loud (R160): "+ Add a signer" always could put somebody first or at a level, and
    // never said which it was doing. An associate director before the owner, a second finance
    // partner, another department's owner on a cross-charge — Aiden's three cases (Meeting #7).
    eyebrow: "ADD A SIGNER", title: "Who else signs?", sub: "The matrix is the minimum. Add an associate director who signs before the owner, a second finance partner, or another department's owner when it charges them.",
    body: html`<input class="input" id="s-name" placeholder="Full name, as on the matrix" autocomplete="off">
      <input class="input" id="s-email" placeholder="first_last@example.com (optional — guessed if blank)" style="margin-top: 10px;" autocomplete="off">
      <div class="sect" style="margin-top: 16px;">WHEN THEY SIGN</div>
      <div class="chips" style="margin-top: 8px;"><button type="button" class="chip sm on" data-level="">${icon("chevR", 12)} First, before the cost-centre ladder</button></div>
      <div class="small muted" style="margin-top: 10px;">…or at a level of the ladder:</div>
      <div class="chips" style="margin-top: 6px;">${LEVELS.map((l) => html`<button type="button" class="chip sm" data-level="${l}">${l}</button>`)}</div>
      <div class="small muted" style="margin-top: 10px;">Charging another department? Add its owner here — they sign first, with the reason printed.</div>
      <input class="input" id="s-why" placeholder="Why — one line, printed for Fixed Assets" style="margin-top: 14px;">`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Add", value: "ok", primary: true }],
    validate: (el) => (!$("#s-name", el).value.trim() ? "A name is required." : null),
    collect: (el) => ({ name: $("#s-name", el).value.trim(), email: $("#s-email", el).value.trim() || null, level: ($(".chip.on[data-level]", el) || {}).dataset ? $(".chip.on[data-level]", el).dataset.level || null : null, why: $("#s-why", el).value.trim() }),
    onMount: (el) => on(el, "click", "[data-level]", (e, b) => { for (const x of el.querySelectorAll("[data-level]")) x.classList.toggle("on", x === b); }),
  });
  if (r.value !== "ok") return;
  const edits = afe().routingEdits || {};
  if (r.data.level) await putEdits({ additional: (edits.additional || []).concat([r.data]) });
  else await putEdits({ preApprovers: (edits.preApprovers || []).concat([{ name: r.data.name, email: r.data.email, why: r.data.why }]) });
}
async function addCopy() {
  const r = await sheet({
    eyebrow: "ADD A COPY", title: "Who receives the signed set?", sub: "Copies do not sign. The requester and Fixed Assets always get one.",
    body: html`<input class="input" id="c-name" placeholder="Name" autocomplete="off"><input class="input" id="c-email" placeholder="first_last@example.com" style="margin-top: 10px;" autocomplete="off">`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Add", value: "ok", primary: true }],
    validate: (el) => (!$("#c-name", el).value.trim() || !$("#c-email", el).value.trim() ? "Name and mailbox, please." : null),
    collect: (el) => ({ name: $("#c-name", el).value.trim(), email: $("#c-email", el).value.trim() }),
  });
  if (r.value !== "ok") return;
  await putEdits({ cc: (afe().ccRecipients || []).concat([r.data]) });
}
async function rulesSheet() {
  const c = chain();
  const applied = (S.rules || []).filter((x) => (c.basis.orgRuleIds || []).includes(x.id) || ((afe().routingEdits || {}).suppressedRules || []).some((s) => s.ruleId === x.id));
  const suppressed = new Map(((afe().routingEdits || {}).suppressedRules || []).map((s) => [s.ruleId, s.reason]));
  await sheet({
    eyebrow: "THE RULES ON THIS AFE", title: "Leave a rule out?", sub: "This AFE only, with a reason, audited. The matrix itself cannot be switched off.",
    body: html`${applied.map((x) => html`<div class="check" data-key="${x.id}"><span class="tick ${suppressed.has(x.id) ? "todo" : "ok"}">${icon(suppressed.has(x.id) ? "minus" : "tick", 14, { stroke: 2.4 })}</span>
      <span style="flex: 1;"><b>${x.person ? x.person.name : x.kind}</b> <span class="muted">· ${x.kind.replace("_", " ")}${x.group ? " · " + x.group : ""}</span><div class="small muted">${x.note || ""}</div>
      ${suppressed.has(x.id) ? html`<div class="small" style="color: var(--yellow); font-weight: 700;">Left out: ${suppressed.get(x.id)}</div>` : ""}</span>
      <button type="button" class="pillbtn ${suppressed.has(x.id) ? "" : "dark"}" data-rule="${x.id}" data-on="${suppressed.has(x.id) ? "1" : "0"}" style="height: 34px; font-size: 12px;">${suppressed.has(x.id) ? "Put back" : "Leave out"}</button></div>`)}`,
    actions: [{ label: "Done", value: null, tone: "sec" }],
    onMount: (el) => on(el, "click", "[data-rule]", async (e, b) => {
      const id = b.dataset.rule;
      const current = ((afe().routingEdits || {}).suppressedRules || []);
      if (b.dataset.on === "1") { closeSheet(null); await putEdits({ suppressedRules: current.filter((s) => s.ruleId !== id) }); return; }
      closeSheet(null);
      const reason = await askText({ eyebrow: "LEAVE OUT", title: "Why is this rule left out of this AFE?", placeholder: "e.g. Daryl is on leave until October; Atwal agreed by email", action: "Leave it out", tone: "dark" });
      if (!reason) return;
      await putEdits({ suppressedRules: current.concat([{ ruleId: id, reason }]) });
    }),
  });
}

// ---- wiring ------------------------------------------------------------------------------------
function wire(root) {
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "click", "[data-confirm]", async (e, b) => {
    const rid = b.dataset.confirm;
    const input = $(`[data-mail="${rid}"]`, root);
    const done = busy(b, "Saving…");
    try {
      const r = await api.post(`/api/afes/${S.id}/routing/confirm-emails`, { confirmations: [{ recipientId: rid, email: input.value.trim() || undefined }] });
      toast(`${r.learned[0].name}'s mailbox ${r.learned[0].source === "typed" ? "saved" : "confirmed"} — the directory will remember it.`, "ok");
      await load(); paint(); store.bust("/api/coordinator");
    } catch (err) { done(); showError(err); }
  });
  on(root, "keydown", "[data-mail]", (e, el) => { if (e.key === "Enter") { const b = $(`[data-confirm="${el.dataset.mail}"]`, root); if (b) b.click(); } });
  on(root, "click", "[data-remove]", async (e, b) => {
    const name = b.dataset.name, role = b.dataset.role;
    const edits = afe().routingEdits || {};
    const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
    const restore = role === "additional" ? { additional: (edits.additional || []).slice() }
      : role === "pre_approver" ? { preApprovers: (edits.preApprovers || []).slice() }
      : { cc: (afe().ccRecipients || []).slice() };
    S.undo = { name, role, restore };
    if (role === "additional") await putEdits({ additional: (edits.additional || []).filter((x) => norm(x.name) !== norm(name)) }, true);
    else if (role === "pre_approver") await putEdits({ preApprovers: (edits.preApprovers || []).filter((x) => norm(x.name) !== norm(name)) }, true);
    else if (role === "cc") await putEdits({ cc: (afe().ccRecipients || []).filter((x) => norm(x.name) !== norm(name)) }, true);
  });
  on(root, "click", "#undo-remove", async () => { const u = S.undo; if (!u) return; await putEdits(u.restore); });
  on(root, "click", "#add-signer", addSigner);
  // Either of the two named on the rule — one signature, chosen here, recorded as a routing edit
  // and audited like every other change to the chain.
  on(root, "click", "[data-choose-rule]", (e, b) => {
    const choice = Object.assign({}, (afe().routingEdits || {}).ruleChoice || {});
    choice[b.dataset.chooseRule] = Number(b.dataset.chooseIndex);
    putEdits({ ruleChoice: choice });
  });
  on(root, "click", "#add-copy", addCopy);
  on(root, "click", "[data-thread-post]", async (e, b) => { if (await postComment(S.id, root, b)) { await load(); paint(); } });
  on(root, "click", "#rules", rulesSheet);
  // The note says it saved BESIDE the note. It used to be "Saved" in the context bar at the top
  // of the page — far from the typing, never cleared, and still there after a save that failed.
  const noteState = (st) => {
    const el = $("#note-state", root);
    if (!el) return;
    el.className = `savestate ${st || ""}`;
    el.textContent = st === "saving" ? "Saving…" : st === "saved" ? "Saved" : st === "failed" ? "Not saved" : "";
    if (st === "saved") setTimeout(() => { if (el.textContent === "Saved") { el.textContent = ""; el.className = "savestate"; } }, 2400);
  };
  on(root, "input", "#note", (e, el) => { el.dataset.dirty = "1"; debounce("note", 600, async () => {
    noteState("saving");
    try { await api.put(`/api/afes/${S.id}/routing/recipients`, { approverNote: el.value }); afe().approverNote = el.value; delete el.dataset.dirty; noteState("saved"); }
    catch (err) { noteState("failed"); showError(err); }
  }); });
  on(root, "click", "#send", async (e, b) => {
    const done = busy(b, "Creating the envelope…");
    // The note is typed on this screen and rides in the DocuSign message: save what is pending
    // before the envelope exists, or the approvers get the note without its last words.
    await settleDebounces();
    try {
      const r = await api.post(`/api/afes/${S.id}/send`);
      store.bust("/api"); toast(r.note || "Sent.", "ok");
      await load(); paint();
    } catch (err) { done(); showError(err); await load(); paint(); }
  });
  on(root, "click", "#send-back", async () => {
    const a = afe();
    const r = await sheet({
      eyebrow: "SEND BACK", title: `Send it back to ${a.requester ? a.requester.name.split(" ")[0] : "the requester"}?`, sub: `They reopen the wizard at the step you pick.${frozen() && S.view.routingBrief && S.view.routingBrief.signed ? ` ${S.view.routingBrief.signed === 1 ? "The signature" : `The ${S.view.routingBrief.signed} signatures`} so far stand${S.view.routingBrief.signed === 1 ? "s" : ""} unless the money, the budget, the case, the documents or who signs changes.` : ""}`,
      body: html`<textarea class="input" id="sb-reason" rows="3" placeholder="What needs to change — in their words."></textarea>
        <div class="sect red" style="margin-top: 14px;">${icon("back", 13)} REOPENS AT</div>
        ${reopenPicker(session.refdata && session.refdata.wizardSteps, 1)}`,
      actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Send back", value: "ok", tone: "dark", primary: true }],
      validate: (el) => (!$("#sb-reason", el).value.trim() ? "Say what needs to change." : null),
      collect: (el) => ({ reason: $("#sb-reason", el).value.trim(), step: Number(($(".chip.on[data-step]", el) || { dataset: { step: 1 } }).dataset.step) }),
      onMount: (el) => on(el, "click", "[data-step]", (e, b) => { for (const x of el.querySelectorAll("[data-step]")) x.classList.toggle("on", x === b); }),
      run: (value, data) => api.post(`/api/afes/${S.id}/send-back`, data),
    });
    if (r.value !== "ok") return;
    store.bust("/api"); toast("Sent back.", "ok"); await load(); paint();
  });
  on(root, "click", "#answer", async () => {
    const open = (afe().thread || []).filter((t) => t.kind === "question" && !t.resolvedAt);
    const text = await askText({ eyebrow: "ANSWER", title: open.length ? `${open[0].byName} asks` : "Answer", sub: open.length ? `“${open[0].text}”` : "", action: "Send the answer" });
    if (!text) return;
    try { await api.post(`/api/afes/${S.id}/answer`, { text }); store.bust("/api"); await load(); paint(); } catch (e) { showError(e); }
  });
  on(root, "click", "#withdraw", async () => {
    const text = await askText({ eyebrow: "WITHDRAW", title: "Withdraw this AFE?", sub: "Any signatures so far are void. Approvers who have it are told.", placeholder: "Why? (optional)", required: false, action: "Withdraw", tone: "dark" });
    if (text === null) return;
    try { await api.post(`/api/afes/${S.id}/withdraw`, { reason: text }); store.bust("/api"); toast("Withdrawn.", "ok"); await navigate("/prepare"); } catch (e) { showError(e); }
  });
}

export async function render(root, ctx) {
  S.id = ctx.params.id; S.root = root;
  try { await load(); } catch (e) { showError(e); await navigate("/prepare", { replace: true }); return; }
  if (!S.view.permissions.canCoordinate && !S.view.permissions.canSend) { await navigate(`/afe/${S.id}`, { replace: true }); return; }
  setRecord({ id: S.id, title: afe().project.title });
  if (!root.dataset.coord) { root.innerHTML = ""; root.dataset.coord = "1"; }
  wire(root);
  paint();
}
export function unmount() { if (S.root) { delete S.root.dataset.coord; S.root.innerHTML = ""; } setRecord(null); }
