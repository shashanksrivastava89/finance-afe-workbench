// Small shared surfaces: toasts, a sheet (bottom sheet on a phone, centred on a desktop), and the
// "say what is happening" helpers for buttons that wait on the server (design rule 6).
import { $, html, render } from "./dom.js";

const layer = () => document.getElementById("layer");

export function toast(message, kind, ms) {
  let wrap = $(".toasts", layer());
  if (!wrap) { wrap = document.createElement("div"); wrap.className = "toasts"; layer().appendChild(wrap); }
  const t = document.createElement("div");
  t.className = "toast" + (kind ? " " + kind : "");
  // An error is announced as one — a screen reader waits for a polite status to finish.
  t.setAttribute("role", kind === "err" ? "alert" : "status");
  t.textContent = message;
  wrap.appendChild(t);
  setTimeout(() => { t.style.transition = "opacity .25s"; t.style.opacity = "0"; setTimeout(() => t.remove(), 260); }, ms || (kind === "err" ? 5200 : 3200));
}

let openSheetEl = null;
let sheetResolve = null;
let sheetSpec = null;
let sheetReturn = null;                          // what had focus before the sheet opened
let sheetCount = 0;

/**
 * Open a sheet. Resolves `{ value, data, result }`: `value` is the action pressed (null when
 * dismissed), `data` is whatever `spec.collect(el)` returns at that moment. `body` is html();
 * `actions` are [{ label, value, tone: "cta|sec|quiet|dark", primary }]; `validate(el, value)` may
 * return an error string to keep the sheet open; `onMount(el)` wires anything inside.
 *
 * `run(value, data)` — the request the action makes, run WITH THE SHEET STILL OPEN (2026-10-16).
 * Record the order, Capitalize and Send back used to close their sheet first, so a refusal (a
 * future date, a number SAP already holds, over the tolerance) arrived as a five-second toast
 * and what had been typed was gone. With `run`, a refusal is said inside the sheet and nothing
 * typed is lost; what `run` returns comes back as `result`.
 *
 * A click outside closes the sheet only while nothing has been typed in it: a half-written
 * send-back reason was thrown away by a stray click. Esc is a deliberate close and still works.
 */
export function sheet(spec) {
  closeSheet(null);
  const el = document.createElement("div");
  el.className = "backdrop";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-modal", "true");
  const titleId = `sheet-title-${++sheetCount}`;
  el.setAttribute("aria-labelledby", titleId);
  sheetReturn = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  render(el, html`
    <div class="sheet ${spec.wide ? "wide" : ""}">
      ${spec.eyebrow ? html`<div class="sect">${spec.eyebrow}</div>` : ""}
      <h2 class="h1" id="${titleId}" style="margin-top: ${spec.eyebrow ? "6px" : "0"}">${spec.title}</h2>
      ${spec.sub ? html`<div class="sub">${spec.sub}</div>` : ""}
      <div class="sheet-body" style="margin-top: 16px;">${spec.body || ""}</div>
      <div class="sheet-err field-msg block" hidden></div>
      <div class="actions">
        ${(spec.actions || [{ label: "Close", value: null, tone: "sec" }]).map((a) =>
          html`<button class="cta sm ${a.tone || ""}" data-act="${a.value === null || a.value === undefined ? "" : a.value}" ${a.primary ? "data-primary" : ""}>${a.label}</button>`)}
      </div>
    </div>`);
  layer().appendChild(el);
  openSheetEl = el;
  sheetSpec = spec;
  document.body.style.overflow = "hidden";
  const first = $(".sheet-body input, .sheet-body textarea, .sheet-body select, .sheet-body button", el) || $(".actions button", el);
  if (first) first.focus();
  if (spec.onMount) spec.onMount(el);

  el.addEventListener("input", () => { el.dataset.edited = "1"; });
  el.addEventListener("click", async (e) => {
    if (e.target === el) { if (!el.dataset.edited && !el.dataset.busy) closeSheet(null); return; }
    const b = e.target instanceof Element ? e.target.closest("button[data-act]") : null;
    if (!b || el.dataset.busy) return;
    const value = b.dataset.act === "" ? null : b.dataset.act;
    const box = $(".sheet-err", el);
    if (value !== null && spec.validate) {
      const err = spec.validate(el, value);
      if (err) { box.hidden = false; box.textContent = err; return; }
    }
    if (value === null || !spec.run) { closeSheet(value); return; }
    // The request runs with the sheet open; a refusal is said here and the typing stays.
    const data = spec.collect ? spec.collect(el) : null;
    el.dataset.busy = "1";
    for (const x of el.querySelectorAll("button[data-act]")) x.disabled = true;
    const before = b.innerHTML;
    b.innerHTML = `<span class="spin"></span>${b.textContent}`;
    box.hidden = true;
    try {
      const result = await spec.run(value, data);
      delete el.dataset.busy;
      closeSheet(value, result);
    } catch (err) {
      delete el.dataset.busy;
      for (const x of el.querySelectorAll("button[data-act]")) x.disabled = false;
      b.innerHTML = before;
      box.hidden = false;
      box.textContent = (err && err.message) || "That did not go through.";
    }
  });
  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !el.dataset.busy) closeSheet(null);
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { const p = $("button[data-primary]", el); if (p) p.click(); }
  });
  return new Promise((resolve) => { sheetResolve = resolve; });
}

export function closeSheet(value, result) {
  if (!openSheetEl) return;
  const el = openSheetEl, spec = sheetSpec, r = sheetResolve, back = sheetReturn;
  const data = spec && spec.collect ? spec.collect(el) : null;
  el.remove();
  openSheetEl = null; sheetSpec = null; sheetResolve = null; sheetReturn = null;
  document.body.style.overflow = "";
  // Focus goes back where it came from, so a keyboard user is not left at the top of the page.
  if (back && back.isConnected) { try { back.focus({ preventScroll: true }); } catch { /* gone */ } }
  if (r) r({ value: value === undefined ? null : value, data, result: result === undefined ? null : result });
}

/** A sheet with one textarea; resolves the trimmed text, or null when cancelled. */
export async function askText(spec) {
  const r = await sheet({
    eyebrow: spec.eyebrow, title: spec.title, sub: spec.sub,
    body: html`<textarea class="input" id="sheet-text" rows="4" placeholder="${spec.placeholder || ""}">${spec.value || ""}</textarea>${spec.extra || ""}`,
    actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: spec.action || "Send", value: "ok", tone: spec.tone || "", primary: true }],
    validate: (el) => (spec.required !== false && !$("#sheet-text", el).value.trim() ? (spec.requiredMessage || "Say something first.") : null),
    collect: (el) => ({ text: $("#sheet-text", el) ? $("#sheet-text", el).value.trim() : "", el }),
    onMount: (el) => { const t = $("#sheet-text", el); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } if (spec.onMount) spec.onMount(el); },
    // `spec.run(text)` sends it with the sheet open (see `sheet`); then the answer is `{ text, result }`.
    run: spec.run ? (value, data) => spec.run(data.text) : undefined,
  });
  if (r.value !== "ok") return null;
  return spec.run ? { text: r.data.text, result: r.result } : r.data.text;
}

/**
 * A screen waiting on its data says so — only if the wait is long enough to notice, so a quick
 * answer does not flash a line nobody had time to read (design rule 6, the judge screen's own
 * pattern). Several screens stayed blank until every call returned. Only on an empty screen: a
 * repaint never replaces content with a spinner. Returns the cancel.
 */
export function opening(root, label, back) {
  if (!root || root.firstElementChild) return () => {};
  const t = setTimeout(() => {
    if (root.firstElementChild) return;
    render(root, html`<div class="page pane" data-key="opening">${back ? html`<div class="small muted"><a href="${back.href}" style="font-weight: 700;">‹ ${back.label}</a></div>` : ""}
      <div class="busy" style="margin-top: 18px;" aria-live="polite"><span class="spin"></span>${label}</div></div>`);
  }, 200);
  return () => clearTimeout(t);
}

/**
 * A screen whose data did not come is not a blank page behind a toast: it says what went wrong
 * and offers to try again. The retry is a link to this same address, which the router renders
 * afresh.
 */
export function loadFailed(root, err, back) {
  if (!root) return;
  const here = `${location.pathname}${location.search}`;
  render(root, html`<div class="page pane" data-key="failed">
    ${back ? html`<div class="small muted"><a href="${back.href}" style="font-weight: 700;">‹ ${back.label}</a></div>` : ""}
    <div class="banner red" style="margin-top: 18px;" role="alert">${(err && err.message) || "This did not load."}</div>
    <a class="cta sec" href="${here}" style="margin-top: 14px; display: inline-flex;">Try again</a>
  </div>`);
}

/** Put a button into its waiting state and give back a function that restores it. */
export function busy(button, label) {
  if (!button) return () => {};
  const before = button.innerHTML;
  button.disabled = true;
  button.innerHTML = `<span class="spin"></span>${label || "Working…"}`;
  return () => { if (button.isConnected) { button.disabled = false; button.innerHTML = before; } };
}

/** Show an API error the way the server phrased it. */
export function showError(e) {
  const msg = e && e.message ? e.message : "Something went wrong.";
  toast(msg, "err");
  if (e && e.detail) console.warn("detail", e.detail);
}
