"use strict";
// The envelope, as a standard rule rather than a person's habit.
//
// Aiden configures every envelope the same way by hand today: he trims DocuSign's default
// subject down to the file name, pastes the context into the message, drops a Sign and a
// Date Signed on each approver's own row, sets them to sign one after another, adds the
// copies, and leaves "Add Delay" alone. All of that is derivable, so this module derives it —
// one definition, built from the AFE, the frozen routing and `refData.ENVELOPE_POLICY`, with
// nothing left for a human to set up.
//
// Both providers build from here, so the simulated envelope carries exactly the definition the
// live one would be created with: you can read what DocuSign will be told, and what each
// approver will receive, before an integration key exists.
const { ENVELOPE_POLICY, CURRENCY } = require("../domain/refData");
const notify = require("../notify");

const clip = (s, n) => (String(s || "").length > n ? String(s).slice(0, n - 1) + "…" : String(s || ""));
const money = (n) => (n === null || n === undefined || n === "" ? null
  : "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 }));

/** R59: subject = the AFE title (DocuSign caps it at 100), message = the approver note. */
function subjectFor(afe) {
  const title = (afe.project && afe.project.title) || "AFE";
  return clip(title, ENVELOPE_POLICY.subjectMaxChars);
}

/**
 * The message body, when the coordinator has not written one.
 *
 * R55: the approver is being asked to decide, and the things they ask for are always the same
 * four — what it is, what it costs, whether it is budgeted, and what happens if it slips. The
 * coordinator can still overwrite it; this only means an envelope never goes out with an empty
 * message because somebody was in a hurry.
 */
function defaultApproverNote(afe) {
  const m = afe.money || {};
  const total = [m.capexUsd, m.opexUsd, m.cloudCapexUsd, m.laborUsd]
    .reduce((sum, v) => sum + (Number(v) || 0), 0);
  const lines = [];
  const what = (afe.project && afe.project.description) || (afe.project && afe.project.title) || "";
  if (what) lines.push(what.trim());
  const facts = [];
  if (total) facts.push(`${money(total)} ${CURRENCY}`);
  if (afe.costCenter) facts.push(`cost centre ${afe.costCenter}`);
  const budgeted = afe.budget && afe.budget.budgeted;
  if (budgeted === "Yes") {
    facts.push(afe.budget.budgetCategory ? `budgeted under ${afe.budget.budgetCategory}` : "budgeted");
  } else if (budgeted === "No") {
    facts.push(afe.budget && afe.budget.unbudgetedReason ? `not budgeted — ${afe.budget.unbudgetedReason}` : "not budgeted");
  }
  if (facts.length) lines.push(facts.join(" · "));
  const start = afe.schedule && afe.schedule.startDate;
  if (start) lines.push(`Work is due to start ${start}.`);
  if (afe.requester && afe.requester.name) lines.push(`Raised by ${afe.requester.name}.`);
  return lines.join("\n");
}

/**
 * The complete envelope definition. `documents` carries metadata only — the bytes are attached
 * by whichever provider actually sends it, so this stays comparable, loggable and testable.
 */
function buildSpec({ afe, routing, documents, anchors, formHash }) {
  const policy = ENVELOPE_POLICY;
  const signers = (routing.recipients || [])
    .filter((r) => r.status === "pending" && r.role !== "cc")
    .sort((a, b) => a.order - b.order);
  const copies = (routing.recipients || []).filter((r) => r.role === "cc");
  const anchorFor = (recipientId) => (anchors || []).find((x) => x.recipientId === recipientId) || null;

  return {
    emailSubject: subjectFor(afe),
    emailBlurb: (afe.approverNote && afe.approverNote.trim()) || defaultApproverNote(afe),
    // Sequential: each approver is asked only once the one before has signed. "Add Delay" is
    // deliberately not used — the reminders below do that job, and a delay hides the envelope.
    signingOrder: "sequential",
    status: "sent",
    formHash: formHash || null,
    documents: (documents || []).map((d, i) => ({
      documentId: String(i + 1),
      name: d.filename || d.name || `document ${i + 1}`,
      role: d.role || null,
      sha256: d.sha256 || null,
      attachmentId: d.attachmentId || null,
    })),
    signers: signers.map((r, i) => {
      const a = anchorFor(r.id);
      return {
        recipientId: String(i + 1),
        routingRecipientId: r.id,
        routingOrder: r.order,
        name: r.name,
        email: r.email,
        level: r.level || null,
        why: r.why || null,
        // The tabs land on this person's own row of the generated form, by anchor string, so
        // nobody drags a signature box onto a page (R59).
        tabs: a ? { signHere: a.sig, dateSigned: a.date, documentId: "1" } : null,
      };
    }),
    carbonCopies: copies.map((r, j) => ({
      recipientId: String(signers.length + j + 1),
      routingRecipientId: r.id,
      routingOrder: r.order,
      name: r.name,
      email: r.email,
      why: r.why || null,
    })),
    notification: {
      useAccountDefaults: false,
      reminders: { enabled: true, delayDays: policy.reminderDelayDays, frequencyDays: policy.reminderFrequencyDays },
      expirations: { enabled: true, afterDays: policy.expireAfterDays, warnDays: policy.expireWarnDays },
    },
    customFields: [{ name: "afeId", value: String(afe.id), show: false }],
  };
}

/**
 * What DocuSign puts in the mailbox of the approver whose turn it is.
 *
 * In simulation nobody is really sending this, so the tool queues it — that way the envelope
 * can be read end to end before an integration key exists, and the wording is the wording
 * DocuSign will use once there is one: its subject is the envelope's subject and its body is
 * the envelope's message.
 */
function signatureRequestEmail({ afe, spec, recipient, envelope, appUrl }) {
  const total = spec.signers.length;
  const nth = spec.signers.findIndex((s) => s.routingRecipientId === recipient.id) + 1;
  const sender = (afe.coordinator && afe.coordinator.name) || (afe.preparer && afe.preparer.name)
    || (afe.requester && afe.requester.name) || "Acme";
  const url = appUrl || notify.link(`/approve/${afe.id}`);
  const body = [
    `${sender} sent you a document to review and sign.`,
    "",
    spec.emailBlurb,
    "",
    `REVIEW DOCUMENT   ${url.startsWith("http") ? url : `${appUrl || ""}/approve/${afe.id}`}`,
    "",
    // DocuSign is where the signature happens, and collaboration is not something the tool can
    // add to that window — "DocuSign, a collaboration on comments and questions is something
    // which is outside of the system" (Meeting #5, 50:00). What it CAN do is make sure the
    // approver knows the other two doors exist and can reach them in one click, which is what
    // Euan asked for: "at least some mechanism should be there so that if they have some
    // questions around it, they can ask it" (51:07).
    `Need to ask something first, or send it back? ${notify.link(`/approve/${afe.id}`)}`,
    "",
    `You are signer ${nth > 0 ? nth : "?"} of ${total}; it goes to the next approver once you sign.`,
    `A reminder follows after ${spec.notification.reminders.delayDays} days, then every ` +
      `${spec.notification.reminders.frequencyDays}. The envelope expires after ` +
      `${spec.notification.expirations.afterDays} days.`,
    envelope && envelope.envelopeId ? `Envelope ID ${envelope.envelopeId}` : "",
    envelope && envelope.provider === "simulated"
      ? "(Simulated envelope — this is the mail DocuSign will send once the integration key exists.)" : "",
  ].filter((l) => l !== undefined).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return { subject: spec.emailSubject, body };
}

module.exports = { subjectFor, defaultApproverNote, buildSpec, signatureRequestEmail };
