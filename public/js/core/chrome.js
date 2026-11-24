// The top bar: the logo (which is the way home — design rule 10), the sections this person has,
// with counts, and who they are — with the demo persona switcher when it is on.
import { html, morph, on } from "./dom.js";
import { icon } from "./icons.js";
import { session, actAs } from "./session.js";
import { store } from "./store.js";
import { initials } from "./format.js";
import { sheet, closeSheet, toast } from "./ui.js";
import { navigate, dispatch } from "./router.js";

let active = "";
let counts = { prepare: null, approvals: null, fa: null, mailbox: null };
let record = null;                                 // { id, title } — the AFE or order you have open
let note = null;                                   // { text, tone } — transient, e.g. "Saved"

export function setActive(name) { active = name; paint(); }

/**
 * Which record is open, on the context bar under the masthead.
 *
 * This used to be a span between the logo and the sections, and it was the wrong place twice
 * over. Inserting it pushed the whole navigation 208px sideways the moment an AFE opened, and
 * every save of the title repainted it a few pixels longer, so typing a name made the top bar
 * crawl. A record's identity is not chrome — it belongs to the record — so it has a line of its
 * own that can grow without moving anything above it.
 *
 * `null` closes the bar: a screen that shows no single record says so on the way in, and every
 * screen's `unmount` says it on the way out.
 */
export function setRecord(rec) {
  record = rec && (rec.id || rec.title) ? rec : null;
  if (!record) note = null;
  paintCtx();
}

/** A transient word at the right of the context bar — "Saved". It never moves anything. */
export function setRecordNote(text, tone) {
  note = text ? { text, tone: tone || "" } : null;
  paintCtx();
}

// The sections the SERVER says this person has, in its order, with the counts we fetched for
// them. Nothing is decided here: `/api/me` resolves lib/domain/rbac.js and sends the list, so a
// tab can never appear that the API would then refuse — and a role change takes effect on the
// next load without a matching edit in the browser.
// A glyph per section. The nav was nine words in a row, which is nine things to read before you
// can move; the shape is taken in first and the word confirms it. Below 1340px the words drop
// and the glyphs carry the nav on their own, which is why each one keeps its label as a title.
const SECTION_ICON = {
  requests: "doc", prepare: "send", approvals: "shield", fa: "search",
  projects: "box", pots: "coins", leadership: "chart", mailbox: "mail", admin: "cog",
};

// And a hue each. Below 1210px the words go and the glyph IS the nav, so nine identical grey
// marks would be nine things to decode every time. Each was measured against white — the lowest
// is 4.4:1, against a floor of 3 for a graphic — and the active underline takes the same hue, so
// "where I am" and "what this is" are one statement instead of two.
const SECTION_COLOR = {
  requests: "#008943", prepare: "#17638F", approvals: "#5A4A90", fa: "#106E7A",
  projects: "#8B3F14", pots: "#9A7106", leadership: "#8A2C63", mailbox: "#5A625C", admin: "#3D423F",
};

function sections() {
  const mine = (session.me && session.me.sections) || [];
  return mine.map((s) => Object.assign({}, s, {
    count: counts[s.key] || null,
    icon: SECTION_ICON[s.key] || "doc",
    color: SECTION_COLOR[s.key] || "#5A625C",
  }));
}

function markup() {
  const me = session.me || {};
  return html`
    <a class="brand" href="/requests" aria-label="AFE Workbench — home">
      <img src="/assets/acme-logo.svg" alt="Acme"><b>AFE Workbench</b>
    </a>
    <nav class="chipnav" aria-label="Sections">
      ${sections().map((s) => html`<a href="${s.href}" class="${s.key === active ? "on" : ""}" data-key="${s.key}" title="${s.label}" aria-label="${s.count ? `${s.label}, ${s.count} waiting` : s.label}" aria-current="${s.key === active ? "page" : "false"}" style="--sec: ${s.color};">${icon(s.icon, 15)}<span class="lbl">${s.label}</span>${s.count ? html`<span class="n">${s.count}</span>` : ""}</a>`)}
    </nav>
    <button class="who ${me.actingAs ? "as" : ""}" id="who" title="${me.actingAs ? `Viewing as ${me.displayName} — you are ${realName()}` : me.email || ""}">
      <span class="av">${initials(me.displayName)}</span>
      <span class="name">${me.actingAs ? html`<span class="asl">Viewing as</span>` : ""}${me.displayName || ""}</span>
    </button>`;
}

/**
 * The person actually at the keyboard while "view as" is on. The who-button used to show only the
 * acted-as name, so in the KT walkthrough (15 Oct) "view as" was stopped half-way through an AFE
 * and nobody noticed: the quote edits and the submit were recorded as somebody else.
 */
function realName() {
  const me = session.me || {};
  const u = (session.users || []).find((x) => String(x.email).toLowerCase() === String(me.realEmail || "").toLowerCase());
  return (u && u.displayName) || me.realEmail || "yourself";
}

export function paint() {
  const top = document.getElementById("top");
  if (top) morph(top, markup());
}

export function paintCtx() {
  const el = document.getElementById("ctx");
  if (!el) return;
  // "View as" is a MODE, and a mode is said on every screen while it lasts — on the context bar,
  // never inserted into the masthead.
  const me = session.me || {};
  const acting = Boolean(me.actingAs);
  el.hidden = !record && !acting;
  if (!record && !acting) { el.replaceChildren(); return; }
  morph(el, html`
    ${record && record.id ? html`<span class="rid">${record.id}</span><span class="rsep"></span>` : ""}
    ${record && record.title ? html`<span class="rtitle">${record.title}</span>` : ""}
    ${note ? html`<span class="rnote ${note.tone}">${note.text}</span>` : ""}
    ${acting ? html`<span class="asbar" data-key="asbar">${icon("user", 13)}Viewing as <b>${me.displayName}</b><button type="button" class="linkbtn" id="as-back">Back to ${String(realName()).split(" ")[0]}</button></span>` : ""}`);
}

/**
 * The counts ride on `/api/me`, which the session already has.
 *
 * They used to be four awaited round trips of their own, two of them the heaviest endpoints in
 * the app, to render four integers — the best part of a second on every page load from India
 * (R92). The server counts them directly now; this just reads them.
 */
export function applyCounts(me) {
  const keys = new Set(((me && me.sections) || []).map((s) => s.key));
  const b = (me && me.badges) || {};
  counts.prepare = keys.has("prepare") ? b.prepare || null : null;
  counts.approvals = keys.has("approvals") ? b.approvals || null : null;
  counts.fa = keys.has("fa") ? b.fa || null : null;
  counts.mailbox = keys.has("mailbox") ? b.mailbox || null : null;
}

/** After something changed: re-read `/api/me` and repaint. Never blocks a screen. */
export async function refreshCounts() {
  try {
    const me = await session.reload();
    applyCounts(me);
  } catch { /* counts are decoration */ }
  paint();
  paintCtx();
}

export function mountChrome() {
  // The counts are already in hand — `boot()` fetched `/api/me`. Nothing to wait for.
  applyCounts(session.me);
  paint();
  paintCtx();
  on(document.getElementById("top"), "click", "#who", () => openWho());
  on(document.getElementById("ctx"), "click", "#as-back", () => switchTo(null));
}

/** Switch "view as" — and say who you are now, every time. */
async function switchTo(email) {
  try {
    await actAs(email);
    await refreshCounts();
    const me = session.me || {};
    toast(me.actingAs ? `You are viewing as ${me.displayName}. What you do is recorded as them, and as you.` : `You are ${me.displayName} again.`, "ok");
    await dispatch();
  } catch (err) { toast(err.message, "err"); }
}

function openWho() {
  const me = session.me;
  const canSwitch = me.isAdmin && me.demoMode && session.users.length;
  sheet({
    eyebrow: "SIGNED IN",
    title: me.displayName,
    sub: me.email,
    body: html`
      <div class="chips" style="margin-top: 4px;">${(me.roles || []).map((r) => html`<span class="tag grey pad">${r.replace("_", " ")}</span>`)}</div>
      ${canSwitch ? html`
        <div class="sect" style="margin-top: 22px;">VIEW AS</div>
        <div class="sub" style="margin-top: 4px;">Opens the tool as someone else, to see what they see. Every action is still recorded against you as well as them, and the Admin section stays with your own account.</div>
        <div id="persona-list" style="margin-top: 10px; display: flex; flex-direction: column; gap: 6px;">
          ${me.actingAs ? html`<button class="row" data-persona="" style="border: 0; background: none; text-align: left; font: inherit; padding: 10px 4px; width: 100%;"><span style="display:flex; align-items:center; gap:12px;"><span class="av dark">${icon("back", 14)}</span><b>Back to myself</b></span></button>` : ""}
          ${session.users.filter((u) => u.email !== me.realEmail && u.active !== false).map((u) => html`
            <button class="row" data-persona="${u.email}" style="border: 0; background: none; text-align: left; font: inherit; padding: 10px 4px; width: 100%;">
              <span style="display:flex; align-items:center; gap:12px; min-width:0;"><span class="av ${(u.roles || []).includes("coordinator") ? "blue" : (u.roles || []).some((r) => r.startsWith("fa_")) ? "gold" : ""}">${initials(u.displayName)}</span>
              <span style="min-width:0;"><b>${u.displayName}</b><span class="small muted" style="display:block;">${u.title || (u.roles || []).join(", ")}</span></span></span>
              ${me.email === u.email ? html`<span class="tag pad small">now</span>` : icon("chevR", 16)}
            </button>`)}
        </div>` : ""}
      ${me.authenticated ? "" : html`<div class="small muted" style="margin-top: 18px;">This environment is not behind single sign-on yet, so everyone arrives as the same signed-out visitor.</div>`}`,
    actions: [{ label: "Close", value: null, tone: "sec" }],
    onMount: (el) => {
      on(el, "click", "button[data-persona]", async (e, b) => {
        const email = b.dataset.persona || null;
        closeSheet(null);
        await switchTo(email);
      });
    },
  });
}

export { navigate };
