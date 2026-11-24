"use strict";
// The reconciliation history, as the conversation it already is (R126).
//
// The AuC recon workbook keeps its follow-up history in one spreadsheet cell per line, and the
// seed builder imports that cell as ONE comment body. Measured over `seed/tracker.json`: 816
// comments, 548 of them carrying an `M/D/YYYY`-style date prefix, 188 with newlines, and the
// longest holding THIRTEEN separate dated entries in 3,249 characters — rendered on the order
// page as a single grey paragraph in a 380px rail, with no `white-space: pre-wrap` anywhere in
// the stylesheet, so even the newlines collapsed.
//
// It is a thread. It was always a thread. This splits it back into one.
//
// PURE and DETERMINISTIC — a regex over an extract, not a model. It reads a field a person is
// reading today, which is exactly the boundary in non-negotiable #1, and it is on the safe side
// of it because nothing here is a proposal or a decision: the same input always gives the same
// entries, and `smoke-projects` asserts that **no character of the source is ever lost**.

// A leading date. Five shapes, all seen in the real file:
//   1/10/2025 -     ·  12/8/23 -     ·  01/23/2026-     ·  2026-09-11 -     ·  March 26-  /  May 2026-
const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t|tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const DATE_AT_START = new RegExp(
  "^\\s*(" +
    "\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4}" +      // 1/10/2025, 12/8/23, 01-23-2026
    "|\\d{4}-\\d{2}-\\d{2}" +                   // 2026-09-11
    "|(?:" + MONTHS + ")\\s+\\d{2,4}" +         // March 26, May 2026
  ")\\s*[-–—:]?\\s*",
  "i"
);

/** Who wrote it, when the line says so. Never invented — null when the text does not say. */
const AUTHOR_PATTERNS = [
  /^Per\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*[,:-]\s*/,   // "Per Josephine Leydon, ..."
  /^([A-Z]{2,3})_Per\s+([A-Z][A-Za-z.'-]+(?:\s+[A-Z][A-Za-z.'-]+){0,2})\s*[,:-]\s*/, // "MS_Per Josephine Leydon, ..."
  /^([A-Z]\.\s?[A-Z]\.)\s*[,:-]?\s*/,                                       // "K.K. No further comments"
  /^([A-Z]{2,3}):\s*/,                                                      // "AL: Expected 10/20"
  /^([A-Z][a-z]+)\s*[-–]\s*/,                                               // "Tasha - Project completed"
];

// The last pattern — "Tasha - Project completed" — is the loose one, and on the real file it
// also fires on "Excluded - AuC assets/project had been previously confirmed…", which is a STATUS
// and not a person. A name is never one of these words. Better to return no author than a wrong
// one: an unattributed entry is honest, an entry attributed to "Excluded" is not.
const NOT_A_NAME = new Set(["excluded", "est", "new", "no", "still", "update", "updated", "note",
  "completed", "complete", "received", "pending", "delayed", "waiting", "project", "signs", "need",
  "needs", "closed", "open", "done", "cancelled", "canceled", "ongoing", "installed", "asset",
  "assets", "budget", "invoice", "invoiced", "capitalized", "reviewed", "confirmed", "expected"]);

function takeAuthor(text) {
  for (const re of AUTHOR_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const name = (m[2] || m[1]).trim();
    if (NOT_A_NAME.has(name.toLowerCase())) return { author: null, rest: text };
    return { author: name, rest: text.slice(m[0].length) };
  }
  return { author: null, rest: text };
}

/** The date token as an ISO day, when it can be read as one. Two-digit years are 2000s. */
function toIso(token) {
  const t = String(token).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(t);
  if (m) {
    const yr = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const mo = Number(m[1]), da = Number(m[2]);
    if (mo >= 1 && mo <= 12 && da >= 1 && da <= 31) return `${yr}-${String(mo).padStart(2, "0")}-${String(da).padStart(2, "0")}`;
    return null;
  }
  m = new RegExp("^(" + MONTHS + ")\\s+(\\d{2,4})$", "i").exec(t);
  if (m) {
    const idx = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
      .indexOf(m[1].slice(0, 3).toLowerCase());
    const yr = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    if (idx >= 0) return `${yr}-${String(idx + 1).padStart(2, "0")}-01`;
  }
  return null;
}

/**
 * Split one imported comment body into the entries it is made of.
 *
 * The contract that matters: for any body with content, **every character comes back in exactly
 * one entry's `raw`**, in order — `smoke-projects` asserts it across all 816 bodies in the seed.
 * (A body that is empty or only whitespace is the one exception: it returns no entries, because
 * a blank comment is not a comment.)
 *
 * A line that does not begin with a date is not a new entry — it belongs to the one before it,
 * because a wrapped sentence is still the same note. Text before the first date is its own entry
 * with `at: null`, which is how "Need to provide the updated building #." survives ahead of the
 * dated history that follows it. Splitting is LINE-based, so several dates run together on one
 * line stay one entry: that is the shape the workbook actually uses, and guessing mid-line would
 * cut sentences that merely mention a date.
 *
 * @param {string} body
 * @returns {Array<{at: string|null, dateText: string|null, author: string|null, text: string, raw: string}>}
 */
function splitEntries(body) {
  const src = String(body == null ? "" : body);
  if (!src.trim()) return [];
  const lines = src.split(/\r?\n/);
  const out = [];
  let cur = null;

  for (const line of lines) {
    const m = DATE_AT_START.exec(line);
    if (m) {
      if (cur) out.push(cur);
      const rest = line.slice(m[0].length);
      const { author, rest: text } = takeAuthor(rest);
      cur = { at: toIso(m[1]), dateText: m[1].trim(), author, text, raw: line };
    } else if (cur) {
      cur.text += (cur.text ? "\n" : "") + line;
      cur.raw += "\n" + line;
    } else {
      cur = { at: null, dateText: null, author: null, text: line, raw: line };
    }
  }
  if (cur) out.push(cur);

  // A body with no dates at all is one entry, not zero — "Completed." is still a comment.
  return out.map((e) => Object.assign({}, e, { text: e.text.trim() })).filter((e) => e.raw.trim() || out.length === 1);
}

/**
 * A stored comment, expanded into thread entries. A comment the APP wrote is already one entry
 * with a real author and a real timestamp, so it passes through untouched; only the legacy
 * import is a wall.
 */
function threadFor(comments) {
  const out = [];
  for (const c of comments || []) {
    const legacy = !c.authorEmail;
    const parts = legacy ? splitEntries(c.body) : [{ at: null, dateText: null, author: null, text: String(c.body || ""), raw: String(c.body || "") }];
    for (const p of parts) {
      out.push({
        kind: c.kind || "preparer_note",
        at: p.at || c.createdAt || null,
        dated: Boolean(p.at),
        author: p.author || c.authorName || null,
        authorEmail: c.authorEmail || null,
        text: p.text,
        legacy,
      });
    }
  }
  // Oldest first — a conversation reads downwards. Undated entries keep their position by
  // falling back to the comment's own date, so nothing jumps to the top.
  return out.map((e, i) => Object.assign({ seq: i }, e))
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")) || a.seq - b.seq);
}

module.exports = { splitEntries, threadFor, DATE_AT_START };
