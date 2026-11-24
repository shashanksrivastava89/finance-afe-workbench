// What the three Fixed Assets screens share: the identity line, the chips, a red-flag row,
// "Show me" (design rule 5 — never assert without showing), and the small badges.
import { html, $ } from "../../core/dom.js";
import { icon } from "../../core/icons.js";
import { money, since, ago, pct, plural, date, stateLabel } from "../../core/format.js";
import { tag, subnav } from "../../components/parts.js";
import { sheet } from "../../core/ui.js";
import { navigate } from "../../core/router.js";
import { session } from "../../core/session.js";

export const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "";
export const LEVEL_TITLE = { M1: "Cost-centre owner", A1: "Level 1", A2: "Level 2", A3: "Level 3", A4: "Level 4", A5: "Level 5", A6: "Level 6", A7: "Level 7", A8: "Level 8", A9: "Level 9" };

/** Requester · division · cost centre · with you N days — the line under the breadcrumb. */
export function identityLine(view) {
  const a = view.afe;
  const bits = [];
  if (a.requester) bits.push(a.requester.name);
  if (a.division) bits.push(a.division);
  if (a.costCenter) bits.push("cost centre " + a.costCenter);
  if (view.receivedAt && a.state === "fa_review") bits.push("with you " + (ago(view.receivedAt) === "just now" ? "since just now" : ago(view.receivedAt)));
  if (a.round > 1) bits.push(`round ${a.round}`);
  return bits.join(" · ");
}

/** Who priced it: the first priced document with a vendor on it, a Acme quotation included (R150). */
const quoteVendor = (view) => {
  const roles = (session.refdata && session.refdata.quoteRoles) || ["quote", "sow", "internal_quote"];
  const d = (view.afe.documents || []).find((x) => roles.includes(x.role) && x.vendor);
  return d ? d.vendor : "";
};
export function chipsFor(view) {
  const a = view.afe, m = a.money || {}, b = a.budget || {};
  const cls = { capex: "CapEx", cloud_capex: "Cloud CapEx", none: "OpEx only" }[m.classification] || "unclassified";
  const t = view.totalUsd, q = view.quoteTotalUsd, cov = t ? pct(q, t) : null;
  return html`
    ${tag(`${cls}${b.budgeted ? " · " + (b.budgeted === "Yes" ? "budgeted" : "unbudgeted") : ""}`, "blue")}
    ${view.pot ? tag(`${view.pot.budgetCategory} · ${view.pot.region} · FY${view.pot.fiscalYear}`, "grey")
      : b.otherBudget && (!b.potId || b.potId === "other") ? tag(`Budget: ${b.otherBudget}`, "grey") : ""}
    ${view.band ? tag(`${view.band.label} · ${(view.band.levels || []).filter((l) => l !== "BOARD").join(" ")}`, "blue") : ""}
    ${cov !== null && q ? tag(`Quoted ${money(q)} of ${money(t)} (${cov}%)`, cov >= Math.round(((session.refdata && session.refdata.quoteCoverageMin) || 0.7) * 100) ? "" : "yellow", { icon: "doc" }) : tag("No quote total", "yellow")}
    ${view.validation && view.validation.applies && view.validation.applies.sourcing && view.afe.sourcing === "internal" ? tag("From Acme inventory", "blue", { icon: "box" }) : ""}
    ${view.cloud && view.cloud.outcome && view.cloud.outcome !== "not_applicable" ? tag(`Cloud CapEx tree: ${view.cloud.outcome.replace(/_/g, " ")}`, view.cloud.fpaReviewRequired ? "yellow" : "grey") : ""}
    ${view.envelope ? tag(view.envelope.provider === "simulated" ? "SIMULATED envelope" : `DocuSign · ${view.envelope.status}`, view.envelope.provider === "simulated" ? "yellow" : "grey", { icon: "pen" }) : ""}
    ${a.state !== "fa_review" ? tag(stateLabel(a.state), "grey") : ""}`;
}

export function verifiedBadge(row) {
  if (!row) return html`<span class="vbadge soft">not on the envelope</span>`;
  if (row.st === "ok") return html`<span class="vbadge">${icon("tick", 14, { stroke: 2.4 })}verified</span>`;
  return html`<span class="vbadge bad">${icon("bang", 14, { stroke: 2.2 })}${row.st}</span>`;
}

/** One red flag. `opts.actions` is the markup for the right column (buttons). */
export function flagRow(f, opts) {
  const o = opts || {};
  const cls = f.cleared ? "ok" : f.severity === "block" ? "bad" : "warn";
  const ic = f.cleared ? "tick" : f.severity === "block" ? "bang" : "clock";
  return html`<div class="flag ${f.cleared ? "cleared" : ""}" data-key="${f.id}" data-flag="${f.id}">
    <span class="tick lg ${cls}">${icon(ic, 15, { stroke: 2.3 })}</span>
    <div style="min-width: 0;">
      <div class="t">${f.title}</div>
      <div class="d">${f.detail || ""}</div>
      ${f.cleared ? html`<div class="d" style="color: var(--link); font-weight: 700; margin-top: 6px;">${f.clearedBy ? html`Cleared with evidence by ${f.clearedBy.byName} ${since(f.clearedBy.at)}${f.clearedBy.note ? ` — “${f.clearedBy.note}”` : ""}` : f.ack ? html`Acknowledged by ${f.ack.byName} ${since(f.ack.at)} — “${f.ack.note}”` : "Cleared"}</div>` : ""}
    </div>
    <div class="acts">${o.actions !== undefined ? o.actions : ""}</div>
  </div>`;
}

/** Whether a flag has anything behind it to show (design rule 5) — no button where there is nothing. */
export const canShow = (t) => Boolean(t && ["documents", "form", "matrix", "chain", "afe"].includes(t.kind));

/**
 * Design rule 5 — the source behind a claim, opened in place.
 * `opts.openTile(key)` lets the judge screen open the tile a target lives on first: the signer
 * rows a segregation-of-duties flag points at are on the signatures tile, so from the flags tile
 * "Show me" found nothing and said "Nothing to open for this one" (2026-10-16).
 */
export async function showMe(view, target, opts) {
  const a = view.afe;
  const t = target || {};
  const o = opts || {};
  const doc = (role) => (a.documents || []).filter((d) => d.role === role).slice(-1)[0] || null;
  if (t.kind === "documents") {
    // A role that is not on the AFE opens the AFE itself — `document.pdf`, the one document
    // (R156) — rather than whichever generation of it happened to be stored.
    const d = doc(t.role);
    const url = d ? `/api/afes/${a.id}/documents/${d.attachmentId}/raw${t.page ? "#page=" + t.page : ""}` : `/api/afes/${a.id}/document.pdf`;
    return sheet({ eyebrow: "SHOW ME", title: d ? d.filename : "AFE Form", sub: d ? { quote: "The quote the requester attached.", envelope_pdf: "The signed set — each signature on its own row.", certificate: "DocuSign's Certificate of Completion, stored as evidence. The verdict comes from the recipient data, not from this page.", afe_form_pdf: "The form as it was sent for signature." }[d.role] || "" : "",
      wide: true,
      body: html`<iframe class="pdf-frame" src="${url}" title="${d ? d.filename : "the AFE"}"></iframe>`, actions: [{ label: "Close", value: null, tone: "sec" }] });
  }
  if (t.kind === "form") {
    // The field by the words on the screen, and the step by its name — "Field: budget.budgeted
    // (wizard step 3)" was the data model talking.
    const spec = ((session.refdata && session.refdata.fields) || []).find((f) => f.id === t.field);
    const step = ((session.refdata && session.refdata.wizardSteps) || []).find((x) => x.n === t.step);
    const where = [spec ? spec.label : null, step ? `on the ${step.label} step` : null].filter(Boolean).join(" — ");
    return sheet({ eyebrow: "SHOW ME", title: "The form as it stands now", sub: where,
      wide: true,
      body: html`<iframe class="pdf-frame" src="/api/afes/${a.id}/document.pdf" title="The AFE"></iframe>`, actions: [{ label: "Close", value: null, tone: "sec" }] });
  }
  if (t.kind === "matrix") {
    const m = view.matrix || {};
    const levels = (m.levels || []).filter((l) => l !== "BOARD");
    return sheet({ eyebrow: "SHOW ME · SAP APPROVER MATRIX", title: `Cost centre ${a.costCenter}`,
      sub: m.batchChanged ? `Batch ${m.sentBatchId} when sent → ${m.currentBatchId} now.` : `Batch ${m.currentBatchId || "?"} — unchanged since send.`,
      body: html`<table class="mtx"><thead><tr><th>LEVEL</th><th>WHEN SENT</th><th>NOW</th></tr></thead><tbody>
        ${levels.map((l) => { const was = m.then && m.then[l] ? m.then[l].name : ""; const now = m.now && m.now[l] ? m.now[l].name : ""; const changed = norm(was) !== norm(now); return html`<tr class="${changed ? "changed" : ""} ${l === t.level ? "ring" : ""}" data-key="${l}"><td><b>${l}</b> <span class="muted small">${LEVEL_TITLE[l] || ""}</span></td><td>${was || html`<span class="muted">—</span>`}</td><td>${now || html`<span class="muted">— (blank)</span>`}${changed ? html` <span class="vbadge bad">changed</span>` : ""}</td></tr>`; })}
      </tbody></table>
      <div class="small muted" style="margin-top: 12px;">The chain was frozen at send from the batch on the left. A change on the right does not alter the chain — it raises a red flag here, cleared with the new approver's email approval.</div>`,
      actions: [{ label: "Close", value: null, tone: "sec" }] });
  }
  if (t.kind === "chain" && t.recipientId) {
    let el = $(`[data-rid="${t.recipientId}"]`);
    if (!el && o.openTile) { o.openTile("signatures"); el = $(`[data-rid="${t.recipientId}"]`); }
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); el.classList.add("ring"); setTimeout(() => el.classList.remove("ring"), 1800); return; }
  }
  if (t.kind === "afe" && t.afeId) return navigate(`/afe/${t.afeId}`);
  return sheet({ eyebrow: "SHOW ME", title: "Nothing to open for this one", sub: "The claim comes from the AFE's own data.", actions: [{ label: "Close", value: null, tone: "sec" }] });
}
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");

export function summaryLine(view) {
  const s = view.redFlags.summary;
  const v = view.envelope && view.envelope.completed ? view.envelope.completed.verification || [] : [];
  const ok = v.filter((x) => x.st === "ok").length;
  return `${view.afe.approvedAt ? "Fully signed " + since(view.afe.approvedAt) : "Not fully signed"}${view.envelope ? " · " + (view.envelope.provider === "simulated" ? "SIMULATED envelope" : "DocuSign envelope") : ""} · ${ok} of ${v.length} ${plural(v.length, "signature")} checked against the chain frozen at send${s.openBlocks ? ` · ${s.openBlocks} red ${plural(s.openBlocks, "flag")}` : ""}.`;
}

export { money, since, ago, date, plural };

/**
 * The three views of Fixed Assets, and which one you are in.
 *
 * This was a row of `<a href>` route links wearing `.chipnav` — the application's OWN top-level
 * section nav — with `class="on"` hardcoded on the first one and the strip rendered on no
 * destination at all. So it looked like a tab set, behaved like a departure, and vanished the
 * moment you used it. "Projects" was in it too, which is a different section entirely: clicking
 * it moved the top-bar highlight off Fixed Assets, so one of the four tabs left the building.
 *
 * Now every screen in the family renders the same strip, the active item is computed from the
 * route, and Projects is where it belongs — in the top nav, with its own hue.
 */
export function faNav(active) {
  return subnav([
    // The whole queue — it was labelled "To check", which is one of its five buckets.
    { key: "queue", label: "Queue", href: "/fa", icon: "search" },
    { key: "tracker", label: "Tracker", href: "/tracker", icon: "box" },
    { key: "review", label: "Quarterly review", href: "/auc-review", icon: "calendar" },
  ], active);
}
