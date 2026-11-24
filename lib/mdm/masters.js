"use strict";
// The master-data registry: one entry per list a person maintains, describing it well enough
// that the exporter, the importer, the validator and the Admin screen all read from here and
// none of them holds a second copy of the truth.
//
// Two kinds of list, and the difference decides who may change them:
//
//   systemOfRecord "tool"  — WE are the record. Routing rules, budget pots, locations, people,
//                            the reference lists. Editable in the UI and by Excel import, and
//                            every change is a version.
//   systemOfRecord "sap"   — SAP is the record. The approver matrix, the per-IO budget, the
//                            order master, the PO lines. Only an extract changes them; they are
//                            exportable so a person can read them, and refused on import.
//   systemOfRecord "global_finance" — Global Finance is the record: the month-end FX rates
//                            (R161). Not edited here, row by row or otherwise; the monthly
//                            workbook they publish is uploaded as it arrives and read in THEIR
//                            layout (`readSource`), because retyping it into ours is how a rate
//                            gets mistyped.
//
// A column's `type` is only ever used to VALIDATE and to coerce on the way in. Every cell is
// written to the workbook as text (see lib/xlsx/workbook.js) because Excel is otherwise eager
// to turn `0123` into 123 and a date into a serial number, and a master that round-trips
// through a person's laptop must come back the way it went out.
const people = require("../domain/people");
const fxRates = require("../ingest/fxRates");
const { ORG_RULE_KINDS, ORG_RULE_KIND_IDS } = require("../domain/refData");

const YES = ["Y", "YES", "TRUE", "1", "ACTIVE"];
const NO = ["N", "NO", "FALSE", "0", "INACTIVE"];

/** "Y"/"N" in the sheet, boolean in the document. Blank means active — the common case. */
function toBool(v, dflt) {
  const s = String(v === null || v === undefined ? "" : v).trim().toUpperCase();
  if (!s) return dflt === undefined ? true : dflt;
  if (YES.includes(s)) return true;
  if (NO.includes(s)) return false;
  return null;                                  // the validator turns this into a row error
}
const fromBool = (b) => (b === false ? "N" : "Y");

function toNum(v) {
  const s = String(v === null || v === undefined ? "" : v).replace(/[,\s$]/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const str = (v) => String(v === null || v === undefined ? "" : v).trim();
const list = (v) => str(v).split(";").map((x) => x.trim()).filter(Boolean);
const unlist = (a) => (Array.isArray(a) ? a : []).join("; ");

// ---- the registry ----------------------------------------------------------------------------

const MASTERS = {
  locations: {
    label: "Locations",
    collection: "locations",
    idPrefix: "loc",
    key: "code",
    systemOfRecord: "tool",
    describe: "Every site an AFE can be raised for. The code is the template's own "
      + "COUNTRY_City_Address spelling and is what prints on the form — including the building "
      + "number, which is what Fixed Assets files property tax against.",
    columns: [
      { name: "code", type: "text", required: true, width: 46,
        help: "The full location string, exactly as it should print. Never edit an existing one — deactivate it and add the correction as a new row." },
      { name: "country", type: "text", width: 12, help: "Three-letter code, filled in for you from the start of the code." },
      { name: "city", type: "text", width: 20, help: "Filled in for you from the code." },
      { name: "active", type: "bool", width: 8, help: "Y or N. N hides it from the wizard without losing the AFEs that used it." },
    ],
    toRow: (d) => ({ code: d.code, country: d.country || "", city: d.city || "", active: fromBool(d.active) }),
    toDoc: (r) => {
      const code = str(r.code);
      const parts = code.split("_");
      return {
        code,
        country: str(r.country) || (parts.length > 1 ? parts[0] : ""),
        city: str(r.city) || (parts.length > 2 ? parts[1] : ""),
        active: toBool(r.active),
      };
    },
    validate: (d) => {
      const out = [];
      if (!d.code) out.push("code is required");
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },

  org_rules: {
    label: "Routing rules",
    collection: "orgRules",
    idPrefix: "rule",
    key: "id",
    systemOfRecord: "tool",
    describe: "Who is added to an approval chain, and when. The SAP matrix is the minimum chain; "
      + "these rules are everything the business adds on top — pre-approvers, the division "
      + "override, the Technical Accounting Review above $1M, copies, coordinators and the "
      + "assistants who check before a leader signs.",
    columns: [
      { name: "id", type: "text", required: true, width: 12,
        help: "Leave blank on a new row and one is generated. Never change an existing id." },
      { name: "kind", type: "enum", required: true, width: 16,
        enum: ORG_RULE_KIND_IDS,
        help: ORG_RULE_KINDS.map((k) => `${k.id} ${k.help}`).join(" · ") + "." },
      { name: "scope_division", type: "text", width: 14, help: "CORP_IT, MFG, Facilities, Selling… Blank means every division." },
      { name: "scope_cost_centre", type: "text", width: 14, help: "A single cost centre, when the rule is that narrow." },
      { name: "scope_owner_name", type: "text", width: 20, help: "Applies when this person is the cost-centre owner (M1)." },
      { name: "scope_person_email", type: "email", width: 26, help: "For an assistant rule: the signer whose work is being checked." },
      { name: "person_name", type: "text", required: true, width: 22, help: "The person this rule adds." },
      { name: "person_email", type: "email", width: 28, help: "Leave blank if you do not know it — the coordinator is asked to confirm it before anything is sent." },
      { name: "group", type: "text", width: 26, help: "The label printed beside them, e.g. 'Assoc. Dir Digital Workplace'." },
      { name: "min_usd", type: "number", width: 12, help: "Only applies at or above this total." },
      { name: "max_usd", type: "number", width: 12, help: "Only applies up to this total." },
      { name: "placement", type: "enum", width: 18, enum: ["", "project_approvals", "after_matrix", "after_m1"],
        help: "Where they land in the chain." },
      { name: "above_limit", type: "enum", width: 12, enum: ["", "include", "skip"],
        help: "For an override: sign anyway above their own authority, or step aside." },
      { name: "handoff", type: "bool", width: 10, help: "For a cc rule: Y marks the shared mailbox the approved AFE is handed to." },
      { name: "active", type: "bool", width: 8 },
      { name: "note", type: "text", width: 50, help: "Why this rule exists. Shown in Admin; never printed." },
    ],
    toRow: (d) => ({
      id: d.id, kind: d.kind,
      scope_division: (d.scope && d.scope.division) || "",
      scope_cost_centre: (d.scope && d.scope.costCenter) || "",
      scope_owner_name: (d.scope && d.scope.ownerName) || "",
      scope_person_email: (d.scope && d.scope.personEmail) || "",
      person_name: (d.person && d.person.name) || "",
      person_email: (d.person && d.person.email) || "",
      group: d.group || "",
      min_usd: d.conditions && d.conditions.min !== undefined && d.conditions.min !== null ? String(d.conditions.min) : "",
      max_usd: d.conditions && d.conditions.max !== undefined && d.conditions.max !== null ? String(d.conditions.max) : "",
      placement: d.placement || "", above_limit: d.aboveLimit || "",
      handoff: d.handoff ? "Y" : "", active: fromBool(d.active), note: d.note || "",
    }),
    toDoc: (r) => {
      const scope = {};
      if (str(r.scope_division)) scope.division = str(r.scope_division);
      if (str(r.scope_cost_centre)) scope.costCenter = str(r.scope_cost_centre);
      if (str(r.scope_owner_name)) scope.ownerName = str(r.scope_owner_name);
      if (str(r.scope_person_email)) scope.personEmail = str(r.scope_person_email).toLowerCase();
      const conditions = {};
      if (str(r.min_usd)) conditions.min = toNum(r.min_usd);
      if (str(r.max_usd)) conditions.max = toNum(r.max_usd);
      const name = str(r.person_name);
      const doc = {
        id: str(r.id) || undefined,
        kind: str(r.kind).toLowerCase(),
        scope,
        person: { name, email: str(r.person_email).toLowerCase() || null },
        active: toBool(r.active),
        note: str(r.note) || null,
      };
      if (Object.keys(conditions).length) doc.conditions = conditions;
      if (str(r.group)) doc.group = str(r.group);
      if (str(r.placement)) doc.placement = str(r.placement);
      if (str(r.above_limit)) doc.aboveLimit = str(r.above_limit);
      if (toBool(r.handoff, false) === true) doc.handoff = true;
      return doc;
    },
    validate: (d, def) => {
      const out = [];
      if (!d.kind) out.push("kind is required");
      else if (!def.columns.find((c) => c.name === "kind").enum.includes(d.kind)) {
        out.push(`kind must be one of ${def.columns.find((c) => c.name === "kind").enum.join(", ")}`);
      }
      if (!d.person || !d.person.name) out.push("person_name is required");
      if (d.person && d.person.email && !people.isCompanyMailbox(d.person.email)) {
        out.push(`person_email does not look like a Acme mailbox: ${d.person.email}`);
      }
      if (d.kind === "assistant" && !(d.scope && d.scope.personEmail)) {
        out.push("an assistant rule needs scope_person_email — the signer they check for");
      }
      if (d.conditions && d.conditions.min === null) out.push("min_usd is not a number");
      if (d.conditions && d.conditions.max === null) out.push("max_usd is not a number");
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },

  budget_pots: {
    label: "Budget pots",
    collection: "budgetPots",
    idPrefix: "pot",
    key: "id",
    systemOfRecord: "tool",
    describe: "The annual capital budget, by division, category and region. The wizard shows a "
      + "requester what is left in the pot they are drawing on before they ask for it.",
    columns: [
      { name: "id", type: "text", required: true, width: 12, help: "Blank on a new row generates one." },
      { name: "division", type: "text", required: true, width: 14 },
      { name: "fiscal_year", type: "number", required: true, width: 12 },
      { name: "budget_category", type: "text", required: true, width: 24, help: "Life Cycle Refresh, Printers & Conf Rooms, Facilities, Capex, CCA…" },
      { name: "region", type: "text", required: true, width: 10, help: "NLAM, EMEA, APAC or Global." },
      { name: "amount_usd", type: "number", required: true, width: 16 },
      { name: "active", type: "bool", width: 8 },
    ],
    toRow: (d) => ({
      id: d.id, division: d.division || "", fiscal_year: String(d.fiscalYear || ""),
      budget_category: d.budgetCategory || "", region: d.region || "",
      amount_usd: d.amountUsd === null || d.amountUsd === undefined ? "" : String(d.amountUsd),
      active: fromBool(d.active),
    }),
    toDoc: (r) => ({
      id: str(r.id) || undefined, division: str(r.division), fiscalYear: toNum(r.fiscal_year),
      budgetCategory: str(r.budget_category), region: str(r.region),
      amountUsd: toNum(r.amount_usd), active: toBool(r.active),
    }),
    validate: (d) => {
      const out = [];
      for (const f of ["division", "budgetCategory", "region"]) if (!d[f]) out.push(`${f} is required`);
      if (d.fiscalYear === null || !(d.fiscalYear >= 2000 && d.fiscalYear <= 2100)) out.push("fiscal_year must be a year like 2026");
      if (d.amountUsd === null || d.amountUsd < 0) out.push("amount_usd must be a number, zero or more");
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },

  directory: {
    label: "Name to mailbox",
    collection: "directory",
    idPrefix: "dir",
    key: "matrix_name",
    systemOfRecord: "tool",
    describe: "The SAP matrix carries names, not addresses, and the form spells some of them "
      + "differently again. This is where a name is tied to a mailbox once, so nobody is asked "
      + "to confirm the same person twice.",
    columns: [
      { name: "matrix_name", type: "text", required: true, width: 24, help: "The name exactly as the SAP matrix spells it." },
      { name: "display_name", type: "text", width: 24, help: "How to show them. Defaults to the matrix name." },
      { name: "email", type: "email", required: true, width: 30 },
      { name: "source", type: "enum", width: 14, enum: ["confirmed", "guessed", "imported", "learned"],
        help: "confirmed means a person vouched for it; guessed means the tool derived it from the name and it still needs confirming." },
      { name: "active", type: "bool", width: 8 },
      { name: "note", type: "text", width: 44 },
    ],
    toRow: (d) => ({
      matrix_name: d.matrixName || "", display_name: d.displayName || "", email: d.email || "",
      source: d.source || "imported", active: fromBool(d.active), note: d.note || "",
    }),
    toDoc: (r) => ({
      matrixName: str(r.matrix_name), displayName: str(r.display_name) || str(r.matrix_name),
      email: str(r.email).toLowerCase(), source: str(r.source).toLowerCase() || "imported",
      active: toBool(r.active), note: str(r.note) || null,
    }),
    validate: (d, def) => {
      const out = [];
      if (!d.matrixName) out.push("matrix_name is required");
      if (!d.email) out.push("email is required");
      else if (!people.isCompanyMailbox(d.email)) out.push(`email does not look like a Acme mailbox: ${d.email}`);
      const src = def.columns.find((c) => c.name === "source").enum;
      if (d.source && !src.includes(d.source)) out.push(`source must be one of ${src.join(", ")}`);
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },

  users: {
    label: "People and roles",
    collection: "users",
    idPrefix: "usr",
    key: "email",
    systemOfRecord: "tool",
    describe: "Everyone who signs in is a requester automatically — they do not need a row here. "
      + "This list is what someone holds IN ADDITION: coordinator, Fixed Assets, leadership, "
      + "administrator. Removing a role takes effect the next time that person loads the tool.",
    columns: [
      { name: "email", type: "email", required: true, width: 30, help: "The Acme mailbox. This is the identity; never edit it." },
      { name: "display_name", type: "text", required: true, width: 24 },
      { name: "title", type: "text", width: 28, help: "Shown in the tool. Not a permission." },
      { name: "roles", type: "text", width: 44,
        help: "Semicolon-separated: approver; coordinator; fa_preparer; fa_checker; leadership; admin. Blank means requester only." },
      { name: "coordinator_for", type: "text", width: 22, help: "Semicolon-separated divisions this person coordinates." },
      { name: "matrix_names", type: "text", width: 30, help: "Other spellings of this person's name in the SAP matrix, so their signature is recognised." },
      { name: "active", type: "bool", width: 8 },
    ],
    toRow: (d) => ({
      email: d.email || "", display_name: d.displayName || "", title: d.title || "",
      roles: unlist(d.roles), coordinator_for: unlist(d.coordinatorFor),
      matrix_names: unlist(d.matrixNames), active: fromBool(d.active),
    }),
    toDoc: (r) => ({
      email: str(r.email).toLowerCase(), displayName: str(r.display_name),
      title: str(r.title) || null, roles: list(r.roles).map((x) => x.toLowerCase()),
      coordinatorFor: list(r.coordinator_for), matrixNames: list(r.matrix_names),
      active: toBool(r.active),
    }),
    validate: (d) => {
      const out = [];
      const rbac = require("../domain/rbac");
      if (!d.email) out.push("email is required");
      else if (!people.isCompanyMailbox(d.email)) out.push(`email does not look like a Acme mailbox: ${d.email}`);
      if (!d.displayName) out.push("display_name is required");
      for (const role of d.roles || []) {
        if (!rbac.ASSIGNABLE_ROLES.includes(role)) {
          out.push(`"${role}" is not a role — use ${rbac.ASSIGNABLE_ROLES.join(", ")}`);
        }
      }
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },

  matrix: {
    label: "Approver matrix (from SAP)",
    collection: "matrix",
    idPrefix: "mxr",
    key: "cost_centre",
    systemOfRecord: "sap",
    describe: "One row per cost centre, with the person SAP names at every approval level. This "
      + "is SAP's list, not ours — it arrives as a scheduled extract and an import here is "
      + "refused. Exported so it can be read, checked against, and sent to whoever is asking.",
    columns: [
      { name: "cost_centre", type: "text", required: true, width: 14 },
      { name: "description", type: "text", width: 40 },
      { name: "plant", type: "text", width: 10 },
      { name: "status", type: "text", width: 12 },
      { name: "M1", type: "text", width: 22 }, { name: "A1", type: "text", width: 22 },
      { name: "A2", type: "text", width: 22 }, { name: "A3", type: "text", width: 22 },
      { name: "A4", type: "text", width: 22 }, { name: "A5", type: "text", width: 22 },
      { name: "A6", type: "text", width: 22 }, { name: "A7", type: "text", width: 22 },
      { name: "A8", type: "text", width: 22 }, { name: "A9", type: "text", width: 22 },
    ],
    toRow: (d) => {
      const out = { cost_centre: d.costCenter || "", description: d.description || "", plant: d.plant || "", status: d.status || "" };
      for (const lvl of ["M1", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]) {
        out[lvl] = (d.levels && d.levels[lvl] && d.levels[lvl].name) || "";
      }
      return out;
    },
    toDoc: (r) => {
      const levels = {};
      for (const lvl of ["M1", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]) {
        if (str(r[lvl])) levels[lvl] = { name: str(r[lvl]) };
      }
      return { costCenter: str(r.cost_centre), description: str(r.description), plant: str(r.plant), status: str(r.status), levels };
    },
    validate: (d) => (d.costCenter ? [] : ["cost_centre is required"]),
  },

  asset_classes: {
    label: "Asset classes",
    collection: "assetClasses",
    idPrefix: "acl",
    key: "value",
    systemOfRecord: "tool",
    describe: "The SAP asset classes the Asset Acquisition block offers, from the template's own "
      + "DataVal sheet. The value is what prints on the form and what Fixed Assets keys at AS01.",
    columns: [
      { name: "value", type: "text", required: true, width: 46,
        help: "Code and name, exactly as SAP spells it — e.g. 16530-Machinery - Production." },
      { name: "code", type: "text", width: 10, help: "The GL account. Taken from the value if left blank." },
      { name: "label", type: "text", width: 36, help: "What the requester reads. Defaults to the name half." },
      { name: "sort_order", type: "number", width: 12, help: "Low numbers first; blank sorts last, alphabetically." },
      { name: "active", type: "bool", width: 8 },
    ],
    toRow: (d) => ({
      value: d.value || "", code: d.code || "", label: d.label || "",
      sort_order: d.sortOrder === null || d.sortOrder === undefined ? "" : String(d.sortOrder),
      active: fromBool(d.active),
    }),
    toDoc: (r) => {
      const value = str(r.value);
      const code = str(r.code) || value.split("-")[0];
      return {
        value, code, label: str(r.label) || value.split("-").slice(1).join("-") || value,
        sortOrder: str(r.sort_order) ? toNum(r.sort_order) : null,
        active: toBool(r.active),
      };
    },
    validate: (d) => {
      const out = [];
      if (!d.value) out.push("value is required");
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },

  asset_lives: {
    label: "Asset lives",
    collection: "assetLives",
    idPrefix: "alv",
    key: "value",
    systemOfRecord: "tool",
    describe: "The asset-life bands, and the number of YEARS each one depreciates over. The "
      + "years column is the one that matters: the form divides an asset's cost by it to get the "
      + "annual depreciation, so a band with no number cannot be used. Two of the thirteen are "
      + "ranges (3-5) and take their upper bound, which is what the template's own worked "
      + "example does — change the number here if the business decides otherwise.",
    columns: [
      { name: "value", type: "text", required: true, width: 56,
        help: "The band, exactly as the template spells it — e.g. 7-Machinery and Equipment." },
      { name: "years", type: "number", required: true, width: 8,
        help: "What the cost is divided by. A band without a number cannot depreciate anything." },
      { name: "open_range", type: "bool", width: 12,
        help: "Y where the band is a range and the number above was a decision rather than a reading." },
      { name: "label", type: "text", width: 44, help: "What the requester reads. Defaults to the value." },
      { name: "sort_order", type: "number", width: 12 },
      { name: "active", type: "bool", width: 8 },
    ],
    toRow: (d) => ({
      value: d.value || "", years: d.years === null || d.years === undefined ? "" : String(d.years),
      open_range: fromBool(d.openRange), label: d.label || "",
      sort_order: d.sortOrder === null || d.sortOrder === undefined ? "" : String(d.sortOrder),
      active: fromBool(d.active),
    }),
    toDoc: (r) => ({
      value: str(r.value), years: str(r.years) ? toNum(r.years) : null,
      openRange: toBool(r.open_range) === true,
      label: str(r.label) || str(r.value),
      sortOrder: str(r.sort_order) ? toNum(r.sort_order) : null,
      active: toBool(r.active),
    }),
    validate: (d) => {
      const out = [];
      if (!d.value) out.push("value is required");
      // The whole reason this master exists rather than parsing the label.
      if (!(d.years > 0)) out.push("years must be a number greater than zero — the form divides the asset's cost by it");
      if (d.years > 60) out.push("years looks wrong: the longest band on the template is 39");
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },

  fx_rates: {
    label: "FX rates (Global Finance)",
    collection: "fxRates",
    idPrefix: "fx",
    key: "month_code",
    systemOfRecord: "global_finance",
    describe: "Global Finance's month-end rates to the US dollar, one row per currency per month, "
      + "every month kept. Upload their monthly workbook (8fx…xlsm) as it arrives: it is read in "
      + "their own layout, and which column is local currency per dollar is worked out from the "
      + "figures and shown before anything is saved. An AFE in another currency takes the newest "
      + "month's rate when its currency is picked, and keeps it.",
    columns: [
      { name: "month_code", type: "text", required: true, width: 14, help: "Generated as YYYY-MM|CODE." },
      { name: "month", type: "text", required: true, width: 10, help: "The month the rate is the month-end of, YYYY-MM." },
      { name: "code", type: "text", required: true, width: 8, help: "The ISO 4217 code: SGD, INR, JPY." },
      { name: "name", type: "text", width: 28 },
      { name: "local_per_usd", type: "number", required: true, width: 16, help: "Units of the currency one US dollar buys." },
      { name: "usd_per_local", type: "number", width: 16, help: "The same rate the other way round." },
    ],
    toRow: (d) => ({
      month_code: `${d.month || ""}|${d.code || ""}`, month: d.month || "", code: d.code || "", name: d.name || "",
      local_per_usd: d.localPerUsd === null || d.localPerUsd === undefined ? "" : String(d.localPerUsd),
      usd_per_local: d.usdPerLocal === null || d.usdPerLocal === undefined ? "" : String(d.usdPerLocal),
    }),
    toDoc: (r) => {
      const [m, c] = str(r.month_code).split("|");
      return {
        month: str(r.month) || str(m), code: (str(r.code) || str(c)).toUpperCase(), name: str(r.name),
        localPerUsd: toNum(r.local_per_usd), usdPerLocal: toNum(r.usd_per_local), active: true,
      };
    },
    validate: (d) => {
      const out = [];
      if (!/^\d{4}-\d{2}$/.test(d.month || "")) out.push("month must be YYYY-MM");
      if (!/^[A-Z]{3}$/.test(d.code || "")) out.push("code must be a three-letter ISO code");
      if (!(d.localPerUsd > 0)) out.push("local_per_usd must be a number above zero");
      return out;
    },
    // Their workbook, in their layout: the month from the title, RATE and REVERSE per currency.
    readSource: (sheets) => {
      const src = fxRates.fromWorkbook(sheets);
      // What the reader folded together and what it left out are said before anything is saved,
      // so a currency that is missing next month is missing on purpose, and visibly.
      const shared = src.rows.filter((x) => x.countries > 1);
      const left = src.skipped.slice(0, 8).map((s) => `${s.code}${s.name ? ` (${s.name})` : ""} row ${s.line}, ${s.reason}`);
      return {
        rows: src.rows.map((x) => ({ month: src.month, code: x.code, name: x.name, localPerUsd: x.localPerUsd, usdPerLocal: x.usdPerLocal, line: x.line })),
        problems: src.problems,
        note: `Global Finance's ${src.monthLabel} rates from the "${src.sheet}" sheet${src.pairNote ? ` (${src.pairNote})` : ""}. `
          + `${src.direction.toUpperCase()} is local currency per US dollar: ${src.decidedBy}.`
          + (shared.length ? ` One rate for several countries: ${shared.map((x) => `${x.code} (${x.countries})`).join(", ")}.` : "")
          + (left.length ? ` Left out: ${left.join("; ")}${src.skipped.length > left.length ? `; and ${src.skipped.length - left.length} more` : ""}.` : ""),
      };
    },
  },

  reference_lists: {
    label: "Reference lists",
    collection: "referenceLists",
    idPrefix: "ref",
    key: "list_value",
    systemOfRecord: "tool",
    describe: "The drop-downs: project types, buy-vs-lease answers, SAP order types, regions. "
      + "They come from the AFE template's own Reference sheet, and this is where they are kept "
      + "current without a code change.",
    columns: [
      { name: "list_value", type: "text", required: true, width: 34,
        help: "Generated for you as list|value. Never edit it; add a new row instead." },
      { name: "list", type: "enum", required: true, width: 18,
        enum: ["project_type", "buy_vs_lease", "order_type", "region", "new_equipment", "yes_no_na"] },
      { name: "value", type: "text", required: true, width: 30, help: "What is stored and printed." },
      { name: "label", type: "text", width: 34, help: "What the requester reads. Defaults to the value." },
      { name: "sort_order", type: "number", width: 12, help: "Low numbers first; blank sorts last, alphabetically." },
      { name: "active", type: "bool", width: 8 },
    ],
    toRow: (d) => ({
      list_value: `${d.list}|${d.value}`, list: d.list || "", value: d.value || "",
      label: d.label || "", sort_order: d.sortOrder === null || d.sortOrder === undefined ? "" : String(d.sortOrder),
      active: fromBool(d.active),
    }),
    toDoc: (r) => {
      const listName = str(r.list) || str(r.list_value).split("|")[0];
      const value = str(r.value) || str(r.list_value).split("|").slice(1).join("|");
      return {
        list: listName, value, label: str(r.label) || value,
        sortOrder: str(r.sort_order) ? toNum(r.sort_order) : null,
        active: toBool(r.active),
        list_value: `${listName}|${value}`,
      };
    },
    validate: (d, def) => {
      const out = [];
      const lists = def.columns.find((c) => c.name === "list").enum;
      if (!d.list) out.push("list is required");
      else if (!lists.includes(d.list)) out.push(`list must be one of ${lists.join(", ")}`);
      if (!d.value) out.push("value is required");
      if (d.active === null) out.push("active must be Y or N");
      return out;
    },
  },
};

const MASTER_KINDS = Object.keys(MASTERS);

/** The value a row is keyed by — what makes an import an upsert rather than a duplicate. */
function keyOf(kind, doc) {
  const def = MASTERS[kind];
  const row = def.toRow(doc);
  return String(row[def.key] === undefined ? doc[def.key] : row[def.key]).trim().toLowerCase();
}

module.exports = { MASTERS, MASTER_KINDS, keyOf, toBool, fromBool, toNum, str, list, unlist };
