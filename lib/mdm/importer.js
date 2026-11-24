"use strict";
// Master data in and out of Excel.
//
// The shape of the deal with the business team: they get a workbook that is already filled in
// with what the tool holds, they edit it in Excel like any other sheet, they send it back, and
// what they see in the tool afterwards is exactly what they typed. So:
//
//   · EXPORT IS THE IMPORT FORMAT. There is one column list per master (lib/mdm/masters.js) and
//     both directions use it. A person can always get a correct file by exporting one.
//   · IMPORT IS AN UPSERT, NEVER A REPLACE. A row missing from the sheet is left alone, because
//     the commonest spreadsheet accident is sending back a filtered copy. Removing something is
//     `active = N`, which is reversible and keeps the AFEs that already referenced it working.
//   · NOTHING APPLIES UNTIL IT HAS BEEN SEEN. `parse` returns a diff — added, changed with the
//     fields that moved, deactivated — and the Admin screen shows that before `apply` runs.
//   · EVERY APPLY IS A VERSION. The team only ever thinks about the current one; the earlier
//     ones exist so a bad import is one click to undo.
const xlsx = require("../xlsx/workbook");
const audit = require("../audit");
const { MASTERS, MASTER_KINDS, keyOf } = require("./masters");

const DATA_SHEET = "Data";
const README_SHEET = "README";
const KEEP_VERSIONS = 20;

class MasterError extends Error {
  constructor(status, message, detail) { super(message); this.status = status; this.detail = detail || null; }
}

function def(kind) {
  const d = MASTERS[kind];
  if (!d) throw new MasterError(404, `no master called ${kind}; masters: ${MASTER_KINDS.join(", ")}`);
  return d;
}

// ---- export ----------------------------------------------------------------------------------

/** The README sheet: what each column means, in the workbook, so nobody has to be told twice. */
function readmeRows(kind) {
  const d = def(kind);
  const rows = [
    [`${d.label} — how this sheet works`, ""],
    ["", ""],
    ["What it is", d.describe],
    ["", ""],
    ["Edit here, import back", "Change what you like in the Data sheet and upload this file in Admin › Master data. You will be shown exactly what will change before anything is applied."],
    ["Adding a row", "Add it at the bottom of the Data sheet. Leave any id column blank and one is generated."],
    ["Removing a row", "Set active to N. Do not delete the line: rows already used by an AFE must keep resolving, and a deleted line is simply ignored on import."],
    ["Rows you leave out", "Left exactly as they are. Import only ever adds and updates, so sending back a filtered copy is safe."],
    ["The key column", `"${d.key}" identifies the row. Change it and you have created a new row, not renamed the old one.`],
    ["", ""],
    ["Column", "Meaning"],
  ];
  for (const c of d.columns) {
    const bits = [];
    if (c.required) bits.push("required");
    if (c.type === "bool") bits.push("Y or N");
    if (c.type === "number") bits.push("a number");
    if (c.type === "email") bits.push("a Acme mailbox");
    if (c.enum && c.enum.filter(Boolean).length) bits.push(`one of: ${c.enum.filter(Boolean).join(", ")}`);
    rows.push([c.name, [c.help, bits.length ? `(${bits.join(" · ")})` : ""].filter(Boolean).join(" ")]);
  }
  return rows;
}

/** The workbook for a master, filled with what the store holds right now. */
async function exportWorkbook(repos, kind) {
  const d = def(kind);
  const docs = await repos[d.collection].all();
  docs.sort((a, b) => String(keyOf(kind, a)).localeCompare(String(keyOf(kind, b))));
  const header = d.columns.map((c) => c.name);
  const rows = [header];
  for (const doc of docs) {
    const row = d.toRow(doc);
    rows.push(header.map((h) => (row[h] === null || row[h] === undefined ? "" : String(row[h]))));
  }
  return xlsx.write([
    { name: DATA_SHEET, rows, widths: d.columns.map((c) => c.width || 18), freezeHeader: true, boldFirstRow: true },
    { name: README_SHEET, rows: readmeRows(kind), widths: [26, 96] },
  ]);
}

const filenameFor = (kind) => `afe-master-${kind.replace(/_/g, "-")}.xlsx`;

// ---- import ----------------------------------------------------------------------------------

/** Compare two documents on the columns the sheet actually carries. */
function changedFields(kind, before, after) {
  const d = def(kind);
  const a = d.toRow(before), b = d.toRow(after);
  const out = [];
  for (const c of d.columns) {
    if (c.name === d.key) continue;
    const x = String(a[c.name] === undefined || a[c.name] === null ? "" : a[c.name]).trim();
    const y = String(b[c.name] === undefined || b[c.name] === null ? "" : b[c.name]).trim();
    if (x !== y) out.push({ field: c.name, was: x, now: y });
  }
  return out;
}

/**
 * Read a workbook and work out what it would do. Nothing is written.
 * @returns {{kind, rows, errors, added, changed, deactivated, unchanged}}
 */
async function parse(repos, kind, bytes) {
  const d = def(kind);
  if (d.systemOfRecord === "sap" || (d.systemOfRecord !== "tool" && !d.readSource)) {
    throw new MasterError(409, `${d.label} comes from SAP — it is updated by an extract, not by import. `
      + "Export it to read it, but the tool is not its system of record.");
  }

  let sheets;
  try { sheets = xlsx.read(bytes); }
  catch (e) { throw new MasterError(422, `that file could not be read as an Excel workbook: ${e.message}`); }

  let data = sheets.find((s) => s.name.toLowerCase() === DATA_SHEET.toLowerCase()) || sheets[0];
  // A list kept by somebody else arrives in THEIR layout (R161): read it with the master's own
  // reader and carry on as if it had been our export, so the diff, the version and the audit are
  // exactly what every other import gets. Our own export still round-trips.
  let source = null;
  const ours = data && (data.rows[0] || []).map((h) => String(h || "").trim().toLowerCase()).includes(String(d.key).toLowerCase());
  if (d.readSource && !ours) {
    let read;
    try { read = d.readSource(sheets); }
    catch (e) { throw new MasterError(e.status || 422, e.message); }
    const header = d.columns.map((c) => c.name);
    data = { name: "(their layout)", rows: [header].concat(read.rows.map((doc) => { const row = d.toRow(doc); return header.map((h) => row[h]); })) };
    source = { note: read.note || null, problems: read.problems || [], lines: read.rows.map((x) => x.line || null) };
  }
  if (!data || data.rows.length < 1) throw new MasterError(422, "the Data sheet is empty");

  // Header by NAME, not by position: a person may reorder columns or add one of their own.
  const header = (data.rows[0] || []).map((h) => String(h || "").trim().toLowerCase());
  const at = {};
  for (const c of d.columns) at[c.name] = header.indexOf(c.name.toLowerCase());
  const missing = d.columns.filter((c) => c.required && at[c.name] < 0).map((c) => c.name);
  if (missing.length) {
    throw new MasterError(422, `the Data sheet is missing these columns: ${missing.join(", ")}. `
      + "Export the master again and edit that file — the export is the import format.");
  }
  const unknown = header.filter((h) => h && !d.columns.some((c) => c.name.toLowerCase() === h));

  const current = await repos[d.collection].all();
  const byKey = new Map(current.map((doc) => [keyOf(kind, doc), doc]));

  const errors = [];
  const seen = new Map();
  const added = [], changed = [], unchanged = [];

  for (let i = 1; i < data.rows.length; i += 1) {
    // The spreadsheet's own row number — in their layout, the row the reader found it on.
    const line = source && source.lines[i - 1] ? source.lines[i - 1] : i + 1;
    const cells = data.rows[i] || [];
    if (!cells.some((v) => String(v === null || v === undefined ? "" : v).trim())) continue;   // a blank line

    const raw = {};
    for (const c of d.columns) raw[c.name] = at[c.name] >= 0 ? (cells[at[c.name]] || "") : "";

    let doc;
    try { doc = d.toDoc(raw); }
    catch (e) { errors.push({ line, problems: [`could not be read: ${e.message}`] }); continue; }

    const problems = d.validate(doc, d) || [];
    const key = keyOf(kind, doc);
    if (!key) problems.push(`${d.key} is required`);
    else if (seen.has(key)) problems.push(`${d.key} "${key}" is on row ${seen.get(key)} as well — each row must be unique`);
    if (problems.length) { errors.push({ line, key, problems }); continue; }

    seen.set(key, line);
    const before = byKey.get(key);
    if (!before) {
      added.push({ line, key, doc });
    } else {
      const fields = changedFields(kind, before, doc);
      if (fields.length) changed.push({ line, key, id: before.id, fields, doc });
      else unchanged.push({ line, key, id: before.id });
    }
  }

  // A row that is in the store, not in the sheet, and active — reported so the difference is
  // visible, but NOT touched. Deleting a line from a spreadsheet must never delete data.
  const absent = current
    .filter((doc) => doc.active !== false && !seen.has(keyOf(kind, doc)))
    .map((doc) => ({ key: keyOf(kind, doc), id: doc.id }));

  // Deactivations are ordinary changes; pull them out so the screen can say so plainly.
  const deactivated = changed.filter((c) => c.fields.some((f) => f.field === "active" && f.now === "N"));

  // What the reader itself could not accept (a RATE and REVERSE that disagree, a code twice) is
  // an error like any other: all of it applies, or none of it does.
  for (const p of (source && source.problems) || []) errors.push({ line: p.line, key: p.code, problems: [p.problem] });

  return {
    kind, label: d.label, sheet: data.name, dataRows: data.rows.length - 1, source: source ? { note: source.note } : null,
    unknownColumns: unknown, errors,
    added, changed, unchanged: unchanged.length, deactivated, absent,
    ok: errors.length === 0,
    summary: { added: added.length, changed: changed.length, deactivated: deactivated.length,
      unchanged: unchanged.length, absent: absent.length, errors: errors.length },
  };
}

/** Write a parsed import. Refuses anything with a row error — all of it applies, or none does. */
async function apply(repos, ctx, parsed, opts) {
  const o = opts || {};
  const d = def(parsed.kind);
  if (!parsed.ok) throw new MasterError(422, `${parsed.errors.length} row(s) still have problems — nothing was changed`, parsed.errors);

  for (const a of parsed.added) {
    const doc = Object.assign({}, a.doc);
    if (!doc.id) delete doc.id;
    await repos[d.collection].insert(doc);
  }
  for (const c of parsed.changed) {
    const patch = Object.assign({}, c.doc);
    delete patch.id;                                     // the id is the row's identity, never an edit
    await repos[d.collection].update(c.id, patch);
  }

  const version = await snapshot(repos, ctx, parsed.kind, {
    summary: parsed.summary, source: o.source || "import", filename: o.filename || null, note: o.note || null,
  });
  await audit.record(repos, ctx, {
    entity: "master", entityId: parsed.kind, type: "master_imported",
    payload: { kind: parsed.kind, version: version.version, filename: o.filename || null, summary: parsed.summary },
  });
  return { version, summary: parsed.summary };
}

// ---- versions --------------------------------------------------------------------------------

/**
 * Freeze the whole master as it now stands. Masters are small — the largest is 150 locations —
 * so a version carries its rows rather than tagging them, which makes restore a plain re-apply
 * and keeps a version readable on its own.
 */
async function snapshot(repos, ctx, kind, meta) {
  const d = def(kind);
  const docs = await repos[d.collection].all();
  const prior = await repos.masterVersions.all((v) => v.kind === kind);
  const version = prior.reduce((n, v) => Math.max(n, v.version || 0), 0) + 1;
  const row = await repos.masterVersions.insert({
    kind, version, at: new Date().toISOString(),
    byEmail: (ctx && ctx.user && ctx.user.email) || "system",
    byName: (ctx && ctx.userRow && ctx.userRow.displayName) || null,
    actingAs: (ctx && ctx.actingAs && ctx.actingAs.email) || null,
    rowCount: docs.length,
    rows: docs.map((doc) => Object.assign({ id: doc.id }, d.toRow(doc))),
    summary: (meta && meta.summary) || null,
    source: (meta && meta.source) || "edit",
    filename: (meta && meta.filename) || null,
    note: (meta && meta.note) || null,
  });
  // Keep the recent ones; a master that is edited weekly should not grow a year of history.
  const all = (await repos.masterVersions.all((v) => v.kind === kind)).sort((a, b) => b.version - a.version);
  for (const old of all.slice(KEEP_VERSIONS)) await repos.masterVersions.remove(old.id);
  return row;
}

/** Put a stored version back — as a NEW version, never by rewinding history. */
async function restore(repos, ctx, kind, versionId) {
  const d = def(kind);
  const v = await repos.masterVersions.get(versionId);
  if (!v || v.kind !== kind) throw new MasterError(404, "no such version of this master");

  const current = await repos[d.collection].all();
  const byKey = new Map(current.map((doc) => [keyOf(kind, doc), doc]));
  let added = 0, changed = 0;
  for (const row of v.rows || []) {
    const doc = d.toDoc(row);
    const key = keyOf(kind, doc);
    const before = byKey.get(key);
    if (!before) { const copy = Object.assign({}, doc); delete copy.id; await repos[d.collection].insert(copy); added += 1; }
    else if (changedFields(kind, before, doc).length) {
      const patch = Object.assign({}, doc); delete patch.id;
      await repos[d.collection].update(before.id, patch); changed += 1;
    }
  }
  const summary = { added, changed, deactivated: 0, unchanged: (v.rows || []).length - added - changed, absent: 0, errors: 0 };
  const made = await snapshot(repos, ctx, kind, { summary, source: "restore", note: `restored from version ${v.version}` });
  await audit.record(repos, ctx, {
    entity: "master", entityId: kind, type: "master_restored",
    payload: { kind, restoredFrom: v.version, newVersion: made.version, summary },
  });
  return { version: made, summary, restoredFrom: v.version };
}

/** One row changed in the UI — the same discipline as an import, so it versions too. */
const keptBy = (d) => (d.systemOfRecord === "global_finance" ? "Global Finance" : "SAP");

async function editRow(repos, ctx, kind, id, patch) {
  const d = def(kind);
  if (d.systemOfRecord !== "tool") throw new MasterError(409, `${d.label} comes from ${keptBy(d)} and is not edited here`);
  const before = await repos[d.collection].get(id);
  if (!before) throw new MasterError(404, "no such row");
  const merged = Object.assign({}, d.toRow(before), patch);
  const doc = d.toDoc(merged);
  const problems = d.validate(doc, d) || [];
  if (problems.length) throw new MasterError(422, problems.join("; "), problems);
  const fields = changedFields(kind, before, doc);
  if (!fields.length) return { unchanged: true, row: d.toRow(before) };
  const next = Object.assign({}, doc); delete next.id;
  const saved = await repos[d.collection].update(id, next);
  const version = await snapshot(repos, ctx, kind, {
    summary: { added: 0, changed: 1, deactivated: fields.some((f) => f.field === "active" && f.now === "N") ? 1 : 0, unchanged: 0, absent: 0, errors: 0 },
    source: "edit", note: fields.map((f) => `${f.field}: ${f.was || "(blank)"} → ${f.now || "(blank)"}`).join("; "),
  });
  await audit.record(repos, ctx, {
    entity: "master", entityId: kind, type: "master_row_edited",
    payload: { kind, id, fields, version: version.version },
  });
  return { row: d.toRow(saved), fields, version: version.version };
}

/** A new row typed in the UI. */
async function addRow(repos, ctx, kind, row) {
  const d = def(kind);
  if (d.systemOfRecord !== "tool") throw new MasterError(409, `${d.label} comes from ${keptBy(d)} and is not edited here`);
  const doc = d.toDoc(row);
  const problems = d.validate(doc, d) || [];
  if (problems.length) throw new MasterError(422, problems.join("; "), problems);
  const key = keyOf(kind, doc);
  const clash = (await repos[d.collection].all()).find((x) => keyOf(kind, x) === key);
  if (clash) throw new MasterError(409, `${d.key} "${key}" already exists`);
  const copy = Object.assign({}, doc); delete copy.id;
  const saved = await repos[d.collection].insert(copy);
  const version = await snapshot(repos, ctx, kind, {
    summary: { added: 1, changed: 0, deactivated: 0, unchanged: 0, absent: 0, errors: 0 }, source: "edit",
  });
  await audit.record(repos, ctx, {
    entity: "master", entityId: kind, type: "master_row_added", payload: { kind, id: saved.id, key, version: version.version },
  });
  return { row: d.toRow(saved), id: saved.id, version: version.version };
}

/** What Admin lists: every master, its size and when it last moved. */
async function status(repos) {
  const out = [];
  for (const kind of MASTER_KINDS) {
    const d = MASTERS[kind];
    const rows = await repos[d.collection].all();
    const versions = (await repos.masterVersions.all((v) => v.kind === kind)).sort((a, b) => b.version - a.version);
    out.push({
      kind, label: d.label, describe: d.describe, systemOfRecord: d.systemOfRecord,
      key: d.key, columns: d.columns,
      rowCount: rows.length, activeCount: rows.filter((r) => r.active !== false).length,
      version: versions.length ? versions[0].version : 0,
      lastChangedAt: versions.length ? versions[0].at : null,
      lastChangedBy: versions.length ? versions[0].byEmail : null,
      filename: filenameFor(kind),
    });
  }
  return out;
}

module.exports = {
  exportWorkbook, filenameFor, parse, apply, snapshot, restore, editRow, addRow, status,
  MasterError, KEEP_VERSIONS, readmeRows,
};
