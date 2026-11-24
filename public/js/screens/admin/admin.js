// /admin — everything the tool decides with: routing rules, budget pots, mailboxes, people,
// extracts and jobs. Configuration, not code, and every change audited with who made it.
//
// The page leads with what changed and who changed it, because that is what an auditor asks
// first. Tabs, because these are six unrelated lists rather than one story.
import { html, morph, on, $ } from "../../core/dom.js";
import { api, fileToBase64 } from "../../core/api.js";
import { store, uiFor } from "../../core/store.js";
import { session } from "../../core/session.js";
import { icon } from "../../core/icons.js";
import { money, moneyCompact, since, date, plural } from "../../core/format.js";
import { tag, avatar, emptyState, tip } from "../../components/parts.js";
import { sheet, askText, toast, busy, showError, opening, loadFailed } from "../../core/ui.js";
import { mastersTab, featuresTab, loadMasters, wireMasters } from "./masters.js";

const ui = uiFor("admin");
const S = { root: null, wiredTo: null, rules: [], pots: [], directory: [], users: [], roles: [], extracts: null, jobs: null, audit: [] };
const TABS = [["masters", "Master data"], ["features", "Features"], ["rules", "Org rules"],
  ["pots", "Pots"], ["directory", "Directory"], ["people", "People"], ["extracts", "Extracts"], ["jobs", "Jobs"]];
const KIND_LABEL = { pre_approver: "pre-approver", override: "override", additional: "additional signer", controllership: "controllership", cc: "receives a copy", coordinator: "coordinator" };

async function load() {
  const [rules, pots, directory, users, extracts, jobs, audit, roles] = await Promise.all([
    api.get("/api/admin/org-rules"), api.get("/api/admin/budget-pots"), api.get("/api/admin/directory"),
    api.get("/api/admin/users"), api.get("/api/admin/extracts"), api.get("/api/admin/jobs"), api.get("/api/admin/audit"),
    api.get("/api/admin/roles").catch(() => []),
  ]);
  Object.assign(S, { rules, pots, directory, users, extracts, jobs, audit, roles });
  await loadMasters(S);
}
function paint() { if (S.root) morph(S.root, markup()); }
const tab = () => ui.tab || "masters";

// ---- org rules ----------------------------------------------------------------------------------
function scopeOf(r) {
  const s = r.scope || {};
  if (s.division) return `division ${s.division}`;
  if (s.costCenter) return `cost centre ${s.costCenter}`;
  if (s.ownerName) return `owner ${s.ownerName}`;
  if (s.projectType) return `type ${s.projectType}`;
  return "every division";
}
function rulesTab() {
  const active = S.rules.filter((r) => r.active !== false && !r.retiredAt);
  return html`<div class="card" style="overflow: hidden;" data-key="rules">
    <div class="tabhd" style="border-top: 0; display: flex; justify-content: space-between; align-items: center;">
      <span>ROUTING RULES THE SAP MATRIX DOES NOT CARRY · ${active.length} ACTIVE ${tip("Retiring a rule never touches an AFE already sent: that chain was frozen when it went out. A change shows on the next preview.")}</span>
      <button type="button" class="pillbtn sm dark" id="add-rule">+ Add a rule</button>
    </div>
    ${active.length ? active.map((r) => html`<div class="rule" data-key="${r.id}">
      ${avatar(r.person ? r.person.name : r.kind, r.kind === "coordinator" ? "blue" : r.kind === "override" ? "dark" : r.kind === "cc" ? "gold" : "", "")}
      <span style="min-width: 0;">
        <span class="nm">${r.person ? r.person.name : "(no person)"} <span class="role">· ${KIND_LABEL[r.kind] || r.kind}${r.group ? " · " + r.group : ""}</span></span>
        <span class="why">${r.person && r.person.email ? r.person.email : "no mailbox on the rule — the coordinator confirms one before sending"}${r.note ? ` — ${r.note}` : ""}</span>
      </span>
      <span class="tagcol">${tag(scopeOf(r), "blue")}</span>
      <span style="display: flex; gap: 6px; justify-content: flex-end;">
        <button type="button" class="pillbtn sm soft" data-edit-rule="${r.id}">Edit</button>
        <button type="button" class="pillbtn sm soft" data-retire-rule="${r.id}">Retire</button>
      </span>
    </div>`) : emptyState("No rules — every chain would come straight from the SAP matrix.")}
  </div>`;
}
async function ruleSheet(existing) {
  const kinds = Object.entries(KIND_LABEL);
  const r = await sheet({
    eyebrow: existing ? "EDIT THE RULE" : "ADD A RULE", title: existing ? existing.person.name : "Who, and when do they join the chain?",
    sub: "The matrix is the minimum chain. These are the additions Acme's own process makes.",
    body: html`<div class="sect">KIND</div>
      <div class="chips" style="margin-top: 8px;">${kinds.map(([k, l]) => html`<button type="button" class="chip sm ${(existing ? existing.kind : "") === k ? "on" : ""}" data-kind="${k}">${l}</button>`)}</div>
      <input class="input" id="r-name" placeholder="Full name, as on the matrix" value="${existing && existing.person ? existing.person.name : ""}" style="margin-top: 14px;" autocomplete="off">
      <input class="input" id="r-email" placeholder="first_last@example.com" value="${existing && existing.person ? existing.person.email || "" : ""}" style="margin-top: 10px;" autocomplete="off">
      <div class="sect" style="margin-top: 16px;">WHEN IT APPLIES</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 8px;">
        <input class="input" id="r-division" placeholder="Division, e.g. CORP_IT" value="${existing && existing.scope ? existing.scope.division || "" : ""}" autocomplete="off">
        <input class="input" id="r-cc" placeholder="Cost centre" value="${existing && existing.scope ? existing.scope.costCenter || "" : ""}" autocomplete="off">
        <input class="input" id="r-owner" placeholder="Cost-centre owner's name" value="${existing && existing.scope ? existing.scope.ownerName || "" : ""}" autocomplete="off">
        <input class="input" id="r-group" placeholder="Group label printed on the form" value="${existing ? existing.group || "" : ""}" autocomplete="off">
      </div>
      <textarea class="input" id="r-note" rows="2" placeholder="Why this rule exists — it is shown to the coordinator" style="margin-top: 12px;">${existing ? existing.note || "" : ""}</textarea>`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: existing ? "Save" : "Add the rule", value: "ok", primary: true }],
    validate: (el) => { if (!$(".chip.on[data-kind]", el)) return "Pick the kind."; if (!$("#r-name", el).value.trim()) return "A name is required."; return null; },
    collect: (el) => ({
      kind: ($(".chip.on[data-kind]", el) || { dataset: {} }).dataset.kind,
      person: { name: $("#r-name", el).value.trim(), email: $("#r-email", el).value.trim() || null },
      scope: { division: $("#r-division", el).value.trim(), costCenter: $("#r-cc", el).value.trim(), ownerName: $("#r-owner", el).value.trim() },
      group: $("#r-group", el).value.trim(), note: $("#r-note", el).value.trim(),
      placement: ($(".chip.on[data-kind]", el) || { dataset: {} }).dataset.kind === "pre_approver" ? "project_approvals" : "after_matrix",
    }),
    onMount: (el) => on(el, "click", "[data-kind]", (e, b) => { for (const x of el.querySelectorAll("[data-kind]")) x.classList.toggle("on", x === b); }),
  });
  if (r.value !== "ok") return;
  try {
    if (existing) await api.put(`/api/admin/org-rules/${existing.id}`, r.data);
    else await api.post("/api/admin/org-rules", r.data);
    store.bust("/api"); toast(existing ? "Rule saved." : "Rule added.", "ok");
    await load(); paint();
  } catch (e) { showError(e); }
}

// ---- pots ----------------------------------------------------------------------------------------
function potsTab() {
  const byYear = {};
  for (const p of S.pots) (byYear[p.fiscalYear] = byYear[p.fiscalYear] || []).push(p);
  const years = Object.keys(byYear).sort().reverse();
  return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="pots">
    ${years.map((y) => html`<div class="card" style="overflow: hidden;" data-key="y${y}">
      <div class="tabhd" style="border-top: 0; display: flex; justify-content: space-between; align-items: center;">
        <span>FY${y} · ${moneyCompact(byYear[y].reduce((n, p) => n + p.amountUsd, 0))} ACROSS ${byYear[y].length} ${plural(byYear[y].length, "POT")} ${tip("Amounts are the division's to load. The pots screen shows what the AFEs have spoken for against them.")}</span>
        <button type="button" class="pillbtn sm dark" data-add-pot="${y}">+ Add a pot</button>
      </div>
      ${byYear[y].map((p) => html`<div class="korow" data-key="${p.id}">
        <span class="tick off">${icon("doc", 14)}</span>
        <span class="fv"><span class="f">${p.division} · ${p.region}</span><span class="v">${money(p.amountUsd)}<span class="note">${p.budgetCategory}${p.note ? ` · ${p.note}` : ""}</span></span></span>
        <button type="button" class="pillbtn sm soft" data-edit-pot="${p.id}">Edit</button>
      </div>`)}
    </div>`)}
  </div>`;
}
async function potSheet(existing, fiscalYear) {
  const r = await sheet({
    eyebrow: existing ? "EDIT THE POT" : "ADD A POT", title: existing ? `${existing.division} · ${existing.budgetCategory} · ${existing.region}` : "Which budget, and how much?",
    sub: "One pot per division, category and region, per fiscal year.",
    body: existing
      ? html`<input class="input" id="p-amount" inputmode="decimal" value="${existing.amountUsd}" style="height: 56px; font-size: 16px; font-weight: 700;" autocomplete="off">
             <input class="input" id="p-note" placeholder="Note (optional)" value="${existing.note || ""}" style="margin-top: 10px;" autocomplete="off">`
      : html`<div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
             <input class="input" id="p-division" placeholder="Division, e.g. CORP_IT" autocomplete="off">
             <input class="input" id="p-year" inputmode="numeric" placeholder="Fiscal year" value="${fiscalYear || new Date().getFullYear()}" autocomplete="off">
             <input class="input" id="p-cat" placeholder="Budget category, e.g. Life Cycle Refresh" autocomplete="off">
             <input class="input" id="p-region" placeholder="Region, e.g. APAC" autocomplete="off">
           </div>
           <input class="input" id="p-amount" inputmode="decimal" placeholder="Amount in USD" style="margin-top: 10px; height: 56px; font-size: 16px; font-weight: 700;" autocomplete="off">`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: existing ? "Save" : "Add the pot", value: "ok", primary: true }],
    validate: (el) => {
      if (!(Number(String($("#p-amount", el).value).replace(/[^0-9.]/g, "")) >= 0)) return "How much?";
      if (!existing && (!$("#p-division", el).value.trim() || !$("#p-cat", el).value.trim() || !$("#p-region", el).value.trim())) return "Division, category and region, please.";
      return null;
    },
    collect: (el) => existing
      ? { amountUsd: Number(String($("#p-amount", el).value).replace(/[^0-9.]/g, "")), note: $("#p-note", el).value.trim() }
      : { division: $("#p-division", el).value.trim(), fiscalYear: Number($("#p-year", el).value), budgetCategory: $("#p-cat", el).value.trim(),
          region: $("#p-region", el).value.trim(), amountUsd: Number(String($("#p-amount", el).value).replace(/[^0-9.]/g, "")) },
  });
  if (r.value !== "ok") return;
  try {
    if (existing) await api.put(`/api/admin/budget-pots/${existing.id}`, r.data);
    else await api.post("/api/admin/budget-pots", r.data);
    store.bust("/api"); toast("Saved.", "ok");
    await load(); paint();
  } catch (e) { showError(e); }
}

// ---- directory ------------------------------------------------------------------------------------
function directoryTab() {
  const rows = S.directory.slice().sort((a, b) => String(a.matrixName || "").localeCompare(String(b.matrixName || "")));
  return html`<div class="card" style="overflow: hidden;" data-key="dir">
    <div class="tabhd" style="border-top: 0; display: flex; justify-content: space-between; align-items: center;">
      <span>NAME → MAILBOX · ${rows.length} ${plural(rows.length, "ENTRY", "ENTRIES")} ${tip("The tool guesses First_Last@example.com and never sends on a guess. A coordinator confirming one on the routing screen writes it here.")}</span>
      <button type="button" class="pillbtn sm dark" id="add-dir">+ Add one</button>
    </div>
    ${rows.length ? rows.map((d) => html`<div class="korow" data-key="${d.id}">
      <span class="tick ${d.source === "confirmed" ? "ok" : "off"}">${d.source === "confirmed" ? icon("tick", 14, { stroke: 2.4 }) : icon("mail", 14)}</span>
      <span class="fv"><span class="f">${d.matrixName || d.displayName}</span><span class="v">${d.email}<span class="note">${d.source}${d.confirmedByEmail ? ` by ${nameOf(d.confirmedByEmail)}` : ""}${d.learnedFromAfeId ? ` · learned on ${d.learnedFromAfeId}` : ""}${d.note ? ` · ${d.note}` : ""}</span></span></span>
      <button type="button" class="pillbtn sm soft" data-edit-dir="${d.id}">Change</button>
    </div>`) : emptyState("Nothing learned yet — a coordinator confirming a mailbox on a routing screen fills this in.")}
  </div>`;
}

// ---- people ---------------------------------------------------------------------------------------
const roleLabel = (r) => ((S.roles || []).find((x) => x.name === r) || {}).label || r.replace(/_/g, " ");
/**
 * What a person may do, changed here (2026-10-16). The tab said "Roles are edited through the API",
 * so onboarding somebody to Fixed Assets was a dead end on the one screen built for it. The sheet
 * is the confirmation; the change is checked and audited by the server.
 */
async function changeRoles(id) {
  const u = S.users.find((x) => x.id === id);
  if (!u) return;
  const has = new Set(u.roles || []);
  const r = await sheet({
    eyebrow: "WHAT THEY MAY DO", title: u.displayName, sub: `${u.email} — everyone signed in can raise an AFE; these are what an administrator adds.`,
    body: html`<div style="display: flex; flex-direction: column; gap: 8px;">${(S.roles || []).map((x) => html`<label class="row" style="display: flex; gap: 10px; align-items: flex-start; padding: 8px 4px;" data-key="${x.name}">
      <input type="checkbox" data-role="${x.name}" ${has.has(x.name) ? "checked" : ""} style="margin-top: 3px;">
      <span><b>${x.label}</b><span class="small muted" style="display: block;">${x.description}</span></span></label>`)}</div>`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Save", value: "ok", primary: true }],
    collect: (el) => ({ roles: Array.from(el.querySelectorAll("[data-role]")).filter((i) => i.checked).map((i) => i.dataset.role) }),
    run: (value, data) => api.put(`/api/admin/users/${id}`, data),
  });
  if (r.value !== "ok") return;
  toast(`${u.displayName}: ${(r.result.roles || []).map(roleLabel).join(", ") || "raises AFEs only"}.`, "ok");
  store.bust("/api"); await load(); paint();
}
function peopleTab() {
  const rows = S.users.slice().sort((a, b) => String(a.displayName).localeCompare(String(b.displayName)));
  return html`<div class="card" style="overflow: hidden;" data-key="people">
    <div class="tabhd" style="border-top: 0;">PEOPLE AND WHAT THEY MAY DO · ${rows.length}</div>
    ${rows.map((u) => html`<div class="signer" data-key="${u.id}">
      <span class="num ${u.active === false ? "off" : "done"}">${(u.roles || []).length}</span>
      ${avatar(u.displayName, (u.roles || []).includes("coordinator") ? "blue" : (u.roles || []).some((r) => r.startsWith("fa_")) ? "gold" : "", "lg")}
      <span style="min-width: 0;"><span class="nm">${u.displayName}${u.active === false ? html` <span class="role">· inactive</span>` : ""}</span>
        <span class="why" style="display: block;">${u.email}${u.title ? ` · ${u.title}` : ""}${(u.coordinatorFor || []).length ? ` · coordinates ${u.coordinatorFor.join(", ")}` : ""}${(u.matrixNames || []).length ? ` · matrix name ${u.matrixNames.join(", ")}` : ""}</span></span>
      <span class="tagcol" style="display: flex; gap: 6px; flex-wrap: wrap;">${(u.roles || []).map((r) => tag(roleLabel(r), r === "admin" ? "red" : "grey"))}</span>
      <button type="button" class="pillbtn sm soft" data-roles="${u.id}">Change</button>
    </div>`)}
  </div>`;
}

// ---- extracts -------------------------------------------------------------------------------------
const BATCH_STATUS = { active: "in use", superseded: "replaced by a newer one", failed: "refused", loading: "loading" };
function extractsTab() {
  const st = S.extracts.status;
  return html`<div style="display: flex; flex-direction: column; gap: 14px;" data-key="extracts">
    <div class="card" style="overflow: hidden;">
      <div class="tabhd" style="border-top: 0;">SAP EXTRACTS</div>
      ${st.map((x) => html`<div class="korow" data-key="${x.kind}">
        <span class="tick ${!x.batchId ? "bad" : x.stale ? "warn" : "ok"}">${!x.batchId ? icon("bang", 14) : x.stale ? icon("clock", 14) : icon("tick", 14, { stroke: 2.4 })}</span>
        <span class="fv"><span class="f">${(S.extracts.kinds.find((k) => k.kind === x.kind) || {}).label || x.kind}</span>
          <span class="v">${x.batchId ? `Report of ${date(x.asOfDate || x.importedAt)}` : "never loaded"}<span class="note">${x.batchId ? `${x.batchId} · ` : ""}${x.rowCount ? `${x.rowCount.toLocaleString("en-US")} rows · ` : ""}${x.importedAt ? `loaded ${since(x.importedAt)}${x.stale ? ` · stale (over 8 days)` : ""}` : "the scheduled transfer has not started"}${x.source ? ` · ${x.source}` : ""}</span></span></span>
        <label class="pillbtn sm ${x.batchId ? "" : "dark"}" style="cursor: pointer;">${x.batchId ? "Replace" : "Upload"}<input type="file" data-upload="${x.kind}" style="display: none;" accept=".txt,.csv,.tsv,.xls,text/plain,text/csv"></label>
      </div>`)}
      <div style="padding: 10px 20px; border-top: 1px solid var(--line-soft);" class="small muted">You see what a file would change before it replaces anything.${tip("UTF-16 or UTF-8, tab or comma. The same file twice changes nothing; a file under half the size of the one it replaces is refused. The scheduled transfer posts to the same pipeline with a shared secret, so this page is the fallback, not the plan.")}</div>
    </div>
    <div class="card" style="overflow: hidden;">
      <div class="tabhd" style="border-top: 0;">BATCHES · NEWEST FIRST</div>
      ${S.extracts.snapshots.slice(0, 12).map((s) => html`<div class="korow" data-key="${s.id}">
        <span class="tick ${s.status === "active" ? "ok" : s.status === "failed" ? "bad" : "off"}">${s.status === "active" ? icon("tick", 14, { stroke: 2.4 }) : s.status === "failed" ? icon("x", 13) : icon("minus", 13)}</span>
        <span class="fv"><span class="f">${(S.extracts.kinds.find((k) => k.kind === s.kind) || {}).label || s.kind}</span><span class="v">${s.id}<span class="note">${BATCH_STATUS[s.status] || s.status}${s.rowCount ? ` · ${s.rowCount} rows` : ""} · ${since(s.importedAt)} by ${nameOf(s.importedByEmail)}${s.error ? ` · ${s.error}` : ""}</span></span></span>
        <span></span>
      </div>`)}
    </div>
  </div>`;
}

// ---- jobs ------------------------------------------------------------------------------------------
const JOB_NOTE = {
  reminders: "nudges whoever has held an AFE past the cadence",
  pollEnvelopes: "reflects what DocuSign reports",
  drainOutbox: "sends what the outbox may send",
  warmUp: "at boot, not on the tick: the Fixed Assets AFEs' hash checks and signed files",
};
// A job's own name is code; this is what it is called on the screen.
const SCHED_MODE = { interval: "RUNNING ON A TIMER", tick: "RUN BY AN OUTSIDE CALL", manual: "RUN BY HAND ONLY" };
const JOB_NAME = { reminders: "Reminders", pollEnvelopes: "DocuSign status", drainOutbox: "Send the outbox", warmUp: "Warm the Fixed Assets AFEs" };
/** The jobs that reach PEOPLE, and what pressing Run does — asked before it happens. */
const JOB_EFFECT = {
  reminders: "It queues a reminder to everyone who has held an AFE past the cadence.",
  drainOutbox: "It sends what the outbox may send — real e-mail, once the mail connection is configured.",
};
/** `{ queued: 3, skipped: 2 }` → "3 queued · 2 skipped": a result in words, not 90 characters of JSON. */
function inWords(result) {
  if (!result || typeof result !== "object") return String(result || "");
  const words = (k) => k.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const parts = Object.entries(result).filter(([, v]) => ["number", "string", "boolean"].includes(typeof v))
    .map(([k, v]) => (typeof v === "boolean" ? (v ? words(k) : "") : `${v} ${words(k)}`)).filter(Boolean);
  return parts.slice(0, 4).join(" · ") || "done";
}
const nameOf = (email) => { const u = (S.users || []).find((x) => String(x.email).toLowerCase() === String(email || "").toLowerCase()); return u ? u.displayName : String(email || "").split("@")[0].replace(/[._]/g, " "); };
function jobsTab() {
  const sch = S.jobs.scheduler;
  return html`<div class="card" style="overflow: hidden;" data-key="jobs">
    <div class="tabhd" style="border-top: 0;">JOBS · ${SCHED_MODE[sch.mode] || sch.mode.toUpperCase()}</div>
    ${(sch.jobs || []).concat(sch.onDemand || []).map((name) => {
      const last = (S.jobs.jobs || []).find((j) => j.id === `job-${name}` || j.name === name);
      return html`<div class="korow" data-key="${name}">
        <span class="tick ${last ? "ok" : "off"}">${last ? icon("tick", 14, { stroke: 2.4 }) : icon("clock", 14)}</span>
        <span class="fv"><span class="f">${JOB_NAME[name] || name}</span><span class="v">${last && last.lastRunAt ? `ran ${since(last.lastRunAt)}${last.lastResult ? ` — ${inWords(last.lastResult)}` : ""}` : "not run yet"}<span class="note">${JOB_NOTE[name] || ""}</span></span></span>
        <button type="button" class="pillbtn sm" data-job="${name}">Run now</button>
      </div>`;
    })}
    <div class="small muted" style="padding: 12px 20px; border-top: 1px solid var(--line-soft);">A timer posts to /api/jobs/tick with the jobs secret when the plan is not Always On. ${sch.mode === "manual" ? "Interval ticks are off here." : ""}</div>
  </div>`;
}

// ---- the page ----------------------------------------------------------------------------------------
const CHANGE_LABEL = {
  org_rule_added: "added a routing rule", org_rule_changed: "changed a routing rule", org_rule_retired: "retired a routing rule",
  pot_added: "added a budget pot", pot_changed: "changed a budget pot", directory_learned: "learned a mailbox",
  extract_imported: "imported an extract", extract_failed: "an extract was refused", matrix_simulated_extract: "simulated a matrix extract",
  job_run: "ran a job", act_as_started: "started acting as someone else", act_as_stopped: "stopped acting as someone else",
  // The two newest kinds of change. The heading over this card promises that every change is
  // audited with who made it; a feed that quietly omitted the ones made this month would be the
  // one place in the tool where that is not true.
  master_imported: "imported master data", master_restored: "restored a master-data version",
  master_row_edited: "changed a master-data row", master_row_added: "added a master-data row",
  feature_enabled: "turned a feature on", feature_disabled: "turned a feature off",
  reminder_ladder_changed: "changed the reminder ladder",
};
function changes() {
  const rows = S.audit.filter((e) => CHANGE_LABEL[e.type]).slice(0, 6);
  if (!rows.length) return "";
  const who = (e) => nameOf(e.actingAsEmail || e.actorEmail);
  const what = (e) => {
    if (e.type === "directory_learned") return `${e.payload.name} → ${e.payload.to}`;
    if (e.type === "extract_imported") return `${((S.extracts && S.extracts.kinds) || []).find((k) => k.kind === e.payload.kind)?.label || e.payload.kind} · ${e.payload.rows} rows`;
    if (e.type === "org_rule_added" || e.type === "org_rule_changed") return (e.payload.rule || e.payload.to || {}).person ? (e.payload.rule || e.payload.to).person.name : "";
    if (e.type === "org_rule_retired") return `${(e.payload.rule || {}).person ? e.payload.rule.person.name : ""} — ${e.payload.reason}`;
    if (e.type === "pot_changed") return `${money(e.payload.from.amountUsd)} → ${money(e.payload.to.amountUsd)}`;
    if (e.type === "act_as_started") return e.payload.actingAs;
    if (e.type === "feature_enabled" || e.type === "feature_disabled") return e.payload.feature;
    if (e.type === "master_imported") {
      const s = e.payload.summary || {};
      return `${e.payload.kind} v${e.payload.version} — ${s.added || 0} added, ${s.changed || 0} changed, ${s.deactivated || 0} deactivated`;
    }
    if (e.type === "master_restored") return `${e.payload.kind} — back to version ${e.payload.restoredFrom}`;
    if (e.type === "master_row_edited" || e.type === "master_row_added") return `${e.payload.kind} v${e.payload.version}`;
    return "";
  };
  return html`<div class="card" style="overflow: hidden;" data-key="changes">
    <div class="tabhd" style="border-top: 0;">THE LAST FEW CHANGES</div>
    <div style="padding: 14px 20px; display: flex; flex-direction: column; gap: 10px; font-size: 12.5px;">
      ${rows.map((e) => html`<div style="display: flex; gap: 12px;" data-key="${e.id}"><span class="muted" style="min-width: 104px; flex: none;">${since(e.createdAt)}</span><span><b>${who(e)}</b> ${CHANGE_LABEL[e.type]}${what(e) ? ` — ${what(e)}` : ""}</span></div>`)}
    </div>
  </div>`;
}

function markup() {
  const t = tab();
  const body = {
    masters: () => mastersTab(S), features: () => featuresTab(S),
    rules: rulesTab, pots: potsTab, directory: directoryTab, people: peopleTab, extracts: extractsTab, jobs: jobsTab,
  }[t];
  return html`<div class="page pane">
    <div class="dec-head">
      <div style="min-width: 0; flex: 1;">
        <h1 class="h1">Everything the tool decides with.</h1>
        <div class="sub">Master data, feature switches, routing rules, budget pots, mailboxes, people, extracts and jobs — configuration, not code. Every change is audited with who made it.</div>
      </div>
      <div class="tabs" id="tabs" role="tablist" aria-label="Administration">${TABS.map(([k, l]) => html`<button type="button" role="tab" aria-selected="${t === k ? "true" : "false"}" class="${t === k ? "on" : ""}" data-tab="${k}" data-key="${k}">${l}</button>`)}</div>
    </div>
    <div class="split" style="margin-top: 18px; align-items: start;">
      <div id="tab-body">${body()}</div>
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${changes()}
        ${session.me && session.me.demoMode ? html`<div class="card pad" style="background: var(--yellow-bg); border-color: #EFE1A6;" data-key="demo">
          <div class="sect" style="color: var(--yellow);">DEMO ONLY</div>
          <div style="font-size: 12.5px; color: var(--ink-2); margin-top: 6px; line-height: 1.5;">Acting as another person is on because DEMO_MODE is on. ADC onboarding removes it, and with it this card. Every action already records both identities.</div>
        </div>` : ""}
      </div>
    </div>
  </div>`;
}

async function upload(kind, file) {
  const label = (S.extracts.kinds.find((k) => k.kind === kind) || {}).label || kind;
  let contentBase64, preview;
  try {
    contentBase64 = await fileToBase64(file);
    preview = (await api.post(`/api/admin/ingest/${kind}`, { filename: file.name, contentBase64, preview: true })).preview;
  } catch (e) { showError(e); return; }
  // What it would change, before it does — the same discipline master data always had.
  const p = preview || {};
  const sure = await sheet({
    eyebrow: "REPLACE AN SAP EXTRACT", title: `Load ${file.name} as the ${label}?`,
    sub: kind === "matrix"
      ? `${p.costCentres} cost centres in the file, ${p.liveCount} in use now: ${p.added} new, ${p.removed} that would be REMOVED from the matrix.`
      : `${p.rows} rows in the file${p.liveCount ? `, replacing ${p.liveCount} in use now` : ""}.`,
    body: html`${p.skipped ? html`<div class="small muted">${p.skipped} ${plural(p.skipped, "line")} in the file were not rows and are left out.</div>` : ""}
      ${(p.unknownColumns || []).length ? html`<div class="small muted" style="margin-top: 6px;">Columns it does not use: ${p.unknownColumns.join(", ")}.</div>` : ""}`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Load it", value: "ok", tone: kind === "matrix" && p.removed ? "dark" : "", primary: true }],
  });
  if (sure.value !== "ok") return;
  try {
    const out = await api.post(`/api/admin/ingest/${kind}`, { filename: file.name, contentBase64 });
    if (out.duplicate) toast(out.note || "Already imported — nothing changed.", "ok");
    else toast(`${out.snapshot.rowCount} rows loaded as ${out.snapshot.id}.`, "ok");
    store.bust("/api");
    await load(); paint();
  } catch (e) {
    if (e.status === 409 && /truncated/.test(e.message)) {
      const yes = await sheet({ eyebrow: "SMALLER THAN EXPECTED", title: "Load it anyway?", sub: e.message,
        actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Load it", value: "force", tone: "dark", primary: true }] });
      if (yes.value !== "force") return;
      try {
        const out = await api.post(`/api/admin/ingest/${kind}`, { filename: file.name, contentBase64: await fileToBase64(file), force: true });
        toast(`${out.snapshot.rowCount} rows loaded.`, "ok");
        store.bust("/api"); await load(); paint();
      } catch (err) { showError(err); }
      return;
    }
    showError(e);
  }
}

export async function render(root) {
  S.root = root;
  const wait = opening(root, "Opening Admin…");
  try { await load(); } catch (e) { wait(); delete root.dataset.admin; loadFailed(root, e); return; }
  wait();
  if (!root.dataset.admin) { root.innerHTML = ""; root.dataset.admin = "1"; }
  paint();
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "click", "[data-tab]", (e, b) => { ui.tab = b.dataset.tab; paint(); });
  wireMasters(root, S, paint, async () => { await load(); });
  on(root, "click", "#add-rule", () => ruleSheet(null));
  on(root, "click", "[data-edit-rule]", (e, b) => ruleSheet(S.rules.find((r) => r.id === b.dataset.editRule)));
  on(root, "click", "[data-retire-rule]", async (e, b) => {
    const rule = S.rules.find((r) => r.id === b.dataset.retireRule);
    const reason = await askText({ eyebrow: "RETIRE", title: `Retire ${rule.person ? rule.person.name : "this rule"}?`,
      sub: "AFEs already sent keep the chain they were sent with. New previews stop including this person.",
      placeholder: "Why — e.g. Finance agreed the IT override is no longer needed", action: "Retire it", tone: "dark" });
    if (!reason) return;
    try { await api.del(`/api/admin/org-rules/${rule.id}`, { reason }); store.bust("/api"); toast("Retired.", "ok"); await load(); paint(); }
    catch (err) { showError(err); }
  });
  on(root, "click", "[data-add-pot]", (e, b) => potSheet(null, Number(b.dataset.addPot)));
  on(root, "click", "[data-edit-pot]", (e, b) => potSheet(S.pots.find((p) => p.id === b.dataset.editPot)));
  on(root, "click", "[data-edit-dir]", async (e, b) => {
    const row = S.directory.find((d) => d.id === b.dataset.editDir);
    const email = await askText({ eyebrow: "MAILBOX", title: row.matrixName || row.displayName, sub: `Currently ${row.email}. DocuSign delivery is what proves it.`,
      placeholder: "first_last@example.com", action: "Save" });
    if (!email) return;
    try { await api.put(`/api/admin/directory/${row.id}`, { email }); store.bust("/api"); toast("Saved.", "ok"); await load(); paint(); }
    catch (err) { showError(err); }
  });
  on(root, "click", "#add-dir", async () => {
    const r = await sheet({ eyebrow: "ADD A MAILBOX", title: "Who, and at what address?",
      sub: "Normally this fills itself in when a coordinator confirms a mailbox on a routing screen.",
      body: html`<input class="input" id="d-name" placeholder="Name, exactly as the matrix spells it" autocomplete="off"><input class="input" id="d-email" placeholder="first_last@example.com" style="margin-top: 10px;" autocomplete="off">`,
      actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: "Add", value: "ok", primary: true }],
      validate: (el) => (!$("#d-name", el).value.trim() || !$("#d-email", el).value.trim() ? "Both, please." : null),
      collect: (el) => ({ matrixName: $("#d-name", el).value.trim(), email: $("#d-email", el).value.trim() }) });
    if (r.value !== "ok") return;
    try { await api.post("/api/admin/directory", r.data); store.bust("/api"); toast("Added.", "ok"); await load(); paint(); }
    catch (err) { showError(err); }
  });
  on(root, "change", "[data-upload]", (e, input) => { const f = (input.files || [])[0]; if (f) upload(input.dataset.upload, f); input.value = ""; });
  on(root, "click", "[data-roles]", (e, b) => changeRoles(b.dataset.roles));
  on(root, "click", "[data-job]", async (e, b) => {
    const name = b.dataset.job;
    // A job that reaches people is asked about first — Run now fired at once.
    if (JOB_EFFECT[name]) {
      const sure = await sheet({ eyebrow: "RUN NOW", title: `Run ${JOB_NAME[name] || name} now?`, sub: JOB_EFFECT[name],
        actions: [{ label: "Not now", value: null, tone: "sec" }, { label: "Run it", value: "ok", primary: true }] });
      if (sure.value !== "ok") return;
    }
    const done = busy(b, "Running…");
    try { const out = await api.post(`/api/admin/jobs/${name}`); toast(`${JOB_NAME[name] || name}: ${inWords(out.result)}.`, "ok"); await load(); paint(); }
    catch (err) { done(); showError(err); }
  });
}
export function unmount() { if (S.root) { delete S.root.dataset.admin; S.root.innerHTML = ""; } }
