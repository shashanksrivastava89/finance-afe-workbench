"use strict";
// Who reviews and sends an AFE (R157). One definition, used by the lifecycle guard, the
// permissions every screen reads, the Prepare queue and its badge.
//
// "Before it is routing it to approvals, right, I would like to review those… either they or I.
// We should be able to make those modifications before it is going to approve us." (Aiden,
// Meeting #7.) The review existed; the rule around it let it be skipped. Any coordinator of the
// division could send, INCLUDING on an AFE they raised — so the demo AFE of Meeting #7, raised by
// somebody who also coordinates CORP_IT, went straight to the four signers and Aiden only met it
// when it was already out.
//
// So: the AFE's assigned coordinator (the org rule's person for its division) reviews it. Another
// coordinator of the same division may stand in — somebody is on leave — but never on an AFE
// they raised or prepared themselves. Where the division has no coordinator at all, the owner
// sends (R41), as before. Pure: plain objects in, a boolean out.
const people = require("./people");

const same = (a, b) => Boolean(a && b) && people.normEmail(a) === people.normEmail(b);
const email = (who) => (who && who.user && who.user.email) || null;

/** Is this person the coordinator the org rule assigned to this AFE? */
function isAssigned(who, afe) {
  return Boolean(afe && afe.coordinator && same(afe.coordinator.email, email(who)));
}

/** Did this person raise or prepare the AFE? */
function isOwner(who, afe) {
  const me = email(who);
  return Boolean(afe && me && ((afe.requester && same(afe.requester.email, me)) || (afe.preparer && same(afe.preparer.email, me))));
}

/** Holds coordinator rights for the AFE's division at all (visibility, the thread's side). */
function holdsCoordination(who, afe) {
  const roles = (who && who.roles) || [];
  return roles.includes("coordinator")
    && (((who && who.coordinatorFor) || []).includes(afe && afe.division) || isAssigned(who, afe));
}

/**
 * Reviews THIS AFE: the assigned coordinator, or a coordinator of the division standing in —
 * who did not raise or prepare it.
 */
function coordinates(who, afe) {
  return holdsCoordination(who, afe) && (isAssigned(who, afe) || !isOwner(who, afe));
}

/**
 * May press Send. The reviewing coordinator — but somebody else's draft is still theirs until
 * they send it to the coordinator, so from `draft` only an AFE the coordinator is preparing
 * themselves — or, where the division has no coordinator, the owner.
 */
function maySend(who, afe) {
  if (coordinates(who, afe)) return afe.state !== "draft" || isOwner(who, afe);
  return !afe.coordinator && isOwner(who, afe);
}

module.exports = { isAssigned, isOwner, holdsCoordination, coordinates, maySend };
