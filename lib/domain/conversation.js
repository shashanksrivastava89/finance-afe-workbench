"use strict";
// The conversation on an AFE, read rather than stored (R149, R163).
//
// "Too noisy" (Judithmelanie, Meeting #7): every comment e-mailed everybody on the AFE, so a line on the
// record cost each of them an e-mail. Now a COMMENT is a line on the record and e-mails nobody,
// and an ASK is the one line that does: it puts a question to the other side of the AFE and stays
// open until somebody on that side answers.
//
// Whether an ask is answered is DERIVED from the thread, never stored. The first later line from
// the other side answers it; a line from the asker's own side does not — Fixed Assets adding a
// second thought is not the requester answering. A stored "answered" flag would be a second copy
// of what the thread already says, and the two would disagree the first time something wrote a
// line without remembering to set it. Pure: a thread in, plain objects out.

/** The AFE's own people. Everybody else — Fixed Assets, approvers, anyone who can view — is the other side. */
const OWNER_SIDES = ["requester", "preparer", "coordinator"];

/** Which side wrote a line. A line written before sides were recorded is read by what it carries. */
function sideOfLine(t) {
  if (!t) return null;
  if (t.side) return t.side;
  if (t.recipientId) return "approver";
  if (/\(Fixed Assets\)$/.test(t.byName || "")) return "fa";
  return null;
}

/** The two groups a conversation runs between. */
function groupOf(side) {
  if (!side) return null;
  return OWNER_SIDES.includes(side) ? "owner" : "other";
}

/**
 * While the AFE is with its coordinator, the coordinator and the requester's side are two sides
 * FOR AN ASK (found in the KT walkthrough, 2026-10-15). In `submitted` both are the owner side,
 * so an ask had nobody to reach: the coordinator's "Please fill the financials" could only be a
 * comment, which tells nobody, or a formal send-back. "With its coordinator" is `submitted`, or
 * `returned` when the coordinator is who sent it back.
 */
function withCoordinator(afe) {
  if (!afe) return false;
  if (afe.state === "submitted") return true;
  return afe.state === "returned" && Boolean(afe.returnedTo) && afe.returnedTo.role === "coordinator";
}
/**
 * Whom an ask from `side` is put to: "requester" (the coordinator asking the requester's side),
 * "coordinator" (the requester's side asking their coordinator), or the group the asker is not
 * in — "other" or "owner" — as before. Stored on the line, so "answered" can be derived later
 * without knowing what state the AFE was in when it was asked.
 */
function askTarget(side, afe) {
  if (withCoordinator(afe) && afe.coordinator && afe.coordinator.email) {
    if (side === "coordinator") return "requester";
    if (side === "requester" || side === "preparer") return "coordinator";
  }
  return groupOf(side) === "owner" ? "other" : "owner";
}
/** Does `line` answer `ask`? The first later line from whoever it was asked of. */
function answers(ask, line) {
  const s = sideOfLine(line);
  if (!s) return false;
  if (ask.askedOf === "coordinator") return s === "coordinator";
  if (ask.askedOf === "requester") return s === "requester" || s === "preparer";
  const g = groupOf(s);
  return Boolean(g) && g !== groupOf(sideOfLine(ask));
}

/**
 * Every ask in the thread, with whether it is still open and the line that answered it.
 * @param {Array} thread  afe.thread
 * @returns {Array<{id, side, group, byEmail, byName, text, at, open, answeredById, answeredAt, answeredByName}>}
 */
function asks(thread) {
  const list = thread || [];
  const out = [];
  list.forEach((t, i) => {
    if (!t || t.kind !== "ask") return;
    const group = groupOf(sideOfLine(t));
    const reply = list.slice(i + 1).find((x) => x && x.byEmail !== "system" && answers(t, x));
    out.push({
      id: t.id, side: sideOfLine(t), group, askedOf: t.askedOf || null, byEmail: t.byEmail || null, byName: t.byName || null, text: t.text || "", at: t.at || null,
      open: !reply, answeredById: reply ? reply.id : null, answeredAt: reply ? reply.at || null : null,
      answeredByName: reply ? reply.byName || null : null,
    });
  });
  return out;
}

/** The asks nobody on the other side has answered yet, oldest first. */
const openAsks = (thread) => asks(thread).filter((a) => a.open);

module.exports = { asks, openAsks, groupOf, sideOfLine, OWNER_SIDES, withCoordinator, askTarget, answers };
