"use strict";
// The Cloud CapEx (CCA) decision, exactly as the Global AFE Template V7 prints it.
//
// The template's Cloud CapEx sheet carries four questions, checkbox branches ("No — do
// not fill out rest of form", "Yes — Contact FP&A Business Partner") and a printed
// decision-tree diagram. Only one path reaches Cloud CapEx:
//
//   software? ──No──────────────────────────────► not applicable
//      │Yes
//   externally hosted? ──No─────────────────────► regular CapEx
//      │Yes                                        (+ FP&A review required)
//   perpetual or subscription? ──Perpetual──────► regular CapEx
//      │Subscription
//   can Acme change host without significant cost? ──Yes──► regular CapEx
//      │No
//   ══════════════════════════════════════════════════► CLOUD CAPEX
//
// Project managers were not taught this ("most of our project managers were not educated
// on these things" — Aiden, 2026-09-03), which is why the wizard asks the questions and
// derives the answer instead of asking for the classification.
const { CLOUD_TREE } = require("./refData");

const OUTCOMES = {
  not_applicable: { id: "not_applicable", label: "No software involved", classification: null },
  regular_capex: { id: "regular_capex", label: "Regular CapEx (not cloud)", classification: "capex" },
  cloud_capex: { id: "cloud_capex", label: "Cloud CapEx (CCA)", classification: "cloud_capex" },
};

/**
 * @param {object} answers { q1Software, q2ExternallyHosted, q3Subscription, q4CanChangeHost }
 * @returns {{outcome, label, classification, fpaReviewRequired, nextQuestion, path}}
 */
function evaluate(answers) {
  const a = answers || {};
  const path = [];
  const done = (key) => Object.assign({}, OUTCOMES[key], {
    outcome: key,
    fpaReviewRequired: a.q2ExternallyHosted === "Yes",
    nextQuestion: null,
    path,
  });
  const ask = (id) => ({
    outcome: null, label: null, classification: null,
    fpaReviewRequired: a.q2ExternallyHosted === "Yes",
    nextQuestion: CLOUD_TREE.find((q) => q.id === id) || null,
    path,
  });

  if (!a.q1Software) return ask("q1Software");
  path.push({ id: "q1Software", answer: a.q1Software });
  if (a.q1Software === "No") return done("not_applicable");

  if (!a.q2ExternallyHosted) return ask("q2ExternallyHosted");
  path.push({ id: "q2ExternallyHosted", answer: a.q2ExternallyHosted });
  if (a.q2ExternallyHosted === "No") return done("regular_capex");

  if (!a.q3Subscription) return ask("q3Subscription");
  path.push({ id: "q3Subscription", answer: a.q3Subscription });
  if (a.q3Subscription === "Perpetual") return done("regular_capex");

  if (!a.q4CanChangeHost) return ask("q4CanChangeHost");
  path.push({ id: "q4CanChangeHost", answer: a.q4CanChangeHost });
  return done(a.q4CanChangeHost === "Yes" ? "regular_capex" : "cloud_capex");
}

/** Does the tree need answering for this AFE at all? */
function isTriggered(afe) {
  const m = (afe && afe.money) || {};
  const p = (afe && afe.project) || {};
  return m.classification === "cloud_capex"
    || Number(m.cloudCapexUsd) > 0
    || /software|automation/i.test(String(p.projectType || ""))
    || Boolean((afe && afe.cloud && afe.cloud.q1Software));
}

module.exports = { evaluate, isTriggered, OUTCOMES, QUESTIONS: CLOUD_TREE };
