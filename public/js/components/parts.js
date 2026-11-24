// The shared pieces every screen is built from — the vocabulary of the design canvas, as functions
// that return markup. Nothing here talks to the server.
import { html, raw } from "../core/dom.js";
import { icon } from "../core/icons.js";
import { session } from "../core/session.js";
import { initials, money, ago, since, exact, stateLabel, clockTime } from "../core/format.js";

/**
 * A moment, said both ways (R129).
 *
 * "3 days ago" is the right thing to read and the wrong thing to audit against. The relative
 * form stays on the surface; the exact one rides in `title` and in `datetime`, so a hover, a
 * screen reader and a copy-paste all recover the moment. Every `since()`/`ago()` in copy goes
 * through this — the data was always there, nothing ever printed it.
 */
export function when(iso, opts) {
  const o = opts || {};
  if (!iso) return html`<span class="muted">${o.blank || "—"}</span>`;
  // `clock` says the moment and keeps the age for the hover — what a history wants; elsewhere the
  // age is said and the exact moment hovers.
  if (o.clock) return html`<time datetime="${iso}" title="${since(iso)} · ${exact(iso)}">${o.prefix || ""}${clockTime(iso)}</time>`;
  const txt = o.bare ? ago(iso) : since(iso);
  return html`<time datetime="${iso}" title="${exact(iso)}">${o.prefix || ""}${txt}</time>`;
}

export const avatar = (name, tone, size) =>
  html`<span class="av ${tone || ""} ${size || ""}" aria-hidden="true">${initials(name)}</span>`;

/**
 * Shape is a channel (R119).
 *
 * A person and a document were the SAME OBJECT: `docRow` rendered `<span class="av lg red">PDF`,
 * literally the avatar class, so a 34px circle meant a human on one row and a file on the next —
 * and a document with role `envelope_pdf` took tone "", which is the same green as a person who
 * had signed. Round is a person. Paper gets the shape of paper. Nothing else needs saying.
 */
const DOC_TONE = {
  quote: "blue", sow: "blue", backup: "grey", email_approval: "yellow", budget_evidence: "yellow",
  internal_quote: "blue", material_evidence: "yellow",
  afe_form_pdf: "ink", sent_packet: "ink", envelope_pdf: "green", certificate: "green", issued_pack: "green",
};
const EXT = (filename) => {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(String(filename || ""));
  return m ? m[1].toLowerCase() : "doc";
};
export const docBadge = (role, filename) =>
  html`<span class="pg ${DOC_TONE[role] || "grey"}" aria-hidden="true">${EXT(filename)}</span>`;

/**
 * A SAP transaction code is an instruction to TYPE, not a status — so it is a keycap, not a
 * fourth kind of circle. `state` is "done" | "now" | "off" | undefined.
 */
export const txnKey = (code, state) => html`<span class="key ${state || ""}">${code}</span>`;

/**
 * A section with a ground and a glyph, instead of a white card under a grey line of capitals.
 *
 * There was no panel component at all — 21 screen files hand-wrote 144 `.card` + `.tabhd` pairs,
 * which is why every back-office screen read as one texture. `tone` is grey (default), green,
 * blue, yellow or red; `flush` is for a body that is its own list of rows.
 */
export function panel(o) {
  const b = o || {};
  return html`<section class="panel ${b.tone ? "t-" + b.tone : ""} ${b.cls || ""}" ${b.id ? raw(`id="${b.id}"`) : nothing} data-key="${b.key || b.title || ""}">
    <div class="panel-hd">${b.icon ? icon(b.icon, 14) : nothing}<span class="ttl">${b.title}</span>${b.meta ? html`<span class="meta">${b.meta}</span>` : nothing}${b.right ? html`<span class="right">${b.right}</span>` : nothing}</div>
    <div class="panel-bd ${b.flush ? "flush" : ""}">${b.children}</div>
  </section>`;
}

/**
 * The strip that says which view of a section you are in. Its own component, deliberately not
 * `.chipnav` — that is the application's top-level nav, and wearing it was most of why the FA
 * tabs read as tabs and behaved as a departure.
 */
export function subnav(items, activeKey) {
  return html`<nav class="subnav" aria-label="Views">${items.map((i) => html`<a href="${i.href}" class="${i.key === activeKey ? "on" : ""}" ${i.key === activeKey ? raw('aria-current="page"') : nothing} data-key="${i.key}">${i.icon ? icon(i.icon, 14) : nothing}<span>${i.label}</span>${typeof i.n === "number" && i.n > 0 ? html`<span class="n">${i.n}</span>` : nothing}</a>`)}</nav>`;
}

/**
 * An explanation you point at, instead of one the screen recites.
 *
 * A grey paragraph at the foot of a screen saying how the screen works is the design talking
 * instead of showing, and there was one on nearly every screen. The trigger is a real button
 * carrying the text as its accessible name, and the bubble opens on FOCUS as well as hover — so
 * a keyboard reaches it, a tap reaches it, and a screen reader never depended on the bubble at
 * all. Never put one inside `.list` or any other `overflow: hidden` box: the bubble is absolute
 * and would be clipped. `end` right-aligns it, `below` drops it under the glyph.
 */
export function tip(text, opts) {
  const o = opts || {};
  return html`<span class="tip ${o.cls || ""}"><button type="button" class="tipb" aria-label="${text}">i</button><span class="tipbody" role="tooltip">${text}</span></span>`;
}

/**
 * Which colour an AFE is, by where it is. ONE map, used by the status badge and by the ground of
 * the row it sits on, so a list can be scanned by colour rather than read line by line.
 */
export function stateTone(state) {
  switch (state) {
    case "draft": return "grey";
    case "submitted": case "on_hold": return "yellow";
    case "in_approval": return "blue";
    case "returned": case "rejected": return "red";
    case "approved": case "fa_review": case "issued": case "tracking": case "capitalized": return "green";
    default: return "grey";
  }
}

/** A coloured fact: `tag("CC 30145", "blue")`. */
export function tag(text, tone, opts) {
  const o = opts || {};
  return html`<span class="tag ${tone || ""} ${o.pad || (!o.avatar && !o.icon) ? "pad" : ""} ${o.cls || ""}" title="${o.title || ""}">${o.avatar ? avatar(o.avatar, o.avatarTone, "xs") : ""}${o.icon ? icon(o.icon, 14) : ""}<span class="txt">${text}</span></span>`;
}

/**
 * Money in a COLUMN, set the way the AFE form sets it.
 *
 * The generated PDF already reproduces Excel's accounting format -- the currency mark against
 * the left edge of the cell, the figure against the right, negatives in parentheses -- because
 * that is what makes a column of money readable: the marks line up, the digits line up, and a
 * figure an order of magnitude out is visible without being read. The screens were rendering a
 * single string with the dollar sign glued to the first digit, so nothing lined up with anything.
 *
 * Only where there IS a column. A figure inside a sentence is prose, and `money()` stays right
 * for that.
 */
export function moneyCell(n, opts) {
  const o = opts || {};
  const v = Number(n);
  if (!Number.isFinite(v)) return html`<span class="amt ${o.cls || ""}">—</span>`;
  const s = money(Math.abs(v), o);                  // "$132,000" — always positive here
  return html`<span class="amt acct ${v < 0 ? "neg" : ""} ${o.cls || ""}">
    <span class="cur">${s.slice(0, 1)}</span><span class="fig">${v < 0 ? `(${s.slice(1)})` : s.slice(1)}</span></span>`;
}

/** A consequence chip that appears under the answer that caused it. */
export function reveal(text, opts) {
  const o = opts || {};
  return html`<span class="reveal ${o.tone || ""}" data-key="${o.key || ""}">${o.avatar ? avatar(o.avatar, o.avatarTone) : o.icon ? html`<span class="av ${o.avatarTone || ""}">${icon(o.icon, 14)}</span>` : ""}<span class="txt">${text}</span></span>`;
}

/**
 * The journey on top. `steps` = [{ n, label, href }], `current` = n; `issues[n]` = { block, pending }.
 * Every segment is a link, so the journey is also the navigation.
 */
export function stepper(steps, current, issues) {
  const cur = steps.findIndex((s) => s.n === current);
  return html`<nav class="stepper" aria-label="Steps">
    ${steps.map((s, i) => {
      const iss = (issues && issues[s.n]) || {};
      const cls = i < cur ? "done" : i === cur ? "on" : "";
      const inner = html`<span class="bar"><i></i></span>
        <span class="lab">${iss.block ? html`<span class="dot" title="${iss.block} to fix"></span>` : iss.pending ? html`<span class="dot pending" title="waiting on a fact"></span>` : ""}${s.label}</span>`;
      // A step past the first one that still blocks is shown and not offered. The journey used to
      // be a breadcrumb you could jump FORWARD on, and jumping forward walks past the validation
      // on everything in between — the one thing a one-question-at-a-time wizard must not allow.
      if (s.readonly) {
        return html`<span class="seg ${cls} ro" data-key="step-${s.n}" aria-current="${i === cur ? "step" : "false"}">${inner}</span>`;
      }
      if (s.locked) {
        return html`<span class="seg locked" data-key="step-${s.n}" title="Finish the earlier steps first." aria-disabled="true" aria-label="Step ${i + 1}: ${s.label} — not yet">${inner}</span>`;
      }
      // A step whose subject is a SECTION of the screen you are already on, not another screen.
      // Fixed Assets' six steps are five sections of one page plus the judgment, and five of the
      // six were `<a href>` to the page you were standing on: the click did nothing, the URL did
      // not change, and "at Done you cannot go back to any step except Judgment" (Shashank,
      // 2026-09-22) is what that feels like from the other side. A jump is honest about it — it
      // scrolls to the section and rings it — and it is a BUTTON, because it navigates nowhere
      // and must not push a history entry you then have to press Back through.
      if (s.jump) {
        return html`<button type="button" class="seg ${cls}" data-step-jump="${s.jump}" data-key="step-${s.n}" aria-current="${i === cur ? "step" : "false"}" aria-label="Step ${i + 1}: ${s.label} — show it on this page">${inner}</button>`;
      }
      return html`<a class="seg ${cls}" href="${s.href}" data-key="step-${s.n}" aria-current="${i === cur ? "step" : "false"}" aria-label="Step ${i + 1}: ${s.label}${iss.block ? ` — ${iss.block} to fix` : ""}">${inner}</a>`;
    })}
    ${cur >= 0 ? html`<span class="stepnow" aria-hidden="true">Step ${cur + 1} of ${steps.length} · ${steps[cur].label}</span>` : ""}
  </nav>`;
}

/**
 * A bucket card: the aggregation a screen opens on. Click toggles it open.
 *
 * R109: it is filled in its own colour and it leads with a glyph in a saturated medallion, with
 * the count opposite. The eye takes the colour, then the shape, then the figure, and reads the
 * sentence last — which is the order they are actually taken in. The previous white card with a
 * 3px rule down its edge had no first three, so it asked to be read.
 */
export function bucket(b) {
  // Only a plain number counts up. A figure written as markup ("4 of 4", or the "—" of a locked
  // tile) used to carry data-count="" — and Number("") is 0, so the count-up wrote "0" over it
  // and the real figure only came back when a click repainted the tile.
  const n = typeof b.n === "number"
    ? html`<span class="n" data-count="${b.n}">${b.n}</span>`
    : html`<span class="n">${b.n}</span>`;
  return html`<button class="bucket ${b.tone} ${b.on ? "on" : ""}" data-bucket="${b.key}" data-key="${b.key}" aria-pressed="${b.on ? "true" : "false"}">
    <span class="bhead"><span class="ico">${icon(b.icon || "doc", 15)}</span>${n}</span>
    <span class="t">${b.title}</span><span class="d">${b.detail}</span>
  </button>`;
}

export function progress(signed, of) {
  const p = of ? Math.round((signed / of) * 100) : 0;
  return html`<span class="prog"><span class="bar"><i style="width: ${p}%"></i></span>${signed} of ${of}</span>`;
}

/**
 * Who signs, in order, drawn as a chain rather than listed.
 *
 * `rows` are `{ key, n, name, level, why, tone }`; `tone` is "" for a matrix signer, "pre" for a
 * pre-approver, "fa" for Fixed Assets at the end, "send" for whoever sends it. The numbered
 * nodes are joined by a line because the ORDER is the point — a flat list of avatars said the
 * same facts and showed none of the shape.
 */
export function signChain(rows) {
  return html`<ol class="chain">
    ${rows.map((r) => html`<li class="cstep ${r.tone || ""}" data-key="${r.key}">
      <span class="cnum">${r.n}</span>
      <span style="min-width: 0;">
        <span class="nm">${r.name}${r.level ? html`<span class="lvl">${r.level}</span>` : ""}</span>
        ${r.why ? html`<span class="why" title="${r.why}">${r.why}</span>` : ""}
      </span>
    </li>`)}
  </ol>`;
}

/** The one line that says where an AFE is: with whom, for how long. */
/** Who the holder is, in words: a level's title rather than "A1", a role rather than "pre_approver". */
function holderRole(h) {
  const titles = (session.refdata && session.refdata.levelTitles) || {};
  if (h.level) return titles[h.level] || h.level;
  return String(h.role || "").replace(/_/g, "-");
}
export function whereTag(brief) {
  const r = brief.routing;
  switch (brief.state) {
    case "draft": return tag("Draft — not sent", "grey", { icon: "pen" });
    case "submitted": return tag(`With ${brief.coordinator ? brief.coordinator.name : "the coordinator"} to send`, "yellow", { avatar: brief.coordinator ? brief.coordinator.name : "C", avatarTone: "blue" });
    case "in_approval":
      return r && r.holder ? tag(`with ${r.holder.name} · ${holderRole(r.holder)} · ${ago(r.holder.since)}`, "blue", { avatar: r.holder.name, avatarTone: "blue" }) : tag("In approval", "blue");
    case "on_hold": return tag(`Question from ${r && r.holder ? r.holder.name : "an approver"} — answer it`, "yellow", { icon: "question" });
    case "returned": return tag(`Sent back${brief.returnedTo ? " by " + brief.returnedTo.byName : ""} — fix and resubmit`, "red", { icon: "back" });
    case "approved": case "fa_review": return tag("Fully signed — with Fixed Assets", "", { icon: "shield" });
    case "issued": case "tracking": return tag(`Issued${brief.afeNo ? " · AFE " + brief.afeNo : ""}`, "", { icon: "box" });
    case "capitalized": return tag("Capitalized", "", { icon: "tick" });
    case "closed": return tag("Closed", "grey", { icon: "lock" });
    case "rejected": return tag("Declined", "red", { icon: "x" });
    case "withdrawn": return tag("Withdrawn", "grey", { icon: "minus" });
    default: return tag(stateLabel(brief.state), "grey", { icon: "info" });
  }
}

/** One AFE in a list. Identity on every row (rule 7): who raised it, division, cost centre. */
export function afeRow(brief, href, opts) {
  const r = brief.routing;
  // On YOUR requests your own name on every row says nothing; elsewhere it is who raised it.
  const mine = Boolean(opts && opts.mine) && brief.requester && session && session.me
    && String(brief.requester.email || "").toLowerCase() === String(session.me.email || "").toLowerCase();
  const who = brief.requester && !mine ? brief.requester.name : "";
  const holder = r && r.holder ? r.holder.name : (brief.coordinator && brief.state === "submitted" ? brief.coordinator.name : (brief.requester ? brief.requester.name : ""));
  return html`<a class="lrow t-${stateTone(brief.state)}" href="${href}" data-key="${brief.id}">
    ${avatar(holder, brief.state === "in_approval" ? "blue" : "", "lg")}
    <span style="min-width: 0;"><span class="ttl">${brief.title}</span><span class="id">${[who, brief.division].filter(Boolean).join(" · ")}${brief.costCenter ? " · cost centre " + brief.costCenter : ""}${brief.sentAt ? " · sent " + since(brief.sentAt) : brief.updatedAt ? " · " + since(brief.updatedAt) : ""}</span></span>
    ${moneyCell(brief.totalUsd)}
    <span class="tagcol" style="min-width: 0;">${whereTag(brief)}</span>
    <span class="wideonly">${r && r.of ? progress(r.signed, r.of) : ""}</span>
    <span class="chev">${icon("chevR", 18)}</span>
  </a>`;
}

/** Validation messages for one field (or several), block first. */
/** A message that names other AFEs offers them (a banner that names a thing offers it). */
function matchLinks(e) {
  const m = e && e.data && e.data.matches;
  if (!m || !m.length) return "";
  return html`<span class="matches" style="display: block; margin-top: 4px;">${m.map((x) => html`<a href="/afe/${x.id}" target="_blank" rel="external" data-key="${x.id}" style="display: block; font-size: 12.5px;">${String(x.id).toUpperCase()} · ${x.title || "(untitled)"}${x.state ? ` · ${stateLabel(x.state)}` : ""}</a>`)}</span>`;
}
/** What a message offers besides its words — the fix, the AFEs it names. */
export function msgExtras(e) { return html`${fixBtn(e)}${matchLinks(e)}`; }
export function fieldMsgs(validation, fields, opts) {
  if (!validation) return "";
  const set = new Set(Array.isArray(fields) ? fields : [fields]);
  const o = opts || {};
  // A rule with a note box beside it has already printed its message there.
  const skip = new Set(o.exceptRules || []);
  const keep = (e) => set.has(e.field) && !skip.has(e.rule);
  const rows = [];
  for (const e of validation.blocks || []) if (keep(e)) rows.push({ kind: "block", e });
  for (const e of validation.pending || []) if (keep(e)) rows.push({ kind: "pending", e });
  if (!o.noWarn) for (const e of validation.warns || []) if (keep(e)) rows.push({ kind: "warn", e });
  if (!rows.length) return "";
  return html`${rows.slice(0, o.max || 2).map((r) => html`<div class="field-msg ${r.kind}" data-key="${r.kind}-${r.e.rule || r.e.field}">${icon(r.kind === "block" ? "bang" : r.kind === "pending" ? "clock" : "info", 14)}<span>${r.e.message}${fixBtn(r.e)}${matchLinks(r.e)}</span></div>`)}`;
}

/**
 * Messages for a step that no control on the screen has already shown.
 *
 * `exceptRules` is the other half of that promise: a rule with a note box beside it has already
 * printed its message inside that box, and repeating it underneath made the quote-coverage
 * warning appear twice on one phone screen.
 */
export function stepMsgs(validation, step, shownFields, opts) {
  if (!validation) return "";
  const shown = new Set(shownFields || []);
  const skip = new Set((opts && opts.exceptRules) || []);
  const rows = [];
  const keep = (e) => e.step === step && !shown.has(e.field) && !skip.has(e.rule);
  for (const e of validation.blocks || []) if (keep(e)) rows.push({ kind: "block", e });
  for (const e of validation.pending || []) if (keep(e)) rows.push({ kind: "pending", e });
  for (const e of validation.warns || []) if (keep(e)) rows.push({ kind: "warn", e });
  return html`${rows.map((r) => html`<div class="field-msg ${r.kind}" data-key="s-${r.kind}-${r.e.rule || r.e.field}">${icon(r.kind === "block" ? "bang" : r.kind === "pending" ? "clock" : "info", 14)}<span>${r.e.message}${fixBtn(r.e)}</span></div>`)}`;
}

/**
 * The button a blocking message offers when the rule knows what would resolve it.
 *
 * `e.fix` is `{ field, value, label }` and comes from the rule itself (`lib/domain/afeRules.js`),
 * so the screen never has to know which rule it is looking at. A block that names a field and
 * gives no way to change it is a dead end — and the Cloud CapEx tree reaches one by answering
 * four questions honestly.
 */
/**
 * What a document IS, in words — said before its file name, because the name is whatever the
 * sender's machine called it: an approver met "画像 (2).png" and "image (9).png" where a Acme
 * quotation and an SAP material screenshot were meant (15 Oct).
 */
export const ROLE_NAMES = { quote: "Quote", internal_quote: "Acme quotation", material_evidence: "SAP material screenshot", sow: "Statement of work", backup: "Supporting", email_approval: "Email approval", budget_evidence: "SAP budget table", afe_form_pdf: "AFE Form — generated", sent_packet: "Sent for signature — one file", envelope_pdf: "Signed set", certificate: "Certificate of Completion", issued_pack: "Issued AFE" };
export const roleName = (role) => ROLE_NAMES[role] || role;

export function fixBtn(e) {
  // A fix that is a STEP rather than a value — "Set it up" opens the Financials step — goes
  // through the screen's own step change, so whatever is typed is saved first.
  if (e && e.fix && e.fix.step && !e.fix.field) return html` <button type="button" class="fixbtn" data-fix-step="${e.fix.step}">${e.fix.label || "Open it"}</button>`;
  if (!e || !e.fix || !e.fix.field) return "";
  return html` <button type="button" class="fixbtn" data-fix-field="${e.fix.field}" data-fix-value="${e.fix.value === null || e.fix.value === undefined ? "" : e.fix.value}">${e.fix.label || "Fix it"}</button>`;
}

/**
 * What resubmitting a returned AFE will do (R148), as a consequence under the thing that caused
 * it: straight back into the round it came out of, with the signatures standing, or round again,
 * with the reason. `resume` is the view's copy of the check the transition itself decides with,
 * so this chip can never promise what Submit then does not do.
 */
export function roundLine(resume) {
  const r = resume;
  if (!r || !r.applies) return "";
  if (r.can) {
    const n = (r.signed || []).length;
    const to = r.mode === "signed" ? "Fixed Assets" : r.holder ? r.holder.name : "the approver";
    const stand = r.mode === "signed" ? "the signatures stand"
      : n === 1 ? `${String(r.signed[0].name).split(" ")[0]}'s signature stands` : n ? `${n} signatures stand` : "the same envelope";
    return tag(`Goes straight back to ${to} · ${stand}`, "", { icon: "tick", cls: "sentence" });
  }
  const why = (r.reasons || []).map((x) => x.text);
  return html`${tag(`Goes round again · ${why[0] || "something that decides it changed"}`, "yellow", { icon: "refresh", cls: "sentence" })}${why.length > 1 ? tip(`Also: ${why.slice(1).join("; ")}.`) : ""}`;
}

/**
 * The conversation on an AFE (R149): ONE component, on every screen that shows it.
 *
 * It was hand-written three times — the approver's decision, the coordinator's routing, the
 * requester's record — and Fixed Assets had none, so "let's use the comment section only… it
 * will have the audit trail, what we asked and what they responded" (Jarrod, Meeting #6) had no
 * comment section to use. Each line says who wrote it and which side of the AFE they are on; a
 * question, an answer and a send-back keep their own ground, a comment is plain.
 *
 * The screen wires `[data-thread-post]` to `POST /api/afes/:id/comment`; nothing here talks to
 * the server.
 *
 * A COMMENT tells nobody and an ASK tells the other side (R163): "too noisy" (Judithmelanie, Meeting
 * #7). So there are two buttons, and the Ask names who it reaches. Whether an ask is still open is
 * the server's reading of the thread (`view.asks`), shown here and never worked out again.
 *
 * @param {Array}  entries  afe.thread
 * @param {object} [o]      { canComment, canAsk, askWho, asks: view.asks, sides: refdata.threadSides, placeholder }
 */
const THREAD_WORD = { question: "asked", answer: "answered", send_back: "sent it back", decline: "declined", ask: "asks" };
const SIDE_TONE = { fa: "blue", approver: "dark" };
export function thread(entries, o) {
  const opts = o || {};
  const list = entries || [];
  // Something waiting on this viewer (`permissions.answerTo`): the main button answers it.
  const ans = opts.answer || null;
  const answerFirst = ans ? String(ans.byName || "them").split(" ")[0] : null;
  if (!list.length && !opts.canComment) return "";
  const sides = opts.sides || {};
  const askState = {};
  for (const a of opts.asks || []) askState[a.id] = a;
  return html`<div class="card pad thread" data-key="thread">
    <div class="sect">${icon("chat", 13)} THE CONVERSATION${list.length ? ` · ${list.length}` : ""}</div>
    ${list.map((t) => { const ask = t.kind === "ask" ? askState[t.id] : null;
      return html`<div class="msg ${t.kind} ${ask && ask.open ? "open" : ""}" data-key="${t.id}">${avatar(t.byName, SIDE_TONE[t.side] || "")}<div class="body">
      <div class="meta"><b>${t.byName}</b>${sides[t.side] ? html` · <span class="side">${sides[t.side]}</span>` : ""}${THREAD_WORD[t.kind] ? ` · ${THREAD_WORD[t.kind]}` : ""} · ${when(t.at)}${ask ? html` <span class="askst ${ask.open ? "open" : "done"}">${icon(ask.open ? "clock" : "tick", 12)}${ask.open ? "waiting for an answer" : `answered by ${String(ask.answeredByName || "").split(" ")[0] || "them"}`}</span>` : ""}</div>
      <div class="text">${t.text}</div></div></div>`; })}
    ${opts.canComment ? html`<div class="compose" data-key="compose" id="compose">
      <textarea class="input" data-thread-text rows="2" maxlength="2000" placeholder="${answerFirst
        ? (ans.mode === "question" ? `Your answer goes to ${answerFirst}, and the approval carries on. A comment does not answer it.` : `Your answer goes to ${answerFirst}.`)
        : opts.placeholder || (opts.canAsk ? `A note on the record. Nobody is e-mailed — Ask ${opts.askWho} to get an answer.` : "A note on the record. Nobody is e-mailed.")}"></textarea>
      <span class="acts">
        ${answerFirst
          ? html`${ans.mode === "question" ? html`<button type="button" class="cta sm sec" data-thread-post>${icon("chat", 14)}Comment</button>` : ""}<button type="button" class="cta sm" data-thread-post data-answer="${ans.mode}">${icon("send", 14)}Answer ${answerFirst}</button>`
          : html`<button type="button" class="cta sm sec" data-thread-post>${icon("chat", 14)}Comment</button>
        ${opts.canAsk ? html`<button type="button" class="cta sm" data-thread-post data-ask="1">${icon("send", 14)}Ask ${opts.askWho}</button>` : ""}`}
      </span>
    </div>` : ""}
  </div>`;
}

/**
 * "Reopens at" — which step a send-back drops the requester on.
 *
 * Built from `refdata.wizardSteps`, which is the server's own list, because this was a literal
 * copied into three screens and all three fell behind the day the journey gained a step. A step
 * that does not apply to this AFE is still offered: the wizard's own route guard moves Cloud
 * CapEx to Quote when the tree is not triggered and Financials to Why when there is no capital,
 * so the worst case is landing on the next step that does apply — which is what the sender meant.
 */
export function reopenPicker(steps, selected) {
  const list = (steps || []).length ? steps : [{ n: 3, label: "How much" }];
  const pick = list.some((s) => s.n === selected) ? selected : 3;
  return html`<div class="chips" style="margin-top: 8px;">${list.map((s) => html`<button type="button" class="chip sm ${s.n === pick ? "on" : ""}" data-step="${s.n}">${s.label}</button>`)}</div>`;
}

/** A two-or-three-way toggle: `toggle("budget.budgeted", ["Yes","No"], value)`. */
export function toggle(field, options, value, opts) {
  const o = opts || {};
  return html`<span class="tog ${o.wide ? "wide" : ""}" role="group" data-field-group="${field}">
    ${options.map((opt) => {
      const v = typeof opt === "string" ? opt : opt.value;
      const label = typeof opt === "string" ? opt : opt.label;
      return html`<button type="button" class="${v === value ? "on" : ""}" data-toggle="${field}" data-value="${v}" aria-pressed="${v === value ? "true" : "false"}">${label}</button>`;
    })}
  </span>`;
}

/** Selectable chips: `chips("project.projectType", options, value)`. Selecting the selected deselects (rule 4). */
export function chips(field, options, value, opts) {
  const o = opts || {};
  return html`<div class="chips" role="group" data-field-group="${field}">
    ${options.map((opt) => html`<button type="button" class="chip ${opt === value ? "on" : ""} ${o.small ? "sm" : ""}" data-chip="${field}" data-value="${opt}" data-key="${opt}" aria-pressed="${opt === value ? "true" : "false"}">${opt}</button>`)}
    ${o.more ? html`<button type="button" class="chip more ${o.small ? "sm" : ""}" data-more="${field}" data-key="__more">${o.more}</button>` : ""}
  </div>`;
}

export const CTA_ARROW = icon("chevR", 16, { stroke: 2.2 });
export const check = icon("tick", 14, { stroke: 2.4 });

/** A person on a chain, as the coordinator and the approver both see them. */
export function signerRow(rec, opts) {
  const o = opts || {};
  const live = ["pending", "sent", "signed"].includes(rec.status);
  const numCls = rec.status === "signed" ? "done" : rec.status === "sent" ? "now" : !live ? "off" : "";
  const roleText = rec.role === "cc" ? "" : rec.level ? `${rec.level}${rec.levelTitle ? " " + rec.levelTitle : ""}` : rec.role === "pre_approver" ? (rec.group || "pre-approver") : rec.role.replace("_", " ");
  return html`<div class="signer ${rec.status === "sent" ? "todo" : ""} ${rec.status === "signed" ? "done" : ""}" data-key="${rec.id}" data-rid="${rec.id}">
    <span class="num ${rec.role === "cc" ? "cc" : numCls}">${rec.role === "cc" ? "cc" : rec.status === "signed" ? icon("tick", 16, { stroke: 2.4 }) : rec.order || (rec.status === "skipped" ? "=" : "–")}</span>
    ${avatar(rec.name || "?", rec.role === "cc" ? "grey" : rec.status === "signed" ? "" : rec.role === "pre_approver" ? "" : rec.role === "additional" ? "lime" : rec.role === "override" ? "dark" : "blue", "lg")}
    <span style="min-width: 0;">
      <span class="nm">${rec.name || "(blank)"} ${roleText ? html`<span class="role">· ${roleText}</span>` : ""}</span>
      <span class="why" style="display:block;">${rec.status === "signed" && rec.signedAt ? html`Signed ${when(rec.signedAt)}. ` : ""}${rec.status === "sent" && rec.notifiedAt ? html`Has had it ${when(rec.notifiedAt, { bare: true })}. ` : ""}${o.hideWhy ? "" : rec.why || ""}</span>
      <!-- Where a rule names a pair and asks for ONE of them — the $1M technical accounting
           review — the choice is made here, on the row, by the person who shapes the chain. -->
      ${o.canChoose && (rec.alternates || []).length > 1 ? html`<span class="alts"><span class="altlbl">either</span>${rec.alternates.map((a) => html`<button type="button" class="altbtn ${a.chosen ? "on" : ""}" data-choose-rule="${rec.sourceRuleId}" data-choose-index="${a.index}" ${a.chosen ? "disabled" : ""}>${a.name}</button>`)}</span>` : ""}
    </span>
    ${o.right !== undefined ? o.right : mailbox(rec)}
    ${o.action !== undefined ? o.action : html`<span></span>`}
  </div>`;
}

const SRC_LABEL = { users: "KNOWN", directory: "KNOWN", rule: "FROM THE RULE", typed: "TYPED", confirmed: "CONFIRMED", guessed: "GUESSED", unresolved: "NO MAILBOX" };
export function mailbox(rec) {
  if (rec.role !== "cc" && !["pending", "sent", "signed"].includes(rec.status)) return html`<span class="mail soft"><span class="txt">${rec.status === "skipped" ? "signs at a higher row" : rec.status === "sod_blocked" ? "cannot sign — party to this AFE" : rec.status}</span></span>`;
  const ok = rec.email && ["users", "directory", "rule", "typed", "confirmed"].includes(rec.emailSource);
  return html`<span class="mail ${ok ? "" : "todo"} ${rec.role === "cc" ? "soft" : ""}">${ok ? icon("tick", 14, { stroke: 2.4 }) : icon("mail", 14)}<span class="txt">${rec.email || "no mailbox yet"}</span><span class="src">${SRC_LABEL[rec.emailSource] || ""}</span></span>`;
}

// The tool's own generations of an AFE: the form it drew, the file sent for signature, the signed
// set, an issued AFE. They are ONE document at different moments (R156), so no list offers them
// as rows of their own — `theAfeRow` stands for whichever of them is current.
export const GENERATED_ROLES = ["afe_form_pdf", "sent_packet", "envelope_pdf", "issued_pack"];

/** What a person attached, and the evidence that came back — everything that is not the AFE itself. */
export const ownDocuments = (afe) => ((afe && afe.documents) || []).filter((d) => !GENERATED_ROLES.includes(d.role));

/**
 * THE AFE, as one row, whatever stage it is at (R156).
 *
 * A Documents panel used to list the generated form, the file sent for signature, the signed set
 * and every issued AFE Fixed Assets had built — four generations of one document — so which of
 * them was "the AFE" was left to whoever was reading, and the one without the quote in it was a
 * click away. This row opens `document.pdf`, which serves the current one, and says which it is
 * in the words of the same choice the server makes (`storedDocument`).
 */
export function theAfeRow(view, opts) {
  const o = opts || {};
  const a = view.afe, env = view.envelope || view.envelopeBrief || null, docs = a.documents || [];
  const pack = docs.filter((d) => d.role === "issued_pack").pop();
  const rs = view.resume;
  const where = pack ? "issued by Fixed Assets — the signed AFE, their marks in red"
    : !env || ["draft", "submitted"].includes(a.state) ? "as it stands now, with everything attached"
    : a.state === "returned" ? (rs && rs.applies && rs.can ? (rs.mode === "signed" ? "as it was signed" : "as it was sent for signature") : "as it stands now, with everything attached")
    : env.status === "completed" ? "as signed by everyone"
    : "as sent for signature";
  return html`<div class="doc" data-key="the-afe">
    ${docBadge(pack || env && env.status === "completed" ? "envelope_pdf" : "afe_form_pdf", "AFE.pdf")}
    <span class="meta"><span class="name">The AFE</span><span class="desc">${where}${a.afeNo ? ` · order ${a.afeNo}` : pack ? "" : " · AFE number blank until issued"}</span></span>
    ${o.right !== undefined ? o.right : html`<a class="pillbtn" href="/api/afes/${a.id}/document.pdf" target="_blank" rel="external">Open ${icon("external", 14)}</a>`}
  </div>`;
}

export function docRow(d, afeId, opts) {
  const o = opts || {};
  const role = roleName(d.role);
  return html`<div class="doc" data-key="${d.attachmentId}">
    ${docBadge(d.role, d.filename)}
    <span class="meta"><span class="name">${d.filename}</span><span class="desc">${role}${d.vendor ? " · " + d.vendor : ""}${d.amountUsd ? " · " + money(d.amountUsd, { cents: true }) : ""}${d.sizeBytes ? " · " + Math.max(1, Math.round(d.sizeBytes / 1024)) + " KB" : ""}</span></span>
    ${o.right !== undefined ? o.right : html`<a class="pillbtn" href="/api/afes/${afeId}/documents/${d.attachmentId}/raw" target="_blank" rel="external">Open ${icon("external", 14)}</a>`}
  </div>`;
}

/**
 * What has happened to this record, in order, with its real dates (R129).
 *
 * The data was never missing — `applyTransition` writes an audit row for every transition with
 * the actor and the moment — but no screen read it, and every time that did appear on screen was
 * a fuzzy duration with no way back to the exact one. `rows` are `{ at, text, kind, byEmail }`
 * from `GET /afes/:id/history`; a milestone with no row yet shows as what is still to come,
 * because a spine that just stops does not say whether the next thing is due or done.
 */
export function spine(rows, opts) {
  const o = opts || {};
  const GLYPH = { done: "tick", warn: "bang", stop: "x", step: "chevR", todo: "clock" };
  return html`<div class="spine">${rows.map((r, i) => {
    const kind = r.at ? (r.kind || "step") : "todo";
    return html`<div class="mrow ${kind}" data-key="${r.key || r.type || i}">
      <span class="pip">${icon(GLYPH[kind] || "chevR", 13, { stroke: kind === "done" ? 2.4 : 2 })}</span>
      <span style="min-width: 0;"><span class="t">${r.text || r.label}</span>${r.byEmail && !o.hideWho ? html`<span class="by"> · ${r.byName || r.byEmail}</span>` : nothing}</span>
      ${r.at ? when(r.at, { clock: true }) : html`<span class="none">not yet</span>`}
    </div>`;
  })}</div>`;
}

/**
 * How the promised in-service date has moved (R125).
 *
 * `esdHistory` is the estimated-service-date history the recon workbook keeps per line, and it
 * arrives structured — one entry per re-forecast. One order in the seed carries TWENTY-TWO of
 * them, running from a 2023 promise to a 2026 one; the screen rendered the last entry as a
 * single yellow chip and threw the other twenty-one away. A date that has moved twenty-two times
 * is the most useful thing anyone can know about an AuC line, and a step line says it instantly:
 * the promise receding, against today, which no list of dates does.
 *
 * Inline SVG. No library — the ADC rules forbid a frontend package and this needs none.
 */
export function slipChart(history, opts) {
  const o = opts || {};
  // ONE CALENDAR DAY, however the workbook wrote it.
  //
  // `Date.parse("2025-05-15")` is UTC midnight; `Date.parse("5/15/2025")` is LOCAL midnight. The
  // recon file uses both, and reading either back with the UTC getters put every US-format date
  // a day early — the chart said "14 May 2025" about a cell that reads 5/15/2025. Normalise to
  // the same UTC calendar day at the door, and every label, hover and axis agrees with the file.
  const day = (v) => {
    const raw = String(v || "").slice(0, 10);
    const t = Date.parse(raw);
    if (!isFinite(t)) return null;
    const d = new Date(t);
    return /^\d{4}-\d{2}-\d{2}$/.test(raw)
      ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
      : Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  // A DATE THAT CANNOT BE TRUE IS NOT PLOTTED, AND IS NOT HIDDEN EITHER.
  //
  // The workbook is typed by hand and it shows: IO 312103 carries "10/31/225", a dropped digit
  // from 2025, which `Date.parse` reads as the year 225 AD. One such value stretches the axis
  // across eighteen centuries and squashes every real promise into a sliver — a single typo makes
  // the whole picture a lie. Dropping it silently would be worse, because the FA team can only
  // fix a number in their own file if somebody tells them it is wrong. So: out of the line and
  // out of the scale, counted in the footer with the text that was actually entered.
  const PLAUSIBLE = [Date.parse("1990-01-01"), Date.parse("2100-01-01")];
  const all = (history || []).map((h) => ({
    at: day(h.enteredAt), to: day(h.estimatedServiceDate), kind: h.kind, raw: h.estimatedServiceDate,
  }));
  const unreadable = all.filter((p) => p.to === null || p.to < PLAUSIBLE[0] || p.to > PLAUSIBLE[1]);
  const pts = all.filter((p) => unreadable.indexOf(p) < 0);
  if (pts.length < 2) return nothing;

  const now = Date.now();
  const issued = day(o.issueDate);
  // The x axis is the ORDER of the promises, not the day they were made: the legacy import gives
  // every entry the same `enteredAt`, so plotting by that would stack them all on one tick.
  const ys = pts.map((p) => p.to).concat([now], issued ? [issued] : []);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(1, hi - lo);
  const W = 560, H = 132, PAD_L = 26, PAD_R = 26, PAD_T = 22, PAD_B = 26;
  const x = (i) => PAD_L + (pts.length === 1 ? 0 : (i / (pts.length - 1)) * (W - PAD_L - PAD_R));
  const y = (t) => PAD_T + (1 - (t - lo) / span) * (H - PAD_T - PAD_B);
  const yNow = y(now);
  const step = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.to).toFixed(1)}`).join("");
  const first = pts[0], last = pts[pts.length - 1];
  const slipDays = Math.round((last.to - first.to) / 86400000);
  const late = last.to < now;

  // WHICH DOTS CARRY THEIR DATE.
  //
  // "Can we show some important info on the dots? If not all, at least alternate counting
  // backward." Counting back from the LATEST is right, because the latest promise is the one
  // being asked about and the early ones are history. How many we can fit is arithmetic, not a
  // guess: a label is about 44px wide, so the stride is whatever keeps them from touching.
  const gap = pts.length > 1 ? (W - PAD_L - PAD_R) / (pts.length - 1) : W;
  const stride = Math.max(1, Math.ceil(46 / Math.max(1, gap)));
  const labelled = (i) => (pts.length - 1 - i) % stride === 0;
  const shortDate = (t) => { const d = new Date(t); return `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`; };
  const longDate = (t) => { const d = new Date(t); return `${d.getUTCDate()} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
  // What a dot says when you rest on it: which promise it is, the date promised, and how far it
  // moved the previous one. The move is the story; the date alone is only half of it.
  const hover = (p, i) => {
    const bits = [`Promise ${i + 1} of ${pts.length}: ${longDate(p.to)}`];
    if (i > 0) {
      const moved = Math.round((p.to - pts[i - 1].to) / 86400000);
      bits.push(moved === 0 ? "unchanged from the one before"
        : moved > 0 ? `${moved} ${moved === 1 ? "day" : "days"} later than the one before`
        : `${Math.abs(moved)} ${Math.abs(moved) === 1 ? "day" : "days"} earlier than the one before`);
    } else bits.push("the first date on file");
    if (p.kind && p.kind !== "reforecast") bits.push(String(p.kind).replace(/_/g, " "));
    return bits.join(" \u00b7 ");
  };

  return html`<div class="slip">
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img"
         aria-label="The expected in-service date was re-forecast ${pts.length} times${slipDays > 0 ? `, moving it ${slipDays} days later` : ""}. It now reads ${longDate(last.to)}.">
      <line x1="0" y1="${yNow.toFixed(1)}" x2="${W}" y2="${yNow.toFixed(1)}" class="nowline"></line>
      <text x="${W - 2}" y="${(yNow - 5).toFixed(1)}" text-anchor="end" class="nowlab">today</text>
      <path d="${step}" class="line"></path>
      ${pts.map((p, i) => { const last_ = i === pts.length - 1; const cx = x(i), cy = y(p.to);
        // A label above the dot, unless the dot is near the top, where it would leave the box.
        const above = cy > PAD_T + 14;
        // The node is a CONTROL: it carries the date it stands for, so the screen around it can
        // jump to what was being said at the time. `o.jump` opts in — a chart with nothing to jump
        // to stays inert rather than offering a click that does nothing.
        return html`<g data-key="p${i}" ${o.jump ? raw(`data-jump="${new Date(p.to).toISOString().slice(0, 10)}" tabindex="0" role="button"`) : nothing}><title>${hover(p, i)}${o.jump ? " \u00b7 click to see what was being said then" : ""}</title>
          <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${last_ ? 4.5 : 3}" class="pt ${last_ ? (late ? "last late" : "last") : ""}"></circle>
          ${labelled(i) ? html`<text x="${cx.toFixed(1)}" y="${(above ? cy - 9 : cy + 15).toFixed(1)}" text-anchor="middle" class="ptlab ${last_ ? "on" : ""}">${shortDate(p.to)}</text>` : nothing}
        </g>`; })}
    </svg>
    <div class="slipfoot"><b>${pts.length}</b> ${pts.length === 1 ? "promise" : "promises"} on file${slipDays > 0 ? html` \u00b7 the date has moved <b>${slipDays.toLocaleString("en-US")} days</b> later` : ""}${late ? html` \u00b7 <span class="late">the latest one has passed</span>` : ""}</div>
    ${unreadable.length ? html`<div class="slipbad">${icon("bang", 12)}<span>${unreadable.length === 1 ? "One date on file cannot be read" : `${unreadable.length} dates on file cannot be read`} and ${unreadable.length === 1 ? "is" : "are"} left off the chart: ${unreadable.map((u) => `"${u.raw}"`).join(", ")}. Worth correcting in the recon workbook.</span></div>` : nothing}
  </div>`;
}

/** An empty list says what lands there, and offers the next thing to do when there is one. */
export function emptyState(text, action) { return html`<div class="empty">${text}${action ? html` ${action}` : ""}</div>`; }
export const nothing = raw("");
