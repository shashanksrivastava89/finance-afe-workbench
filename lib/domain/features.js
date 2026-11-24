"use strict";
// Feature flags: what is switched on, who switched it, and what the environment refuses to let
// anyone switch on at all.
//
// Three layers, in this order:
//
//   1. DEFAULT      — every flag ships OFF. A capability nobody has reviewed is not running.
//   2. SETTINGS     — an administrator flips it in Admin › Features; stored as one document,
//                     audited, and it takes effect on the next request.
//   3. ENVIRONMENT  — `FEATURES_LOCKED` names flags that may NOT be turned on here, whatever
//                     the settings document says. This is the lock that lets UAT try the quote
//                     reader while production cannot, without a separate build: the security
//                     review gates the setting, not the deploy.
//
// A flag never changes what is CORRECT, only what is OFFERED. Every path a flag opens has a
// deterministic path behind it that stays in the product — turning a flag off is always safe,
// and no stored AFE becomes unreadable because of it.
const FLAGS = {
  quoteReading: {
    label: "Read vendor quotes",
    summary: "Azure Document Intelligence reads the vendor, the total and the date off an uploaded "
      + "quote and offers them, each with its confidence; anything under 80% is not offered. The "
      + "requester uses them or sets them aside — a proposal is never a value until a person does — "
      + "and Fixed Assets sees what was read beside what was typed, with who confirmed it.",
    needs: "DI_ENDPOINT set, and this app's identity granted Cognitive Services User on the resource "
      + "(a role assignment that needs Owner or User Access Administrator). Unlocked on UAT from "
      + "2026-10-14 ahead of the security review, which is still to sign it off; production keeps "
      + "it in FEATURES_LOCKED until it has.",
    fallback: "The vendor, total and date are typed, exactly as they are today.",
  },
  agentic: {
    label: "Assisted coordination",
    summary: "Reads replies to chases and mail arriving in the Fixed Assets mailbox, and proposes "
      + "the update or the action it thinks follows. Fixed Assets accepts or dismisses each one; "
      + "nothing moves on its own.",
    needs: "An Azure OpenAI deployment in the tenant (AOAI_ENDPOINT, AOAI_DEPLOYMENT, managed "
      + "identity), mail arriving through Graph, and the security review's sign-off.",
    fallback: "The reply is shown and a person reads it, as today.",
  },
  sapPrefill: {
    label: "Pre-fill the SAP screen",
    summary: "Offers a script that opens KO01, fills every field from the AFE and stops before "
      + "Save. Fixed Assets checks the screen and presses Save themselves.",
    needs: "SAP GUI scripting enabled for the Fixed Assets users (a Basis change) and IT policy sign-off.",
    fallback: "The keying sheet, copied field by field.",
  },
};

const FLAG_NAMES = Object.keys(FLAGS);
const SETTINGS_ID = "features";

/** Flags the environment forbids, however the settings document reads. */
function lockedNames() {
  return String(process.env.FEATURES_LOCKED || "")
    .split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * The effective state of every flag.
 * @returns {Promise<Array<{name, label, summary, needs, fallback, on, locked, changedBy, changedAt}>>}
 */
async function all(repos) {
  const doc = await repos.settings.get(SETTINGS_ID);
  const stored = (doc && doc.flags) || {};
  const locked = lockedNames();
  return FLAG_NAMES.map((name) => {
    const s = stored[name] || {};
    const isLocked = locked.includes(name);
    return Object.assign({ name }, FLAGS[name], {
      on: isLocked ? false : Boolean(s.on),
      requested: Boolean(s.on),
      locked: isLocked,
      changedBy: s.by || null,
      changedAt: s.at || null,
    });
  });
}

/** Is one flag on right now? The question every call site asks. */
async function isOn(repos, name) {
  if (lockedNames().includes(name)) return false;
  const doc = await repos.settings.get(SETTINGS_ID);
  return Boolean(doc && doc.flags && doc.flags[name] && doc.flags[name].on);
}

/** Flip one. The caller audits; this only stores. */
async function set(repos, ctx, name, on) {
  if (!FLAGS[name]) throw new Error(`no feature called ${name}; features: ${FLAG_NAMES.join(", ")}`);
  if (lockedNames().includes(name) && on) {
    throw new Error(`${name} is locked off in this environment (FEATURES_LOCKED) — it cannot be turned on here`);
  }
  const doc = await repos.settings.get(SETTINGS_ID);
  const flags = Object.assign({}, (doc && doc.flags) || {});
  flags[name] = { on: Boolean(on), by: (ctx && ctx.user && ctx.user.email) || "system", at: new Date().toISOString() };
  if (doc) await repos.settings.update(SETTINGS_ID, { flags });
  else await repos.settings.insert({ id: SETTINGS_ID, flags });
  return flags[name];
}

module.exports = { FLAGS, FLAG_NAMES, all, isOn, set, lockedNames, SETTINGS_ID };
