"use strict";
// Who may do what — one table, read by the server's guards and by the top bar.
//
// The rule the frontend obeys is that it never decides anything: `capabilities(ctx)` is
// computed here, on the server, from the roles the signed-in person actually holds, and the
// same set both guards the routes and draws the nav. A screen can therefore only offer what
// the API would allow, and a screen that is hidden is hidden because the server said so —
// not because a copy of the rules in the browser happened to agree.
//
// Roles are additive and a person may hold several. Nothing here reads storage: it takes the
// request context and returns plain data, like the rest of `lib/domain`.

/**
 * EVERY authenticated employee is a requester. That is the whole point of the portal — an AFE
 * is raised by the person who wants the thing, with no coordinator standing between them and
 * the form (Manaia and Jarrod, 2026-09-03). A role is what someone holds IN ADDITION.
 */
const BASE_ROLE = "requester";

const ROLES = {
  requester: {
    label: "Requester",
    description: "Raises AFEs and follows their own. Everyone signed in holds this.",
    grants: ["afe.raise", "afe.own.read", "projects.own.read", "mailbox.own.read"],
  },
  approver: {
    label: "Approver",
    description: "Signs AFEs routed to them. Also granted for the life of a pending signature.",
    grants: ["approval.act"],
  },
  coordinator: {
    label: "Coordinator",
    description: "Prepares and routes their division's AFEs, shapes the chain, sends the envelope.",
    // `pots.read` and NOT `pots.all`: a coordinator sees the pots of the divisions they
    // coordinate. Fixed Assets and leadership see every division, and say so here rather than
    // having a route infer it.
    grants: ["afe.coordinate", "pots.read", "projects.read", "portfolio.read"],
  },
  fa_preparer: {
    label: "Fixed Assets — preparer",
    description: "Judges an approved AFE, keys SAP by hand, records the internal orders, capitalizes.",
    grants: ["fa.process", "fa.capitalize", "pots.read", "pots.all", "projects.read", "portfolio.read",
      "aucreview.run", "tracker.read", "extract.upload"],
  },
  fa_checker: {
    label: "Fixed Assets — checker",
    description: "The second pair of eyes: closes what someone else capitalized.",
    grants: ["fa.process", "fa.close", "pots.read", "pots.all", "projects.read", "portfolio.read",
      "aucreview.run", "tracker.read"],
  },
  leadership: {
    label: "Leadership",
    description: "Reads the portfolio, the pots and the tracker. Changes nothing.",
    grants: ["portfolio.read", "pots.read", "pots.all", "projects.read", "tracker.read"],
  },
  admin: {
    label: "Administrator",
    description: "Business configuration, people and roles, extracts, jobs. The whole Admin section.",
    // Deliberately NOT a superset of the operational roles: an administrator configures the
    // tool, and holding the role does not make them Fixed Assets or a coordinator. Anyone who
    // needs both is given both — which is then visible in the people list and in the audit,
    // instead of being implied by a wildcard nobody can see.
    grants: ["admin", "people.manage", "config.manage", "extract.upload", "jobs.run",
      "mailbox.read", "audit.read", "masters.manage", "features.manage", "reminders.run"],
  },
};

const ROLE_NAMES = Object.keys(ROLES);

/** Roles an administrator may hand out. `requester` is not one — it is held by everybody. */
const ASSIGNABLE_ROLES = ROLE_NAMES.filter((r) => r !== BASE_ROLE);

/**
 * The capability set for a request context.
 *
 * `opts.hasPendingSignature` grants `approval.act` to someone the matrix names but who does not
 * hold the approver role here — the matrix is a list of names, not of portal users, so a
 * signature actually waiting is what earns the section (the alternative is asking an approver to
 * be set up before they can sign, which is the delay this tool exists to remove).
 */
function capabilities(ctx, opts) {
  const o = opts || {};
  const held = rolesOf(ctx);
  const out = new Set();
  for (const role of held) {
    const def = ROLES[role];
    if (!def) continue;                                   // an unknown role grants nothing
    for (const g of def.grants) out.add(g);
  }
  if (o.hasPendingSignature) out.add("approval.act");
  return out;
}

/** The roles this context effectively holds — always including the base one. */
function rolesOf(ctx) {
  const raw = (ctx && ctx.roles) || [];
  const held = new Set([BASE_ROLE]);
  for (const r of raw) held.add(String(r));
  return held;
}

/** Does this context hold a capability? The one question every route guard asks. */
function can(ctx, capability, opts) {
  return capabilities(ctx, opts).has(capability);
}

/**
 * Administration is decided by the REAL identity, never the acted-as one.
 *
 * An administrator viewing the tool as someone else is looking at that person's screens; they
 * must not keep the keys to the configuration while they do it, or "view as" becomes a way to
 * make a change that the audit trail attributes to the wrong person.
 */
function isAdmin(ctx) {
  return Boolean(ctx && (ctx.realRoles || []).includes("admin"));
}

/**
 * The sections of the top bar, in order, each with the capability that earns it. The server
 * sends the resolved list to the browser; `public/js/core/chrome.js` renders it and adds
 * nothing of its own.
 */
const SECTIONS = [
  { key: "requests", label: "Requests", href: "/requests", capability: "afe.raise" },
  { key: "prepare", label: "Prepare", href: "/prepare", capability: "afe.coordinate" },
  { key: "approvals", label: "Approvals", href: "/approvals", capability: "approval.act" },
  { key: "fa", label: "Fixed Assets", href: "/fa", capability: "fa.process" },
  // Two ways to earn Projects. A requester has no business seeing the whole portfolio, but
  // "it will be good to have to see their AFEs whatever they have requested" (Euan, 46:33) —
  // and `/projects` already narrows a non-privileged caller to their own rows, so the section
  // is safe to offer on the weaker capability.
  { key: "projects", label: "Projects", href: "/projects", capability: "projects.read", orCapability: "projects.own.read" },
  { key: "pots", label: "Pots", href: "/pots", capability: "pots.read" },
  { key: "leadership", label: "Portfolio", href: "/leadership", capability: "portfolio.read" },
  { key: "mailbox", label: "Mailbox", href: "/mailbox", capability: "mailbox.read" },
  { key: "admin", label: "Admin", href: "/admin", capability: "admin" },
];

function sections(ctx, opts) {
  const caps = capabilities(ctx, opts);
  return SECTIONS
    .filter((s) => caps.has(s.capability) || (s.orCapability && caps.has(s.orCapability)))
    .map((s) => ({ key: s.key, label: s.label, href: s.href }));
}

module.exports = {
  ROLES, ROLE_NAMES, ASSIGNABLE_ROLES, BASE_ROLE, SECTIONS,
  capabilities, rolesOf, can, isAdmin, sections,
};
