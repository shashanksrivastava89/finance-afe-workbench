// The requester wizard: /afe/new · /afe/:id/edit/:step · /afe/:id/review
//
// One question per screen, the journey on top, consequences as chips under the answer that
// caused them. Every field autosaves half a second after the last keystroke; the response
// carries the whole AFE and its validation, so the inline messages are the server's own words.
// `block` disables Continue on its step, `pending` only stops Send, `warn` never blocks.
import { html, morph, on, $, $$, debounce, cancelDebounce, settleDebounces } from "../../core/dom.js";
import { api, documentToBase64 } from "../../core/api.js";
import { store } from "../../core/store.js";
import { session } from "../../core/session.js";
import { navigate } from "../../core/router.js";
import { setRecord, setRecordNote } from "../../core/chrome.js";
import { icon } from "../../core/icons.js";
import { money, parseMoney, pct, plural, ago, since, date, coverage, stateLabel } from "../../core/format.js";
import { stepper, reveal, tag, avatar, signChain, fieldMsgs, fixBtn, msgExtras, stepMsgs, toggle, chips, docRow, docBadge, tip, roundLine, CTA_ARROW } from "../../components/parts.js";
import { sheet, toast, busy, showError } from "../../core/ui.js";
import { afterPaint, bringTo, sendOff, nudge } from "../../core/motion.js";
import { fieldProblem, specIndex, fieldProgress } from "../../core/fieldCheck.js";

const S = {
  id: null, step: 1, view: null, preview: null, matrix: null, pots: null,
  ccQuery: "", showAllTypes: false, showExtras: false, showLines: false, showOpex: false, locQuery: "", locations: null,
  uploading: null, root: null, wiredTo: null,
  local: new Map(),                        // field -> the problem this keystroke has, or null (R105)
  specs: null,                             // refdata.fields, indexed by field id
  saveState: null,                         // null | "saving" | "saved" | "failed"
  showGrid: false,                         // the eleven-year grid, revealed on demand (R94)
  pdfVersion: null,                        // what the preview iframe is showing; see OFF_FORM_FIELDS
  touched: new Set(),                      // fields the person has typed in — "is required" waits for them
  lastSave: null,                          // the save in flight, so `settle` waits for it rather than repeating it
  docSave: {},                             // attachment id -> { st, msg }: a quote's own fields say whether they saved
  confirmDel: null,                        // the attachment whose × is asking "remove it?"
  uploadErrors: [],                        // files that were not attached, said where the files are
};
// The handful a requester picks most, in the template's own words. It is filtered against the
// reference list before it is rendered, so a chip can never offer a type the form would refuse
// -- "Software" used to sit here and is not one of the sixteen the Type List carries, so
// choosing it failed validation with no way forward. Software is said at the classification
// step instead, where the Cloud CapEx tree asks the question directly.
const TOP_TYPE_ORDER = ["New Equipment", "Office Equip/Furniture", "Automation", "New Construction", "Safety"];
// The Financials step is 8 and sits after "Why" in the journey. The NUMBER is the URL and the
// ORDER is `steps()`, so a screen in the middle costs an out-of-sequence id and nothing else —
// renumbering would break every saved link and every `S.step === n` in this file. It came
// before Why until 2026-10-16, which asked for an in-service date the requester had not given
// yet, and pointed a negative NPV at a justification on a step they had not reached.
const STEP_LABELS = { 1: "What", 2: "Who pays", 3: "How much", 4: "Why", 8: "Financials", 5: "Cloud CapEx", 6: "Quote", 7: "Review" };
const STEP_ORDER = [1, 2, 3, 4, 8, 5, 6, 7];

const afe = () => S.view.afe;

// ---- what the screen believes, right now ------------------------------------------------------
// A field's own shape is checked in the browser on every keystroke (R105) and folded into the
// server's validation under the same field id. Everything downstream — the message under the
// input, the dots on the stepper, whether Continue is disabled, the step counts — reads it
// through `v()` / `vAll()` and never learns which side decided. When the save lands the
// server's answer replaces it, because the server is still the one that is right.
const specFor = (field) => {
  if (!S.specs) S.specs = specIndex((session.refdata && session.refdata.fields) || []);
  return S.specs.get(field) || null;
};
function withLocal(raw) {
  if (!S.local.size) return raw;
  // Only the SHAPE blocks are the browser's to replace. `fieldProblems` produces blocks with no
  // `rule`; every cross-field consequence in RULES carries one. So a stale "the lines do not sum
  // to the total" stays on the screen where it belongs, and a stale "the title is 51 characters"
  // — written about a value the person has already changed — does not.
  const blocks = (raw.blocks || []).filter((e) => !(S.local.has(e.field) && !e.rule));
  for (const problem of S.local.values()) if (problem) blocks.push(problem);
  return Object.assign({}, raw, { blocks });
}
/**
 * Check one field against its own spec and repaint only if the verdict moved. Typing forty
 * characters into a forty-character title repaints once, as it crosses — not forty times.
 */
function liveCheck(field, el) {
  const spec = specFor(field);
  if (!spec) return;
  const raw = S.view && S.view.validation;
  const problem = fieldProblem(spec, coerce(field, el.value), (raw && raw.applies) || {});
  // Repaint when what the screen SHOWS would change. Going from "no opinion" to "it is fine"
  // is such a change, even though both read as no message: before it, the server's verdict on
  // the old value was still on screen.
  const had = S.local.has(field);
  const before = S.local.get(field);
  const was = before ? before.message : null;
  const now = problem ? problem.message : null;
  S.local.set(field, problem);
  if (!had || was !== now) paint();
  // The counter is a character count, not a verdict, so it moves on EVERY keystroke — and it
  // moves by touching one text node rather than by rendering the screen. It has to come after
  // the repaint: the markup draws it from the value the server holds, which is still half a
  // second behind what the person has typed.
  const counter = $(`[data-counter="${field}"]`, S.root);
  if (counter) {
    const progress = fieldProgress(spec, el.value);
    counter.textContent = progress ? `${el.value.length} / ${progress.of}` : "";
    counter.classList.toggle("over", Boolean(progress && (progress.over || progress.short)));
  }
}
// Validation as the screen shows it: an empty field nobody has touched yet is not an error on a
// fresh form, so its "answer this" waits until the field has been typed in or pressed. Continue
// stays disabled with the reason beside it either way.
//
// QUIET IS DECIDED BY THE FIELD AND ITS VALUE, NEVER BY THE WORDING. It used to match
// `/is required\.$/`, and the yes/no questions say "Pick one." instead (the question-label fix),
// so every untouched toggle on "Why?" opened in red with "3 things to fix" (found 2026-10-16).
// A shape problem (no `rule`) on an empty field is the field asking to be answered.
const QUIET_RULES = new Set(["breakup_positive", "quote_present", "amount_present"]);   // "give me something" rules — same treatment
const blank = (x) => x === undefined || x === null || x === "" || (Array.isArray(x) && !x.length);
/**
 * Could more typing still fix this? A short year, a half-typed number, a description under its
 * minimum — those wait until the person leaves the field (P1-6): "202" was shown as wrong, and
 * saved, while somebody was typing 2026. Too long, or a character that is not part of a number,
 * cannot be fixed by typing more, so those still show at once.
 */
function typingCanFix(spec, raw) {
  if (!spec) return false;
  const s = String(raw === undefined || raw === null ? "" : raw);
  if (spec.type === "text") return !(spec.max && s.length > spec.max);
  if (spec.type === "int" || spec.type === "money") return /^[\d,.\s$-]*$/.test(s);
  return false;
}
const v = () => {
  const raw = vAll();
  const untouchedAndEmpty = (e) => !S.touched.has(e.field) && ((!e.rule && blank(get(e.field))) || QUIET_RULES.has(e.rule));
  // The field with the caret in it — read from the document rather than tracked from focus
  // events, so there is no state of its own to fall out of step.
  const at = typeof document !== "undefined" ? document.activeElement : null;
  const typingIn = at && at.dataset && at.dataset.field && S.root && S.root.contains(at) ? at : null;
  const stillTyping = (e) => Boolean(typingIn && typingIn.dataset.field === e.field && !e.rule && typingCanFix(specFor(e.field), typingIn.value));
  return Object.assign({}, raw, { blocks: (raw.blocks || []).filter((e) => !untouchedAndEmpty(e) && !stillTyping(e)) });
};
const vAll = () => withLocal(S.view.validation);
const get = (path) => String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), afe());
const cloudTriggered = () => (v().sections || []).some((s) => s.id === "cloud_questionnaire");

// The financial case is asked for on an AFE that buys something capital; a purely operating
// request has no asset to depreciate and no NPV to argue about.
const capitalAfe = () => (Number(get("money.capexUsd")) || 0) > 0 || (Number(get("money.cloudCapexUsd")) || 0) > 0;
/**
 * The journey, and how far along it you have earned.
 *
 * You can always go BACK — looking at an answer you have already given costs nothing. You can go
 * forward as far as the first step that still has something blocking, and no further: a
 * breadcrumb that jumps over a blocked step is a breadcrumb that skips the validation on it,
 * which is the one thing a one-question-at-a-time wizard must not allow. Continue was already
 * disabled on a blocked step; the stepper was the way round it.
 *
 * `stepBlocks` is the UNFILTERED set on purpose: a required field nobody has touched yet still
 * blocks, it just keeps quiet about it until they do.
 */
function steps() {
  const list = STEP_ORDER.filter((n) => (n !== 5 || cloudTriggered()) && (n !== 8 || capitalAfe()));
  const stop = list.findIndex((n) => stepBlocks(n).length > 0);
  return list.map((n, i) => ({
    n,
    label: STEP_LABELS[n],
    href: n === 7 ? `/afe/${S.id}/review` : `/afe/${S.id}/edit/${n}`,
    locked: stop >= 0 && i > stop,
  }));
}
function issues() {
  const out = {};
  for (const e of v().blocks || []) { const k = e.step || 0; out[k] = out[k] || {}; out[k].block = (out[k].block || 0) + 1; }
  for (const e of v().pending || []) { const k = e.step || 0; out[k] = out[k] || {}; out[k].pending = (out[k].pending || 0) + 1; }
  return out;
}
// Quote coverage used to block Send and need a coordinator's waiver. It is a warning now
// ("don't block them, give them a red flag only" — Imogen, Meeting #5 22:44), so nothing has to
// be carved out of the blocking set any more: a warning never blocked Continue in the first place.
const stepBlocks = (n) => (vAll().blocks || []).filter((e) => e.step === n);
const nextStep = () => { const list = steps().map((s) => s.n); const i = list.indexOf(S.step); return list[Math.min(list.length - 1, i + 1)]; };
const prevStep = () => { const list = steps().map((s) => s.n); const i = list.indexOf(S.step); return list[Math.max(0, i - 1)]; };

// ---- data ------------------------------------------------------------------------------------
async function load() {
  S.view = await api.get(`/api/afes/${S.id}`);
  S.preview = S.view.routingPreview || S.view.routing || null;
}
const CHAIN_FIELDS = /^(costCenter|money\.|kind|supplementalOf|chargeTo|budget\.budgeted)/;
// What the generated form does NOT print. The preview is an iframe, and an iframe reloads the
// moment its src changes — so busting the cache on `updatedAt`, which moves on every save,
// made the PDF flicker on every keystroke of a note that never appears on it. These fields
// leave the preview alone; everything else refreshes it.
const OFF_FORM_FIELDS = /^(approverNote|ccRecipients|routingEdits)/;
function save(patch) {
  const p = saveNow(patch);
  S.lastSave = p;
  return p;
}
async function saveNow(patch) {
  // Anything typed but not yet saved rides along, so no repaint can ever lose a keystroke.
  const dirty = $$("[data-dirty][data-field]", S.root);
  for (const el of dirty) {
    const f = el.dataset.field;
    if (!(f in patch)) patch[f] = coerce(f, el.value);
    cancelDebounce(f);
  }
  // The toggle shows CapEx by default; the first amount typed makes that real.
  if (!get("money.classification") && !("money.classification" in patch)) {
    if ("money.capexUsd" in patch) patch["money.classification"] = "capex";
    else if ("money.cloudCapexUsd" in patch) patch["money.classification"] = "cloud_capex";
    // OpEx no longer implies a classification: it stands beside whichever capital nature
    // applies, and typing one must not silently rewrite the other.
  }
  // Show the answer at once. A chip or a toggle is a direct manipulation — waiting for a round
  // trip before the thing you pressed looks pressed is the difference between a screen that
  // feels like an app and one that feels like a form. The server is still the source of truth:
  // its reply lands a moment later and repaints, and a refusal puts the old value back.
  const rollback = JSON.stringify(S.view.afe);
  applyLocally(patch);
  paint();

  setSaving("saving");
  try {
    const r = await api.patch(`/api/afes/${S.id}`, patch);
    for (const el of dirty) delete el.dataset.dirty;
    S.view.afe = r.afe;
    S.view.validation = r.validation;
    // The server has now looked at these fields itself, so the browser's guess about them is
    // withdrawn rather than left to argue with the answer.
    for (const k of Object.keys(patch)) S.local.delete(k);
    // Everything the screens read off the view and the server recomputes on a write. A key
    // missing from this list is a figure that never updates until the page is reloaded, which
    // is how the financial summary came back empty the first time it was wired up.
    if (r.view) for (const k of ["pot", "band", "costCentre", "cloud", "possibleDuplicates", "totalUsd", "quoteTotalUsd", "lineTotalUsd", "financials", "resume", "permissions"]) S.view[k] = r.view[k];
    if (Object.keys(patch).some((k) => !OFF_FORM_FIELDS.test(k))) S.pdfVersion = r.afe.updatedAt;
    // An answer the server dropped because this change invalidated it. Silently un-selecting
    // somebody's budget pot is worse than leaving it wrong: they would never know it had gone.
    for (const c of r.cleared || []) toast(`${c.label} is no longer the budget for this AFE — ${c.because}. Pick it again.`, "err");
    // A cost centre in another division is another coordinator's review (R157).
    if (r.reassigned) toast(`This cost centre belongs to ${r.reassigned.division || "another division"}${r.reassigned.coordinatorName ? ` — ${r.reassigned.coordinatorName} reviews it now` : ", which has no coordinator"}.`, "ok");
    setSaving("saved");
    // The chain preview is decoration until send, so it never holds up the answer.
    if (Object.keys(patch).some((k) => CHAIN_FIELDS.test(k))) {
      api.get(`/api/afes/${S.id}/routing/preview`)
        .then((p) => { S.preview = p; paint(); })
        .catch(() => { /* decoration */ });
    }
    return r;
  } catch (e) {
    S.view.afe = JSON.parse(rollback);
    paint();
    setSaving("failed");
    showError(e);
    if (e.status === 409) await navigate(`/afe/${S.id}`, { replace: true });
    return null;
  }
}

/**
 * Throw the draft away. Only a draft can go — once it is sent it has a frozen chain and a
 * hashed form behind it — so the wording says what will actually happen and asks once.
 */
async function binDraft() {
  const title = get("project.title");
  const r = await sheet({
    eyebrow: "DELETE THIS DRAFT",
    title: title ? `Delete "${title}"?` : "Delete this untitled draft?",
    sub: "It has not been sent, so nobody has seen it and nothing has been signed. This cannot be undone.",
    actions: [{ label: "Keep it", value: null, tone: "sec" }, { label: "Delete the draft", value: "yes", tone: "dark", primary: true }],
  });
  if (r.value !== "yes") return;
  try {
    await api.del(`/api/afes/${S.id}`);
    store.bust("/api/afes");
    toast("Draft deleted.", "ok");
    await navigate("/requests", { replace: true });
  } catch (e) { showError(e); }
}

/** Put a patch onto the local copy so the screen can answer before the server does. */
function applyLocally(patch) {
  const afe = S.view && S.view.afe;
  if (!afe) return;
  for (const [path, value] of Object.entries(patch)) {
    const parts = String(path).split(".");
    let node = afe;
    for (let i = 0; i < parts.length - 1; i++) node = (node[parts[i]] = node[parts[i]] || {});
    node[parts[parts.length - 1]] = value;
  }
}
function coerce(field, value) {
  if (/Usd$/.test(field) || field === "supplementalOf.approvedTotalUsd") return parseMoney(value);
  if (field === "schedule.fiscalYear") { const n = parseInt(value, 10); return Number.isFinite(n) ? n : null; }
  return value === "" ? null : value;
}

/**
 * What the screen is doing with what you just typed, said BESIDE the button you are about to
 * press. It used to go up into the brand area — which is also where the AFE's title was shown,
 * so the first save replaced the title with "saved" and the title never came back. Two
 * different facts were sharing one slot. The title has its own bar now (`setRecord`); the save
 * state stays down here, where the typing is.
 */
let saveStateTimer = null;
function setSaving(state) {
  S.saveState = state;
  clearTimeout(saveStateTimer);
  // "Saved" is worth a moment and then it is noise; a failure stays until something changes it.
  if (state === "saved") saveStateTimer = setTimeout(() => { if (S.saveState === "saved") { S.saveState = null; paint(); } }, 2400);
  paint();
  // One short bounce when the answer lands. It is the only confirmation a per-field autosave
  // gives, and a word that simply appears is a word that gets missed.
  if (state === "saved") nudge($(".savestate", S.root));
}
const saveChip = () => (S.saveState
  ? html`<span class="savestate ${S.saveState}" data-key="savestate">${S.saveState === "saving"
      ? html`<i class="spin"></i>Saving…`
      : S.saveState === "saved" ? html`${icon("tick", 12, { stroke: 2.4 })}Saved`
      : html`${icon("bang", 12)}Not saved`}</span>`
  : "");

// ---- pieces ----------------------------------------------------------------------------------
const foot = (opts) => {
  const o = opts || {};
  const blocks = stepBlocks(S.step);                       // everything that blocks, shown or not
  const shown = (v().blocks || []).filter((e) => e.step === S.step);   // what the screen is saying
  const disabled = o.disabled !== undefined ? o.disabled : blocks.length > 0;
  return html`<div class="foot">
    ${S.step > 1 ? html`<button class="back" id="back">${icon("chevL", 14, { stroke: 2.2 })}Back</button>` : ""}
    <button class="cta ${disabled ? "is-blocked" : ""}" id="${o.id || "next"}" aria-disabled="${disabled ? "true" : "false"}" ${disabled ? "data-blocked" : ""} title="${disabled && blocks.length ? blocks[0].message : ""}">${o.label || "Continue"}${o.icon === false ? "" : CTA_ARROW}</button>
    ${saveChip()}
    ${disabled && shown.length
      // The message itself is already on the screen — every block for this step is rendered
      // inline by fieldMsgs or picked up by stepMsgs — so printing it again under Continue was
      // the same sentence twice on one screen. The count, and a way to get to it.
      //
      // It counts what is SHOWN, not what blocks. On a form nobody has typed in yet the required
      // fields block and stay quiet about it (see `v()`), so a red "2 things to fix" was the
      // screen telling somebody off for not having started. Then the reason is the quiet one it
      // always was.
      ? html`<button type="button" class="kbd asbtn why" id="foot-why">${shown.length} thing${shown.length > 1 ? "s" : ""} to fix ${icon("arrowR", 12)}</button>`
      : html`<span class="kbd ${disabled && blocks.length ? "why" : "hint"}">${disabled && blocks.length ? blocks[0].message : (o.kbd === undefined ? "press Enter ↵" : o.kbd)}</span>`}
    ${afe().state === "draft" ? html`<button type="button" class="linkbtn quiet" id="bin">Delete draft</button>` : ""}
  </div>`;
};

function signerNames(limit) {
  const live = ((S.preview && S.preview.recipients) || []).filter((r) => r.role !== "cc" && ["pending", "sent", "signed"].includes(r.status));
  const names = live.map((r) => r.name);
  if (!names.length) return null;
  const shown = names.slice(0, limit || 3);
  const rest = names.length - shown.length;
  // "A, B and C will sign" · "A, B, C and 2 more will sign"
  const list = rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.length > 1 ? shown.slice(0, -1).join(", ") + " and " + shown[shown.length - 1] : shown[0];
  return { text: `${list} will sign`, count: names.length, first: names[0] };
}

// What resubmitting will do rides with the reason it came back (R148): an edit to the money is
// exactly what turns "straight back" into "round again", and the person making it should see so.
const returnedBanner = () => (afe().state === "returned" && afe().returnedTo
  ? html`<div class="banner red" style="margin-bottom: 22px;" data-key="returned">${icon("back", 16)}<span><b>${afe().returnedTo.byName}</b> sent this back: “${afe().returnedTo.reason}”. Fix it and submit again.${S.view.resume && S.view.resume.applies ? html`<span style="display: block; margin-top: 8px;">${roundLine(S.view.resume)}</span>` : ""}</span></div>` : "");

// ---- 1 · what ---------------------------------------------------------------------------------
function step1() {
  const title = get("project.title") || "";
  const max = session.refdata.titleMaxChars;
  const type = get("project.projectType");
  const all = session.refdata.projectTypes;
  const top = TOP_TYPE_ORDER.filter((t) => all.includes(t));
  const options = S.showAllTypes || (type && !top.includes(type)) ? all : top;
  return html`
    ${returnedBanner()}
    <h1 class="q">What are you asking for?</h1>
    <div class="hint">One line, the way you would say it out loud.</div>
    <input class="big ${title.length > max ? "is-block" : ""}" id="title" data-field="project.title" value="${title}" placeholder="e.g. PC hardware refresh — APAC" autocomplete="off" style="margin-top: 26px;" aria-label="Title">
    <div class="counter"><span>Becomes the SAP order name, which holds ${max} characters</span><span data-counter="project.title" class="${title.length > max ? "over" : ""}">${title.length} / ${max}</span></div>
    ${fm("project.title")}
    <label class="lbl">Which is it, mostly?</label>
    ${chips("project.projectType", options, type, { more: options === top ? `+ ${all.length - top.length} more` : null })}
    ${fm("project.projectType")}
    ${flagNotes(1)}
    ${foot()}`;
}

// ---- 2 · who pays -----------------------------------------------------------------------------
function ccMatches() {
  const q = S.ccQuery.trim().toLowerCase();
  if (!q || !S.matrix) return [];
  return S.matrix.filter((m) => m.costCenter.startsWith(q) || m.description.toLowerCase().includes(q)).slice(0, 8);
}
function step2() {
  const cc = afe().costCenter || "";
  const row = S.view.costCentre;
  const names = signerNames(1);
  const coord = afe().coordinator;
  return html`
    ${returnedBanner()}
    <h1 class="q">Who pays for it?</h1>
    <div class="hint">Your cost centre — a number or a department name.</div>
    <div style="position: relative; margin-top: 26px;">
      <input class="big" id="cc-input" value="${S.ccQuery || cc}" placeholder="30145 or “IT Infrastructure”" autocomplete="off" aria-label="Cost centre">
      <div id="cc-list" style="position: absolute; left: 0; right: 0; top: 70px; z-index: 5;">${ccList()}</div>
    </div>
    ${row ? html`<div class="card" style="margin-top: 14px; padding: 18px 20px; display: flex; align-items: center; gap: 16px;" data-key="cc-card">
      <span class="av lg blue" style="font-size: 11.5px;">CC</span>
      <div style="min-width: 0; flex: 1;"><div style="font-size: 14.5px; font-weight: 700;">${row.description}</div><div class="small muted">Cost centre ${row.costCenter} · plant ${row.plant}${afe().division ? " · " + afe().division : ""}${row.status && row.status !== "Active" ? " · " + row.status : ""}</div></div>
      ${icon("tick", 22, { stroke: 2.2 })}
    </div>` : ""}
    ${fm(["costCenter"])}
    <div class="chips" style="margin-top: 22px;" id="cc-chips">
      ${names ? reveal(names.count === 1 ? `${names.first} will sign` : `${names.first} signs first — ${names.count} signatures in all`, { avatar: names.first, key: "signer" }) : ""}
      ${coord ? reveal(`${coord.name} reviews it before it goes`, { avatar: coord.name, avatarTone: "blue", tone: "blue", key: "coord" }) : ""}
      ${cc && !row ? reveal("Not in the SAP approver matrix — Fixed Assets will confirm it", { icon: "clock", tone: "yellow", avatarTone: "gold", key: "unknown" }) : ""}
    </div>
    <label class="lbl">Where will it be?</label>
    <!-- One field, from the template's own list of 150 sites, because the building number
         inside it is what Fixed Assets files property tax against ("the 725 is the building
         number" — Lyndsay, Meeting #5 26:29). Typing something else is allowed and warned about:
         a new building exists before anyone updates a master. -->
    <!-- A SEARCH box, not the field: what is typed here is a query, and the location changes only
         when a site is picked (or the typed words are used on purpose, from the last row). It
         carried data-field, so every pause saved the query as the location — "S", "Si", "Singa"
         on afe-0032 — and leaving before a pick kept a half-word on the AFE and the form. -->
    <input class="big" id="loc-input" value="${S.locQuery || afe().location || ""}" placeholder="Start typing a city, a country code or a street" style="font-size: 14.5px;" autocomplete="off" aria-label="Location">
    <div id="loc-list">${locList()}</div>
    ${fm("location")}
    <label class="lbl">Region <span class="optional">— one AFE per region, per year</span></label>
    ${chips("region", session.refdata.regions, afe().region || null)}
    ${fm("region")}
    ${flagNotes(2)}
    ${foot()}`;
}
/** The location master, matched on any part of `CCC_City_Address`. */
function locMatches() {
  const q = String(S.locQuery || "").trim().toLowerCase();
  if (!q || !S.locations || !S.locations.length) return [];
  return S.locations.filter((l) => l.toLowerCase().includes(q)).slice(0, 8);
}
/** The site the typed words name exactly, whatever their case — or null. */
const locExact = (typed) => {
  const q = String(typed || "").trim().toLowerCase();
  return (q && (S.locations || []).find((l) => l.toLowerCase() === q)) || null;
};
const listRow = "width: 100%; border: 0; background: none; text-align: left; font: inherit; padding: 11px 18px; cursor: pointer;";
function locList() {
  const typed = String(S.locQuery || "").trim();
  if (!typed) return html``;
  const hits = locMatches();
  // The last row commits the typed words ON PURPOSE. A site not on the list is allowed (it is
  // warned about — a new building exists before anybody updates a master); a half-typed word
  // that got saved because somebody paused is not.
  return html`<div class="card" style="overflow: hidden; box-shadow: var(--shadow-card); margin-top: 6px;">
    ${!S.locations ? html`<div class="row small muted" style="padding: 11px 18px;">Loading the sites…</div>` : ""}
    ${hits.map((l) => html`<button type="button" class="row" data-loc="${l}" data-key="${l}" style="${listRow}">
      <span style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: block;">${l}</span>
    </button>`)}
    ${S.locations && !locExact(typed) ? html`<button type="button" class="row" data-loc-free="${typed}" data-key="free" style="${listRow} color: var(--ink-3);">
      ${hits.length ? "" : html`<span class="small muted" style="display: block;">No site on the list matches “${typed}”.</span>`}
      <span>Use “<b>${typed}</b>” as typed — not on the list</span>
    </button>` : ""}
  </div>`;
}
function ccList() {
  const typed = S.ccQuery.trim();
  if (!typed) return html``;
  if (!S.matrix) return html`<div class="card small muted" style="padding: 12px 18px; box-shadow: var(--shadow-card);">Loading the cost centres…</div>`;
  const hits = ccMatches();
  if (!hits.length) {
    return html`<div class="card small muted" style="padding: 12px 18px; box-shadow: var(--shadow-card);">No cost centre matches “${typed}”.${/^\d{4,6}$/.test(typed)
      ? " Press Enter to use it as typed — Fixed Assets will confirm it." : " Try its number, or a word from its name."}</div>`;
  }
  return html`<div class="card" style="overflow: hidden; box-shadow: var(--shadow-card);">
    ${hits.map((m) => html`<button type="button" class="row" data-cc="${m.costCenter}" data-key="${m.costCenter}" style="width: 100%; border: 0; background: none; text-align: left; font: inherit; padding: 12px 18px; display: flex; gap: 14px; cursor: pointer;">
      <b style="min-width: 64px;">${m.costCenter}</b><span style="flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${m.description}</span><span class="small muted">plant ${m.plant}</span>
    </button>`)}
  </div>`;
}

// ---- 3 · how much -----------------------------------------------------------------------------
// The CAPITAL nature — one of these, never two. OpEx is a separate amount beside it, because
// "in most of the AFE, the question for both CapEx and OpEx over the same AFE" (Lyndsay, Meeting
// #5 05:46). Asking one question with three answers was the mistake; these are two questions.
// An AFE is capital (R158), so "Neither" is not offered — except on an AFE that was already
// SENT with it, which has to be able to show the answer it was signed with.
const CLASS_OPTS_ALL = [{ value: "capex", label: "CapEx" }, { value: "cloud_capex", label: "Cloud CapEx" }, { value: "none", label: "Neither" }];
const classOpts = () => CLASS_OPTS_ALL.filter((o) => o.value !== "none" || (S.view.afe.sentAt && get("money.classification") === "none"));
const capitalField = () => (get("money.classification") === "cloud_capex" ? "money.cloudCapexUsd" : "money.capexUsd");
/**
 * Switching the capital nature carries the amount across — CapEx and Cloud CapEx are mutually
 * exclusive, so the figure belongs to whichever is chosen. "Neither" clears it and leaves the
 * operating amount alone, which is the whole point of them being separate.
 *
 * One function, because the toggle and the "Make it regular CapEx" button on the Cloud CapEx
 * block both do it, and a second copy would be the one that forgot to move the money.
 */
function setClassification(value) {
  const amt = get(capitalField());
  save({
    "money.classification": value,
    "money.capexUsd": value === "capex" ? amt : null,
    "money.cloudCapexUsd": value === "cloud_capex" ? amt : null,
  });
  if (value === "none") S.showOpex = true;
}
const hasOpex = () => S.showOpex || afeRules_num("money.opexUsd") > 0;
const afeRules_num = (path) => Number(get(path)) || 0;
function pinPct(t) {
  if (!t || t <= 0) return 0;
  if (t <= 25000) return (t / 25000) * 25;
  if (t <= 100000) return 25 + ((t - 25000) / 75000) * 35;
  if (t <= 300000) return 60 + ((t - 100000) / 200000) * 40;
  return 100;
}
/**
 * Which currency the form's local columns print in (R161). The approval is in US dollars — the
 * bands, the chain and the budget all read dollars — so this is a second view of the same money,
 * at Global Finance's month-end rate, attached by the server when the currency is picked. Offered
 * only once Global Finance's rates have been loaded; an AFE that already has a currency keeps
 * showing it whatever the master holds today.
 */
function currencyRow() {
  const table = session.refdata && session.refdata.fx;
  const m = afe().money || {};
  const code = String(m.currency || "USD").toUpperCase();
  if (!table && code === "USD") return "";
  const rates = (table && table.rates) || [];
  const codes = rates.map((r) => r.code);
  const rate = code !== "USD" && m.fx ? m.fx : null;
  const local = (usd) => Math.round((Number(usd) || 0) * rate.localPerUsd).toLocaleString("en-US");
  const parts = rate ? [
    Number(get(capitalField())) ? `${code} ${local(get(capitalField()))} capital` : "",
    Number(get("money.opexUsd")) ? `${code} ${local(get("money.opexUsd"))} operating` : "",
  ].filter(Boolean) : [];
  return html`<div class="row" style="margin-top: 14px;" data-key="currency">
      <span>Local currency<span class="small muted" style="display: block; font-weight: 400;">The approval is in US dollars. The form also prints the local amounts.</span></span>
      <select class="input" data-currency style="width: 220px;" aria-label="Local currency">
        <option value="USD" ${code === "USD" ? "selected" : ""}>USD — US dollars only</option>
        ${rates.map((r) => html`<option value="${r.code}" ${r.code === code ? "selected" : ""}>${r.code} — ${r.name}</option>`)}
        ${code !== "USD" && !codes.includes(code) ? html`<option value="${code}" selected>${code}</option>` : ""}
      </select>
    </div>
    ${rate ? html`<div class="small muted" data-key="fxline" style="margin-top: 6px;">1 USD = ${Number(rate.localPerUsd).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${code} · Global Finance, ${rate.month ? monthName(rate.month) : "month-end"} month-end${parts.length ? html` — <b style="color: var(--ink-2);">${parts.join(" · ")}</b>` : ""}</div>` : ""}`;
}
/** "2026-08" -> "August 2026". */
const monthName = (m) => { const [y, mo] = String(m).split("-"); return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][Number(mo) - 1] || ""} ${y}`; };

function step3() {
  const total = S.view.totalUsd || 0;
  const capital = get(capitalField());
  const opex = get("money.opexUsd");
  const noCapital = get("money.classification") === "none";
  const names = signerNames(3);
  const band = S.view.band;
  const budgeted = get("budget.budgeted");
  const lines = get("money.lines") || [];
  const showLines = S.showLines || lines.length > 0;
  const pots = S.pots || [];
  const region = afe().region;
  const potOptions = pots.filter((p) => !region || !p.region || p.region === region || region === "Global");
  const potId = get("budget.potId");
  // Words with no pot chosen are an "Other" answer too — a division that had no pots when they were
  // typed may have some now — so they stay on screen rather than answering the question unseen.
  const otherOn = potId === "other" || (!potId && Boolean(String(get("budget.otherBudget") || "").trim()));
  return html`
    ${returnedBanner()}
    <h1 class="q">How much?</h1>
    <div class="hint">The vendor's number is fine. All amounts in USD.</div>
    ${noCapital ? "" : html`<div class="money-row" style="margin-top: 26px;" data-key="capital">
      <span class="cur">$</span>
      <input class="big money" id="amount" data-field="${capitalField()}" value="${capital === null || capital === undefined ? "" : Number(capital).toLocaleString("en-US")}" placeholder="0" inputmode="decimal" autocomplete="off" aria-label="Capital amount in USD">
      ${toggle("money.classification", classOpts(), get("money.classification") || "capex")}
    </div>`}
    ${noCapital ? html`<div class="row" style="margin-top: 26px;" data-key="capital-none"><span>${S.view.afe.sentAt ? html`No capital spend on this one<span class="small muted" style="display:block; font-weight:400;">Services, maintenance, a licence — it goes in the operating amount below.</span>` : html`Which kind of capital is it?<span class="small muted" style="display:block; font-weight:400;">An AFE is for capital; the operating cost goes beside it.</span>`}</span>${toggle("money.classification", classOpts(), "none")}</div>` : ""}
    <!-- OpEx is its own question. Most AFEs carry both, and making a requester choose between
         them was forcing them to file the same project twice or misstate it once. -->
    ${hasOpex() || noCapital ? html`<div class="money-row" style="margin-top: 14px;" data-key="opex">
      <span class="cur">$</span>
      <!-- The big class is not decoration here: .money-row .big is what constrains the field to
           the row. Without it the input keeps its intrinsic size, runs off the right edge of a
           phone, and renders larger than the capital amount it sits under. -->
      <input class="big money" id="opex" data-field="money.opexUsd" value="${opex === null || opex === undefined ? "" : Number(opex).toLocaleString("en-US")}" placeholder="0" inputmode="decimal" autocomplete="off" aria-label="Operating amount in USD">
      <span class="tag grey pad" style="align-self: center;">OpEx</span>
    </div>`
      : html`<button type="button" class="linkbtn quiet" id="add-opex" data-key="add-opex" style="margin-top: 12px;">+ There's an operating cost too</button>`}
    ${fm(["money.capexUsd", "money.opexUsd", "money.cloudCapexUsd", "money.classification"])}
    ${currencyRow()}
    ${total > 0 && afeRules_num("money.opexUsd") > 0 && !noCapital ? html`<div class="small muted" data-key="split" style="margin-top: 8px;">${money(afeRules_num(capitalField()))} capital + ${money(afeRules_num("money.opexUsd"))} operating — approvers see ${money(total)}.</div>` : ""}
    <div class="scale" aria-hidden="true">
      <span class="pin" style="left: ${pinPct(total)}%"></span>
      <span class="tick" style="left: 0">$0</span><span class="tick" style="left: 25%">$25k</span><span class="tick" style="left: 60%">$100k</span><span class="tick last" style="left: 100%">$300k+</span>
    </div>
    <div class="chips" style="margin-top: 40px;" id="band-chips">
      ${/* The band, not the matrix's level codes ("M1, A1, A2, A3"): who signs is named on the line below. */ ""}
      ${total > 0 ? reveal(`${band.label} — ${band.levels.filter((l) => l !== "BOARD").length} ${plural(band.levels.filter((l) => l !== "BOARD").length, "level")} of approval`, { tone: "blue", icon: "shield", avatarTone: "blue", key: "band" }) : ""}
      ${names ? reveal(names.text, { avatar: names.first, key: "signers" }) : ""}
      ${(v().sections || []).some((s) => s.id === "controllership_review") ? reveal("Above $1M — Controllership reviews the classification", { tone: "yellow", icon: "bang", avatarTone: "gold", key: "controllership" }) : ""}
      <!-- A capital amount adds a step to the journey. The stepper grows silently otherwise, and
           a step nobody noticed arriving is a step nobody expects to fill in — which is how the
           Financials page came to be reported missing. Consequences belong under the answer that
           caused them (design rule 1), and this is one. -->
      ${capitalAfe() ? reveal("Capital — so there's a Financials step next: NPV, payback and ROI", { icon: "info", key: "financials" }) : ""}
    </div>
    <div class="row" style="margin-top: 22px; border-top: 1px solid var(--line-soft);"><span>Is it in this year's budget?</span>${toggle("budget.budgeted", ["Yes", "No"], budgeted)}</div>
    ${fm("budget.budgeted")}
    ${budgeted === "Yes" ? html`<div data-key="pots" style="margin-top: 12px;">
      <div class="small muted" style="margin-bottom: 10px;">Which budget does it come out of?${afe().division ? "" : " Pick the cost centre first and its budgets will appear."}</div>
      ${potOptions.length ? html`<div class="chips">${potOptions.map((p) => html`<button type="button" class="chip sm ${p.id === potId ? "on" : ""}" data-pot="${p.id}" data-key="${p.id}">${p.budgetCategory}${p.region ? " · " + p.region : ""} · FY${p.fiscalYear}</button>`)}<button type="button" class="chip sm ${otherOn ? "on" : ""}" data-pot="other" data-key="other">Other</button></div>` : ""}
      ${/* "Other" in words (R167): asked when Other is chosen, and on its own where a division has no
           pots yet — the budget is still a question approvers ask. */ ""}
      ${!potOptions.length || otherOn ? html`<input class="input" data-field="budget.otherBudget" value="${get("budget.otherBudget") || ""}" maxlength="120" autocomplete="off" placeholder="In your words — e.g. Facilities FY26 maintenance budget" style="margin-top: ${potOptions.length ? 10 : 0}px;" aria-label="Which budget it comes out of">` : ""}
      ${/* The balance is shown only when the server sent one, which it does for the coordinator and
           Fixed Assets and not for the requester (R167). */ ""}
      ${S.view.pot && Number.isFinite(S.view.pot.remainingUsd) ? html`<div class="chips" style="margin-top: 12px;">${reveal(`${money(S.view.pot.remainingUsd)} left in this pot before yours${S.view.pot.remainingAfterThisUsd < 0 ? " — it does not fit" : ""}`, { tone: S.view.pot.remainingAfterThisUsd < 0 ? "yellow" : "blue", icon: "info", avatarTone: "blue", key: "potleft" })}</div>` : ""}
      ${fm(["budget.potId", "budget.otherBudget"], { exceptRules: S.view.pot && Number.isFinite(S.view.pot.remainingUsd) ? ["budget_pot_available"] : [] })}
      <div class="row" style="margin-top: 8px;"><span>Fiscal year</span><input class="input" style="width: 120px; text-align: center;" data-field="schedule.fiscalYear" value="${get("schedule.fiscalYear") || ""}" placeholder="${new Date().getUTCFullYear()}" inputmode="numeric" aria-label="Fiscal year"></div>
      ${fm("schedule.fiscalYear")}
    </div>` : ""}
    ${budgeted === "No" ? html`<div data-key="unbudgeted" style="margin-top: 12px;">
      <textarea class="input" data-field="budget.unbudgetedReason" rows="2" placeholder="Why now, if it wasn't planned? Every approver will ask.">${get("budget.unbudgetedReason") || ""}</textarea>
      ${fm("budget.unbudgetedReason")}
    </div>` : ""}
    <div class="row"><span>Is this a supplemental AFE?${tip("A supplemental tops up an AFE that was already approved. The approval chain is rebuilt on the cumulative total, not on the top-up alone.")}</span>${toggle("kind", [{ value: "original", label: "No" }, { value: "supplemental", label: "Yes" }], get("kind") || "original")}</div>
    ${get("kind") === "supplemental" ? html`<div data-key="supp" style="margin-top: 8px;">
      <div class="row"><span>The internal order it tops up</span><input class="input" style="width: 160px;" data-field="supplementalOf.ioNumber" value="${get("supplementalOf.ioNumber") || ""}" placeholder="6 digits" inputmode="numeric" aria-label="Original internal order"></div>
      <div class="row"><span>Its approved total (USD)</span><input class="input" style="width: 160px;" data-field="supplementalOf.approvedTotalUsd" value="${get("supplementalOf.approvedTotalUsd") || ""}" inputmode="decimal" aria-label="Original approved total"></div>
      ${fm(["supplementalOf.ioNumber", "supplementalOf.approvedTotalUsd"])}
    </div>` : ""}
    ${showLines ? html`<div data-key="lines" style="margin-top: 22px;">
      <div style="display: flex; align-items: baseline; gap: 12px;"><label class="lbl" style="margin: 0;">Split by site or country</label><span class="small muted">— each becomes a child internal order</span></div>
      <div class="lines" style="margin-top: 12px;">
        <span class="hd">SITE</span><span class="hd">COUNTRY</span><span class="hd">AMOUNT (USD)</span><span></span>
        ${lines.map((l, i) => html`
          <input class="input" data-line="site" data-i="${i}" value="${l.site || ""}" placeholder="Singapore DC" aria-label="Site">
          <input class="input" data-line="country" data-i="${i}" value="${l.country || ""}" placeholder="SG" maxlength="2" style="text-transform: uppercase;" aria-label="Country">
          <input class="input" data-line="amountUsd" data-i="${i}" value="${l.amountUsd === null || l.amountUsd === undefined ? "" : Number(l.amountUsd).toLocaleString("en-US")}" inputmode="decimal" aria-label="Amount">
          <button type="button" class="x" data-line-del="${i}" title="Remove">${icon("x", 12)}</button>`)}
        <span class="sum"><span>${lines.length} ${plural(lines.length, "line")} · ${money(S.view.lineTotalUsd || 0)}${total && Math.abs((S.view.lineTotalUsd || 0) - total) >= 0.005 ? html` <span style="color: var(--red)">≠ ${money(total)}</span>` : total ? html` ${icon("tick", 14, { stroke: 2.4 })}` : ""}</span><button type="button" class="linkbtn" id="add-line">+ Add a line</button></span>
      </div>
      ${fm("money.lines")}
    </div>` : html`<div style="margin-top: 18px;"><button type="button" class="linkbtn" id="toggle-lines">+ Split by site or country</button> <span class="small muted">— when one AFE covers several places</span></div>`}
    ${stepMsgs(v(), 3, ["money.capexUsd", "money.opexUsd", "money.cloudCapexUsd", "money.classification", "budget.budgeted", "budget.potId", "budget.unbudgetedReason", "schedule.fiscalYear", "supplementalOf.ioNumber", "supplementalOf.approvedTotalUsd", "money.lines"], { exceptRules: noteableRules(3) })}
    ${flagNotes(3)}
    ${foot()}`;
}

// ---- 4 · why ----------------------------------------------------------------------------------
function step4() {
  const approver = signerNames(1);
  const extras = S.showExtras || get("project.scope") || get("project.alternatives") || get("project.ehsImpact");
  return html`
    ${returnedBanner()}
    <h1 class="q">Why?</h1>
    <div class="hint">Two or three sentences ${approver ? html`— the first thing ${approver.first.split(" ")[0]} reads.` : html`— the first thing your approvers read.`}</div>
    <textarea class="big" data-field="project.description" placeholder="What it is, in a sentence or two." style="margin-top: 26px; height: 110px;" aria-label="Project description">${get("project.description") || ""}</textarea>
    ${fm("project.description")}
    <label class="lbl">Why now, and why this?</label>
    <textarea class="big" data-field="project.justification" placeholder="The problem it solves and what happens if it waits." style="height: 110px; font-size: 14px;" aria-label="Justification">${get("project.justification") || ""}</textarea>
    ${fm("project.justification")}
    <!-- align-items: end, because the right-hand label carries a second line and the left one
         does not — so without it the two date fields sat 18px apart and read as misaligned. -->
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 26px; align-items: end;">
      <div><label class="lbl" style="margin: 0 0 8px;">Starts</label><input class="input" type="date" data-field="schedule.startDate" value="${get("schedule.startDate") || ""}" aria-label="Estimated start date"></div>
      <!-- Lyndsay asked for a date rather than a year, because the AuC reconciliation needs one
           (Meeting #5, 08:28). The field already existed; what it did not say is that this is
           the date the reconciliation reads as the expected go-live. -->
      <div><label class="lbl" style="margin: 0 0 8px;">Expected completion<span class="optional" style="display: block; font-weight: 400; font-size: 12px;">When it is expected to be in service</span></label><input class="input" type="date" data-field="schedule.finishDate" value="${get("schedule.finishDate") || ""}" aria-label="Expected completion, in-service date"></div>
    </div>
    ${fm(["schedule.startDate", "schedule.finishDate"])}
    ${vAll().applies && vAll().applies.surplusCheck === false ? "" : html`<div class="row" style="margin-top: 14px;" data-key="surplus"><span class="rq"><span class="ico green">${icon("box", 13)}</span><span style="min-width: 0;">${qLabel("project.surplusChecked")}${tip("Acme keeps returned and spare equipment in the surplus area at Site A. Worth a look before buying new.")}</span></span>${toggle("project.surplusChecked", ["Yes", "No"], get("project.surplusChecked"))}</div>`}
    <div class="row"><span class="rq"><span class="ico yellow">${icon("coins", 13)}</span><span>${qLabel("project.buyVsLease")}</span></span>${toggle("project.buyVsLease", ["Yes", "No", "N/A"], get("project.buyVsLease"))}</div>
    <div class="row"><span class="rq"><span class="ico blue">${icon("box", 13)}</span><span>New equipment purchase?</span></span>${toggle("project.newEquipment", ["Yes", "No", { value: "NA", label: "N/A" }], get("project.newEquipment"))}</div>
    <div class="row"><span class="rq"><span class="ico">${icon("external", 13)}</span><span>${qLabel("project.assistAsset")}${tip("An Assist asset is equipment Acme gives to an overseas supplier so they can make what we then import.")}</span></span>${toggle("project.assistAsset", ["Yes", "No"], get("project.assistAsset"))}</div>
    ${fm(["project.surplusChecked", "project.buyVsLease", "project.newEquipment", "project.assistAsset"])}
    ${extras ? html`<div data-key="extras" style="margin-top: 22px;">
      <label class="lbl" style="margin-top: 0;">Scope <span class="optional">— optional</span></label><textarea class="input" data-field="project.scope" rows="2">${get("project.scope") || ""}</textarea>
      <label class="lbl">Alternatives considered <span class="optional">— optional</span></label><textarea class="input" data-field="project.alternatives" rows="2">${get("project.alternatives") || ""}</textarea>
      <label class="lbl">Environmental, regulatory or safety impact <span class="optional">— optional</span></label><textarea class="input" data-field="project.ehsImpact" rows="2">${get("project.ehsImpact") || ""}</textarea>
    </div>` : html`<button type="button" class="linkbtn" id="show-extras" style="margin-top: 16px; font-size: 13px;">+ Add scope, alternatives or safety impact</button>`}
    ${stepMsgs(v(), 4, ["project.description", "project.justification", "schedule.startDate", "schedule.finishDate", "project.surplusChecked", "project.buyVsLease", "project.newEquipment", "project.assistAsset"], { exceptRules: noteableRules(4) })}
    ${flagNotes(4)}
    ${foot()}`;
}

// ---- 5 · cloud capex --------------------------------------------------------------------------
function step5() {
  const tree = session.refdata.cloudTree;
  const answers = afe().cloud || {};
  const outcome = S.view.cloud || {};
  let reached = true;
  return html`
    ${returnedBanner()}
    <h1 class="q">Is this Cloud CapEx?</h1>
    <div class="hint">Four questions, in order. It stops as soon as it has an answer.</div>
    <div style="margin-top: 26px; display: flex; flex-direction: column; gap: 18px;">
      ${tree.map((q, i) => {
        const value = answers[q.id] || null;
        const show = reached;
        if (show && value === null) reached = false;
        if (show && value !== null) {
          const stops = (q.noOutcome && value === "No") || (q.perpetualOutcome && value === "Perpetual") || (q.yesOutcome && value === "Yes");
          if (stops) reached = false;
        }
        return show ? html`<div class="card pad" data-key="q${i}">
          <div style="font-size: 14px; font-weight: 700; line-height: 1.35;">${i + 1}. ${q.q}</div>
          <div style="margin-top: 12px;">${chips("cloud." + q.id, q.options, value, { small: true })}</div>
        </div>` : "";
      })}
    </div>
    <div class="chips" style="margin-top: 22px;" id="cloud-chips">
      ${outcome.outcome === "cloud_capex" ? reveal("These answers make it Cloud CapEx", { tone: "blue", icon: "tick", avatarTone: "blue", key: "cca" }) : ""}
      ${outcome.outcome === "regular_capex" ? reveal("Regular CapEx — not cloud", { icon: "tick", key: "reg" }) : ""}
      ${outcome.outcome === "not_applicable" ? reveal("The Cloud CapEx questions do not apply", { tone: "grey", icon: "tick", avatarTone: "grey", key: "na" }) : ""}
      ${outcome.fpaReviewRequired ? reveal("Externally hosted — the FP&A Business Partner must review it", { tone: "yellow", icon: "bang", avatarTone: "gold", key: "fpa" }) : ""}
    </div>
    ${stepMsgs(v(), 5, [], { exceptRules: noteableRules(5) })}
    ${flagNotes(5)}
    ${foot()}`;
}

// ---- 6 · quote --------------------------------------------------------------------------------
/**
 * A flag that does not block, and a box to say why it is acceptable.
 *
 * Imogen asked for the box (Meeting #5, 24:26); Euan said what it is for: "it will be easy for
 * the approval, because once they receive for the approval, then there is an exception around
 * it. So either they need to send it back or start a communication to understand why it is a
 * red flag" (24:46). So this is not an annotation the requester keeps to themselves — the note
 * is printed on the form, shown to every approver and carried into the DocuSign message.
 */
/** The rules that have a note box on this step — so nothing repeats their message underneath. */
function noteableRules(step) {
  return (vAll().noteable || [])
    .filter((n) => (vAll().warns.concat(vAll().pending).find((e) => e.rule === n.rule) || {}).step === step)
    .map((n) => n.rule);
}
/** This step's field messages, less any a note box on the step already prints. */
const fm = (field, opts) => fieldMsgs(v(), field, Object.assign({}, opts, { exceptRules: [].concat((opts && opts.exceptRules) || [], noteableRules(S.step)) }));
function flagNotes(step) {
  const rows = (vAll().noteable || []).filter((n) => (vAll().warns.concat(vAll().pending)
    .find((e) => e.rule === n.rule) || {}).step === step);
  if (!rows.length) return html``;
  return html`<div data-key="flag-notes-${step}" style="margin-top: 18px;">
    ${rows.map((n) => html`<div class="card pad" data-key="${n.rule}" style="border-left: 4px solid var(--yellow);">
      <div style="display: flex; gap: 10px; align-items: flex-start;">
        ${icon("bang", 16)}
        <div style="min-width: 0; flex: 1;">
          <div style="font-size: 12.5px; font-weight: 700;">${n.message}${msgExtras(n)}</div>
          <textarea class="input" data-flag-note="${n.rule}" rows="2" maxlength="500"
            placeholder="Why is this alright? Everyone who approves this will read it."
            style="margin-top: 10px;">${n.note || ""}</textarea>
          <div class="small muted" style="margin-top: 6px;">Goes onto the form, the approver's screen and the signature request.</div>
        </div>
      </div>
    </div>`)}
  </div>`;
}

// What may be attached, and which of it is priced: the server's own lists (refData), so a new role
// reaches this screen without a second copy of it here (R150).
const supportingRoles = () => (session.refdata && session.refdata.supportingRoles) || ["quote", "sow", "backup", "internal_quote", "material_evidence"];
const quoteRoles = () => (session.refdata && session.refdata.quoteRoles) || ["quote", "sow", "internal_quote"];
const ROLE_WORD = { quote: "Vendor quote", sow: "Statement of work", backup: "Supporting", internal_quote: "Acme quotation", material_evidence: "SAP material" };
// A screenshot is a screenshot (R151): the server sniffs the bytes, this only keeps an obvious
// wrong file from making the round trip.
const FILE_OK = (f) => /\.(pdf|png|jpe?g)$/i.test(f.name) || ["application/pdf", "image/png", "image/jpeg"].includes(f.type);
const ACCEPT = "application/pdf,image/png,image/jpeg,.pdf,.png,.jpg,.jpeg";

function dropZone(role, title, sub) {
  const have = (afe().documents || []).some((d) => d.role === role);
  return html`<label class="drop ${S.uploading ? "over" : ""} ${have ? "has" : ""}" style="display: block; cursor: pointer;" data-drop="${role}" data-key="drop-${role}">
    ${icon(have ? "tick" : "upload", 30, { stroke: 1.4 })}
    <div style="font-size: 14px; font-weight: 700; margin-top: 8px;">${S.uploading ? S.uploading : html`${title} — drop it here, or <span style="color: var(--link)">browse</span>`}</div>
    <div class="small muted" style="margin-top: 4px;">${sub} · PDF, PNG or JPEG · up to 25 MB</div>
    <input type="file" data-file="${role}" accept="${ACCEPT}" multiple>
  </label>`;
}

// ---- the quote reader (R170) ------------------------------------------------------------------
// What the reader proposed for one quote, and what a person did with it. A proposal is shown AS a
// proposal — read values with their confidence, each one a Show me onto the page it came from —
// and counts for nothing until somebody presses Use these. Nothing at all is said while the reader
// is switched off, because the typed figures are then the whole story.
const READ_STALE_MS = 3 * 60 * 1000;
const readingNow = (r) => Boolean(r) && r.status === "reading" && Date.now() - Date.parse(r.startedAt || 0) <= READ_STALE_MS;
const READ_WORD = { amount: "Total", quoteDate: "Dated", vendor: "Vendor" };
function readValue(name, f) {
  if (name === "amount") return f.currency && f.currency !== "USD" ? `${f.currency} ${Number(f.value).toLocaleString("en-US")}` : money(f.value);
  if (name === "quoteDate") return date(f.value);
  return f.value;
}
function readingLine(d) {
  const r = d.reading;
  const canAsk = S.view.readerOn && S.view.permissions && S.view.permissions.canEdit;
  const again = canAsk ? html`<button type="button" class="linkbtn" data-read="${d.attachmentId}">${r ? "Read it again" : "Read it"}</button>` : "";
  if (!r) return canAsk ? html`<div class="readline off" data-key="read-${d.attachmentId}">${icon("search", 13)}<span>Attached before the quote reader was on.</span>${again}</div>` : "";
  if (readingNow(r)) return html`<div class="readline busy" data-key="read-${d.attachmentId}"><span class="spin" aria-hidden="true"></span><span>Reading the quote — carry on, it will show here.</span></div>`;
  if (r.status !== "read") {
    // The reason is about the platform, so it is an administrator's to read; everyone else is told
    // what it means for them.
    const why = r.status === "reading" ? " — it was interrupted" : r.reason && session.me && session.me.isAdmin ? `: ${r.reason}` : "";
    return html`<div class="readline off" data-key="read-${d.attachmentId}">${icon("info", 13)}<span>Not read automatically${why}. Type the figures — they are the ones used.</span>${again}</div>`;
  }
  const fields = r.fields || {};
  const names = Object.keys(fields);
  const held = r.held || [];
  const min = Math.round((r.minConfidence || 0.8) * 100);
  if (r.decision) {
    const skipped = r.decision.skipped || [];
    return html`<div class="readline done" data-key="read-${d.attachmentId}">${icon(r.decision.outcome === "used" ? "tick" : "x", 13)}<span>${r.decision.outcome === "used"
      ? `Filled from the quote by ${r.decision.byName}${skipped.length ? ` · ${skipped.map((s) => s.why).join("; ")}` : ""}`
      : `Reading set aside by ${r.decision.byName} — the typed figures stand`}</span></div>`;
  }
  if (!names.length) {
    return html`<div class="readline off" data-key="read-${d.attachmentId}">${icon("info", 13)}<span>Nothing on it was read surely enough to offer${held.length ? ` — the best was ${Math.round((Math.max(...held.map((h) => h.confidence || 0))) * 100)}%, under ${min}%` : ""}. Type the figures.</span></div>`;
  }
  return html`<div class="readline offer" data-key="read-${d.attachmentId}">
    <span class="rl-hd">${icon("search", 13)} Read from the quote</span>
    <span class="rl-vals">${names.map((n) => html`<a class="rl-v" data-key="${n}" href="/api/afes/${S.id}/documents/${d.attachmentId}/reading/${n}/show.pdf" target="_blank" rel="external" title="Show me where it was read">${READ_WORD[n] || n} <b>${readValue(n, fields[n])}</b> <i>${Math.round(fields[n].confidence * 100)}%</i></a>`)}</span>
    <span class="rl-acts"><button type="button" class="pillbtn sm dark" data-use-reading="${d.attachmentId}">Use these</button><button type="button" class="pillbtn sm soft" data-setaside-reading="${d.attachmentId}">Not right</button></span>
    ${held.length ? html`<span class="rl-held">Not offered, under ${min}%: ${held.map((h) => `${(READ_WORD[h.field] || h.field).toLowerCase()} (${Math.round((h.confidence || 0) * 100)}%)`).join(", ")}.</span>` : ""}
  </div>`;
}

// A read runs on the server after the upload has been answered. While one is in flight on this AFE
// the card says so and this asks again every second and a half — for a minute and a half at most,
// and only while the AFE is on screen. Only the documents are taken from the answer: everything
// else on the screen is the person's, and may be in the middle of being typed.
let readWatch = null;
function watchReadings() {
  if (readWatch || !S.view || !(afe().documents || []).some((d) => readingNow(d.reading))) return;
  const id = S.id, until = Date.now() + 90 * 1000;
  const tick = async () => {
    readWatch = null;
    if (!S.root || S.id !== id || !S.view || Date.now() > until) return;
    if (!(afe().documents || []).some((d) => readingNow(d.reading))) return;
    try {
      const v = await api.get(`/api/afes/${id}`);
      if (S.id !== id || !S.view) return;
      S.view.afe.documents = v.afe.documents;
      paint();
    } catch (e) { /* the next tick asks again */ }
    if (!readWatch && (afe().documents || []).some((d) => readingNow(d.reading))) readWatch = setTimeout(tick, 1500);
  };
  readWatch = setTimeout(tick, 1500);
}

function step6() {
  const docs = (afe().documents || []).filter((d) => supportingRoles().includes(d.role));
  const priced = docs.filter((d) => quoteRoles().includes(d.role));
  const total = S.view.totalUsd || 0;
  const quoteTotal = S.view.quoteTotalUsd || 0;
  const coverage = total ? pct(quoteTotal, total) : null;
  const typed = priced.every((d) => d.amountUsd !== null && d.amountUsd !== undefined);
  // Where the equipment comes from (R150). Asked only of an AFE that buys something physical,
  // decided by the server (`validation.applies.sourcing`), and an outside vendor until said otherwise.
  const asks = Boolean(vAll().applies && vAll().applies.sourcing);
  const internal = asks && get("sourcing") === "internal";
  const sourcing = (session.refdata && session.refdata.sourcing) || [{ id: "vendor", label: "An outside vendor" }, { id: "internal", label: "Acme inventory" }];
  return html`
    ${returnedBanner()}
    <h1 class="q">${internal ? "Attach the Acme quotation." : "Attach the quote."}</h1>
    ${asks ? html`<div class="row wide-answers" style="margin-top: 14px;" data-key="sourcing"><span class="rq"><span class="ico green">${icon("box", 13)}</span><span style="min-width: 0;">Where does it come from?${tip("Equipment moved out of Acme's own inventory is priced by a Acme quotation, and the material is shown as SAP displays it, instead of a vendor quote.")}</span></span>${toggle("sourcing", sourcing.map((s) => ({ value: s.id, label: s.label })), get("sourcing") || "vendor")}</div>` : ""}
    <div class="hint">${internal ? "The quotation Acme generates, and a screenshot of the material in SAP." : "From the vendor."} Type the quote's total so we can check it covers your estimate.${tip(S.view.readerOn ? "The quote can be read for you, and what is read is only a proposal: nothing counts until you press Use these, and you can always type the figures yourself." : "Nothing is read off the file. The total you type is the only figure used.")}</div>
    <div class="drops ${internal ? "two" : ""}" style="margin-top: 22px;" data-key="drops-${internal ? "internal" : "vendor"}">
      ${internal
        ? html`${dropZone("internal_quote", "The Acme quotation", "The quote Acme generates")}${dropZone("material_evidence", "The material in SAP", "A Display Material screenshot")}`
        : dropZone("quote", "The vendor's quote", "Or a statement of work")}
    </div>
    ${(S.uploadErrors || []).map((x, i) => html`<div class="field-msg block" data-key="upfail-${i}" style="margin-top: 10px;">${icon("bang", 14)}<span><b>${x.name}</b> was not attached: ${x.message}</span></div>`)}
    ${docs.length ? html`<div class="card" style="margin-top: 14px; overflow: hidden;" data-key="docs">
      ${docs.map((d) => { const priced = quoteRoles().includes(d.role); return html`<div class="doc ${priced ? "priced" : ""}" data-key="${d.attachmentId}">
        ${docBadge(d.role, d.filename)}
        <span class="meta"><span class="name">${d.filename}</span><span class="desc">${ROLE_WORD[d.role] || d.role} · ${Math.max(1, Math.round((d.sizeBytes || 0) / 1024))} KB · <a href="/api/afes/${S.id}/documents/${d.attachmentId}/raw" target="_blank" rel="external">open</a></span></span>
        <button type="button" class="x" data-doc-del="${d.attachmentId}" title="Remove">${icon("x", 12)}</button>
        ${/* A priced document's own facts take a line of their own under its name: who, how much, and
             the date on it (R169) — over 90 days old when the AFE is sent is flagged. */ ""}
        ${priced ? html`<span class="doc-fields">
          <span class="doc-price"><input class="input doc-vendor" data-doc="vendor" data-att="${d.attachmentId}" value="${d.vendor || ""}" placeholder="Vendor" aria-label="Vendor">
          <span class="muted">$</span><input class="input doc-amount" data-doc="amountUsd" data-att="${d.attachmentId}" value="${d.amountUsd === null || d.amountUsd === undefined ? "" : Number(d.amountUsd).toLocaleString("en-US")}" placeholder="total" inputmode="decimal" aria-label="Quote total"></span>
          <span class="doc-when"><span class="muted">dated</span><input type="date" class="input doc-date" data-doc-date="1" data-att="${d.attachmentId}" value="${d.quoteDate || ""}" max="${new Date().toISOString().slice(0, 10)}" aria-label="Date on the quote"></span>
        </span>` : ""}
        ${priced && S.docSave[d.attachmentId] ? html`<span class="doc-save small ${S.docSave[d.attachmentId].st}" data-key="docsave-${d.attachmentId}" aria-live="polite">${S.docSave[d.attachmentId].st === "saving" ? "Saving…" : S.docSave[d.attachmentId].st === "saved" ? html`${icon("tick", 12, { stroke: 2.4 })} Saved` : html`${icon("bang", 12)} Not saved — ${S.docSave[d.attachmentId].msg}`}</span>` : ""}
        ${S.confirmDel === d.attachmentId ? html`<span class="doc-confirm small" data-key="del-${d.attachmentId}">Remove ${d.filename}${priced ? " and the vendor, total and date typed for it" : ""}? <button type="button" class="linkbtn" data-doc-del-yes="${d.attachmentId}" style="color: var(--red);">Remove</button> <button type="button" class="linkbtn" data-doc-del-no="1">Keep it</button></span>` : ""}
        ${priced ? readingLine(d) : ""}
      </div>`; })}
    </div>` : ""}
    <div class="chips" style="margin-top: 18px;" id="quote-chips">
      ${priced.length && typed && coverage !== null ? reveal(coverText(quoteTotal, total), { tone: coverage >= Math.round(session.refdata.quoteCoverageMin * 100) ? "" : "yellow", icon: coverage >= Math.round(session.refdata.quoteCoverageMin * 100) ? "tick" : "bang", avatarTone: coverage >= Math.round(session.refdata.quoteCoverageMin * 100) ? "" : "gold", key: "cov" }) : ""}
    </div>
    ${/* What the quotes leave out, said by the person who knows (2026-10-16). Below the minimum the
          warning's own note box asks this (flagNotes); above it nothing asked, so the approvers did. */ ""}
    ${priced.length && typed && coverage !== null && quoteTotal < total && !noteableRules(6).includes("quote_covers_estimate") ? html`<div class="card pad" style="margin-top: 12px;" data-key="cover-rest">
      <label class="small" style="font-weight: 700;" for="cover-rest">What covers the other ${money(total - quoteTotal)}? <span class="optional">— optional</span></label>
      <textarea class="input" id="cover-rest" data-flag-note="quote_covers_estimate" rows="2" maxlength="500" placeholder="e.g. installation by our own team; freight is quoted separately" style="margin-top: 8px;">${((afe().flagNotes || []).find((n) => n.ruleId === "quote_covers_estimate") || {}).note || ""}</textarea>
      <div class="small muted" style="margin-top: 6px;">The approvers read this beside the amounts.</div>
    </div>` : ""}
    ${fieldMsgs(v(), "documents", { max: 3, exceptRules: noteableRules(6) })}
    ${flagNotes(6)}
    ${stepMsgs(v(), 6, ["documents"], { exceptRules: noteableRules(6) })}
    ${foot({ label: "Review" })}`;
}

// ---- 7 · review -------------------------------------------------------------------------------
// ---- 8 · the financial case (R94, R96, R97) ---------------------------------------------------
//
// Aggregation first (design rule 1): the four figures an approver actually reads, then the grid
// only if you ask for it. THE COMMON CASE IS ZERO TYPING — the first visit fills one capital row
// and one asset from what the AFE already knows, in the year it is expected to be in service,
// and the only thing left to answer is how long the asset lasts.
const coverText = (q, t) => coverage(q, t).text;
/** A question's words, from FIELDS — the same words its "Pick one." message uses. */
const qLabel = (field) => (specFor(field) || {}).label || field;
const FIN = () => S.view.financials || null;
const finInput = () => afe().financials || null;
const finYears = () => (session.refdata.financials || { years: 11 }).years;

/** A blank grid built from what the AFE already says, so nobody starts at eleven empty columns. */
function seedFinancials() {
  const years = finYears();
  const total = (Number(get("money.capexUsd")) || 0) + (Number(get("money.cloudCapexUsd")) || 0);
  // The case starts in the AFE's own year, with the capital in its first column (R162): signed
  // AFE 313453 runs 2026 … 2036 that way. It started a year early before — the finish year less
  // one — so an AFE starting in 2026 opened on a 2025 column nobody spends in. The same order as
  // `financials.caseYear` on the server; the clock is only the last resort of a blank draft.
  const yr = (d) => Number(String(d || "").slice(0, 4)) || null;
  const startYear = yr(get("schedule.startDate")) || Number(get("schedule.fiscalYear")) || yr(get("schedule.finishDate")) || new Date().getUTCFullYear();
  const at = 0;
  const row = (description, amount) => {
    const amounts = new Array(years).fill(0);
    if (amount) amounts[at] = amount;
    return { description, amounts };
  };
  return {
    startYear,
    capexRows: [row(get("project.title") || "Capital", total)],
    opexRows: [], cloudRows: [], benefitRows: [],
    assets: [{
      description: get("project.title") || "Capital",
      costUsd: total || null, lifeYears: null,
      inServiceDate: get("schedule.finishDate") || null,
      assetClass: null, assetLife: null,
    }],
    costCentreRows: [],
  };
}

const bigMoney = (n) => (n === null || n === undefined ? "—" : money(n));

/**
 * The answer, before the four numbers that support it (R131).
 *
 * "Very black and white — why would it be seen as better than editing in Excel?" Because a
 * spreadsheet gives you four cells and leaves the conclusion to you. These four figures already
 * KNEW the verdict — and `.kpi .v` had a green and a blue and no red, so a negative NPV and a
 * \u221278% ROI rendered in exactly the same ink as a healthy one. A figure that decides whether a
 * project goes ahead should not look like a figure that does not.
 */
function finVerdict() {
  const f = FIN();
  if (!f) return "";
  const noBenefits = f.totals.benefits === 0;
  const rate = Math.round((f.policy.discountRate || 0.1) * 100);
  if (noBenefits) {
    return html`<div class="verdict warn" data-key="verdict">
      <span class="ico">${icon("info", 16)}</span>
      <span><span class="t">No savings entered, so these are costs only.</span>
      <span class="d">Add what it saves, or leave it if it saves nothing.</span></span>
      <button type="button" class="pillbtn sm dark" id="fin-benefits">${icon("trend", 13)}Add savings</button></div>`;
  }
  const good = f.npv >= 0;
  return html`<div class="verdict ${good ? "good" : "bad"}" data-key="verdict">
    <span class="ico">${icon(good ? "tick" : "bang", 16, { stroke: good ? 2.4 : 2 })}</span>
    <span><span class="t">${good
      ? `It pays for itself${f.paybackWithin ? ` in ${f.payback} years` : ""}.`
      : `It does not pay for itself.`}</span>
    <span class="d">${good
      ? html`Worth <b>${bigMoney(f.npv)}</b> today at ${rate}%.`
      : html`<b>${bigMoney(Math.abs(f.npv))}</b> short in today's money. That can be fine \u2014 <a href="/afe/${S.id}/edit/4">say why in the justification</a>.`}</span></span></div>`;
}

function finSummary() {
  const f = FIN();
  if (!f) return "";
  // The money counts up as you type — reading a number that MOVED tells you it changed, which is
  // the one thing a static figure cannot say on a screen you edit a cell at a time.
  const figure = (label, value, tone, glyph, sub) => html`<div class="kpi finfig t-${tone}" data-key="${label}">
    <div class="k">${icon(glyph, 12)}${label}</div><div class="v ${tone === "green" ? "green" : tone === "red" ? "red" : tone === "amber" ? "amber" : ""}">${value}</div>
    ${sub ? html`<div class="sub">${sub}</div>` : ""}</div>`;
  const rate = Math.round((f.policy.discountRate || 0.1) * 100);
  const irrTone = f.irr === null ? "grey" : f.irr >= rate ? "green" : f.irr > 0 ? "amber" : "red";
  return html`<div class="kpis fin" data-key="fin-kpis" style="margin-top: 14px;">
    ${figure("NPV over " + f.years.length + " years", bigMoney(f.npv), f.npv >= 0 ? "green" : "red", f.npv >= 0 ? "trend" : "bang",
      `at ${rate}%`)}
    ${figure("ROI", `${f.roiPct}%`, f.roiPct >= 0 ? "green" : "red", f.roiPct >= 0 ? "trend" : "bang",
      f.roiPct >= 0 ? "back on the spend" : "less back than spent")}
    ${figure("Payback", f.paybackWithin ? `${f.payback} yrs` : `over ${f.years.length - 1}`, f.paybackWithin ? "green" : "red", "clock",
      f.paybackWithin ? "to break even" : "never breaks even")}
    ${figure("IRR", f.irr === null ? "\u2014" : `${f.irr}%`, irrTone, "chart",
      f.irr === null ? "never breaks even" : f.irr >= rate ? `clears ${rate}%` : f.irr > 0 ? `under ${rate}%` : "negative")}
  </div>`;
}

/**
 * What the earlier steps already said, carried into this one (R131).
 *
 * "Should it be mentioned somewhere that in the previous step, the number mentioned was X?" —
 * and it is not only a convenience. THREE numbers here have to agree and nothing was comparing
 * them: what "How much" asked for, what the grid spends, and what the assets depreciate. On the
 * screen that prompted this they were $140,000, $120,000 and $140,000 — a $20,000 hole that
 * makes every figure above wrong, sitting in plain sight with nothing to point at it.
 */
function finCarry() {
  const f = FIN(), input = finInput();
  if (!f || !input) return "";
  const asked = (Number(get("money.capexUsd")) || 0) + (Number(get("money.cloudCapexUsd")) || 0);
  const spent = f.totals.outflows - f.totals.opex;          // the capital in the grid
  const depreciated = (input.assets || []).reduce((n, a) => n + (Number(a.costUsd) || 0), 0);
  const near = (a, b) => Math.abs(a - b) < 1;
  const allAgree = near(asked, spent) && near(asked, depreciated);
  const cell = (k, v, glyph, state) => html`<div class="cell ${state || ""}" data-key="${k}">
    <span class="k">${icon(glyph, 11)}${k}</span><span class="v">${money(v)}</span></div>`;
  return html`<div class="carry" data-key="carry">
    ${cell("How much said", asked, "coins", allAgree ? "agree" : "")}
    ${cell("In the grid", spent, "chart", near(spent, asked) ? (allAgree ? "agree" : "") : "off")}
    ${cell("Being depreciated", depreciated, "box", near(depreciated, asked) ? (allAgree ? "agree" : "") : "off")}
    ${allAgree
      ? html`<div class="cell" style="border-right: 0;"><span class="k">${icon("tick", 11)}They match</span><span class="v" style="font-size: 12.5px; font-weight: 400; color: var(--ink-2);">Nothing to fix.</span></div>`
      : html`<div class="act"><button type="button" class="pillbtn sm dark" id="fin-match">${icon("refresh", 13)}Match them to ${money(asked)}</button></div>`}
  </div>`;
}

/**
 * Depreciation, DRAWN (R131).
 *
 * This was a grey sentence: "Depreciates at $24,000 a year, half of that in 2026 and in the year
 * it leaves." The half-year convention is a SHAPE — a short bar at each end with full bars
 * between — and the picture is understood before the sentence is read. It is also the single
 * clearest answer to "why is this better than a spreadsheet": Excel would make you build it.
 */
function deprecStrip(a, life) {
  const cost = Number(a.costUsd) || 0;
  const yrs = Number(a.lifeYears) || 0;
  if (!cost || !yrs) return "";
  const perYear = cost / yrs;
  const start = a.inServiceDate ? Number(String(a.inServiceDate).slice(0, 4)) : null;
  // The half-year convention: half in the year it goes in and half in the year it leaves, so the
  // schedule spans one more year than the life.
  const bars = [];
  const n = start ? yrs + 1 : yrs;
  for (let i = 0; i < n; i += 1) {
    const half = start ? (i === 0 || i === n - 1) : false;
    bars.push({ year: start ? start + i : null, amount: half ? perYear / 2 : perYear });
  }
  const max = Math.max(...bars.map((b) => b.amount), 1);
  return html`<div style="margin-top: 9px;" data-key="dep">
    <div class="small muted"><b>${money(perYear)}</b> a year over <b>${yrs} years</b>${start ? ", half at each end" : ""}.${life && life.openRange
      ? tip(`This band covers a range of years. Acme's own worked example takes the top of it, so ${yrs} years is what the form prints.`) : ""}</div>
    <div class="deprec" role="img" aria-label="Depreciation of ${money(cost)} over ${n} years${start ? ", half in " + start + " and half in the final year" : ""}.">
      ${bars.map((b, i) => html`<i style="height: ${Math.max(5, Math.round((b.amount / max) * 30))}px;" title="${b.year ? b.year + ": " : ""}${money(b.amount)}" data-key="b${i}"></i>`)}
    </div>
    ${start ? html`<div class="deprecfoot"><span>${bars[0].year}</span><span>fully written down by ${bars[bars.length - 1].year}</span></div>` : ""}
  </div>`;
}

/** One asset: what it cost, how long it lasts, and the two SAP designations. */
function assetRow(a, i) {
  const lives = session.refdata.assetLives || [];
  const classes = session.refdata.assetClasses || [];
  const life = lives.find((l) => l.value === a.assetLife) || null;
  return html`<div class="card pad" data-key="asset-${i}" style="margin-top: 10px;">
    <div style="display: flex; gap: 10px; align-items: center;">
      <input class="input" data-asset="description" data-i="${i}" value="${a.description || ""}" placeholder="What is being bought" aria-label="Asset description" style="flex: 1 1 200px;">
      <span class="muted">$</span>
      <input class="input" data-asset="costUsd" data-i="${i}" value="${a.costUsd === null || a.costUsd === undefined ? "" : Number(a.costUsd).toLocaleString("en-US")}" placeholder="cost" inputmode="decimal" aria-label="Cost" style="width: 130px;">
      ${(finInput().assets || []).length > 1 ? html`<button type="button" class="x" data-asset-del="${i}" title="Remove">${icon("x", 12)}</button>` : ""}
    </div>
    <div style="display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 150px; gap: 10px; margin-top: 10px;">
      <label style="min-width: 0;"><span class="sect">ASSET LIFE</span>
        <select class="input" data-asset="assetLife" data-i="${i}" aria-label="Asset life" style="margin-top: 5px;">
          <option value="">Choose…</option>
          ${lives.map((l) => html`<option value="${l.value}" ${l.value === a.assetLife ? "selected" : ""}>${l.label} — ${l.years} yrs</option>`)}
        </select></label>
      <label style="min-width: 0;"><span class="sect">ASSET CLASS</span>
        <select class="input" data-asset="assetClass" data-i="${i}" aria-label="Asset class" style="margin-top: 5px;">
          <option value="">Choose…</option>
          ${classes.map((c) => html`<option value="${c.value}" ${c.value === a.assetClass ? "selected" : ""}>${c.value}</option>`)}
        </select></label>
      <label><span class="sect">IN SERVICE</span>
        <input class="input" type="date" data-asset="inServiceDate" data-i="${i}" value="${(a.inServiceDate || "").slice(0, 10)}" aria-label="Date in service" style="margin-top: 5px;"></label>
    </div>
    ${a.lifeYears ? deprecStrip(a, life) : ""}
  </div>`;
}

/** What a grid cell may hold: digits, grouping commas, one decimal point, a leading minus or $. */
const FIN_NUMBER = /^-?\$?(\d[\d,]*)?(\.\d*)?$/;

/** The eleven-year grid, one section at a time. Shown only when asked for. */
function finGrid() {
  const f = FIN(), input = finInput();
  if (!f || !input) return "";
  const years = f.years;
  const section = (key, label, rows, tone, glyph) => html`<div class="finsec ${tone || ""}" data-key="sec-${key}">
    <div class="sect">${icon(glyph || "chart", 13)} ${label}</div>
    ${(rows || []).map((r, i) => html`<div class="finrow" data-key="${key}-${i}">
      <input class="input" data-fin="description" data-list="${key}" data-i="${i}" value="${r.description || ""}" placeholder="What it is" aria-label="Description">
      ${years.map((y, n) => html`<input class="input num" data-fin="amount" data-list="${key}" data-i="${i}" data-y="${n}"
        value="${Number(r.amounts && r.amounts[n]) || ""}" inputmode="decimal" aria-label="${label} ${y}">`)}
      <button type="button" class="x" data-fin-del="${key}:${i}" title="Remove">${icon("x", 12)}</button>
    </div>`)}
    ${S.finBad && S.finBad.key === key ? html`<div class="field-msg block" data-key="fin-num-${key}">${icon("bang", 14)}<span>Numbers only — like 12,500 or -3000.50. That cell was not saved.</span></div>` : ""}
    <button type="button" class="linkbtn" data-fin-add="${key}" style="margin-top: 6px;">+ Add a row</button>
  </div>`;
  // The ACCUMULATED row is the one a spreadsheet makes you read down yourself: the year it stops
  // being negative is the payback, and marking it is most of what this screen is for.
  const totalRow = (label, values, opts) => { const o = opts || {};
    return html`<div class="finrow total ${o.strong ? "strong" : ""} ${o.sign ? "" : ""}" data-key="t-${label}">
      <span>${label}</span>${values.map((v, n) => { const cross = o.markCrossing && v >= 0 && (n === 0 || values[n - 1] < 0);
        return html`<span data-key="v${n}"><span class="${cross ? "crossed" : ""}">${v ? money(v) : "\u2014"}</span></span>`; })}<span></span></div>`; };
  return html`<div class="card pad" data-key="fin-grid" style="margin-top: 16px; overflow-x: auto;">
    <div class="finrow head" data-key="head"><span>All amounts in USD</span>${years.map((y) => html`<span data-key="y${y}">${y}</span>`)}<span></span></div>
    ${section("capexRows", "Capital expenditures", input.capexRows, "capex", "coins")}
    ${totalRow("Total CapEx", f.capex)}
    ${section("opexRows", "Operating expenses", input.opexRows, "opex", "refresh")}
    ${totalRow("Total OpEx", f.opex)}
    ${section("cloudRows", "Cloud CapEx", input.cloudRows, "cloud", "box")}
    ${totalRow("Total Cloud CapEx", f.cloud)}
    ${totalRow("TOTAL CASH OUTFLOWS", f.outflows, { strong: true })}
    ${section("benefitRows", "Recurring costs & benefits", input.benefitRows, "benefit", "trend")}
    ${totalRow("Total benefits", f.benefits)}
    ${totalRow("Depreciation", f.depreciation)}
    ${totalRow("Net cash flow", f.netCashFlow, { strong: true })}
    ${totalRow("Accumulated \u2014 the year this turns green is the payback", f.accumulated, { markCrossing: true })}
  </div>`;
}

function step8() {
  const input = finInput();
  const f = FIN();
  const total = (Number(get("money.capexUsd")) || 0) + (Number(get("money.cloudCapexUsd")) || 0);
  return html`
    ${returnedBanner()}
    <h1 class="q">Does it pay for itself?</h1>
    <div class="hint">What it costs, what it saves, what that is worth today.${session.refdata.financials.requiredAboveUsd === null
      ? html` Optional — once started, finish it or remove it.${tip("Nobody has set a value above which the case is required, so leaving it empty never stops the AFE. Once an asset is added it needs a life and an in-service date: depreciation is the cost divided by the life.")}` : ""}</div>
    ${!input
      ? html`<div class="card pad" style="margin-top: 26px; text-align: center; padding: 30px 24px;">
          <div style="font-size: 15px; font-weight: 700;">Start from what you have already entered.</div>
          <div class="muted" style="font-size: 13px; margin-top: 6px; max-width: 460px; margin-left: auto; margin-right: auto; line-height: 1.5;">
            ${money(total)} of capital${get("schedule.finishDate") ? `, in service ${date(get("schedule.finishDate"))}` : ""}. One row and one asset, filled in. You pick how long it lasts.
          </div>
          <button class="cta sm" id="fin-start" style="margin-top: 16px;">Set it up ${CTA_ARROW}</button>
          <div class="small muted" style="margin-top: 10px;">You can come back to this.</div>
        </div>`
      : html`
        ${finVerdict()}
        ${finSummary()}
        ${finCarry()}
        <label class="lbl" style="margin-top: 22px;">What is being bought</label>
        ${(input.assets || []).map((a, i) => assetRow(a, i))}
        ${fieldMsgs(v(), (input.assets || []).map((_, i) => `financials.assets.${i}.lifeYears`).concat(
          (input.assets || []).map((_, i) => `financials.assets.${i}.inServiceDate`)), { max: 3 })}
        <button type="button" class="linkbtn" id="fin-add-asset" style="margin-top: 10px;">+ Add another asset</button>
        <div style="margin-top: 22px; display: flex; gap: 14px; align-items: center; flex-wrap: wrap;">
          <button type="button" class="chip" id="fin-toggle">${S.showGrid ? "Hide" : "Show"} the ${finYears()}-year grid</button>
          ${session.refdata.financials.requiredAboveUsd === null ? html`<button type="button" class="linkbtn quiet" id="fin-remove">Remove the financial case</button>` : ""}
        </div>
        ${S.showGrid ? finGrid() : ""}`}
    ${stepMsgs(v(), 8, (input && input.assets || []).flatMap((_, i) => [
      `financials.assets.${i}.lifeYears`, `financials.assets.${i}.inServiceDate`, `financials.assets.${i}.costUsd`,
    ]), { exceptRules: noteableRules(8) })}
    ${flagNotes(8)}
    ${foot()}`;
}

function step7() {
  const a = afe();
  const p = S.preview;
  const perms = S.view.permissions;
  const ro = !perms.canEdit && !perms.canSend;
  const signers = ((p && p.recipients) || []).filter((r) => r.role !== "cc" && ["pending", "sent", "signed"].includes(r.status));
  const copies = ((p && p.recipients) || []).filter((r) => r.role === "cc");
  const docs = (a.documents || []).filter((d) => supportingRoles().includes(d.role));
  // Whoever the server says may send THIS AFE (R157). A global "is a coordinator" let somebody
  // who coordinates the division send their own AFE past the colleague assigned to review it.
  const iAmSender = perms.canSend;
  // A returned AFE whose round goes on is signed next by whoever held it, not by the preview's
  // first name, and the button says where it is going (R148).
  const goesOn = S.view.resume && S.view.resume.applies && S.view.resume.can ? S.view.resume : null;
  const first = goesOn && goesOn.mode === "paused" && goesOn.holder ? goesOn.holder : signers[0];
  const goesTo = goesOn ? (goesOn.mode === "signed" ? "Fixed Assets" : goesOn.holder ? goesOn.holder.name.split(" ")[0] : "the approver") : "";
  const blocks = vAll().blocks || [], pending = vAll().pending || [];      // the review shows everything
  const chainBlockers = (p && p.blockers) || [];
  // EVERY blocker that stops Send is shown to whoever can send. A mailbox to confirm was shown to
  // coordinators only, so where the requester sends (any division without a coordinator) the
  // page said "Nothing is outstanding" in green beside a disabled Send and "0 things to fix
  // first" (found 2026-10-16). A sender may confirm mailboxes (`canEditRouting`), so it is theirs.
  const shownBlockers = iAmSender ? chainBlockers : [];
  const toFix = blocks.length + shownBlockers.length;     // what the person in front of the screen must do
  const toCome = pending.length;                           // facts that are on their way from somebody else
  const ready = iAmSender ? (vAll().sendable && p && p.canSend) : vAll().ok;
  const stepFor = (e) => (e.step === 7 ? `/afe/${S.id}/review` : `/afe/${S.id}/edit/${e.step || 1}`);
  const pdfSrc = `/api/afes/${S.id}/document.pdf?v=${encodeURIComponent(S.pdfVersion || a.updatedAt || "")}`;
  const titles = (session.refdata && session.refdata.levelTitles) || {};
  const exceptions = vAll().exceptions || [];
  const classLabel = { capex: "CapEx", cloud_capex: "Cloud CapEx", none: "OpEx only" }[get("money.classification")] || "";

  // WHAT EVERY SIGNER HAS IN COMMON, SAID ONCE.
  //
  // Each row used to carry "Senior Manager (A1) for cost centre 30145 — $300,001 – $500,000",
  // which is the same cost centre and the same band on every line, three quarters of it
  // repeated, and far too long for the rail — so it ran off the edge. The level title is what
  // differs; the rest is a caption under the heading. A stand-in, a skipped row or a signer the
  // coordinator added keeps its own sentence, because there the reason IS the information.
  const bandLabel = (S.view.band && S.view.band.label) || "";
  const chainWhy = (r) => {
    if (r.standInFor || r.signsAs || r.role !== "matrix") return r.why;
    return titles[r.level] || r.why;
  };

  const todo = html`
    ${blocks.map((e) => html`<div class="field-msg block" data-key="b-${e.rule || e.field}">${icon("bang", 14)}<span>${e.message}${ro ? "" : html`${fixBtn(e)} <a href="${stepFor(e)}">Fix in ${STEP_LABELS[e.step] || "the form"} →</a>`}</span></div>`)}
    ${pending.map((e) => html`<div class="field-msg pending" data-key="p-${e.rule || e.field}">${icon("clock", 14)}<span>${e.message}${e.step ? html` <a href="${stepFor(e)}">${STEP_LABELS[e.step]} →</a>` : ""}</span></div>`)}
    ${shownBlockers.map((b) => html`<div class="field-msg ${b.code === "emails_unconfirmed" ? "pending" : "block"}" data-key="c-${b.code}">${icon("bang", 14)}<span>${b.message}${b.code === "emails_unconfirmed" && (perms.canEditRouting || perms.canCoordinate) ? html` <a href="/afe/${S.id}/coordinate">Confirm them →</a>` : ""}</span></div>`)}`;

  const noteCard = perms.canSend
    ? html`<div class="card pad" data-key="note">
        <div class="sect yellow">${icon("pen", 13)} NOTE TO APPROVERS <span class="optional" style="text-transform: none; letter-spacing: 0;">— optional</span></div>
        <textarea class="input" data-field="approverNote" rows="2" placeholder="Budgeted under…; quotes cover…; ships before…" style="margin-top: 8px;">${a.approverNote || ""}</textarea>
        <div class="small muted" style="margin-top: 6px; display: flex; gap: 10px; align-items: center;"><span style="flex: 1;">It becomes the DocuSign message and sits at the top of every approver's screen.</span>${saveChip()}</div>
      </div>`
    : a.approverNote ? html`<div class="card pad soft" data-key="note"><div class="sect yellow">${icon("pen", 13)} NOTE TO APPROVERS</div><div style="margin-top: 8px; font-size: 13px;">${a.approverNote}</div></div>` : "";

  return html`
    ${returnedBanner()}

    <!-- The header carries the decision: what, how much, and to how many people. It used to be a
         title and a hint, with the amount nowhere and the total number of signatures nowhere. -->
    <div class="reviewtop" data-key="head">
      <div style="min-width: 0;">
        <h1 class="q">${first ? `This is what ${first.name.split(" ")[0]} signs.` : "This is the form."}</h1>
        <div class="meta">
          <span class="rid">${S.id}</span>
          ${a.costCenter ? tag(`cost centre ${a.costCenter}`, "yellow", { icon: "coins" }) : ""}
          ${a.division ? tag(a.division, "blue", { icon: "box" }) : ""}
          ${classLabel ? tag(classLabel, get("money.classification") === "cloud_capex" ? "" : "grey", { icon: get("money.classification") === "none" ? "minus" : "chart" }) : ""}
          ${a.location ? tag(a.location, "grey", { icon: "pin" }) : ""}
          ${signers.length ? tag(`${signers.length} ${plural(signers.length, "signature")}`, "grey", { icon: "users" }) : ""}
        </div>
      </div>
      <div class="headamt">
        <div class="big-amt" data-count="${S.view.totalUsd || 0}" data-count-as="money">${money(S.view.totalUsd || 0)}</div>
        <div class="small muted">${a.budget && a.budget.budgeted === "Yes" ? "budgeted" : a.budget && a.budget.budgeted === "No" ? "not budgeted" : ""}</div>
      </div>
    </div>

    <!-- What stands between this AFE and Send, across the full width rather than squeezed into a
         400px rail. It is the first thing you need and it was the narrowest thing on the page. -->
    ${blocks.length || pending.length || shownBlockers.length ? html`<div class="card pad todobar ${blocks.length || shownBlockers.some((b) => b.code !== "emails_unconfirmed") ? "stop" : "wait"}" data-key="todo">
      <div class="sect">${toFix ? `${toFix} ${plural(toFix, "thing")} before it can go${toCome ? ` · ${toCome} still to come` : ""}` : "Still to come"}</div>
      ${todo}
    </div>` : html`<div class="card pad todobar go" data-key="ok">
      <div class="okline">${icon("tick", 16, { stroke: 2.4 })}<span><b>Nothing is outstanding.</b> ${goesOn ? (goesOn.mode === "signed" ? "It goes back to Fixed Assets with the signatures it has." : "It goes back into the envelope that is already out.") : iAmSender ? "Pressing Send creates the DocuSign envelope." : `${a.coordinator ? a.coordinator.name : "The coordinator"} shapes the chain and sends it.`}</span></div>
    </div>`}

    ${(vAll().hints || []).map((h) => html`<div class="banner yellow" style="margin-top: 10px;" data-key="hint-${h.id}">${icon("info", 16)}<span>${h.message}${fixBtn(h)}</span></div>`)}

    <div class="split" style="margin-top: 14px;">
      <div style="display: flex; flex-direction: column; gap: 12px; min-width: 0;">
        ${noteCard}
        <!-- Design rule 6: say what is happening. Assembling the document means rendering the
             form and binding every attachment behind it, which takes a moment on a cold cache —
             and until the iframe paints, the reader is looking at a white rectangle with no way
             to tell working from broken. The frame is data-static so a repaint never reloads it;
             the wrapper carries the ready flag, set by the capturing load listener in wire(). -->
        <div data-static data-key="pdf">
          <!-- The link sits on the frame's own top edge, because that is where a reader who
               cannot make the page out actually looks for it. -->
          <div class="pdfbar">
            <span>${icon("doc", 13)}</span>
            <span>The AFE, as it will be sent${docs.length ? ` — with ${docs.length} ${plural(docs.length, "attachment")} bound in` : ""}</span>
            <a class="openpdf" href="${pdfSrc}" target="_blank" rel="external">Open in a new tab ${icon("external", 12)}</a>
          </div>
          <div class="pdfwrap" id="pdfpanel">
            <div class="pdfbusy" aria-live="polite">
              <span class="spin"></span>
              <span><b>Assembling the AFE</b><br>the form, then everything you attached, bound in behind it</span>
            </div>
            <iframe class="pdf-frame" src="${pdfSrc}" title="The AFE, as it will be sent for signature"></iframe>
          </div>
        </div>
      </div>

      <div style="display: flex; flex-direction: column; gap: 12px;">
        <div class="card pad" data-key="env">
          <!-- ONE file (R112). The approvers get a single PDF — the form, then everything
               attached, bound in behind it — because that is what they can actually sign, and a
               quote sent as document 2 is a quote most of them never open. -->
          <div class="sect blue">${icon("doc", 13)} WHAT THEY SIGN — ONE FILE</div>
          <ol class="chain" style="margin-top: 10px;">
            <li class="cstep send"><span class="cnum">${icon("doc", 12)}</span><span style="min-width:0;"><span class="nm">The AFE form</span><span class="why">generated from your answers</span></span></li>
            ${docs.map((d) => html`<li class="cstep" data-key="${d.attachmentId}"><span class="cnum">${icon("plus", 12)}</span><span style="min-width: 0;"><span class="nm">${d.filename}</span><span class="why">bound in behind the form${d.vendor ? " · " + d.vendor : ""}${d.amountUsd ? " · " + money(d.amountUsd) : ""}</span></span></li>`)}
          </ol>
          ${ro ? "" : html`<a href="/afe/${S.id}/edit/6" style="display: inline-block; margin-top: 10px; font-size: 12.5px;">${docs.length ? "+ Add another attachment" : "+ Attach the quote"}</a>`}
        </div>

        <div class="card pad" data-key="who">
          <div class="sect">${icon("users", 13)} WHO SIGNS${signers.length ? ` · ${signers.length}` : ""}</div>
          ${signers.length && (a.costCenter || bandLabel) ? html`<div class="chaincap">${[a.costCenter ? `all for cost centre ${a.costCenter}` : "", bandLabel].filter(Boolean).join(" · ")}</div>` : ""}
          ${signers.length ? signChain([
            ...(a.coordinator && !perms.canSend ? [{ key: "sender", n: icon("send", 12), name: `${a.coordinator.name} sends it`, why: "reviews the chain and the mailboxes first", tone: "send" }] : []),
            ...signers.map((r) => ({ key: r.id, n: r.order, name: r.name, level: r.level || r.group || "", why: chainWhy(r), tone: r.role === "pre_approver" ? "pre" : "" })),
            { key: "fa", n: icon("shield", 12), name: "Fixed Assets", why: "checks, then writes your AFE number on it", tone: "fa" },
          ]) : html`<div class="small muted" style="margin-top: 8px;">Pick the cost centre and an amount and the chain appears here.</div>`}
          ${copies.length ? html`<div class="chaincap" style="margin: 12px 0 0;">copies to ${copies.map((c) => c.name).join(", ")}</div>` : ""}
        </div>

        ${exceptions.length ? html`<div class="card pad" data-key="exceptions" style="border-left: 4px solid var(--edge-yellow);">
          <div class="sect red">${icon("bang", 13)} EXCEPTIONS THEY WILL SEE</div>
          <div class="small muted" style="margin-top: 6px;">A check this AFE does not pass, and the reason you gave. It prints on the form and sits above everything else on each approver's screen.</div>
          ${exceptions.map((e) => html`<div style="margin-top: 12px;" data-key="x-${e.rule}">
            <div style="font-size: 12.5px; font-weight: 700;">${e.label || e.message}</div>
            <div style="font-size: 12.5px; margin-top: 4px;">${e.note}</div>
            <div class="small muted" style="margin-top: 4px;">${[e.byName, e.at ? since(e.at) : ""].filter(Boolean).join(" · ")}</div>
          </div>`)}
          ${ro ? "" : html`<a href="/afe/${S.id}/edit/6" style="display: inline-block; margin-top: 12px; font-size: 12.5px;">Change what it says →</a>`}
        </div>` : ""}

        <div class="small muted" style="padding: 0 4px;">You'll get the signed copy back with DocuSign's certificate — the same document Finance keeps.</div>
      </div>
    </div>

    <!-- The commit bar STICKS. It sat under a 720px document, so the one button the whole
         journey is for was below the fold on every screen smaller than a poster. -->
    ${ro ? html`<div class="foot commit"><a class="back" href="/afe/${a.id}">${icon("chevL", 14, { stroke: 2.2 })}The AFE</a><span class="banner ${a.state === "submitted" ? "yellow" : "grey"}">${icon(a.state === "submitted" ? "clock" : "info", 16)}${a.state === "submitted" && a.coordinator ? `With ${a.coordinator.name} to send. You'll see it move on your requests page.` : `${stateLabel(a.state)} — this is how it reads; it cannot be changed from here.`}</span></div>`
    : a.state === "submitted" && !iAmSender ? html`<div class="foot commit"><button class="back" id="back">${icon("chevL", 14, { stroke: 2.2 })}Back</button><span class="banner yellow">${icon("clock", 16)}With ${a.coordinator.name} to send. You'll see it move on your requests page.</span></div>`
      : html`<div class="foot commit">
          <button class="back" id="back">${icon("chevL", 14, { stroke: 2.2 })}Back</button>
          <span class="commitsum">${ready
            ? html`<b>${money(S.view.totalUsd || 0)}</b> · ${signers.length} ${plural(signers.length, "signature")}${docs.length ? ` · ${docs.length} ${plural(docs.length, "attachment")} bound in` : ""}`
            : html`<button type="button" class="tofix" id="tofix">${icon("bang", 13)}${toFix ? `${toFix} ${plural(toFix, "thing")} to fix first` : toCome ? `${toCome} still to come` : "Not ready to send yet"} ${icon("chevD", 12)}</button>`}</span>
          <button class="cta" id="${iAmSender ? "send" : "submit"}" ${ready ? "" : "disabled"}>${goesOn ? `Resubmit to ${goesTo}` : iAmSender ? "Send for signature" : `Send to ${a.coordinator ? a.coordinator.name.split(" ")[0] : "the coordinator"}`}${CTA_ARROW}</button>
        </div>`}`;
}

// ---- paint + events ---------------------------------------------------------------------------
const bodies = { 1: step1, 2: step2, 3: step3, 4: step4, 5: step5, 6: step6, 7: step7, 8: step8 };
// The coordinator editing an AFE in their review (R157) is in somebody else's form: say so, and
// keep the way back to the routing one click away on every step.
function reviewing() {
  const a = S.view && S.view.afe, p = S.view && S.view.permissions;
  if (!a || !p || a.state !== "submitted" || !p.canCoordinate) return "";
  const who = a.requester && a.requester.name ? a.requester.name.split(" ")[0] : "the requester";
  return html`<div class="banner blue" data-key="reviewing" style="margin-bottom: 14px;">${icon("pen", 16)}<span>You are editing ${who}'s AFE before it goes. <a href="/afe/${a.id}/coordinate">Back to the routing →</a></span></div>`;
}
function markup() {
  const wide = S.step === 7 || (S.step === 8 && S.showGrid);
  const p = S.view && S.view.permissions;
  // Read-only: the steps are where the answers came from, not doors (see step7).
  const journey = p && !p.canEdit && !p.canSend ? steps().map((s) => Object.assign({}, s, { readonly: true })) : steps();
  return html`${stepper(journey, S.step, issues())}<div class="wrap pane ${wide ? "wide" : ""}" data-key="pane-${S.step}">${reviewing()}${bodies[S.step]()}</div>`;
}
function paint() {
  if (!S.root || !S.view) return;
  morph(S.root, markup());
  // The wizard repaints itself on every keystroke, so it runs the same hook the router runs for
  // every other screen rather than keeping a second copy of "what moves". It is idempotent, which
  // is what makes that safe at this frequency.
  afterPaint(S.root);
}

function wire(root) {
  if (S.wiredTo === root) return;
  S.wiredTo = root;
  on(root, "input", "[data-field]", (e, el) => {
    const field = el.dataset.field;
    S.touched.add(field);
    el.dataset.dirty = "1";
    liveCheck(field, el);
    // A date is saved by `change` below and by nothing else. It used to save here TOO, on a zero
    // debounce — so picking a date fired two saves and two repaints a few milliseconds apart,
    // which is the flicker you see the moment the picker closes. Typing one by hand was worse:
    // every digit posted a half-written date.
    if (el.type === "date") return;
    // Free text is written in sentences, with pauses in them: saving on every half-second pause
    // stored "The deal came th" as a flag note. It waits a little longer, and leaving the field
    // saves it at once (below).
    debounce(field, el.tagName === "TEXTAREA" ? 1500 : 500, () => save({ [field]: coerce(field, el.value) }));
  });
  // Leaving a field saves what was typed in it at once, and shows any message that waited for
  // the person to finish (`typingCanFix`). The caret has moved on by the time this runs.
  on(root, "focusout", "[data-field]", (e, el) => {
    if (el.type === "date") return;
    if (el.dataset.dirty) { cancelDebounce(el.dataset.field); save({ [el.dataset.field]: coerce(el.dataset.field, el.value) }); }
    else setTimeout(paint, 0);
  });
  on(root, "change", "input[type=date][data-field]", (e, el) => { cancelDebounce(el.dataset.field); save({ [el.dataset.field]: el.value || null }); });
  // The currency is a pick, saved at once; the server attaches Global Finance's rate (R161).
  on(root, "change", "select[data-currency]", (e, el) => save({ "money.currency": el.value }));
  // `load` does not bubble, so it is caught on the way DOWN. One listener for every frame on
  // the screen rather than an inline handler the escaping tag would not keep.
  root.addEventListener("load", (e) => {
    const f = e.target;
    if (f && f.classList && f.classList.contains("pdf-frame")) {
      const w = f.closest(".pdfwrap");
      if (w) w.dataset.ready = "1";
    }
  }, true);

  on(root, "click", "#add-opex", () => { S.showOpex = true; paint(); });

  // ---- 8 · the financial case (R94, R96, R97) ------------------------------------------------
  // Every edit writes the whole list back, as the cost lines already do: a grid is edited a cell
  // at a time and saved as one thing, and the server recomputes the case from it.
  on(root, "click", "#fin-start", () => save({
    "financials.startYear": seedFinancials().startYear,
    "financials.capexRows": seedFinancials().capexRows,
    "financials.opexRows": [], "financials.cloudRows": [], "financials.benefitRows": [],
    "financials.assets": seedFinancials().assets,
    "financials.costCentreRows": [],
  }));
  // "Match them" — the fix for the three numbers that must agree (R131).
  //
  // It reconciles the two lists THIS step owns against what "How much" asked for, and it never
  // touches "How much" itself: that figure is the AFE's own ask, approved by the chain, and a
  // financial model is not allowed to quietly rewrite the amount being requested. If the ask is
  // the wrong number, it is wrong on the step that collects it.
  on(root, "click", "#fin-match", () => {
    const asked = (Number(get("money.capexUsd")) || 0) + (Number(get("money.cloudCapexUsd")) || 0);
    if (!asked) { toast("Nothing to match — How much has no capital on it.", "err"); return; }
    const input = finInput();
    const assets = (input.assets || []).slice();
    const have = assets.reduce((n, a) => n + (Number(a.costUsd) || 0), 0);
    // Put the difference on the FIRST asset rather than spreading it: a person can see one
    // number change and undo it, and cannot see five.
    if (assets.length) assets[0] = Object.assign({}, assets[0], { costUsd: (Number(assets[0].costUsd) || 0) + (asked - have) });
    // The grid's capital row gets the ask in the first year, which is where the seed puts it.
    const capexRows = (input.capexRows || []).length
      ? input.capexRows.map((r, i) => (i === 0 ? Object.assign({}, r, { amounts: [asked].concat(new Array(Math.max(0, (r.amounts || []).length - 1)).fill(0)) }) : r))
      : [{ description: get("project.title") || "Capital", amounts: [asked] }];
    save({ "financials.assets": assets, "financials.capexRows": capexRows });
    toast(`Matched to ${money(asked)}.`, "ok");
  });
  on(root, "click", "#foot-why", () => {
    const m = $(".field-msg.block", S.root);
    if (m) bringTo(m);
  });
  on(root, "click", "#fin-toggle", () => { S.showGrid = !S.showGrid; paint(); });
  // "Add savings" opens the grid AT a row you can type in, rather than telling somebody where to
  // look. A banner that names a thing should offer it, and offering it means the empty row is
  // already there — landing on a section whose only control is "+ Add a row" is one more click
  // than the button promised (R140).
  on(root, "click", "#fin-benefits", async () => {
    S.showGrid = true;
    if (!(finInput().benefitRows || []).length) {
      await save({ "financials.benefitRows": [{ description: "", amounts: new Array(finYears()).fill(0) }] });
    } else {
      paint();
    }
    const sec = $('[data-key="sec-benefitRows"]', S.root);
    if (!sec) return;
    bringTo(sec);
    const box = $("input", sec);
    if (box) box.focus();
  });
  on(root, "click", "#fin-add-asset", () => {
    const assets = (finInput().assets || []).concat([{ description: "", costUsd: null, lifeYears: null, inServiceDate: null, assetClass: null, assetLife: null }]);
    save({ "financials.assets": assets });
  });
  on(root, "click", "[data-asset-del]", (e, b) => {
    const assets = (finInput().assets || []).slice();
    assets.splice(Number(b.dataset.assetDel), 1);
    save({ "financials.assets": assets });
  });
  // Typing in an asset: local first, saved after a pause, like every other field here.
  on(root, "input", "input[data-asset]", (e, el) => {
    const assets = (finInput().assets || []).slice();
    const a = Object.assign({}, assets[Number(el.dataset.i)]);
    a[el.dataset.asset] = el.dataset.asset === "costUsd" ? parseMoney(el.value) : (el.value || null);
    assets[Number(el.dataset.i)] = a;
    afe().financials.assets = assets;
    el.dataset.dirty = "1";
    debounce("fin-assets", 600, () => {
      for (const x of $$("[data-asset][data-dirty]", root)) delete x.dataset.dirty;
      save({ "financials.assets": afe().financials.assets });
    });
  });
  // Choosing a band sets the YEARS the depreciation actually uses. The label is never parsed:
  // "3-5-Softwares" is a range, and the number beside it in the master is the business's answer.
  on(root, "change", "select[data-asset]", (e, el) => {
    const assets = (finInput().assets || []).slice();
    const a = Object.assign({}, assets[Number(el.dataset.i)]);
    a[el.dataset.asset] = el.value || null;
    if (el.dataset.asset === "assetLife") {
      const band = (session.refdata.assetLives || []).find((l) => l.value === el.value);
      a.lifeYears = band ? band.years : null;
    }
    assets[Number(el.dataset.i)] = a;
    save({ "financials.assets": assets });
  });
  on(root, "change", "input[type=date][data-asset]", (e, el) => {
    cancelDebounce("fin-assets");
    const assets = (finInput().assets || []).slice();
    assets[Number(el.dataset.i)] = Object.assign({}, assets[Number(el.dataset.i)], { inServiceDate: el.value || null });
    save({ "financials.assets": assets });
  });

  on(root, "click", "[data-fin-add]", (e, b) => {
    const key = b.dataset.finAdd;
    const rows = (finInput()[key] || []).concat([{ description: "", amounts: new Array(finYears()).fill(0) }]);
    save({ [`financials.${key}`]: rows });
  });
  on(root, "click", "[data-fin-del]", (e, b) => {
    const [key, i] = b.dataset.finDel.split(":");
    const rows = (finInput()[key] || []).slice();
    rows.splice(Number(i), 1);
    save({ [`financials.${key}`]: rows });
  });
  on(root, "input", "[data-fin]", (e, el) => {
    const key = el.dataset.list;
    const rows = (finInput()[key] || []).slice();
    const row = Object.assign({}, rows[Number(el.dataset.i)]);
    if (el.dataset.fin === "description") row.description = el.value;
    else {
      // Numbers only (R162). A letter used to become 0 without a word, so a figure typed as
      // "12k5" silently vanished from the NPV. It is refused where it is typed, and said.
      const bad = !FIN_NUMBER.test(el.value.trim());
      const was = S.finBad;
      S.finBad = bad ? { key, i: el.dataset.i, y: el.dataset.y } : (was && was.key === key && was.i === el.dataset.i && was.y === el.dataset.y ? null : was);
      if (bad || was !== S.finBad) paint();
      if (bad) return;
      row.amounts = (row.amounts || []).slice();
      while (row.amounts.length < finYears()) row.amounts.push(0);
      row.amounts[Number(el.dataset.y)] = parseMoney(el.value) || 0;
    }
    rows[Number(el.dataset.i)] = row;
    afe().financials[key] = rows;
    el.dataset.dirty = "1";
    debounce("fin-grid", 600, () => {
      for (const x of $$("[data-fin][data-dirty]", root)) delete x.dataset.dirty;
      save({ [`financials.${key}`]: afe().financials[key] });
    });
  });
  on(root, "input", "[data-flag-note]", (e, el) => {
    el.dataset.dirty = "1";
    debounce(`flag:${el.dataset.flagNote}`, 600, async () => {
      delete el.dataset.dirty;
      try {
        const r = await api.put(`/api/afes/${S.id}/flag-notes`, { ruleId: el.dataset.flagNote, note: el.value });
        S.view.afe = r.afe; S.view.validation = r.validation;
        setSaving("saved");
      } catch (err) { showError(err); }
    });
  });
  on(root, "click", "[data-toggle]", (e, b) => {
    const field = b.dataset.toggle, value = b.dataset.value;
    const current = field === "kind" ? (get("kind") || "original") : get(field);
    if (field === "money.classification") { setClassification(value); return; }
    // "Where does it come from" has a default rather than a blank (R150): pressing the chosen
    // answer again goes back to it, which is what rule 4 means for a question that is never empty.
    if (field === "sourcing") { save({ sourcing: (get("sourcing") || "vendor") === value ? "vendor" : value }); return; }
    save({ [field]: current === value && field !== "kind" ? null : value });
  });
  // A blocking message can carry the change that clears it (`e.fix` from the rule). Routed
  // through the same handlers a person would use, so a fix can never do something pressing the
  // control would not have done.
  on(root, "click", "[data-fix-step]", (e, b) => go(Number(b.dataset.fixStep)));
  on(root, "click", "#fin-remove", async () => {
    const r = await sheet({
      eyebrow: "REMOVE THE FINANCIAL CASE", title: "Take the financial case off this AFE?",
      sub: "The assets, the grid and the figures go. The AFE does not need one to be sent; your coordinator may ask for it.",
      actions: [{ label: "Keep it", value: null, tone: "sec" }, { label: "Remove it", value: "yes", tone: "dark", primary: true }],
    });
    if (r.value !== "yes") return;
    S.showGrid = false;
    await save({ financials: null });
  });
  on(root, "click", "[data-fix-field]", (e, b) => {
    const field = b.dataset.fixField;
    const value = b.dataset.fixValue === "" ? null : b.dataset.fixValue;
    if (field === "money.classification") { setClassification(value); return; }
    save({ [field]: value });
  });

  on(root, "click", "[data-chip]", (e, b) => {
    const field = b.dataset.chip, value = b.dataset.value;
    save({ [field]: get(field) === value ? null : value });
  });
  on(root, "click", "[data-more]", () => { S.showAllTypes = true; paint(); });
  on(root, "click", "#bin", () => binDraft());
  on(root, "input", "#cc-input", (e, el) => { S.ccQuery = el.value; S.touched.add("costCenter"); morph($("#cc-list", root), ccList()); });
  on(root, "input", "#loc-input", (e, el) => { S.locQuery = el.value; S.touched.add("location"); morph($("#loc-list", root), locList()); });
  // The location changes HERE and nowhere else: a pick, the typed words used on purpose, or —
  // on leaving the box — words that name a site exactly.
  const pickLocation = (value) => {
    S.locQuery = ""; S.touched.add("location");
    // morph never rewrites a FOCUSED input, so the box would go on saying "Singa" over a saved site.
    const box = $("#loc-input", root);
    if (box) box.value = value;
    save({ location: value });
  };
  on(root, "click", "[data-loc]", (e, b) => pickLocation(b.dataset.loc));
  on(root, "click", "[data-loc-free]", (e, b) => pickLocation(b.dataset.locFree));
  on(root, "focusout", "#loc-input", (e, el) => {
    const exact = locExact(el.value);
    if (exact && exact !== afe().location) pickLocation(exact);
  });
  on(root, "click", "[data-cc]", (e, b) => { S.ccQuery = ""; save({ costCenter: b.dataset.cc }); });
  // A cost centre the matrix does not know is still a cost centre: typed as a number and
  // left, it is saved and the rule marks it pending for Fixed Assets rather than refusing it.
  on(root, "focusout", "#cc-input", (e, el) => {
    const typed = el.value.trim();
    if (/^\d{4,6}$/.test(typed) && typed !== String(afe().costCenter || "") && !ccMatches().length) { S.ccQuery = ""; save({ costCenter: typed }); }
  });
  on(root, "click", "[data-pot]", (e, b) => {
    const cur = get("budget.potId");
    const otherOn = cur === "other" || (!cur && Boolean(String(get("budget.otherBudget") || "").trim()));
    if (b.dataset.pot === "other" && otherOn) return save({ "budget.potId": null, "budget.otherBudget": "" });
    const next = cur === b.dataset.pot ? null : b.dataset.pot;
    save({ "budget.potId": next });
    // Choosing Other opens a line to say which budget; put the cursor in it.
    if (next === "other") setTimeout(() => { const i = $('[data-field="budget.otherBudget"]', root); if (i) i.focus(); }, 0);
  });
  on(root, "click", "#toggle-lines", () => { S.showLines = true; const lines = get("money.lines") || []; if (!lines.length) save({ "money.lines": [{ site: "", country: "", amountUsd: null }] }); else paint(); });
  on(root, "click", "#add-line", () => save({ "money.lines": (get("money.lines") || []).concat([{ site: "", country: "", amountUsd: null }]) }));
  on(root, "click", "[data-line-del]", (e, b) => { const lines = (get("money.lines") || []).slice(); lines.splice(Number(b.dataset.lineDel), 1); if (!lines.length) S.showLines = false; save({ "money.lines": lines }); });
  on(root, "input", "[data-line]", (e, el) => {
    const lines = (get("money.lines") || []).map((l) => Object.assign({}, l));
    const i = Number(el.dataset.i);
    if (!lines[i]) return;
    lines[i][el.dataset.line] = el.dataset.line === "amountUsd" ? parseMoney(el.value) : el.dataset.line === "country" ? el.value.toUpperCase() : el.value;
    afe().money.lines = lines;                                     // keep local state current between keystrokes
    el.dataset.dirty = "1";
    debounce("money.lines", 600, () => { for (const x of $$("[data-line][data-dirty]", root)) delete x.dataset.dirty; save({ "money.lines": afe().money.lines }); });
  });
  on(root, "click", "#show-extras", () => { S.showExtras = true; paint(); });
  on(root, "change", "[data-file]", (e, el) => { upload(Array.from(el.files || []), el.dataset.file); el.value = ""; });
  on(root, "dragover", "[data-drop]", (e, el) => { e.preventDefault(); el.classList.add("over"); });
  on(root, "dragleave", "[data-drop]", (e, el) => el.classList.remove("over"));
  on(root, "drop", "[data-drop]", (e, el) => { e.preventDefault(); el.classList.remove("over"); upload(Array.from((e.dataTransfer && e.dataTransfer.files) || []), el.dataset.drop); });
  const docSaved = (att, st, msg) => {
    S.docSave[att] = { st, msg: msg || "" };
    if (st === "saved") setTimeout(() => { if (S.docSave[att] && S.docSave[att].st === "saved") { delete S.docSave[att]; paint(); } }, 2400);
  };
  on(root, "input", "[data-doc]", (e, el) => {
    const att = el.dataset.att, key = el.dataset.doc;
    el.dataset.dirty = "1";
    debounce("doc-" + att + key, 500, async () => {
      docSaved(att, "saving"); paint();
      try {
        const r = await api.patch(`/api/afes/${S.id}/documents/${att}`, { [key]: key === "amountUsd" ? parseMoney(el.value) : el.value });
        delete el.dataset.dirty;
        S.view.afe = r.afe; S.view.validation = r.validation;
        if (r.quoteTotalUsd !== undefined) S.view.quoteTotalUsd = r.quoteTotalUsd;
        docSaved(att, "saved"); setSaving("saved"); paint();
      } catch (err) { docSaved(att, "failed", err.message); paint(); }
    });
  });
  // A date is saved by `change` and nothing else (R111): a date field fires `input` part-way
  // through being typed, and saving each fragment is a repaint per keystroke for a value that
  // does not exist yet.
  on(root, "change", "[data-doc-date]", async (e, el) => {
    const att = el.dataset.att;
    docSaved(att, "saving"); paint();
    try {
      const r = await api.patch(`/api/afes/${S.id}/documents/${att}`, { quoteDate: el.value || "" });
      S.view.afe = r.afe; S.view.validation = r.validation;
      if (r.resume !== undefined) S.view.resume = r.resume;
      docSaved(att, "saved"); setSaving("saved"); paint();
    } catch (err) { docSaved(att, "failed", err.message); paint(); }
  });
  // The quote reader (R170): ask for a read, then use what it proposed or set it aside. Using it is
  // the confirmation non-negotiable #1 asks for — the figures count from that press, as the person's.
  on(root, "click", "[data-read]", async (e, b) => {
    try {
      const r = await api.post(`/api/afes/${S.id}/documents/${b.dataset.read}/read`);
      S.view.afe = r.afe; S.view.validation = r.validation;
      paint(); watchReadings();
    } catch (err) { showError(err); }
  });
  on(root, "click", "[data-use-reading], [data-setaside-reading]", async (e, b) => {
    const use = b.hasAttribute("data-use-reading");
    const att = use ? b.dataset.useReading : b.dataset.setasideReading;
    const done = busy(b, use ? "Using…" : "Setting aside…");
    try {
      const r = await api.post(`/api/afes/${S.id}/documents/${att}/reading`, { use });
      S.view.afe = r.afe; S.view.validation = r.validation;
      if (r.quoteTotalUsd !== undefined) S.view.quoteTotalUsd = r.quoteTotalUsd;
      if (r.resume !== undefined) S.view.resume = r.resume;
      setSaving("saved"); paint();
      if (use && (r.skipped || []).length) toast(r.skipped.map((s) => s.why).join(" · "), "err");
    } catch (err) { done(); showError(err); }
  });
  on(root, "click", "[data-doc-del]", (e, b) => { S.confirmDel = S.confirmDel === b.dataset.docDel ? null : b.dataset.docDel; paint(); });
  on(root, "click", "[data-doc-del-no]", () => { S.confirmDel = null; paint(); });
  on(root, "click", "[data-doc-del-yes]", async (e, b) => {
    S.confirmDel = null;
    try { const r = await api.del(`/api/afes/${S.id}/documents/${b.dataset.docDelYes}`); S.view.afe = r.afe; S.view.validation = r.validation;
      if (r.quoteTotalUsd !== undefined) S.view.quoteTotalUsd = r.quoteTotalUsd;
      if (r.resume !== undefined) S.view.resume = r.resume; paint(); }
    catch (err) { showError(err); }
  });
  // A blocked Continue is not a dead button: pressing it says what is missing, on this step, and
  // takes you to the first of it. A disabled button explained only in a hover tip was a dead end
  // on a phone, where there is no hover (P2).
  on(root, "click", "#next", (e, b) => {
    if (b.hasAttribute("data-blocked")) return revealBlocks();
    go(nextStep());
  });
  on(root, "click", "#back", () => go(prevStep()));
  // The count is a control: it takes you to the thing, and then says which thing. A number you
  // have to go and hunt for is a number that makes the reader do the work.
  on(root, "click", "#tofix", () => {
    const first = $(".todobar .field-msg.block", root) || $(".todobar .field-msg", root) || $(".todobar", root);
    bringTo(first, { colour: "rgba(179,53,46,.5)" });
  });

  on(root, "click", "#submit", (e, b) => act("submit", b));
  on(root, "click", "#send", (e, b) => act("send", b));
  on(root, "keydown", "input.big, input.input", (e, el) => {
    const enter = e.key === "Enter" || e.key === "Return" || e.keyCode === 13;
    if (!enter || el.tagName === "TEXTAREA") return;
    if (el.id === "cc-input") {
      const first = $("[data-cc]", root);
      if (first) { first.click(); return; }
      const typed = el.value.trim();
      if (/^\d{4,6}$/.test(typed)) { S.ccQuery = ""; save({ costCenter: typed }); }
      return;
    }
    // Enter in the location box picks, exactly as it does for the cost centre: the first site
    // offered, or the typed words when nothing on the list matches. It used to save the raw text
    // and jump to the next step.
    if (el.id === "loc-input") {
      const first = $("[data-loc]", root) || $("[data-loc-free]", root);
      if (first) first.click();
      return;
    }
    cancelDebounce(el.dataset.field || "");
    if (el.dataset.field) save({ [el.dataset.field]: coerce(el.dataset.field, el.value) }).then(() => { const n = $("#next", root); if (n && !n.hasAttribute("data-blocked")) n.click(); });
  });
}

/**
 * Everything typed and not yet saved, saved — before the screen changes or the AFE goes anywhere.
 * Typed fields go in ONE patch (`save` folds every `[data-dirty]` field in); then whatever else is
 * waiting runs: the cost lines, the grid, the assets, the quote's fields, the notes. Resolves false
 * when the save failed, and the caller stays where it is: the screen already says "Not saved".
 */
async function settle() {
  if (S.lastSave) await S.lastSave;                // a save already on its way (leaving a field starts one)
  const typed = $$("[data-dirty][data-field]", S.root);
  if (typed.length && !(await save({}))) return false;
  await settleDebounces();
  return S.saveState !== "failed";
}
/** Everything blocking this step, said: its fields count as touched, and the first is brought into view. */
function revealBlocks() {
  for (const e of stepBlocks(S.step)) if (e.field) S.touched.add(e.field);
  paint();
  const m = $(".field-msg.block", S.root) || $(".foot .kbd", S.root);
  if (m) bringTo(m, { colour: "rgba(179,53,46,.5)" });
}
async function go(n) {
  // It used to CANCEL the pending saves and move on, so the last half-second of typing before
  // Continue or Back was thrown away without a word (found 2026-10-16).
  if (!(await settle())) return;
  await navigate(n === 7 ? `/afe/${S.id}/review` : `/afe/${S.id}/edit/${n}`);
}

async function upload(files, role) {
  const ok = files.filter(FILE_OK);
  if (!ok.length) { toast("Attach a PDF, a PNG or a JPEG.", "err"); return; }
  let i = 0;
  S.uploadErrors = [];
  for (const f of ok) {
    i += 1;
    S.uploading = `Uploading ${f.name} (${i} of ${ok.length})…`;
    paint();
    try {
      const r = await api.post(`/api/afes/${S.id}/documents`, { filename: f.name, role: role || "quote", contentBase64: await documentToBase64(f, session.refdata && session.refdata.attachmentLimits) });
      S.view.afe = r.afe; S.view.validation = r.validation;
      if (r.quoteTotalUsd !== undefined) S.view.quoteTotalUsd = r.quoteTotalUsd;
      if (r.resume !== undefined) S.view.resume = r.resume;
    } catch (e) { S.uploadErrors.push({ name: f.name, message: e.message }); }
  }
  S.uploading = null;
  paint();
  watchReadings();
  const first = $("[data-doc='amountUsd']", S.root);
  if (first && !first.value) first.focus();
}

async function act(action, button) {
  // Whose name it goes under, said BEFORE it goes, when that is not the AFE's own people. In the
  // KT walkthrough (afe-0032, 15 Oct) "view as" had been stopped half-way, so Anita Uppal's AFE
  // was submitted as Shashank and nothing on the screen said so.
  const me = session.me || {};
  const isMe = (p) => Boolean(p && p.email) && String(p.email).toLowerCase() === String(me.email || "").toLowerCase();
  const a = afe();
  if (!isMe(a.requester) && !isMe(a.preparer) && !(action === "send" && isMe(a.coordinator))) {
    const whose = (a.requester && a.requester.name) || "somebody else";
    const sure = await sheet({
      eyebrow: action === "send" ? "SEND FOR SIGNATURE" : "SUBMIT",
      title: `${action === "send" ? "Send" : "Submit"} ${whose}'s AFE as ${me.displayName}?`,
      sub: `It is recorded as ${me.displayName}'s${me.actingAs ? " (you, viewing as them)" : ""}. If you meant to act as ${whose.split(" ")[0]}, switch to them first.`,
      actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: action === "send" ? "Send it" : "Submit it", value: "ok", primary: true }],
    });
    if (sure.value !== "ok") return;
  }
  const done = busy(button, action === "send" ? "Creating the envelope…" : "Sending…");
  // The note to the approvers is typed on this screen; the envelope must carry all of it.
  if (!(await settle())) { done(); return; }
  // The document takes off while the envelope is being created. Two things make this honest
  // rather than decorative: the request starts FIRST, so nothing is waiting on the animation;
  // and a failure CANCELS it, so the panel comes straight back and the error is the only thing
  // on the screen. An animation that keeps playing over a failure is a lie.
  const flight = sendOff($("#pdfpanel", S.root));
  try {
    const r = await api.post(`/api/afes/${S.id}/${action}`);
    store.bust("/api/afes");
    await flight;
    toast(r.note || "Done", "ok");
    await navigate(`/afe/${S.id}`);
  } catch (e) {
    flight.cancel();
    done();
    showError(e);
    if (e.detail && (e.detail.blocks || e.detail.pending)) { await load(); paint(); }
  }
}

// ---- entry ------------------------------------------------------------------------------------
export async function render(root, ctx) {
  if (ctx.path === "/afe/new") {
    try { const created = await api.post("/api/afes"); store.bust("/api/afes"); await navigate(`/afe/${created.afe.id}/edit/1`, { replace: true }); }
    catch (e) { showError(e); await navigate("/requests", { replace: true }); }
    return;
  }
  if (S.id !== ctx.params.id) S.local.clear();    // a different AFE: forget what the last one was told
  S.id = ctx.params.id;
  // 8 is the Financials step. It is out of sequence on purpose — see STEP_ORDER — so the clamp
  // has to know about it rather than trimming it back to the review screen.
  const asked = parseInt(ctx.params.step, 10);
  S.step = ctx.path.endsWith("/review") ? 7
    : STEP_ORDER.includes(asked) ? asked : 1;
  S.root = root;
  S.ccQuery = "";
  try { await load(); } catch (e) { showError(e); await navigate("/requests", { replace: true }); return; }
  // Arriving at the screen always shows the form as it stands; after that only a change to a
  // field the form prints moves it (OFF_FORM_FIELDS).
  S.pdfVersion = S.view.afe.updatedAt;
  if (!S.view.permissions.canEdit && !(S.step === 7 && S.view.permissions.canView)) { await navigate(`/afe/${S.id}`, { replace: true }); return; }
  if (S.step === 5 && !cloudTriggered()) { await navigate(`/afe/${S.id}/edit/6`, { replace: true }); return; }
  // "Carry on": the first step that still has something missing, or the review when nothing is.
  if (ctx.params.step === "resume") {
    const journey = steps();
    const at = journey.find((s) => s.n !== 7 && stepBlocks(s.n).length) || journey[journey.length - 1];
    await navigate(at.href, { replace: true });
    return;
  }
  // And a typed URL does not get what the stepper no longer offers. Land on the step that is
  // actually in the way, rather than on a page whose Continue is dead for a reason two screens
  // back. Only forward: everything at or before the blocked step stays reachable.
  {
    const journey = steps();
    const here = journey.find((s) => s.n === S.step);
    if (here && here.locked) {
      await navigate(journey[journey.findIndex((s) => s.locked) - 1].href, { replace: true });
      return;
    }
  }
  // The financial case is only asked of an AFE that buys something capital (R94).
  if (S.step === 8 && !capitalAfe()) { await navigate(`/afe/${S.id}/edit/4`, { replace: true }); return; }
  setRecord({ id: S.id, title: afe().project.title || "New AFE" });
  if (S.step === 2 && !S.matrix) store.get("/api/matrix/all", { maxAge: 600000 }).then((m) => { S.matrix = m; }).catch(() => {});
  // The location master, cached for the session like the matrix: 150 rows, and a typeahead
  // must not round-trip on every keystroke.
  if (S.step === 2 && !S.locations) {
    // The failure handler belongs to the FETCH, not to the repaint that follows it. Catching
    // both meant a render error quietly emptied the list instead of showing itself, which is
    // the worst of both: no typeahead, and no reason why.
    store.get("/api/locations", { maxAge: 600000 })
      .then((rows) => rows.map((r) => r.code), () => [])
      .then((codes) => { S.locations = codes; paint(); });
  }
  if (S.step === 3 && afe().division) {
    store.get(`/api/pots?division=${encodeURIComponent(afe().division)}`, { maxAge: 60000 }).then((p) => { S.pots = p.pots || []; paint(); }).catch(() => { S.pots = []; });
  }
  if (!root.dataset.wizard) { root.innerHTML = ""; root.dataset.wizard = "1"; }
  wire(root);
  paint();
  if (S.step === 6) watchReadings();               // a read still in flight when the step opens (R170)
  const stepChanged = S.paintedStep !== S.step;
  S.paintedStep = S.step;
  if (stepChanged) window.scrollTo(0, 0);
  const focus = $(".big, input.input", root);
  if (focus && S.step !== 7 && window.matchMedia("(min-width: 900px)").matches) focus.focus();
  else if (stepChanged) { const q = $(".q", root); if (q) { q.setAttribute("tabindex", "-1"); q.focus({ preventScroll: true }); } }
}

export function unmount() {
  clearTimeout(readWatch); readWatch = null;
  if (S.root) { delete S.root.dataset.wizard; S.root.innerHTML = ""; }
  S.paintedStep = null;
  setRecord(null);
}
