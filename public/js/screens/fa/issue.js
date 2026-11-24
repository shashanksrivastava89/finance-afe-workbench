// /fa/:id/issue — SAP smoothness: the KO01 sheet field for field in SAP's own tab order, each
// value a Copy button; then "Saved in SAP — record the IO number" (parent and, per cost line,
// the children); then KO22, AS01 and KO02 ticked as done. The IO number SAP assigns IS the AFE number.
import { html, morph, on, $ } from "../../core/dom.js";
import { api, documentToBase64 } from "../../core/api.js";
import { session } from "../../core/session.js";
import { store, uiFor } from "../../core/store.js";
import { navigate } from "../../core/router.js";
import { setRecord, setRecordNote, refreshCounts } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, since, plural, date, stateLabel } from "../../core/format.js";
import { tag, avatar, stepper, emptyState, CTA_ARROW, panel, txnKey, when, docBadge } from "../../components/parts.js";
import { sheet, toast, busy, showError, askText, opening, loadFailed } from "../../core/ui.js";
import { sendOff, bringTo } from "../../core/motion.js";
import { identityLine, firstName } from "./common.js";

const ui = uiFor("fa-issue");
const S = { id: null, view: null, root: null, wiredTo: null };
const afe = () => S.view.afe;
const copied = () => (ui.copied && ui.copied[S.id]) || {};
const BLANK = /^— not recorded$/;

async function load() { S.view = await api.get(`/api/fa/afes/${S.id}`); }
function take(res) { if (res && res.redFlags) S.view = res; }
function paint() { if (S.root && S.view) morph(S.root, markup()); }

const copyable = (r) => !r.system && !BLANK.test(String(r.value || ""));
/**
 * WHERE IT STANDS, from judgment to close — one function, read by the stepper, the headline and
 * the Next panel, so they cannot disagree (2026-10-16). They did: the stepper reached "Done" the
 * moment KO22 was ticked, the headline said "Three SAP steps follow" for ever, and Next said "All
 * done" — while AS01, KO02, the issued AFE, Capitalize and Close were all still on the page.
 *   1 Judgment · 2 Approval · 3 Key KO01 · 4 Record the order · 5 SAP steps · 6 Issued AFE ·
 *   7 Capitalize · 8 Close
 */
function stepNo() {
  const a = afe(), st = (a.fa && a.fa.steps) || {};
  const issue = S.view.issue || {};
  if (a.state === "fa_review") {
    if (S.view.judgment.open || !S.view.redFlags.ready) return 1;
    // R101: between finishing the judgment and touching SAP there is now a person to wait for.
    if (issue.required && !issue.approval) return 2;
    const rows = S.view.ko01.rows.filter(copyable);
    return rows.length && rows.every((r) => copied()[r.field]) ? 4 : 3;
  }
  if (["issued", "tracking"].includes(a.state)) {
    if (!(st.KO22_BUDGET && st.AS01_AUC && st.KO02_SETTLEMENT)) return 5;
    return a.fa && a.fa.packSentAt ? 7 : 6;
  }
  return 8;                                              // capitalized: a second person closes it; closed: the last step, done
}
/** What the headline says, from the same facts as the stepper. */
function headline() {
  const a = afe(), n = stepNo(), who = a.requester ? firstName(a.requester.name) : "the requester";
  if (a.state === "fa_review") return { h: "Key it into SAP — in this order.", sub: "Copy top to bottom. SAP's tabs are in the order they appear on screen." };
  if (!a.afeNo) return { h: "Not with Fixed Assets.", sub: `This AFE is ${stateLabel(a.state).toLowerCase()}.` };
  if (a.state === "closed") return { h: `Closed — AFE ${a.afeNo}.`, sub: "Capitalized and closed by two different people. The project page keeps its figures." };
  if (a.state === "capitalized") return { h: `Capitalized — AFE ${a.afeNo}.`, sub: "A second person on the Fixed Assets team closes it." };
  if (n === 5) return { h: `Issued — AFE ${a.afeNo}.`, sub: `${who} has the number. KO22, AS01 and KO02 come next, in that order.` };
  if (n === 6) return { h: `Issued — AFE ${a.afeNo}.`, sub: `The SAP steps are done. Send ${who} the issued AFE.` };
  return { h: `Issued — AFE ${a.afeNo}.`, sub: `${who} has the issued AFE. Capitalize when AIBU settles the AuC.` };
}

// ---- the sheet -------------------------------------------------------------------------------------
function ko01Card() {
  const rows = S.view.ko01.rows, c = copied();
  const groups = [];
  for (const r of rows) { const g = groups.find((x) => x.screen === r.screen); if (g) g.rows.push(r); else groups.push({ screen: r.screen, rows: [r] }); }
  // After the order exists this is a RECORD of what was keyed rather than a sheet to key from,
  // so it folds away — the Done screen is long enough without it — and the stepper's "Key KO01"
  // opens it. A step that says it is done has to be able to show what it did (design rule 5).
  const past = !["fa_review"].includes(afe().state);
  const open = !past || ui.ko01 === true;
  return html`<div class="panel t-blue" style="margin-top: 18px;" data-key="ko01">
    <div class="panel-hd">${past
      ? html`<button type="button" class="ttl asbtn" id="ko01-toggle" aria-expanded="${open ? "true" : "false"}">${icon("copy", 14)} KO01 · what was keyed <span class="chev ${open ? "up" : ""}">${icon("chevD", 12)}</span></button>`
      : html`<span class="ttl">${icon("copy", 14)} KO01 · field for field, in SAP's own tab order</span>`}
      <span class="meta">${past ? `${rows.filter(copyable).length} fields` : "every value one click from the clipboard"}</span></div>
    ${!open ? "" : groups.map((g, gi) => html`<div data-key="g-${gi}">
      <div class="tabhd" style="${gi === 0 ? "border-top: 0;" : ""}">${g.screen.replace(/^KO01 · /, "").toUpperCase()}</div>
      ${g.rows.map((r) => { const done = Boolean(c[r.field]); const can = copyable(r); const blank = BLANK.test(String(r.value || "")); return html`<div class="korow ${done ? "copied" : ""}" data-key="${r.screen}-${r.field}">
        <span class="tick ${done ? "ok" : r.system ? "off" : blank ? "bad" : "off"}">${done ? icon("tick", 15, { stroke: 2.4 }) : r.system ? icon("minus", 14) : blank ? icon("bang", 14) : ""}</span>
        <span class="fv"><span class="f">${r.field}${r.required ? " *" : ""}</span><span class="v ${r.system ? "soft" : ""} ${blank ? "blank" : ""}">${r.value}${r.note ? html`<span class="note">${r.note}</span>` : ""}</span></span>
        ${can ? html`<button type="button" class="pillbtn sm ${done ? "done" : ""} copy" data-copy="${r.field}" data-value="${r.value}">${done ? "Copied" : "Copy"}</button>` : html`<span></span>`}
      </div>`; })}
    </div>`)}
  </div>`;
}
function recordCta() {
  const a = afe(), ready = S.view.readiness, perms = S.view.permissions;
  if (a.state !== "fa_review") return "";
  return html`<div class="foot" style="margin-top: 22px; justify-content: flex-start;" data-key="record">
    ${ready.canRecord ? html`<button class="cta" id="record">Saved in SAP — record the IO number ${CTA_ARROW}</button>` : html`<button class="cta off" disabled>Saved in SAP — record the IO number ${CTA_ARROW}</button>`}
    <span class="small muted" style="max-width: 420px;">${ready.canRecord ? "Investments tab stays empty — asset class is set at AS01. Estimated costs stays 0.00; the budget rides KO22." : html`${!perms.canRecordIo && perms.canJudge ? "A Fixed Assets preparer records the order. " : ""}${ready.why.filter((w) => !/not with Fixed Assets/.test(w)).join(" ")} <a href="/fa/${a.id}/judge">Back to the judgment →</a>`}</span>
  </div>`;
}

// ---- after KO01 ------------------------------------------------------------------------------------------
function issuedCards() {
  const a = afe(), st = (a.fa && a.fa.steps) || {}, ios = S.view.ios || [], perms = S.view.permissions;
  const steps = S.view.ko01.steps;                       // KO22 · AS01 · KO02 as data, with their lines
  const keyOf = { KO22: "KO22_BUDGET", AS01: "AS01_AUC", KO02: "KO02_SETTLEMENT" };
  const parent = ios.find((x) => x.kind === "parent");
  return html`<div style="display: flex; flex-direction: column; gap: 14px; margin-top: 18px;" data-key="issued">
    <div class="panel t-green" data-key="orders">
      <div class="panel-hd"><span class="ttl">${icon("box", 14)} Internal orders recorded</span><span class="meta">${ios.length} ${plural(ios.length, "order")}</span></div>
      ${ios.length ? ios.map((io) => html`<div class="korow" data-key="${io.id}">
        <span class="tick ok">${icon("tick", 15, { stroke: 2.4 })}</span>
        <span class="fv"><span class="f">${io.kind === "parent" ? "Parent · AFE number" : `Child · ${io.site || io.country || "line " + io.lineSeq}`}</span><span class="v">${io.ioNumber}<span class="note">${io.orderType} · ${money(io.allocatedBudgetUsd)} allocated${io.aucNumber ? ` · AuC ${io.aucNumber}` : ""} · recorded ${when(io.issuedAt)}</span></span></span>
        <button type="button" class="pillbtn sm copy" data-copy="io-${io.ioNumber}" data-value="${io.ioNumber}">${copied()["io-" + io.ioNumber] ? "Copied" : "Copy"}</button>
      </div>`) : emptyState("No orders recorded.")}
      ${S.view.ko01.children.length > ios.filter((x) => x.kind === "child").length ? html`<div class="small muted" style="padding: 10px 20px; border-top: 1px solid var(--line-soft);">${S.view.ko01.children.length - ios.filter((x) => x.kind === "child").length} cost ${plural(S.view.ko01.children.length - ios.filter((x) => x.kind === "child").length, "line")} without a child order yet — added from the project page (Stage 6).</div>` : ""}
    </div>
    ${(() => { const c = copied(); return panel({ tone: "blue", icon: "cog", title: "After KO01 · in this order", key: "runsheet",
      meta: `${steps.filter((x) => st[keyOf[x.key]]).length} of ${steps.length} done`, flush: true, children: html`${steps.map((s) => {
        const key = keyOf[s.key];
        const done = st[key];
        // What this step needs, and whether it can be started — from `handoff`, which is derived
        // from the same declarations the route enforces (R99, R100, R103).
        const h = (S.view.handoff || []).find((x) => x.key === key) || {};
        const blocked = Boolean(h.blockedBy);
        const open = ui.step === s.key || (!ui.step && !done && !blocked);
        const wants = [];
        // The labels carry units and initials (USD, AuC), so they are quoted as written.
        if (h.needsEvidence && !h.hasEvidence) wants.push(`the ${h.needsEvidence.label} screenshot`);
        if (h.needsAmount) wants.push(`the ${h.needsAmount.label}`);
        if (h.needsValue) wants.push(`the ${h.needsValue.label}`);
        return html`<div class="runstep ${done ? "done" : ""} ${open ? "open" : ""} ${blocked ? "blocked" : ""}" data-key="${s.key}">
          <button type="button" class="runhd" data-step="${s.key}" aria-expanded="${open ? "true" : "false"}">
            ${txnKey(s.txn, done ? "done" : blocked ? "off" : "now")}
            <span class="rt"><span class="t">${s.title}</span><span class="d">${done
              ? html`Done by ${done.byName || done.byEmail} ${when(done.doneAt)}${done.value ? ` · ${h.needsValue ? h.needsValue.label + " " : ""}${done.value}` : ""}${done.amountUsd !== null && done.amountUsd !== undefined ? ` · ${money(done.amountUsd)} loaded` : ""}`
              : blocked ? html`Comes after ${(S.view.handoff.find((x) => x.key === h.blockedBy) || {}).title || h.blockedBy}.`
              : html`${s.path}`}</span></span>
            <span class="chev">${icon(open ? "chevD" : "chevR", 16)}</span>
          </button>
          ${open ? html`<div class="runbd">
            <div class="runcols">
              <div class="runkey">
                <div class="sect blue">${icon("copy", 13)} IN SAP, KEY THIS</div>
                ${(s.rows || []).map((r) => { const blank = BLANK.test(String(r.value || "")); return html`<div class="kv ${r.system ? "soft" : ""}" data-key="${r.field}">
                  <span class="f">${r.field}${r.required ? html`<i class="req">*</i>` : ""}</span>
                  <span class="v ${blank ? "blank" : ""}">${r.value}${r.note ? html`<span class="note">${r.note}</span>` : ""}</span>
                  ${!r.system && !blank ? html`<button type="button" class="pillbtn sm copy" data-copy="${s.key}-${r.field}" data-value="${r.value}">${c[s.key + "-" + r.field] ? "Copied" : "Copy"}</button>` : html`<span></span>`}
                </div>`; })}
                ${(s.expect || []).map((e, i) => html`<div class="expect" data-key="e${i}">${icon("info", 13)}<span>${e}</span></div>`)}
              </div>
              <div class="runret">
                <div class="sect green">${icon("arrowIn", 13)} THEN RECORD WHAT IT GAVE YOU</div>
                <div class="d">${s.then}</div>
                ${done
                  ? html`<div class="gotit">${icon("tick", 15, { stroke: 2.4 })}<span>${done.value ? html`<b>${done.value}</b> · ` : ""}${done.amountUsd !== null && done.amountUsd !== undefined ? html`<b>${money(done.amountUsd)}</b> loaded · ` : ""}recorded ${when(done.doneAt)}</span></div>`
                  : wants.length ? html`<div class="needs">${icon("bang", 14)}<span>Needs ${wants.join(" and ")}.</span></div>` : ""}
                ${done && h.evidence && h.evidence.length ? html`<a class="pillbtn sm" style="margin-top: 8px;" href="/api/afes/${a.id}/documents/${h.evidence[0].attachmentId}/raw" target="_blank" rel="external">${h.evidence[0].filename} ${icon("external", 13)}</a>` : ""}
                <div class="acts" style="margin-top: 10px;">${perms.canTickSteps ? (done
                  ? html`<button type="button" class="pillbtn sm soft" data-key="undo" data-undo="${key}">Undo</button>`
                  : html`<button type="button" class="pillbtn dark" data-key="do" data-done="${key}" ${blocked ? "disabled" : ""}>${wants.length ? "Record what SAP gave" : "Mark it done"}</button>`) : ""}</div>
              </div>
            </div>
          </div>` : ""}
        </div>`; })}` }); })()}
    ${packCard()}
    ${endOfLine()}
    <div class="small muted">${parent ? `${a.requester ? firstName(a.requester.name) : "The requester"} was told AFE ${parent.ioNumber} when it was recorded. ` : ""}Budget, actual and commitment come from SAP's extracts on the project page.</div>
  </div>`;
}

/**
 * R93, R104 — the issued AFE, sent when Fixed Assets says so.
 *
 * It used to be built at KO01 and mailed straight away, which meant it went out with two empty
 * boxes in it: the AuC number and the budget evidence do not exist when the order is created.
 * Now it is a step of its own, after the SAP work, and this card says what is still missing,
 * what would bind into it and who it reaches.
 */
/**
 * What goes back to the requester, said as a STRUCTURE (R133).
 *
 * It was two run-on sentences: "Ready. The signed form with internal order 313850, AuC 87654321
 * printed in red, the SAP budget table beside them, and 2 documents bound in behind." then "Goes
 * to Shashank Srivastava and the coordinator, copying Fixed Assets and Judithmelanie Ware and Jarrod
 * Dane." Four different kinds of fact welded into prose, which is read word by word to
 * extract things that would each fit on one line. "Clutter is what I see, effort is what goes
 * into reading such unstructured continuous text" (Shashank, 2026-09-22).
 *
 * And the red marks are shown IN RED, because that is what they will be on the page. A preview
 * that describes a colour instead of using it is asking to be taken on trust.
 *
 * Shared by the card and by the send sheet, so the two can never describe different packs.
 */
function packPreview(opts) {
  const o = opts || {};
  const a = afe(), p = S.view.pack;
  // What the sheet had typed when it went off to Preview (R166). The sheet reopened from the SAVED
  // values, so a profit centre typed and previewed was gone on return — the one moment somebody is
  // checking it is the moment it was thrown away.
  const draft = o.draft || null;
  const typed = (key, saved) => (draft && draft[key] !== undefined ? draft[key] : saved);
  const leftOut = new Set((draft && draft.excludeDocs) || []);
  // The pack is the SIGNED FILE with the red marks on it (R156): what the approvers were given is
  // inside it and is not a choice, so it is shown as the signed AFE's own contents, and only what
  // goes behind it carries a checkbox.
  const inSigned = p.willMerge.filter((d) => d.inSigned);
  const bound = p.willMerge.filter((d) => !d.inSigned && d.byDefault && d.can);
  const drawn = p.willMerge.filter((d) => d.drawn);
  const listed = p.willMerge.filter((d) => !d.inSigned && !(d.byDefault && d.can) && !d.drawn);
  const kb = (n) => `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
  const red = (label, value, pending) => html`<div class="redrow" data-key="${label}">
    <span class="l">${label}</span>
    ${value ? html`<b class="v">${value}</b>` : html`<i class="v none">${pending || "not recorded"}</i>`}</div>`;
  // The two Fixed Assets supplies are TYPED HERE, in the block that shows what will be printed.
  // They used to say "add it below" and put the inputs under a separate heading — "why below?
  // allow adding there itself" (Shashank, 2026-09-22), and he is right: a preview that sends you
  // somewhere else to change what it is previewing is two screens pretending to be one.
  // "Optional" is said beside the label, in ink (R173): the placeholder said it and vanished at the
  // first keystroke, and a value printed in red read as a field that had to be filled.
  const redInput = (label, id, value, placeholder, multi) => html`<div class="redrow edit" data-key="${label}">
    <span class="l">${label}${/optional/i.test(placeholder || "") ? html` <span class="opt">optional</span>` : ""}</span>
    ${multi
      ? html`<textarea class="input redin" id="${id}" rows="2" maxlength="400" placeholder="${placeholder}">${value || ""}</textarea>`
      : html`<input class="input redin" id="${id}" value="${value || ""}" placeholder="${placeholder}" autocomplete="off">`}</div>`;

  return html`<div class="packview" data-key="packview">
    <div class="redset">
      <div class="redhd">${icon("pen", 12)} Printed in red on the form</div>
      ${red("AFE number", a.afeNo)}
      ${red("AuC number", (a.fa && a.fa.aucNumber) || "")}
      ${red("Plant", a.plant || "")}
      ${red("Order type", (a.fa && a.fa.orderType) || "")}
      ${red("Budget loaded (KO22)", (a.fa && a.fa.budgetLoadedUsd) ? money(a.fa.budgetLoadedUsd) : "")}
      ${red("Approved for issue", p.approval ? [p.approval.byName, p.approval.group].filter(Boolean).join(" · ") : "", "not approved yet")}
      ${a.fa && a.fa.fx ? red("Rate for SAP", `1 USD = ${a.fa.fx.localPerUsd} ${a.fa.fx.currency}`) : ""}
      ${o.editable
        ? html`${redInput("Profit centre", "p-pc", typed("profitCentre", (a.fa && a.fa.profitCentre) || ""), "From the AuC master — optional")}
               ${redInput("Note on the form", "p-note", typed("note", (a.fa && a.fa.issuedNote) || ""), "Anything you would have written on the page — optional", true)}`
        : html`${red("Profit centre", (a.fa && a.fa.profitCentre) || "", "—")}
               ${red("Note on the form", (a.fa && a.fa.issuedNote) || "", "—")}`}
    </div>
    ${drawn.length ? html`<div class="packsec" data-key="drawn">
      <div class="packhd">${icon("chart", 12)} Drawn at the top of page 1</div>
      ${drawn.map((d) => html`<div class="packdoc" data-key="${d.attachmentId}">${docBadge(d.role, d.filename)}
        <span class="nm">${d.filename}<i>${d.why}</i></span></div>`)}
    </div>` : ""}
    ${p.signed ? html`<div class="packsec" data-key="signed">
      <div class="packhd">${icon("lock", 12)} The AFE as it was signed — unchanged</div>
      <div class="packdoc" data-key="${p.signed.attachmentId}">${docBadge("envelope_pdf", p.signed.filename)}
        <span class="nm">${p.signed.filename}<i>${p.signed.pages ? `${p.signed.pages} ${p.signed.pages === 1 ? "page" : "pages"} · ` : ""}the red marks are drawn over page 1</i></span>${tag("signed", "green", { icon: "pen" })}</div>
      ${inSigned.map((d) => html`<div class="packdoc inside" data-key="${d.attachmentId}">${docBadge(d.role, d.filename)}
        <span class="nm">${d.filename}<i>inside it</i></span></div>`)}
    </div>` : ""}
    ${/* The supervisor's "Approved, please proceed" e-mail is bound in by hand today; the pack
         carries it as a page of its own straight after the index (R168). */ ""}
    ${p.approval ? html`<div class="packsec" data-key="approval">
      <div class="packhd">${icon("shield", 12)} After the index, a page of its own</div>
      <div class="packdoc" data-key="approval-page">${docBadge("issued_pack", "approval.pdf")}
        <span class="nm">Approval for issue — ${p.approval.byName}<i>${[p.approval.when, p.approval.note ? `“${p.approval.note}”` : ""].filter(Boolean).join(" · ")}</i></span>${tag("recorded", "green", { icon: "tick" })}</div>
    </div>` : ""}
    ${bound.length || listed.length ? html`<div class="packsec" data-key="files">
      <div class="packhd">${icon("plus", 12)} Added behind it</div>
      ${bound.map((d) => o.pickable
        ? html`<label class="packdoc pick" data-key="${d.attachmentId}"><input type="checkbox" data-bind="${d.attachmentId}" ${leftOut.has(d.attachmentId) ? "" : "checked"}>${docBadge(d.role, d.filename)}
            <span class="nm">${d.filename}<i>${kb(d.sizeBytes)}</i></span>${tag("bound in", "green", { icon: "tick" })}</label>`
        : html`<div class="packdoc" data-key="${d.attachmentId}">${docBadge(d.role, d.filename)}
            <span class="nm">${d.filename}<i>${kb(d.sizeBytes)}</i></span>${tag("bound in", "green", { icon: "tick" })}</div>`)}
      ${listed.map((d) => html`<div class="packdoc dim" data-key="${d.attachmentId}">${docBadge(d.role, d.filename)}
        <span class="nm">${d.filename}<i>${d.why || "listed with a link"}</i></span>${tag("listed", "grey")}</div>`)}
      ${o.pickable && bound.length ? html`<div class="small muted" style="margin-top: 6px;">Untick one to leave it out. The index page lists it with a link to the AFE.</div>` : ""}
    </div>` : ""}
    ${o.hideRecipients ? "" : html`<div class="packsec" data-key="to">
      <div class="packhd">${icon("send", 12)} Goes to</div>
      <div class="packto">
        ${/* One person, once — with every part they play. A requester who coordinates their own
              division was listed twice, as two people. */ ""}
        ${(() => {
          const people = [];
          for (const [p, role] of [[a.requester, "requester"], [a.coordinator, "coordinator"]]) {
            if (!p || !p.name) continue;
            const same = people.find((x) => (x.email && p.email && x.email.toLowerCase() === p.email.toLowerCase()) || x.name === p.name);
            if (same) same.roles.push(role); else people.push({ name: p.name, email: p.email, roles: [role] });
          }
          return people.map((x) => html`<span class="who" data-key="${x.email || x.name}">${avatar(x.name)}<span>${x.name}<i>${x.roles.join(" · ")}</i></span></span>`);
        })()}
      </div>
      <div class="packcc">${icon("copy", 11)} copying Fixed Assets${(p.approvers || []).length ? ` · ${p.approvers.join(` · `)}` : ""}</div>
    </div>`}
  </div>`;
}

function packCard() {
  const a = afe(), p = S.view.pack;
  if (!p || !["issued", "tracking"].includes(a.state)) return "";
  const ready = !p.missing.length;
  return panel({
    tone: p.sentAt ? "green" : ready ? "blue" : "yellow",
    icon: p.sentAt ? "tick" : "send",
    title: "The issued AFE",
    meta: p.sentAt ? `sent ${since(p.sentAt)}` : ready ? "ready to send" : "not ready yet",
    key: "pack",
    // Before it is sent there is nothing stored to open, so the preview builds it on demand —
    // the same builder, nothing kept. Fixed Assets assembles this by hand today precisely so
    // they can check it; not being able to look was the gap (R134).
    right: p.latest
      ? html`<a class="pillbtn sm" href="/api/afes/${a.id}/issued-pack.pdf" target="_blank" rel="external">Open ${icon("external", 12)}</a>`
      : ready ? html`<a class="pillbtn sm" href="/api/fa/afes/${a.id}/issued-pack/preview.pdf" target="_blank" rel="external">${icon("search", 12)}Preview it</a>` : "",
    children: html`
      ${p.sentAt ? html`<div class="packsent">${icon("tick", 14, { stroke: 2.4 })}<span>Sent by <b>${(p.sentBy || {}).byName || "Fixed Assets"}</b> ${when(p.sentAt)}${p.count > 1 ? ` · ${p.count} versions built` : ""}.</span></div>` : ""}
      ${!p.sentAt && !ready ? html`<div class="needs">${icon("bang", 14)}<span>Not yet — ${p.missing.join(", and ")}. The issued AFE carries the AuC number and the budget table, so it cannot be built before they exist.</span></div>` : ""}
      ${ready || p.sentAt ? packPreview() : ""}
      ${p.can ? html`<div style="margin-top: 12px;"><button type="button" class="${p.sentAt ? "pillbtn sm soft" : "cta sm"}" id="send-pack">${p.sentAt ? "Rebuild and send again" : "Send the issued AFE"}</button></div>` : ""}`,
  });
}

// ---- the end of the line: capitalize, then a second person closes -------------------------------
// Four eyes is the point of splitting these, so the screen says whose turn it is rather than
// hiding a disabled button.
function endOfLine() {
  const a = afe(), perms = S.view.permissions, cap = (a.fa && a.fa.capitalized) || null, closed = (a.fa && a.fa.closed) || null;
  const steps = (a.fa && a.fa.steps) || {};
  // The same rule the transition holds (P0-4): the three SAP steps AND the issued AFE sent. The
  // button used to be live as soon as the order existed, and pressing it early ended the run with
  // the steps unrecordable and the issued AFE never built.
  const stepsDone = steps.KO22_BUDGET && steps.AS01_AUC && steps.KO02_SETTLEMENT;
  const packSent = Boolean(a.fa && a.fa.packSentAt);
  const ready = stepsDone && packSent;
  const waitingOn = !stepsDone ? "KO22, AS01 and KO02 come first — the settlement rule decides where the cost lands."
    : "Send the issued AFE to the requester first — once it is capitalized it can no longer be built.";
  if (!["issued", "tracking", "capitalized", "closed"].includes(a.state)) return "";
  return html`<div class="panel t-grey" data-key="end">
    <div class="tabhd" style="border-top: 0;">THE END OF THE LINE · FOUR EYES</div>
    <div class="flag ${cap ? "cleared" : ""}" data-key="cap">
      <span class="tick lg ${cap ? "ok" : ready ? "ready" : "off"}">${cap ? icon("tick", 15, { stroke: 2.4 }) : html`<b style="font-size: 10.5px;">AIBU</b>`}</span>
      <div style="min-width: 0;">
        <div class="t">Capitalize — the asset under construction settles to a fixed asset</div>
        <div class="d">${cap ? html`Asset <b>${cap.assetNumber}</b> on ${date(cap.capitalizedAt)} at ${money(cap.amountUsd)}${cap.overTolerance ? " — over the tolerance, covered by a supplemental" : ""}. By ${cap.byName} ${when(cap.at)}.`
          : ready ? "The budget is loaded, the AuC exists, the settlement rule is set and the requester has the issued AFE. Record what AIBU settled to." : waitingOn}</div>
      </div>
      <div class="acts">${!cap && perms.canCapitalize ? html`<button type="button" class="pillbtn sm ${ready ? "dark" : "soft"}" id="capitalize" ${ready ? "" : "disabled"} title="${ready ? "" : waitingOn}">Capitalize</button>` : ""}</div>
    </div>
    <div class="flag ${closed ? "cleared" : ""}" data-key="close">
      <span class="tick lg ${closed ? "ok" : "off"}">${closed ? icon("tick", 15, { stroke: 2.4 }) : icon("shield", 15)}</span>
      <div style="min-width: 0;">
        <div class="t">Close — a second person agrees it is finished</div>
        <div class="d">${closed ? html`Closed by <b>${closed.byName}</b> ${when(closed.at)}${closed.note ? ` — “${closed.note}”` : ""}.`
          : cap ? (perms.canClose ? "You did not capitalize this one, so it is yours to close."
            : perms.capitalizedByMe ? "You capitalized it — somebody else on the Fixed Assets team closes it. They have been told."
            : "A Fixed Assets checker closes it.")
          : "Nothing to close until it is capitalized."}</div>
      </div>
      <div class="acts">${!closed && perms.canClose ? html`<button type="button" class="pillbtn sm dark" id="close-afe">Close it</button>` : ""}</div>
    </div>
  </div>`;
}

/**
 * R101 — who signs the issue off, and whose turn it is, said plainly.
 *
 * Three readers, three different sentences: an approver who can act sees a button; a preparer
 * waiting sees the names; and once it is approved everyone sees who did it and when. The last
 * case matters most to the person keying SAP, because if it was THEM the tool will refuse the
 * order and this is where they find that out rather than at the refusal.
 */
function approvalCard() {
  const a = afe(), issue = S.view.issue || {};
  if (!issue.required) return "";
  // It used to vanish the moment the AFE left `fa_review`, which is exactly when it matters
  // most: four eyes on the creation of an internal order is a control, and the evidence that it
  // ran should outlive the step. Once it is recorded it stays; only the "waiting for someone"
  // state belongs to the review.
  const approval = issue.approval;
  if (!approval && a.state !== "fa_review") return "";
  const names = (issue.approvers || []).map((x) => x.name + (x.group ? ` (${x.group})` : "")).join(" or ");
  if (approval) {
    return html`<div class="card pad" data-key="approval">
      <div class="sect">APPROVED FOR ISSUE</div>
      <div style="display: flex; gap: 10px; align-items: flex-start; margin-top: 8px;">
        <span class="tick ok">${icon("tick", 12, { stroke: 2.6 })}</span>
        <div style="min-width: 0;">
          <div style="font-size: 13px; font-weight: 700;">${approval.byName}${approval.group ? html` <span class="muted" style="font-weight: 400;">· ${approval.group}</span>` : ""}</div>
          <div class="small muted">${since(approval.at)}</div>
          ${approval.note ? html`<div style="font-size: 12.5px; color: var(--ink-2); margin-top: 5px;">“${approval.note}”</div>` : ""}
        </div>
      </div>
      ${issue.approvedByMe ? html`<div class="field-msg warn" style="margin-top: 10px;">${icon("info", 13)}<span>You approved this, so somebody else records the internal order — two people, by name.</span></div>` : ""}
    </div>`;
  }
  return html`<div class="card pad" data-key="approval">
    <div class="sect">APPROVAL TO ISSUE</div>
    <div style="font-size: 12.5px; color: var(--ink-2); margin-top: 6px; line-height: 1.5;">
      ${issue.canApprove
        ? "The judgment is done and the flags are clear. Approving this releases it for the internal order — somebody else then keys SAP."
        : html`No internal order is created until <b>${names || "an FA issue approver"}</b> has approved it.`}
    </div>
    ${issue.canApprove
      ? html`<button class="cta sm" id="approve-issue" style="margin-top: 12px;">Approve for issue</button>`
      : ""}
  </div>`;
}

// ---- the page -------------------------------------------------------------------------------------------
function side(secApproval) {
  const a = afe(), J = S.view.judgment, docs = a.documents || [];
  const signed = docs.filter((d) => d.role === "envelope_pdf").slice(-1)[0];
  const st = (a.fa && a.fa.steps) || {};
  const issue = S.view.issue || {};
  const next = a.state === "fa_review"
    ? (S.view.readiness.canRecord ? `Save in SAP, then record the order number here — it becomes the AFE number and ${a.requester ? firstName(a.requester.name) : "the requester"} is told.`
      : S.view.judgment.open || !S.view.redFlags.ready ? "Finish the judgment first; the sheet is read-only until then."
      : issue.required && !issue.approval ? `Waiting on ${(issue.approvers || []).map((x) => x.name).join(" or ") || "an FA issue approver"} to approve this for issue.`
      : issue.approvedByMe ? "You approved this, so another Fixed Assets preparer records the internal order."
      : "Finish the judgment first; the sheet is read-only until then.")
    : !st.KO22_BUDGET ? `KO22 — post ${money(S.view.totalUsd)} to order ${a.afeNo}. Then AS01 creates the AuC and KO02 sets the settlement rule.`
    : !st.AS01_AUC ? "AS01 — create the Asset Under Construction and record its number here."
    : !st.KO02_SETTLEMENT ? "KO02 — settlement rule to the AuC, 100%."
    : !(a.fa && a.fa.packSentAt) ? `Send ${a.requester ? firstName(a.requester.name) : "the requester"} the issued AFE.`
    : a.state === "capitalized" ? "A second person on the team closes it."
    : a.state === "closed" ? "Nothing left. The project page tracks its figures."
    : "Capitalize when AIBU settles the AuC to a fixed asset.";
  return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="side">
    <div class="panel"><div class="panel-hd"><span class="ttl">${icon("doc", 14)} This AFE</span></div><div class="panel-bd">
      <div style="font-size: 14.5px; font-weight: 700; margin-top: 6px; line-height: 1.25;">${a.project.title}</div>
      <div style="font-size: 19px; font-weight: 700; margin-top: 8px;">${money(S.view.totalUsd)}</div>
      <div class="chips" style="margin-top: 12px;">
        ${a.requester ? tag(`${a.requester.name}`, "", { avatar: a.requester.name }) : ""}
        ${tag(`${{ capex: "CapEx", cloud_capex: "Cloud CapEx", none: "OpEx only" }[a.money.classification] || "unclassified"}${a.budget && a.budget.budgeted ? " · " + (a.budget.budgeted === "Yes" ? "budgeted" : "unbudgeted") : ""}`, "blue")}
        ${tag(`${a.division || "—"} · cost centre ${a.costCenter || "?"}`, "grey")}
        ${a.afeNo ? tag(`AFE ${a.afeNo}`, "", { icon: "tick" }) : ""}
      </div>
      ${signed ? html`<a href="/api/afes/${a.id}/document.pdf" target="_blank" rel="external" style="display: inline-block; margin-top: 14px; font-size: 12.5px; font-weight: 700;">Open the AFE (PDF) ${icon("external", 13)}</a>` : ""}
    </div></div>
    <div class="panel ${J.open ? "t-yellow" : "t-green"}"><div class="panel-hd"><span class="ttl">${icon("tick", 14)} Your judgment</span><span class="meta">${J.open ? `${J.rows.length - J.open} of ${J.rows.length}` : "done"}</span></div><div class="panel-bd">
      <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 10px; font-size: 12.5px;">
        ${J.rows.map((r) => html`<div style="display: flex; gap: 10px; align-items: center;" data-key="${r.id}"><span class="tick ${r.st === "ok" ? "ok" : "off"}" style="width: 22px; height: 22px;">${r.st === "ok" ? icon("tick", 12, { stroke: 2.6 }) : ""}</span><span>${r.t}${r.id === "order_type" && a.fa && a.fa.orderType ? ` — ${a.fa.orderType}` : ""}</span></div>`)}
      </div>
      ${a.state === "fa_review" ? html`<a href="/fa/${a.id}/judge" style="display: inline-block; margin-top: 12px; font-size: 12.5px; font-weight: 700;">Back to the judgment →</a>` : ""}
    </div></div>
    ${secApproval}
    <div class="panel t-yellow"><div class="panel-hd"><span class="ttl">${icon("arrowR", 14)} Next</span></div>
      <div class="panel-bd" style="font-size: 12.5px; color: var(--ink-2); line-height: 1.5;">${next}</div>
    </div>
  </div>`;
}
function markup() {
  const a = afe(), n = stepNo();
  const afterOrder = ["issued", "tracking", "capitalized", "closed"].includes(a.state);
  // The sections are built BEFORE the stepper, so a step can be locked by whether its own
  // section actually rendered rather than by a second copy of the condition that rendered it.
  // A segment is a door exactly when there is a room behind it — which is R110's rule ("you
  // can go forward exactly as far as you have earned") said in the terms of this screen.
  const secApproval = approvalCard();
  const secKo01 = a.state === "fa_review" || afterOrder ? ko01Card() : "";
  const secIssued = afterOrder ? issuedCards() : "";
  // Five of these six are SECTIONS of this page and one is another screen, so five carry a
  // `jump` and one carries an `href`. They were all hrefs to `/fa/:id/issue` — the page you are
  // standing on — so at Done only Judgment went anywhere and the other four were dead clicks.
  // The whole run, to Close. A segment is still a door only when there is a room behind it — and
  // the step you are ON is never drawn locked: "Record the order" used to be greyed out with
  // "finish the earlier steps first" at the very moment it was the thing to do.
  const steps = [
    { n: 1, label: "Judgment", href: `/fa/${a.id}/judge` },
    { n: 2, label: "Approval", jump: "approval", locked: !secApproval },
    { n: 3, label: "Key KO01", jump: "ko01", locked: !secKo01 },
    { n: 4, label: "Record the order", jump: a.state === "fa_review" ? "record" : "orders", locked: !(a.state === "fa_review" || secIssued) },
    { n: 5, label: "SAP steps", jump: "runsheet", locked: !secIssued },
    { n: 6, label: "Issued AFE", jump: "pack", locked: !secIssued },
    { n: 7, label: "Capitalize", jump: "end", locked: !secIssued },
    { n: 8, label: "Close", jump: "end", locked: !secIssued },
  ].map((s) => (s.n === n ? Object.assign({}, s, { locked: false }) : s));
  const head = headline();
  const rows = S.view.ko01.rows.filter(copyable), done = rows.filter((r) => copied()[r.field]).length;
  const inReview = a.state === "fa_review";
  return html`<div class="pane">
    ${stepper(steps, n)}
    <div class="page" style="padding-top: 24px;">
      <div class="small muted"><a href="/fa" style="font-weight: 700;">‹ Fixed Assets</a> · ${identityLine(S.view)}</div>
      <div class="split" style="margin-top: 8px;">
        <div>
          <div class="dec-head" style="align-items: flex-end;">
            <div style="min-width: 0; flex: 1;">
              <h1 class="h1">${head.h}</h1>
              <div class="sub">${head.sub}</div>
            </div>
            ${inReview ? tag(`${done} of ${rows.length} copied`, done === rows.length && rows.length ? "" : "grey", { icon: "copy" }) : ""}
          </div>
          ${secKo01}
          ${inReview ? recordCta() : ""}
          ${secIssued}
          ${!inReview && !["issued", "tracking", "capitalized", "closed"].includes(a.state) ? html`<div class="foot" style="margin-top: 22px; justify-content: flex-start;"><a class="cta sec" href="/afe/${a.id}">Open the AFE ${CTA_ARROW}</a></div>` : ""}
        </div>
        ${side(secApproval)}
      </div>
    </div>
  </div>`;
}

// ---- actions ----------------------------------------------------------------------------------------------
/** R101 — approve this AFE for issue. Optional note; the refusal comes from the server. */
async function approveIssue() {
  const a = afe(), issue = S.view.issue || {};
  const others = (issue.approvers || []).filter((x) => !issue.approvedByMe).map((x) => x.name);
  const note = await askText({
    eyebrow: "APPROVE FOR ISSUE",
    title: "Release this for the internal order?",
    sub: "The judgment is done and the red flags are clear. After this a different Fixed Assets preparer keys KO01 — never you, and never whoever raised it.",
    placeholder: "Anything the preparer should know (optional)",
    action: "Approve for issue",
    required: false,
  });
  if (note === null) return;
  const btn = $("#approve-issue", S.root);
  const done = busy(btn, "Approving…");
  try {
    const res = await api.post(`/api/fa/afes/${a.id}/approve-issue`, { note });
    take(res); store.bust("/api"); toast(res.note || "Approved.", "ok"); refreshCounts(); paint();
  } catch (e) { done(); showError(e); }
}

async function recordIo() {
  const a = afe(), kids = S.view.ko01.children, types = S.view.ko01.orderTypes, cur = a.fa && a.fa.orderType;
  const r = await sheet({
    eyebrow: "RECORD THE INTERNAL ORDER", title: "What number did SAP assign?",
    sub: "The order number on KO01's save message is the AFE number. It is written on the AFE and the requester is told.",
    body: html`<input class="input" id="io-parent" inputmode="numeric" pattern="[0-9]*" placeholder="Parent order — e.g. 313403" autocomplete="off" style="height: 56px; font-size: 16px; font-weight: 700; letter-spacing: .02em;">
      <div class="sect" style="margin-top: 16px;">ORDER TYPE</div>
      <div class="chips" style="margin-top: 8px;">${types.map((t) => html`<button type="button" class="chip sm ${cur === t.code ? "on" : ""}" data-ot="${t.code}">${t.code} · ${t.label}</button>`)}</div>
      ${kids.length ? html`<div class="sect" style="margin-top: 18px;">CHILD ORDERS · ONE PER COST LINE (OPTIONAL NOW)</div>
        <div style="display: flex; flex-direction: column; gap: 8px; margin-top: 8px;">${kids.map((k) => html`<label style="display: grid; grid-template-columns: minmax(0, 1fr) 180px; gap: 10px; align-items: center; font-size: 12.5px;" data-key="k${k.seq}"><span><b>${k.site}</b>${k.country ? ` · ${k.country}` : ""} · ${money(k.amountUsd)}</span><input class="input" data-child="${k.seq}" inputmode="numeric" placeholder="child order no." autocomplete="off" style="height: 42px;"></label>`)}</div>
        <div class="small muted" style="margin-top: 8px;">Leave a line blank to add its order later from the project page.</div>` : ""}`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Record and notify", value: "ok", primary: true }],
    validate: (el) => { const v = $("#io-parent", el).value.trim(); if (!/^\d{6,10}$/.test(v)) return "The order number is 6 to 10 digits."; if (!$(".chip.on[data-ot]", el)) return "Pick the order type."; for (const i of el.querySelectorAll("[data-child]")) if (i.value.trim() && !/^\d{6,10}$/.test(i.value.trim())) return `${i.value.trim()} is not an order number.`; return null; },
    collect: (el) => ({ ioNumber: $("#io-parent", el).value.trim(), orderType: ($(".chip.on[data-ot]", el) || { dataset: {} }).dataset.ot, children: Array.from(el.querySelectorAll("[data-child]")).map((i) => ({ seq: Number(i.dataset.child), ioNumber: i.value.trim() })).filter((c) => c.ioNumber) }),
    onMount: (el) => { on(el, "click", "[data-ot]", (e, b) => { for (const x of el.querySelectorAll("[data-ot]")) x.classList.toggle("on", x === b); }); $("#io-parent", el).focus(); },
    // Sent with the sheet open: a number SAP already holds, or anything else the server refuses,
    // is said here — and the order numbers typed are still in the boxes.
    run: (value, data) => api.post(`/api/fa/afes/${a.id}/record-io`, data),
  });
  if (r.value !== "ok") return;
  const res = r.result;
  take(res); store.bust("/api"); toast(res.note || "Recorded.", "ok"); refreshCounts(); paint();
}
/**
 * Finish a SAP step, with whatever it has to come back with (R99, R100, R103).
 *
 * The sheet is built from the step's own declaration rather than from a switch on its key, so
 * adding a requirement to `refData.HANDOFF_STEPS` gives it a field here without touching this
 * function. The screenshot uploads before the tick, because the tick is refused without it.
 */
async function stepDone(key) {
  const a = afe();
  const h = (S.view.handoff || []).find((x) => x.key === key);
  if (!h) return;
  if (!h.needsAmount && !h.needsValue && !h.needsEvidence) {
    try { const res = await api.post(`/api/fa/afes/${a.id}/steps/${key}`, {}); take(res); store.bust("/api/fa"); toast("Done.", "ok"); paint(); refreshCounts(); }
    catch (e) { showError(e); }
    return;
  }
  const r = await sheet({
    eyebrow: h.title.toUpperCase(),
    title: h.needsEvidence ? "What did SAP show back?" : h.needsValue ? `The ${h.needsValue.label} SAP assigned` : "Record this step",
    sub: h.needsEvidence
      ? "The table proves two things at once: the order exists, and the budget is unlocked. It prints at the top of the issued AFE."
      : h.needsValue ? h.needsValue.help : "",
    body: html`${h.needsAmount ? html`<label class="sect">${h.needsAmount.label.toUpperCase()}</label>
        <input class="input" id="s-amount" inputmode="decimal" value="${S.view.totalUsd}" autocomplete="off" style="height: 42px; font-size: 16px; font-weight: 700; margin-top: 6px;">
        <div class="small muted" style="margin-top: 5px;">${h.needsAmount.help}</div>` : ""}
      ${h.needsValue ? html`<label class="sect" style="${h.needsAmount ? "margin-top: 16px;" : ""}">${h.needsValue.label.toUpperCase()}</label>
        <input class="input" id="s-value" inputmode="numeric" placeholder="${h.needsValue.shape}" autocomplete="off" style="height: 42px; font-size: 16px; font-weight: 700; margin-top: 6px;">` : ""}
      ${h.needsEvidence ? html`<div class="sect" style="margin-top: 16px;">${h.needsEvidence.label.toUpperCase()} · SCREENSHOT</div>
        ${h.hasEvidence
          ? html`<div class="field-msg" style="background: var(--green-ok-bg); color: var(--green-deep); margin-top: 6px;">${icon("tick", 13, { stroke: 2.4 })}<span>${h.evidence[0].filename} is attached.</span></div>`
          : html`<label class="drop" style="margin-top: 6px; padding: 18px; display: block; cursor: pointer;">
              ${icon("upload", 26, { stroke: 1.5 })}
              <div style="font-size: 13px; font-weight: 700; margin-top: 8px;" id="s-file-name">Drop the screenshot here, or <span style="color: var(--link);">browse</span></div>
              <div class="small muted" style="margin-top: 4px;">PNG, JPEG or PDF · paste the SAP table into anything</div>
              <input type="file" id="s-file" accept="image/png,image/jpeg,application/pdf">
            </label>
            <div class="small muted" style="margin-top: 6px;">${h.needsEvidence.help}</div>`}` : ""}`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Record", value: "ok", primary: true }],
    validate: (el) => {
      if (h.needsAmount && !String($("#s-amount", el).value).replace(/[^0-9.]/g, "")) return `${h.needsAmount.label} is required.`;
      if (h.needsValue && !new RegExp(h.needsValue.pattern).test($("#s-value", el).value.trim())) return `The ${h.needsValue.label} is ${h.needsValue.shape}.`;
      if (h.needsEvidence && !h.hasEvidence && !(($("#s-file", el).files || [])[0])) return `Attach the ${h.needsEvidence.label} screenshot.`;
      return null;
    },
    collect: (el) => ({
      amountUsd: h.needsAmount ? Number(String($("#s-amount", el).value).replace(/[^0-9.]/g, "")) : undefined,
      value: h.needsValue ? $("#s-value", el).value.trim() : null,
      file: h.needsEvidence && !h.hasEvidence ? ($("#s-file", el).files || [])[0] : null,
    }),
    onMount: (el) => {
      const first = $("#s-amount", el) || $("#s-value", el);
      if (first) { first.focus(); first.select(); }
      const file = $("#s-file", el);
      if (file) {
        on(el, "change", "#s-file", () => {
          const picked = (file.files || [])[0];
          const label = $("#s-file-name", el);
          if (label) label.textContent = picked ? picked.name : "Drop the screenshot here, or browse";
          if (picked) el.querySelector(".drop").classList.add("over");
        });
      }
    },
  });
  if (r.value !== "ok") return;
  try {
    if (r.data.file) {
      await api.post(`/api/afes/${a.id}/documents`, {
        filename: r.data.file.name, role: "budget_evidence", contentBase64: await documentToBase64(r.data.file, session.refdata && session.refdata.attachmentLimits),
      });
    }
    const res = await api.post(`/api/fa/afes/${a.id}/steps/${key}`, { value: r.data.value, amountUsd: r.data.amountUsd });
    take(res); store.bust("/api/fa"); toast("Recorded.", "ok"); paint(); refreshCounts();
  } catch (e) { showError(e); }
}

/** R93/R104 — build the issued AFE and send it. */
async function sendPack(draft) {
  const a = afe(), p = S.view.pack;
  const merging = p.willMerge.filter((d) => d.byDefault && d.can);
  const r = await sheet({
    eyebrow: p.sentAt ? "REBUILD THE ISSUED AFE" : "SEND THE ISSUED AFE",
    title: p.sentAt ? "Build it again and send it?" : "Send it back to the requester?",
    sub: "This is what the requester receives. Everything below in red is printed in red on the page.",
    body: html`${packPreview({ inSheet: true, pickable: true, editable: true, draft })}
`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Preview", value: "preview", tone: "sec" },
      { label: p.sentAt ? "Rebuild and send" : "Send it", value: "ok", primary: true }],
    collect: (el) => ({
      profitCentre: $("#p-pc", el).value.trim(),
      note: $("#p-note", el).value.trim(),
      excludeDocs: Array.from(el.querySelectorAll("[data-bind]")).filter((i) => !i.checked).map((i) => i.dataset.bind),
    }),
  });
  // Preview opens the pack the button WOULD build — with whatever has just been typed, which is
  // the point — and then puts the sheet straight back so nothing has to be re-entered.
  if (r.value === "preview") {
    // Both fields travel even when blank: a cleared profit centre is a change the preview has to
    // show, not a value to fall back from (R166).
    const q = new URLSearchParams();
    q.set("profitCentre", r.data.profitCentre);
    q.set("note", r.data.note);
    if ((r.data.excludeDocs || []).length) q.set("exclude", r.data.excludeDocs.join(","));
    window.open(`/api/fa/afes/${a.id}/issued-pack/preview.pdf?${q}`, "_blank", "noopener");
    return sendPack(r.data);
  }
  if (r.value !== "ok") return;
  const btn = $("#send-pack", S.root);
  const done = busy(btn, "Building…");
  // The issued AFE leaving is the other end of the journey from pressing Send on the review
  // screen, and it is just as irreversible for the reader: the requester gets the mail. Same
  // flight, same rules — the request goes FIRST so nothing waits on the animation, and a failure
  // CANCELS it, because an animation that keeps playing over an error is a lie. The panel that
  // flies is the pack itself, which is the thing being sent.
  const flight = sendOff($('[data-key="pack"]', S.root));
  try {
    const res = await api.post(`/api/fa/afes/${a.id}/issue-pack`, r.data);
    await flight;
    take(res); store.bust("/api"); toast(res.note || "Sent.", "ok"); paint(); refreshCounts();
  } catch (e) { flight.cancel(); done(); showError(e); }
}

async function capitalize() {
  const approved = S.view.totalUsd;
  const supps = (S.view.supplementals || []).filter((x) => x.issued);
  const r = await sheet({
    eyebrow: "AIBU · CAPITALIZE", title: "What did the AuC settle to?",
    sub: `Approved at ${money(approved)}. Beyond 105% a supplemental AFE covers the difference first — that is the AuC recon workbook's own tolerance.`,
    body: html`<input class="input" id="c-asset" inputmode="numeric" placeholder="Fixed-asset number — e.g. 165024071" style="height: 56px; font-size: 16px; font-weight: 700;" autocomplete="off">
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px;">
        <label class="small muted">Capitalization date<input class="input" id="c-date" type="date" value="${new Date().toISOString().slice(0, 10)}" style="margin-top: 4px;"></label>
        <label class="small muted">Amount settled (blank = the approved total)<input class="input" id="c-amount" inputmode="decimal" placeholder="${approved}" style="margin-top: 4px;" autocomplete="off"></label>
      </div>
      <input class="input" id="c-note" placeholder="Note (optional)" style="margin-top: 10px;" autocomplete="off">
      ${/* Beyond the tolerance the refusal names a supplemental; this is where you say which one. */ ""}
      ${supps.length ? html`<div class="sect" style="margin-top: 16px;">OVER 105%? THE SUPPLEMENTAL THAT COVERS IT</div>
        <div class="chips" style="margin-top: 8px;">${supps.map((x) => html`<button type="button" class="chip sm" data-supp="${x.id}">${x.id} · ${x.title} · ${money(x.totalUsd)}</button>`)}</div>`
        : html`<div class="small muted" style="margin-top: 12px;">Over 105% needs an issued supplemental AFE on this one, and there is none yet.</div>`}`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Capitalize", value: "ok", primary: true }],
    validate: (el) => (!/^\d{6,12}$/.test($("#c-asset", el).value.trim()) ? "The asset number is 6 to 12 digits." : null),
    collect: (el) => ({ assetNumber: $("#c-asset", el).value.trim(), capitalizedAt: $("#c-date", el).value,
      amountUsd: $("#c-amount", el).value.trim() ? Number(String($("#c-amount", el).value).replace(/[^0-9.]/g, "")) : null,
      note: $("#c-note", el).value.trim(),
      supplementalAfeId: ($(".chip.on[data-supp]", el) || { dataset: {} }).dataset.supp || undefined }),
    onMount: (el) => on(el, "click", "[data-supp]", (e, b) => { for (const x of el.querySelectorAll("[data-supp]")) x.classList.toggle("on", x === b && !b.classList.contains("on")); }),
    // A refusal — a future date, over the tolerance with no supplemental — is said in the sheet.
    run: (value, data) => api.post(`/api/fa/afes/${afe().id}/capitalize`, data),
  });
  if (r.value !== "ok") return;
  const out = r.result;
  take(out); store.bust("/api"); toast(out.note || "Capitalized.", "ok"); paint(); refreshCounts();
}

function wire(root) {
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  // A stepper segment that names a section of THIS page scrolls to it and rings it, rather
  // than being a link to the URL you are already on. `bringTo` is the same move "N things to
  // fix first" uses on the review screen.
  on(root, "click", "[data-step-jump]", (e, b) => {
    const key = b.dataset.stepJump;
    if (key === "ko01") ui.ko01 = true;                 // it is folded away once the order exists
    if (ui.ko01 === true && key === "ko01") paint();
    const el = $(`[data-key="${key}"]`, S.root);
    if (el) bringTo(el);
  });
  on(root, "click", "#ko01-toggle", () => { ui.ko01 = !(ui.ko01 === true); paint(); });
  on(root, "click", "#capitalize", capitalize);
  on(root, "click", "#close-afe", async () => {
    const note = await askText({ eyebrow: "CLOSE", title: "Close this AFE?", sub: "Four eyes: you are confirming somebody else's capitalization. The orders close with it.",
      placeholder: "Anything worth recording (optional)", required: false, action: "Close it", tone: "dark" });
    if (note === null) return;
    try { const out = await api.post(`/api/fa/afes/${afe().id}/close`, { note }); take(out); store.bust("/api"); toast(out.note || "Closed.", "ok"); paint(); refreshCounts(); }
    catch (e) { showError(e); }
  });
  on(root, "click", "[data-copy]", async (e, b) => {
    const v = b.dataset.value;
    try { await navigator.clipboard.writeText(v); } catch { toast("Copy failed — select the value and copy it.", "err"); return; }
    ui.copied = ui.copied || {}; ui.copied[S.id] = Object.assign({}, ui.copied[S.id], { [b.dataset.copy]: true });
    toast(`Copied ${v.length > 24 ? v.slice(0, 24) + "…" : v}`, "ok", 1400);
    paint();
  });
  // One step open at a time. Somebody keying SAP is alt-tabbing between two windows and works
  // one transaction at a time; eleven sentences of every step at once is what made this a wall.
  // Pressing the open one shuts it, because a run sheet you have finished reading is a list.
  on(root, "click", "[data-step]", (e, b) => { ui.step = ui.step === b.dataset.step ? "-" : b.dataset.step; paint(); });
  on(root, "click", "#approve-issue", approveIssue);
  on(root, "click", "#send-pack", sendPack);
  on(root, "click", "#record", recordIo);
  on(root, "click", "[data-done]", (e, b) => stepDone(b.dataset.done));
  on(root, "click", "[data-undo]", async (e, b) => { try { const res = await api.post(`/api/fa/afes/${afe().id}/steps/${b.dataset.undo}`, { undo: true }); take(res); store.bust("/api/fa"); paint(); } catch (err) { showError(err); } });
}

export async function render(root, ctx) {
  S.id = ctx.params.id; S.root = root;
  const wait = opening(root, `Opening ${S.id}…`, { href: "/fa", label: "Fixed Assets" });
  try { await load(); } catch (e) { wait(); delete root.dataset.issue; loadFailed(root, e, { href: "/fa", label: "Fixed Assets" }); return; }
  wait();
  setRecord({ id: S.id, title: afe().project.title });
  if (!root.dataset.issue) { root.innerHTML = ""; root.dataset.issue = "1"; }
  wire(root);
  paint();
}
export function unmount() { if (S.root) { delete S.root.dataset.issue; S.root.innerHTML = ""; } setRecord(null); }
