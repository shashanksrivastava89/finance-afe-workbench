"use strict";
// Admin › Master data. Export a workbook, edit it in Excel, send it back; or change one row in
// the screen. Either way it is the same pipeline, and either way it leaves a version behind.
//
// Mounted onto the admin router, so it inherits the admin guard — these routes never repeat it.
//
// The import is two calls on purpose. `POST …/import` with `apply: false` (the default) only
// READS the file and answers with what it would do; the Admin screen shows that, and a second
// call with `apply: true` writes it. A person should never find out what an import did by
// looking at the result.
const express = require("express");
const mdm = require("../mdm/importer");
const { MASTERS } = require("../mdm/masters");

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;      // a master is a list, not a dataset

function fail(res, e) {
  const status = e && e.status ? e.status : 500;
  res.status(status).json({ error: e && e.message ? e.message : String(e), detail: (e && e.detail) || null });
}

module.exports = function adminMasterRoutes({ repos, router }) {
  const r = router || express.Router();

  // What exists, how big it is, and when it last moved.
  r.get("/admin/masters", async (req, res) => {
    try { res.json({ masters: await mdm.status(repos) }); }
    catch (e) { fail(res, e); }
  });

  // The rows themselves, for the screen's table. Always in the workbook's own column order, so
  // what a person sees here and what they see in Excel are laid out the same way.
  r.get("/admin/masters/:kind/rows", async (req, res) => {
    try {
      const kind = req.params.kind;
      const def = MASTERS[kind];
      if (!def) return res.status(404).json({ error: `no master called ${kind}` });
      const docs = await repos[def.collection].all();
      const rows = docs.map((d) => Object.assign({ _id: d.id }, def.toRow(d)));
      rows.sort((a, b) => String(a[def.key] || "").localeCompare(String(b[def.key] || "")));
      res.json({
        kind, label: def.label, key: def.key, columns: def.columns,
        systemOfRecord: def.systemOfRecord, describe: def.describe, rows,
      });
    } catch (e) { fail(res, e); }
  });

  // The workbook. Filled in with what the tool holds, because a blank template is a quiz.
  r.get("/admin/masters/:kind/export.xlsx", async (req, res) => {
    try {
      const kind = req.params.kind;
      if (!MASTERS[kind]) return res.status(404).json({ error: `no master called ${kind}` });
      const buf = await mdm.exportWorkbook(repos, kind);
      res.setHeader("content-type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("content-disposition", `attachment; filename="${mdm.filenameFor(kind)}"`);
      res.setHeader("cache-control", "no-store");
      res.send(buf);
    } catch (e) { fail(res, e); }
  });

  /**
   * Read an uploaded workbook. `apply: true` writes it; anything else only reports.
   * Body: { contentBase64, filename?, apply?, note? }
   */
  r.post("/admin/masters/:kind/import", async (req, res) => {
    try {
      const b = req.body || {};
      if (!b.contentBase64) return res.status(422).json({ error: "contentBase64 is required — upload the .xlsx" });
      const bytes = Buffer.from(String(b.contentBase64), "base64");
      if (!bytes.length) return res.status(422).json({ error: "that upload was empty" });
      if (bytes.length > MAX_UPLOAD_BYTES) {
        return res.status(413).json({ error: `that file is ${(bytes.length / 1048576).toFixed(1)} MB — the limit is ${MAX_UPLOAD_BYTES / 1048576} MB` });
      }
      const parsed = await mdm.parse(repos, req.params.kind, bytes);
      if (b.apply !== true) return res.json(Object.assign({ applied: false }, parsed));
      const out = await mdm.apply(repos, req.ctx, parsed, { filename: b.filename || null, note: b.note || null });
      res.json(Object.assign({ applied: true }, parsed, { version: out.version.version, versionId: out.version.id }));
    } catch (e) { fail(res, e); }
  });

  // One row, typed in the screen. Same validation, same versioning as an import.
  r.post("/admin/masters/:kind/rows", async (req, res) => {
    try { res.status(201).json(await mdm.addRow(repos, req.ctx, req.params.kind, req.body || {})); }
    catch (e) { fail(res, e); }
  });

  r.patch("/admin/masters/:kind/rows/:id", async (req, res) => {
    try { res.json(await mdm.editRow(repos, req.ctx, req.params.kind, req.params.id, req.body || {})); }
    catch (e) { fail(res, e); }
  });

  // History. The team only thinks about the current list; these exist so a bad import is one
  // click to undo rather than an evening of retyping.
  r.get("/admin/masters/:kind/versions", async (req, res) => {
    try {
      const kind = req.params.kind;
      if (!MASTERS[kind]) return res.status(404).json({ error: `no master called ${kind}` });
      const rows = (await repos.masterVersions.all((v) => v.kind === kind)).sort((a, b) => b.version - a.version);
      // A version written before names were kept says who by the person's name all the same: a
      // mailbox is what the record holds, a name is what a screen says (P5).
      const users = await repos.users.all();
      const nameOf = (email) => { const u = users.find((x) => String(x.email).toLowerCase() === String(email || "").toLowerCase()); return u ? u.displayName : null; };
      res.json({
        kind,
        versions: rows.map((v) => ({
          id: v.id, version: v.version, at: v.at, byEmail: v.byEmail, byName: v.byName || nameOf(v.byEmail), actingAs: v.actingAs,
          rowCount: v.rowCount, source: v.source, filename: v.filename, note: v.note, summary: v.summary,
        })),
      });
    } catch (e) { fail(res, e); }
  });

  r.post("/admin/masters/:kind/versions/:id/restore", async (req, res) => {
    try { res.json(await mdm.restore(repos, req.ctx, req.params.kind, req.params.id)); }
    catch (e) { fail(res, e); }
  });

  return r;
};
