"use strict";
// Who may approve an AFE for issue, and whose approval a given AFE is waiting on.
//
// It lived in TWO places — `stateMachine.js` enforced it and `views/faView.js` kept a byte-for-
// byte copy, because stateMachine requires faView lazily inside its own transitions and a
// top-level require in the other direction would close the cycle. That was fine while the answer
// was one line. R145 gives the preparer a CHOICE of approver, and a choice the screen and the
// guard can disagree about is a button that offers something the server refuses — so both now
// read this, which requires neither of them and closes nothing.
const people = require("./people");

/**
 * The people an active `fa_issue_approver` org rule names (R101).
 *
 * Business config as data, like the hand-off mailbox: Judithmelanie Ware (FA Supervisor), Jarrod
 * Dane (FA Manager) and Manaia Ginty (Assoc Director, Finance) are seeded, and Admin can
 * change that without a deploy.
 */
async function issueApprovers(repos) {
  const rules = await repos.orgRules.all((x) => x.kind === "fa_issue_approver" && x.active !== false && !x.retiredAt);
  const out = [];
  for (const r of rules) {
    const email = people.normEmail(r.person && r.person.email);
    if (!email || out.some((p) => p.email === email)) continue;
    out.push({ email, name: (r.person && r.person.name) || email, group: r.group || null });
  }
  return out;
}

/**
 * Whose approval THIS AFE is waiting on (R145).
 *
 * "There is some option that preparer can choose either me or Jarrod or Manaia, so that once
 * they will choose the approval, then it will go to that particular approval" (Judithmelanie, Meeting
 * #6, 2026-09-22). The reason is leave cover — "in case I am not available, I am on leave on
 * that day" — and the honest answer is that the person holding the AFE says who to send it to,
 * because a system cannot know who is in the office. Jarrod: "preparer will choose the approver."
 *
 * `afe.fa.issueApprovalAskedOf` is the mailboxes Fixed Assets chose. Missing or empty means
 * nobody has chosen, and then ANY named approver may act — so an AFE already in flight behaves
 * exactly as it did before this existed. A name that is no longer an approver is DROPPED rather
 * than honoured: the org rule is the authority and the choice may only narrow it, never widen it.
 *
 * Pure: it takes the AFE and the list, and returns who is live.
 *
 * @returns {{ chosen: Array, wasChosen: boolean }}
 */
function issueApproverChoice(afe, approvers) {
  const all = approvers || [];
  const asked = ((afe && afe.fa && afe.fa.issueApprovalAskedOf) || [])
    .map((e) => people.normEmail(e))
    .filter(Boolean);
  const narrowed = all.filter((a) => asked.includes(a.email));
  return { chosen: narrowed.length ? narrowed : all, wasChosen: narrowed.length > 0 };
}

module.exports = { issueApprovers, issueApproverChoice };
