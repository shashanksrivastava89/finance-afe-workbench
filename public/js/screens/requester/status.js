// /afe/:id — where a request is: the rail from Sent to the AFE number, the people, the
// documents, the conversation. Everything the requester can do from here is one button.
import { html, morph, on, $ } from "../../core/dom.js";
import { api } from "../../core/api.js";
import { store } from "../../core/store.js";
import { isCoordinator, session } from "../../core/session.js";
import { postComment } from "../../core/comments.js";
import { navigate } from "../../core/router.js";
import { setRecord, setRecordNote } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, ago, date, stateLabel , since } from "../../core/format.js";
import { tag, avatar, whereTag, signerRow, docRow, progress, roundLine, thread, theAfeRow, ownDocuments, spine } from "../../components/parts.js";
import { askText, toast, busy, showError, sheet } from "../../core/ui.js";

const S = { id: null, view: null, history: null, root: null, wiredTo: null };

function rail(view) {
  const a = view.afe, r = view.routing, perms = view.permissions;
  const signers = ((r && r.recipients) || []).filter((x) => x.role !== "cc" && ["pending", "sent", "signed", "declined", "superseded", "returned"].includes(x.status));
  const nodes = [];
  const sent = Boolean(a.sentAt);
  nodes.push({ label: sent ? "Sent" : a.submittedAt ? "Submitted" : "Draft", sub: sent ? since(a.sentAt) : a.submittedAt ? since(a.submittedAt) : "not sent yet", state: sent || a.submittedAt ? "done" : "now", icon: "tick" });
  if (a.coordinator && !sent) nodes.push({ label: a.coordinator.name, sub: a.state === "submitted" ? "reviews and sends" : "will review and send", state: a.state === "submitted" ? "now" : "todo", initials: a.coordinator.name });
  // ONE node for the signatures (2026-10-16). Each signer was a node here AND a row in "Who
  // signs" below — and on a signed AFE a third time under "Signatures checked" — so the page drew
  // the same chain two or three times. The strip says how far along it is; the chain is below.
  const live = signers.filter((s) => s.status !== "superseded");
  if (live.length) {
    const done = live.filter((s) => s.status === "signed").length;
    const holder = live.find((s) => s.status === "sent");
    const declined = live.some((s) => s.status === "declined");
    nodes.push({ label: "Signatures", sub: declined ? "declined"
      : holder ? `${done} of ${live.length} · ${a.state === "on_hold" ? `${holder.name} asked a question` : `with ${holder.name}`}`
      : `${done} of ${live.length}${done === live.length ? " · all signed" : ""}`,
      state: declined ? "bad" : done === live.length ? "done" : holder ? "now" : "todo", icon: "pen" });
  }
  const faDone = ["issued", "tracking", "capitalized", "closed"].includes(a.state);
  nodes.push({ label: "Fixed Assets", sub: faDone ? "issued" : ["approved", "fa_review"].includes(a.state) ? "checking now" : "checks", state: faDone ? "done" : ["approved", "fa_review"].includes(a.state) ? "now" : "todo", icon: "shield" });
  nodes.push({ label: "AFE number", sub: a.afeNo ? a.afeNo : "given when Fixed Assets creates the order in SAP", state: a.afeNo ? "done" : "todo", icon: "arrowIn" });
  return html`<div class="rail">${nodes.map((n, i) => html`
    ${i > 0 ? html`<span class="link ${nodes[i - 1].state === "done" ? "done" : ""}"></span>` : ""}
    <div class="node" data-key="n${i}">
      <span class="dot ${n.state}">${n.state === "done" ? icon("tick", 18, { stroke: 2.2 }) : n.level && n.state !== "done" ? n.level : n.icon ? icon(n.icon, 16, { stroke: 1.7 }) : (n.initials ? n.initials.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase() : "")}</span>
      <span><b>${n.label}</b><br>${n.sub}</span>
    </div>`)}</div>`;
}

/**
 * The chain, drawn once (2026-10-16). A person named at several matrix levels signs once, at the
 * highest row; the rows they do not sign were drawn as rows of their own ("= Udarsh Atwal · M1 ·
 * signs at a higher row"). They are folded into the row that signs — "also holds M1" — as the
 * coordinator's chain already does. "Signed 2 days ago." and "signed 2 days ago" were both on each
 * row: the time is said once, and where DocuSign's recipients were checked against the frozen chain
 * that check is a mark on the row instead of a third list of the same people.
 */
function chainRows(view, signers) {
  const env = view.envelope;
  const checked = new Map(((env && env.completed && env.completed.verification) || []).map((x) => [x.recipientId, x]));
  const alsoHolds = new Map();
  for (const s of signers) if (s.status === "skipped" && s.signsAs) alsoHolds.set(s.signsAs, (alsoHolds.get(s.signsAs) || []).concat([s.level || s.role]));
  return signers.filter((s) => s.status !== "skipped").map((rec) => {
    const also = alsoHolds.get(rec.id);
    const row = also ? Object.assign({}, rec, { levelTitle: `${rec.levelTitle ? rec.levelTitle + " " : ""}· also holds ${also.join(", ")}` }) : rec;
    const v = checked.get(rec.id);
    const right = rec.status === "signed"
      ? (v ? html`<span class="mail ${v.st === "ok" ? "" : "todo"}">${icon(v.st === "ok" ? "shield" : "bang", 14)}<span class="txt">${v.st === "ok" ? "checked against the chain" : v.note}</span></span>` : html`<span></span>`)
      : html`<span class="mail soft"><span class="txt">${rec.status === "sent" ? "has it now" : rec.status === "returned" ? "sent it back" : rec.status === "pending" ? "waiting" : rec.status === "sod_blocked" ? "party to this AFE" : rec.status}</span></span>`;
    return signerRow(row, { hideWhy: true, right });
  });
}

/** A wizard step by its name — "step 8" is the Financials step's id, and it is the fourth one. */
function stepName(n) {
  const s = ((session.refdata && session.refdata.wizardSteps) || []).find((x) => x.n === Number(n));
  return s ? `"${s.label}"` : "the form";
}

function headline(view) {
  const a = view.afe, r = view.routing;
  const holder = r && r.recipients ? r.recipients.find((x) => x.status === "sent") : null;
  switch (a.state) {
    case "draft": return "Still a draft.";
    case "submitted": return `With ${a.coordinator ? a.coordinator.name : "the coordinator"} to send.`;
    case "in_approval": return holder ? `With ${holder.name}${view.envelope && view.envelope.provider === "simulated" ? "" : " — in DocuSign"}.` : "In approval.";
    case "on_hold": return holder ? `${holder.name} asked a question.` : "On hold — a question is open.";
    case "returned": return `Sent back${a.returnedTo ? " by " + a.returnedTo.byName : ""}.`;
    case "approved": case "fa_review": return "Fully signed — with Fixed Assets.";
    case "issued": return `Issued — AFE ${a.afeNo}.`;
    case "rejected": return "Declined.";
    case "withdrawn": return "Withdrawn.";
    default: return stateLabel(a.state);
  }
}

/**
 * The issued AFE, where the requester can actually find it (R134).
 *
 * "The requester can only see it through a link in email — not ideal" (Shashank, 2026-09-22).
 * It WAS reachable: the pack lands in `afe.documents` and the document list rendered it like any
 * other attachment, between the quote and the certificate. But this is the one document the
 * requester has been waiting for — it carries the internal order number they have to quote on
 * every requisition — and a row in a list of five is not where you put that.
 *
 * It is the first thing in the column now, green, with the numbers spelled out, so nobody has to
 * go back to an email to find the PDF or the order number.
 */
function issuedPackCard(a, docs) {
  const pack = (docs || []).filter((d) => d.role === "issued_pack").slice(-1)[0];
  if (!pack) return "";
  const auc = a.fa && a.fa.aucNumber;
  return html`<div class="panel t-green" data-key="issued">
    <div class="panel-hd"><span class="ttl">${icon("tick", 14)} Your issued AFE</span><span class="meta">back from Fixed Assets</span></div>
    <div class="panel-bd">
      <div class="issuedfacts">
        ${a.afeNo ? html`<div><span>AFE / internal order</span><b>${a.afeNo}</b></div>` : ""}
        ${auc ? html`<div><span>AuC number</span><b>${auc}</b></div>` : ""}
      </div>
      <div class="small muted" style="margin-top: 8px;">Quote the AFE number on every purchase requisition and order for this project.</div>
      <a class="cta sm" style="margin-top: 12px; display: inline-flex;" href="/api/afes/${a.id}/issued-pack.pdf" target="_blank" rel="external">Open the issued AFE ${icon("external", 14)}</a>
    </div>
  </div>`;
}

/**
 * What has been done to it, in order (R129, R157). The rail says where the AFE IS; nothing here
 * said what had happened to it — least of all that the coordinator filled in the Financials
 * before sending it, which is the one change on the record its requester did not make.
 */
function historyCard() {
  const rows = (S.history && S.history.timeline) || [];
  if (!rows.length) return "";
  return html`<div class="card pad soft" data-key="history">
    <div class="sect">WHAT HAPPENED <span class="muted" style="font-weight: 400;">· ${rows.length} ${rows.length === 1 ? "event" : "events"}</span></div>
    <div style="margin-top: 8px;">${spine(rows)}</div>
  </div>`;
}

/** An ask from the other side still waiting on this AFE's own people (R163) — the latest one. */
function askedOfMe(view) {
  const t = (view.permissions || {}).answerTo;
  return t && t.mode === "ask" ? t : null;
}

function markup() {
  const view = S.view, a = view.afe, perms = view.permissions, env = view.envelope, r = view.routing;
  const docs = a.documents || [];
  const signers = ((r && r.recipients) || []).filter((x) => x.role !== "cc");
  const open = (a.thread || []).filter((t) => t.kind === "question" && !t.resolvedAt);
  const fixStep = a.returnedTo && a.returnedTo.step ? a.returnedTo.step : 1;
  return html`<div class="page pane">
    <div style="display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;">
      <div style="min-width: 0;">
        <div class="small muted">${a.requester ? a.requester.name : ""}${a.division ? " · " + a.division : ""}${a.costCenter ? " · cost centre " + a.costCenter : ""}${a.round > 1 ? ` · round ${a.round}` : ""}</div>
        <h1 class="h1" style="margin-top: 4px;">${a.project.title || "(untitled)"}</h1>
        <div class="sub">${headline(view)}</div>
      </div>
      <div class="big-amt" style="margin-left: auto;">${money(view.totalUsd)}</div>
    </div>
    <div class="chips" style="margin-top: 14px;">
      ${a.kind === "supplemental" && a.supplementalOf ? tag(`Supplemental to order ${a.supplementalOf.ioNumber}${a.supplementalOf.approvedTotalUsd ? ` · ${money(a.supplementalOf.approvedTotalUsd)} already approved` : ""}`, "yellow", { icon: "plus" }) : ""}
      ${(a.ioNumbers || []).length > 1 ? tag(`${a.ioNumbers.length} internal orders`, "blue", { icon: "doc" }) : ""}
      ${view.band ? tag(view.band.label, "blue") : ""}
      ${env ? tag(env.provider === "simulated" ? "SIMULATED envelope" : "DocuSign envelope · " + env.status, env.provider === "simulated" ? "yellow" : "grey", { icon: "pen" }) : ""}
      ${a.budget && a.budget.budgeted ? tag(a.budget.budgeted === "Yes" ? "Budgeted" : "Unbudgeted", a.budget.budgeted === "Yes" ? "" : "yellow") : ""}
    </div>

    ${a.state === "returned" && a.returnedTo ? html`<div class="banner red" style="margin-top: 18px;">${icon("back", 16)}<span><b>${a.returnedTo.byName}</b>: “${a.returnedTo.reason}”${a.returnedTo.step ? ` — reopens at ${stepName(a.returnedTo.step)}` : ""}.${view.resume && view.resume.applies ? html`<span style="display: block; margin-top: 8px;">${roundLine(view.resume)}</span>` : ""}</span></div>` : ""}
    ${a.state === "on_hold" && open.length ? html`<div class="banner yellow" style="margin-top: 18px;">${icon("question", 16)}<span><b>${open[0].byName}</b> asks: “${open[0].text}”</span></div>` : ""}
    ${askedOfMe(view) ? html`<div class="banner yellow" style="margin-top: 18px;" data-key="asked">${icon("question", 16)}<span><b>${askedOfMe(view).byName}</b> asked: “${askedOfMe(view).text}” <a href="#compose" data-jump-compose>Answer it below</a></span></div>` : ""}

    ${a.state !== "draft" ? rail(view) : ""}

    <div class="foot acts" style="margin-top: 30px; justify-content: flex-start;">
      ${perms.canEdit && a.state === "draft" ? html`<a class="cta" href="/afe/${a.id}/edit/resume">Continue${icon("chevR", 16, { stroke: 2.2 })}</a>` : ""}
      ${perms.canEdit && a.state === "returned" ? html`<a class="cta" href="/afe/${a.id}/edit/${fixStep}">Fix and resubmit${icon("chevR", 16, { stroke: 2.2 })}</a>` : ""}
      ${perms.canAnswer ? html`<a class="cta" href="#compose" data-jump-compose>${icon("question", 16)}Answer ${open.length && open[0].byName ? open[0].byName.split(" ")[0] : ""}</a>` : ""}
      ${perms.canSign || perms.canQuestion ? html`<a class="cta" href="/approve/${a.id}">It's yours to sign${icon("chevR", 16, { stroke: 2.2 })}</a>` : ""}
      ${perms.canCoordinate && ["draft", "submitted", "returned", "in_approval", "on_hold"].includes(a.state) ? html`<a class="cta ${perms.canEdit && a.state !== "submitted" ? "sec" : ""}" href="/afe/${a.id}/coordinate">${a.state === "submitted" ? "Review and send" : "Open the routing"}${icon("chevR", 16, { stroke: 2.2 })}</a>` : ""}
      ${perms.canWithdraw && a.state !== "draft" ? html`<button class="cta quiet" id="withdraw">Withdraw</button>` : ""}
      ${perms.canWithdraw && a.state === "draft" ? html`<button class="cta quiet" id="delete-draft">Delete this draft</button>` : ""}
      ${["issued", "tracking", "capitalized"].includes(a.state) && a.afeNo ? html`<a class="cta" href="/io/${a.afeNo}">Open the project ${icon("chevR", 16, { stroke: 2.2 })}</a>` : ""}
      ${["issued", "tracking", "capitalized"].includes(a.state) && (perms.isRequester || perms.isPreparer || perms.isCoordinator) ? html`<a class="cta sec" href="/afe/${a.id}/supplemental">Need more? Raise a supplemental</a>` : ""}
    </div>

    <div class="split" style="margin-top: 30px;">
      <div style="display: flex; flex-direction: column; gap: 14px;">
        <div class="card pad soft">
          <div class="sect">WHY</div>
          <div style="font-size: 13px; line-height: 1.55; margin-top: 8px;">${a.project.description || html`<span class="muted">No description yet.</span>`}</div>
          ${a.project.justification ? html`<div style="font-size: 13px; line-height: 1.55; margin-top: 10px; color: var(--ink-2);">${a.project.justification}</div>` : ""}
          <div class="small muted" style="margin-top: 10px;">${a.schedule.startDate ? `${date(a.schedule.startDate)} → ${date(a.schedule.finishDate)}` : ""}${a.location ? " · " + a.location : ""}</div>
        </div>
        ${signers.length ? html`<div class="card" style="overflow: hidden;">
          <div class="tabhd" style="border-top: 0; display: flex; justify-content: space-between; align-items: center;"><span>WHO SIGNS</span>${view.routingBrief ? progress(view.routingBrief.signed, view.routingBrief.of) : ""}</div>
          ${chainRows(view, signers)}
        </div>` : ""}
        ${thread(a.thread, { answer: perms.answerTo, canComment: perms.canComment, canAsk: perms.canAsk, askWho: perms.askWho, asks: view.asks, sides: session.refdata && session.refdata.threadSides })}
        ${historyCard()}
      </div>
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${issuedPackCard(a, docs)}
        <div class="card" style="overflow: hidden;">
          <div class="tabhd" style="border-top: 0;">THE DOCUMENTS</div>
          ${theAfeRow(view)}
          ${ownDocuments(a).map((d) => docRow(d, a.id))}
        </div>
        ${a.approverNote ? html`<div class="card pad soft"><div class="sect">NOTE TO APPROVERS</div><div style="margin-top: 8px; font-size: 13px;">${a.approverNote}</div></div>` : ""}
        ${a.coordinator ? html`<div class="small muted" style="padding: 0 4px;">${a.coordinator.name} coordinates ${a.division || "this division"}'s AFEs. ${a.state === "draft" ? "It goes to them when you submit." : ""}</div>` : ""}
      </div>
    </div>
  </div>`;
}

async function load() {
  // Read beside the record, not before it, and allowed to fail on its own: the history is the one
  // panel the page can do without.
  const [view, history] = await Promise.all([
    api.get(`/api/afes/${S.id}`),
    api.get(`/api/afes/${S.id}/history`).catch(() => null),
  ]);
  S.view = view;
  S.history = history;
}

export async function render(root, ctx) {
  S.id = ctx.params.id;
  S.root = root;
  try { await load(); } catch (e) { showError(e); await navigate("/requests", { replace: true }); return; }
  // "Ideally, approval should land into this page" (Shashank, Meeting #6, 19:24). The person the
  // envelope is WITH opens the AFE on the page where they act on it, however they got here: a
  // link in a mail, a row in a list, or switching to them in the demo. Every mail an approver is
  // sent already links there; this is the one road that did not (R154).
  const p = S.view.permissions || {};
  if (p.isCurrentRecipient && ["in_approval", "on_hold"].includes(S.view.afe.state)) {
    await navigate(`/approve/${S.id}`, { replace: true });
    return;
  }
  // The same for the second pair of eyes: a checker who may close it lands where Close is. The
  // "To close" mail linked here, and this page offers no Close.
  if (p.canClose && S.view.afe.state === "capitalized") {
    await navigate(`/fa/${S.id}/issue`, { replace: true });
    return;
  }
  setRecord({ id: S.id, title: S.view.afe.project.title });
  if (!root.dataset.status) { root.innerHTML = ""; root.dataset.status = "1"; }
  morph(root, markup());
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "click", "[data-thread-post]", async (e, b) => { if (await postComment(S.id, root, b)) { await load(); morph(root, markup()); } });
  on(root, "click", "[data-jump-compose]", (e) => { e.preventDefault(); const box = $("[data-thread-text]", root); if (box) { box.scrollIntoView({ block: "center" }); box.focus(); } });
  on(root, "click", "#delete-draft", async () => {
    const a = S.view.afe;
    const r = await sheet({
      eyebrow: "DELETE THIS DRAFT", title: a.project.title ? `Delete "${a.project.title}"?` : "Delete this untitled draft?",
      sub: "It has not been sent, so nobody has seen it and nothing has been signed. This cannot be undone.",
      actions: [{ label: "Keep it", value: null, tone: "sec" }, { label: "Delete the draft", value: "yes", tone: "dark", primary: true }],
    });
    if (r.value !== "yes") return;
    try { await api.del(`/api/afes/${S.id}`); store.bust("/api/afes"); toast("Draft deleted.", "ok"); await navigate("/requests", { replace: true }); }
    catch (e) { showError(e); }
  });
  on(root, "click", "#withdraw", async () => {
    const a = S.view.afe;
    const text = await askText({ eyebrow: a.state === "draft" ? "DISCARD" : "WITHDRAW", title: a.state === "draft" ? "Discard this draft?" : "Withdraw this AFE?", sub: a.state === "draft" ? "It disappears from your requests. Nothing was sent." : "Any signatures so far are void. Approvers who have it are told.", placeholder: "Why? (optional)", required: false, action: a.state === "draft" ? "Discard" : "Withdraw", tone: "dark" });
    if (text === null) return;
    try { await api.post(`/api/afes/${S.id}/withdraw`, { reason: text }); store.bust("/api/afes"); toast(a.state === "draft" ? "Draft discarded." : "Withdrawn.", "ok"); await navigate("/requests"); }
    catch (e) { showError(e); }
  });
}

export function unmount() { if (S.root) { delete S.root.dataset.status; S.root.innerHTML = ""; } }
