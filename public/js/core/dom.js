// DOM helpers: an auto-escaping template tag, a keyed morph, and delegated events.
//
// `html` builds markup safely — every interpolated value is escaped unless it is itself the
// result of `html` (or wrapped in `raw`). `morph` reconciles a container against new markup
// instead of replacing it, which is what lets a screen update one region without losing the
// user's scroll position or the element they are typing in (design rule 2).

class Raw {
  constructor(s) { this.s = String(s); }
  toString() { return this.s; }
}

export const raw = (s) => (s instanceof Raw ? s : new Raw(s));

export function esc(v) {
  return String(v === null || v === undefined ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function part(v) {
  if (v === null || v === undefined || v === false) return "";
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join("");
  return esc(v);
}

/** Tagged template: `html\`<b>${name}</b>\`` — values escaped, nested `html` results kept. */
export function html(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) out += part(values[i]);
  }
  return new Raw(out);
}

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

/** One delegated listener per event type per root — the handler gets the matched element. */
export function on(root, type, selector, handler, opts) {
  root.addEventListener(type, (e) => {
    const target = e.target instanceof Element ? e.target.closest(selector) : null;
    if (target && root.contains(target)) handler(e, target);
  }, opts);
}

/** First paint of a container. Later updates should go through `morph`. */
export function render(container, content) {
  container.innerHTML = String(content);
}

/**
 * Reconcile `container`'s children against new markup. Elements carrying `data-key` are matched
 * by key, everything else by position and tag. The focused form control keeps its value; an
 * element with `data-static` is left alone once present (an iframe, say), so it never reloads.
 */
export function morph(container, content) {
  const tpl = document.createElement("template");
  tpl.innerHTML = String(content);
  reconcile(container, tpl.content);
}

function same(a, b) {
  if (a.nodeType !== b.nodeType) return false;
  if (a.nodeType === Node.ELEMENT_NODE) return a.tagName === b.tagName && (a.dataset.key || "") === (b.dataset.key || "");
  return true;
}

function reconcile(oldParent, newParent) {
  const oldKids = Array.from(oldParent.childNodes);
  const newKids = Array.from(newParent.childNodes);
  const byKey = new Map();
  for (const k of oldKids) if (k.nodeType === Node.ELEMENT_NODE && k.dataset.key) byKey.set(k.tagName + "#" + k.dataset.key, k);
  const used = new Set();
  let cursor = oldParent.firstChild;

  for (const nk of newKids) {
    let match = null;
    if (nk.nodeType === Node.ELEMENT_NODE && nk.dataset.key) {
      match = byKey.get(nk.tagName + "#" + nk.dataset.key) || null;
      if (match && used.has(match)) match = null;
    } else {
      for (let c = cursor; c; c = c.nextSibling) {
        if (used.has(c)) continue;
        if (c.nodeType === Node.ELEMENT_NODE && c.dataset.key) continue;
        if (same(c, nk)) { match = c; break; }
        // do not skip past a keyed element or a differing element type — insert instead
        if (c.nodeType === Node.ELEMENT_NODE || nk.nodeType === Node.ELEMENT_NODE) break;
      }
    }
    if (match) {
      used.add(match);
      if (match !== cursor) oldParent.insertBefore(match, cursor);
      patchNode(match, nk);
      cursor = match.nextSibling;
    } else {
      oldParent.insertBefore(nk, cursor);
      used.add(nk);
    }
  }
  for (const k of oldKids) if (!used.has(k) && k.parentNode === oldParent) k.remove();
}

const FORM_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

function patchNode(oldNode, newNode) {
  if (oldNode.nodeType === Node.TEXT_NODE || oldNode.nodeType === Node.COMMENT_NODE) {
    if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
    return;
  }
  if (oldNode.nodeType !== Node.ELEMENT_NODE) return;
  if (oldNode.hasAttribute("data-static") && newNode.hasAttribute("data-static")) return;

  // A control the person is typing in, or whose edit has not reached the server yet
  // (`data-dirty`, set by the screen), keeps its value whatever the new markup says.
  const focused = document.activeElement === oldNode || oldNode.hasAttribute("data-dirty");
  for (const attr of Array.from(oldNode.attributes)) {
    if (attr.name === "data-dirty") continue;
    if (!newNode.hasAttribute(attr.name)) oldNode.removeAttribute(attr.name);
  }
  for (const attr of Array.from(newNode.attributes)) {
    if (focused && (attr.name === "value" || attr.name === "checked")) continue;
    if (oldNode.getAttribute(attr.name) !== attr.value) oldNode.setAttribute(attr.name, attr.value);
  }
  if (FORM_TAGS.has(oldNode.tagName)) {
    if (!focused) {
      if (oldNode.tagName === "TEXTAREA") { if (oldNode.value !== newNode.textContent) oldNode.value = newNode.textContent; }
      else if (oldNode.type === "checkbox" || oldNode.type === "radio") { oldNode.checked = newNode.hasAttribute("checked"); }
      else if (oldNode.tagName === "SELECT") { const v = newNode.querySelector("option[selected]"); if (v && oldNode.value !== v.value) oldNode.value = v.value; }
      else if (oldNode.value !== (newNode.getAttribute("value") || "")) oldNode.value = newNode.getAttribute("value") || "";
    }
    if (oldNode.tagName === "TEXTAREA") return;
  }
  reconcile(oldNode, newNode);
}

/** Debounce by key — the wizard saves one field at a time, half a second after the last keystroke. */
const timers = new Map();                        // key -> { id, fn }
export function debounce(key, ms, fn) {
  const prev = timers.get(key);
  if (prev) clearTimeout(prev.id);
  timers.set(key, { fn, id: setTimeout(() => { timers.delete(key); fn(); }, ms) });
}
/**
 * CANCEL a pending call — for a save that already carries this key's value. It is not a flush.
 * It used to be called `flushDebounce`, and moving to the next step called it to "flush" the
 * fields: the timers were cleared, nothing ran, and the last half-second of typing was thrown
 * away (found 2026-10-16). Running what is pending is `settleDebounces`.
 */
export function cancelDebounce(key) {
  const t = timers.get(key);
  if (t) { clearTimeout(t.id); timers.delete(key); }
}
/**
 * Run every pending call NOW, one after another, and resolve when they have all finished — what a
 * screen does before it changes or sends, so nothing typed is lost. `only(key)` narrows it.
 */
export async function settleDebounces(only) {
  const due = [];
  for (const [key, t] of timers) {
    if (only && !only(key)) continue;
    clearTimeout(t.id); timers.delete(key); due.push(t.fn);
  }
  for (const fn of due) {
    try { await fn(); } catch { /* each save reports its own failure on the screen */ }
  }
}
