// Admin › Master data and Features — the two tabs that let the business change the tool
// without a deploy.
//
// Master data is edited in Excel because that is where the business already works: export a
// workbook that is already filled in, edit it, send it back, see exactly what will change, then
// apply. Nothing is applied sight-unseen, and every apply leaves a version so a bad import is
// one click to undo.
//
// Features are switches with consequences, so each one says what it does, what it still needs,
// and what happens instead while it is off — an administrator should never have to ask.
import { html, morph, on, $ } from "../../core/dom.js";
import { api, fileToBase64 } from "../../core/api.js";
import { store, uiFor } from "../../core/store.js";
import { icon } from "../../core/icons.js";
import { since, plural } from "../../core/format.js";
import { tag, emptyState } from "../../components/parts.js";
import { sheet, toast, showError, busy } from "../../core/ui.js";

const ui = uiFor("admin-masters");

// ---- master data -----------------------------------------------------------------------------

export function mastersTab(S) {
  const list = S.masters || [];
  const open = list.find((m) => m.kind === ui.master) || null;
  return html`
    <div class="card pad" data-key="mdm-intro">
      <div class="sect">HOW THIS WORKS</div>
      <div style="font-size: 12.5px; line-height: 1.6; margin-top: 8px; color: var(--ink-2);">
        Download a list, edit it in Excel, upload it back. The file you download is already
        filled in and is the same format the upload expects, so there is no template to keep.
        You will always be shown exactly what will change before anything is saved.
      </div>
    </div>
    <div class="cats" id="master-cats" style="margin-top: 14px;">${catsMarkup(list)}</div>
    <div id="master-body" style="margin-top: 6px;">${open ? masterBody(S, open)
      : html`<div class="muted" style="padding: 18px 4px; font-size: 12.5px;" data-key="mdm-pick">Pick a list to see what is in it, download it, or upload a new version.</div>`}</div>`;
}

function catsMarkup(list) {
  return html`${list.map((m) => html`<button class="cat ${ui.master === m.kind ? "on" : ""}" data-master="${m.kind}" data-key="${m.kind}" aria-pressed="${ui.master === m.kind ? "true" : "false"}">
    <span class="t">${m.label}</span><span class="b">${m.rowCount}</span>
    <span class="s">${m.systemOfRecord === "sap" ? "from SAP · read only"
      : m.systemOfRecord === "global_finance" ? (m.rowCount ? `from Global Finance · ${m.version ? since(m.lastChangedAt) : "loaded"}` : "from Global Finance · none yet")
      : m.version ? `v${m.version} · ${since(m.lastChangedAt)}` : "not changed yet"}</span>
  </button>`)}`;
}

function masterBody(S, m) {
  const rows = (S.masterRows && S.masterRows.kind === m.kind) ? S.masterRows.rows : null;
  const diff = ui.diff && ui.diff.kind === m.kind ? ui.diff : null;
  return html`<div class="card pad" data-key="body-${m.kind}">
    <div style="display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap;">
      <div style="min-width: 0; flex: 1;">
        <div style="font-size: 14px; font-weight: 700;">${m.label}</div>
        <div class="small muted" style="margin-top: 5px; line-height: 1.5;">${m.describe}</div>
      </div>
      <div style="display: flex; gap: 8px; flex: none;">
        <a class="pillbtn" href="/api/admin/masters/${m.kind}/export.xlsx" download>${icon("download", 14)} Download</a>
        ${m.systemOfRecord !== "sap" ? html`<label class="pillbtn" style="cursor: pointer;">${icon("upload", 14)} ${m.systemOfRecord === "global_finance" ? "Upload their workbook" : "Upload"}
          <input type="file" id="master-file" accept=".xlsx,.xlsm" style="display: none;"></label>` : ""}
        ${m.version ? html`<button type="button" class="pillbtn" id="master-versions">${m.version} ${plural(m.version, "version")}</button>` : ""}
      </div>
    </div>
    ${m.systemOfRecord === "sap" ? html`<div class="banner blue" style="margin-top: 14px;">${icon("info", 16)}
      <span>SAP is the system of record for this list. It changes when an extract arrives; uploading here is refused.</span></div>` : ""}
    ${m.systemOfRecord === "global_finance" ? html`<div class="banner blue" style="margin-top: 14px;">${icon("info", 16)}
      <span>Global Finance publishes these. Upload their monthly workbook as it arrives — the rows are not edited here.</span></div>` : ""}
    ${ui.reading ? html`<div class="banner blue" data-key="reading" style="margin-top: 14px;"><span class="spin"></span><span>Reading ${ui.reading} — you will see what it changes before anything is saved.</span></div>` : ""}
    ${diff ? diffMarkup(m, diff) : ""}
    ${rows ? rowsMarkup(m, rows) : html`<div class="small muted" style="margin-top: 14px;">Loading the rows…</div>`}
  </div>`;
}

/**
 * What an upload would do, before it does it. Added, changed with the fields that moved, and
 * the rows that are simply absent from the sheet — which are left alone, and said so, because
 * the commonest spreadsheet accident is sending back a filtered copy.
 */
function diffMarkup(m, d) {
  const s = d.summary;
  return html`<div class="card pad" data-key="diff" style="margin-top: 16px; background: var(--card-soft);">
    <div class="sect">${d.applied ? "APPLIED" : "WHAT THIS UPLOAD WOULD CHANGE"}</div>
    ${d.source && d.source.note ? html`<div class="small" style="margin-top: 8px; color: var(--ink-2);" data-key="source">${icon("info", 13)} ${d.source.note}</div>` : ""}
    <div class="chips" style="margin-top: 10px;">
      ${tag(`${s.added} added`, s.added ? "green" : "grey", { pad: true })}
      ${tag(`${s.changed} changed`, s.changed ? "blue" : "grey", { pad: true })}
      ${tag(s.deactivated ? `${s.deactivated} of them deactivated` : "0 deactivated", s.deactivated ? "yellow" : "grey", { pad: true })}
      ${tag(`${s.unchanged} unchanged`, "grey", { pad: true })}
      ${s.errors ? tag(`${s.errors} with problems`, "red", { pad: true }) : ""}
    </div>
    ${s.absent ? html`<div class="small muted" style="margin-top: 10px;">${s.absent} ${plural(s.absent, "row")} in the tool ${s.absent === 1 ? "is" : "are"} not in your sheet. They are left exactly as they are — to remove one, set its <b>active</b> column to N.</div>` : ""}
    ${d.unknownColumns && d.unknownColumns.length ? html`<div class="small muted" style="margin-top: 8px;">Columns the tool does not use, ignored: ${d.unknownColumns.join(", ")}.</div>` : ""}
    ${d.errors && d.errors.length ? html`<div style="margin-top: 12px;">
      ${d.errors.slice(0, 12).map((e) => html`<div class="field-msg block" data-key="e${e.line}">${icon("bang", 14)}<span><b>Row ${e.line}</b> — ${e.problems.join("; ")}</span></div>`)}
      ${d.errors.length > 12 ? html`<div class="small muted" style="margin-top: 6px;">…and ${d.errors.length - 12} more.</div>` : ""}
      <div class="small muted" style="margin-top: 8px;">Nothing is saved while any row has a problem. Fix them in the sheet and upload it again.</div>
    </div>` : ""}
    ${d.changed && d.changed.length ? html`<div style="margin-top: 12px;">
      <div class="sect">CHANGES</div>
      ${d.changed.slice(0, 10).map((c) => html`<div class="small" data-key="c${c.key}" style="margin-top: 6px;">
        <b>${c.key}</b> — ${c.fields.map((f) => `${f.field}: ${f.was || "(blank)"} → ${f.now || "(blank)"}`).join(" · ")}</div>`)}
      ${d.changed.length > 10 ? html`<div class="small muted" style="margin-top: 6px;">…and ${d.changed.length - 10} more.</div>` : ""}
    </div>` : ""}
    ${d.added && d.added.length ? html`<div style="margin-top: 12px;">
      <div class="sect">NEW</div>
      ${d.added.slice(0, 10).map((a) => html`<div class="small" data-key="a${a.key}" style="margin-top: 4px;">${a.key}</div>`)}
      ${d.added.length > 10 ? html`<div class="small muted" style="margin-top: 6px;">…and ${d.added.length - 10} more.</div>` : ""}
    </div>` : ""}
    ${!d.applied ? html`<div style="display: flex; gap: 10px; margin-top: 16px;">
      <button type="button" class="cta sm" id="master-apply" ${d.ok ? "" : "disabled"}>Apply ${d.summary.added + d.summary.changed} change${d.summary.added + d.summary.changed === 1 ? "" : "s"}</button>
      <button type="button" class="pillbtn" id="master-cancel">Cancel</button>
    </div>` : ""}
  </div>`;
}

function rowsMarkup(m, rows) {
  if (!rows.length) return emptyState(m.systemOfRecord === "sap" ? "This list is empty — it fills when the next SAP extract arrives."
    : m.systemOfRecord === "global_finance" ? "This list is empty — upload Global Finance's monthly workbook."
    : "This list is empty — download the sheet, fill it in and upload it.");
  // The key column identifies a row and is usually the longest; the rest share what is left.
  // Truncating the one column a person is looking for makes the table useless.
  const cols = m.columns.slice(0, 6);
  const grid = `${cols.map((c) => (c.name === m.key ? "minmax(0, 2.4fr)" : "minmax(0, 1fr)")).join(" ")} 96px`;
  const shown = rows.filter((r) => !ui.q || JSON.stringify(r).toLowerCase().includes(String(ui.q).toLowerCase()));
  return html`<div data-key="rows-${m.kind}" style="margin-top: 16px;">
    <div style="display: flex; gap: 10px; align-items: center;">
      <input class="input" id="master-q" type="search" aria-label="Search this list" value="${ui.q || ""}" placeholder="Search ${m.label.toLowerCase()}" style="max-width: 280px;">
      <span class="small muted">${shown.length === rows.length ? plural(rows.length, "row") : `${shown.length} of ${rows.length}`}</span>
    </div>
    <div class="list" style="margin-top: 10px;">
      <div class="prow hd" style="grid-template-columns: ${grid};">
        ${cols.map((c) => html`<span data-key="h-${c.name}">${c.name.replace(/_/g, " ").toUpperCase()}</span>`)}<span></span>
      </div>
      ${shown.slice(0, 200).map((r) => html`<div class="prow" data-key="${r._id}" style="grid-template-columns: ${grid}; ${r.active === "N" ? "opacity: .55;" : ""}">
        ${cols.map((c) => html`<span data-key="${c.name}" style="min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${r[c.name] || ""}</span>`)}
        <span>${m.systemOfRecord === "tool"
          ? html`<button type="button" class="linkbtn" data-toggle-active="${r._id}" data-now="${r.active || "Y"}">${r.active === "N" ? "Restore" : "Deactivate"}</button>`
          : ""}</span>
      </div>`)}
    </div>
    ${shown.length > 200 ? html`<div class="small muted" style="margin-top: 8px;">Showing the first 200. Download the sheet to see them all.</div>` : ""}
  </div>`;
}

// ---- features --------------------------------------------------------------------------------

export function featuresTab(S) {
  const f = S.features || { features: [], locked: [], note: "" };
  return html`
    <div class="card pad" data-key="feat-intro">
      <div class="sect">WHAT A SWITCH MEANS HERE</div>
      <div style="font-size: 12.5px; line-height: 1.6; margin-top: 8px; color: var(--ink-2);">${f.note}</div>
    </div>
    ${f.features.map((x) => html`<div class="card pad" data-key="${x.name}" style="margin-top: 12px;">
      <div style="display: flex; gap: 16px; align-items: flex-start;">
        <div style="min-width: 0; flex: 1;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 13.5px; font-weight: 700;">${x.label}</span>
            ${x.locked ? tag("locked off here", "red", { pad: true })
              : x.on ? tag("on", "green", { pad: true }) : tag("off", "grey", { pad: true })}
          </div>
          <div style="font-size: 12.5px; line-height: 1.6; margin-top: 8px; color: var(--ink-2);">${x.summary}</div>
          <div class="small muted" style="margin-top: 8px;"><b>While it is off:</b> ${x.fallback}</div>
          <div class="small muted" style="margin-top: 4px;"><b>Needs:</b> ${x.needs}</div>
          ${x.lastError ? html`<div class="small" style="margin-top: 6px; color: var(--red);" data-key="lasterr"><b>Last read failed</b> ${since(x.lastError.at)}: ${x.lastError.reason || x.lastError.code || "no reason given"}</div>` : ""}
          ${x.locked ? html`<div class="small" style="margin-top: 8px; color: var(--red); font-weight: 700;">This environment forbids it (FEATURES_LOCKED). It cannot be turned on here until that is changed.</div>` : ""}
          ${x.changedBy ? html`<div class="small muted" style="margin-top: 8px;">Last changed by ${x.changedByName || x.changedBy}, ${since(x.changedAt)}.</div>` : ""}
        </div>
        <button type="button" class="pillbtn" data-feature="${x.name}" data-on="${x.on ? "1" : ""}" ${x.locked ? "disabled" : ""} style="flex: none;">
          ${x.on ? "Turn off" : "Turn on"}
        </button>
      </div>
    </div>`)}`;
}

// ---- wiring ----------------------------------------------------------------------------------

/** Everything both tabs need. Called by the Admin screen's own `load`. */
export async function loadMasters(S) {
  const [m, f] = await Promise.all([
    api.get("/api/admin/masters").catch(() => ({ masters: [] })),
    api.get("/api/admin/features").catch(() => ({ features: [], locked: [], note: "" })),
  ]);
  S.masters = m.masters;
  S.features = f;
  // The tab opens on the tiles, not on 150 locations. A landing state that dumps a list is the
  // thing design rule 1 forbids, and here it also fetches a list nobody asked to see.
  if (ui.master) S.masterRows = await api.get(`/api/admin/masters/${ui.master}/rows`).catch(() => null);
}

export function wireMasters(root, S, paint, reload) {
  on(root, "click", "[data-master]", async (e, b) => {
    // Tapping the open one closes it (design rule 4).
    const same = ui.master === b.dataset.master;
    ui.master = same ? null : b.dataset.master;
    ui.diff = null; ui.q = "";
    S.masterRows = null; paint();
    if (!ui.master) return;
    S.masterRows = await api.get(`/api/admin/masters/${ui.master}/rows`).catch(() => null);
    paint();
  });

  on(root, "input", "#master-q", (e, el) => { ui.q = el.value; morph($("#master-body", root), masterBody(S, S.masters.find((m) => m.kind === ui.master))); });

  on(root, "change", "#master-file", async (e, el) => {
    const file = el.files && el.files[0];
    if (!file) return;
    ui.reading = file.name;
    paint();
    try {
      const contentBase64 = await fileToBase64(file);
      const d = await api.post(`/api/admin/masters/${ui.master}/import`, { contentBase64, filename: file.name });
      ui.diff = Object.assign({ kind: ui.master, filename: file.name, contentBase64 }, d);
    } catch (err) { showError(err); } finally { ui.reading = null; el.value = ""; paint(); }
  });

  on(root, "click", "#master-cancel", () => { ui.diff = null; paint(); });

  on(root, "click", "#master-apply", async (e, b) => {
    const d = ui.diff;
    if (!d || !d.ok) return;
    const done = busy(b, "Applying…");
    try {
      const out = await api.post(`/api/admin/masters/${d.kind}/import`,
        { contentBase64: d.contentBase64, filename: d.filename, apply: true });
      ui.diff = Object.assign({}, out, { kind: d.kind, applied: true });
      toast(`${out.summary.added + out.summary.changed} change${out.summary.added + out.summary.changed === 1 ? "" : "s"} saved as version ${out.version}.`, "ok");
      store.bust("/api");
      await reload();
      paint();
    } catch (err) { showError(err); } finally { done(); }
  });

  on(root, "click", "[data-toggle-active]", async (e, b) => {
    const next = b.dataset.now === "N" ? "Y" : "N";
    try {
      await api.patch(`/api/admin/masters/${ui.master}/rows/${b.dataset.toggleActive}`, { active: next });
      toast(next === "N" ? "Deactivated — it stops being offered, and the AFEs that used it still work." : "Back in use.", "ok");
      store.bust("/api");
      await reload(); paint();
    } catch (err) { showError(err); }
  });

  on(root, "click", "#master-versions", async () => {
    const kind = ui.master;
    const m = S.masters.find((x) => x.kind === kind);
    let out;
    try { out = await api.get(`/api/admin/masters/${kind}/versions`); }
    catch (err) { showError(err); return; }
    // A version is a LIST, and putting one back rewrites the live one — so a row is something to
    // read, and Restore is a button on it behind a confirmation of what will change. One click on
    // the row used to restore it, with the sheet left open on a stale list.
    const chosen = await sheet({
      eyebrow: "VERSIONS",
      title: m.label,
      sub: "Every change leaves one of these behind. Restoring puts the list back as it was — as a new version, so the history is never rewritten.",
      body: html`<div style="margin-top: 12px; display: flex; flex-direction: column; gap: 6px;">
        ${out.versions.map((v, i) => html`<div class="row" data-key="${v.id}" style="display: flex; gap: 12px; align-items: center; padding: 9px 4px;">
          <b style="min-width: 40px;">v${v.version}</b>
          <span style="min-width: 0; flex: 1;">
            <span style="display: block; font-size: 12.5px;">${v.rowCount} rows · ${v.source}${v.filename ? ` · ${v.filename}` : ""}</span>
            <span class="small muted" style="display: block;">${v.byName || v.byEmail} · ${since(v.at)}${v.note ? ` · ${v.note}` : ""}</span>
          </span>
          ${i === 0 ? html`<span class="small muted">in use</span>` : html`<button type="button" class="pillbtn sm soft" data-act="restore:${v.id}">Restore</button>`}
        </div>`)}
      </div>`,
      actions: [{ label: "Close", value: null, tone: "sec" }],
    });
    const pick = chosen && typeof chosen.value === "string" && chosen.value.startsWith("restore:") ? chosen.value.slice(8) : null;
    const v = pick && out.versions.find((x) => x.id === pick);
    if (!v) return;
    const current = out.versions[0];
    const sure = await sheet({
      eyebrow: "RESTORE", title: `Put ${m.label} back to version ${v.version}?`,
      sub: `${v.rowCount} rows as ${v.byName || v.byEmail} left it ${since(v.at)}${current ? `, in place of the ${current.rowCount} in use now` : ""}. It is saved as a new version — nothing is deleted, and this can be undone the same way.`,
      actions: [{ label: "Cancel", value: null, tone: "sec" }, { label: `Restore version ${v.version}`, value: "ok", tone: "dark", primary: true }],
    });
    if (sure.value !== "ok") return;
    try {
      const r = await api.post(`/api/admin/masters/${kind}/versions/${v.id}/restore`);
      toast(`Restored from version ${r.restoredFrom} — saved as version ${r.version.version}.`, "ok");
      store.bust("/api");
      await reload(); paint();
    } catch (err) { showError(err); }
  });

  on(root, "click", "[data-feature]", async (e, b) => {
    const name = b.dataset.feature;
    const turningOn = !b.dataset.on;
    const x = (S.features.features || []).find((f) => f.name === name);
    if (turningOn) {
      const ok = await sheet({
        eyebrow: "TURN ON",
        title: x.label,
        sub: x.summary,
        body: html`<div class="banner yellow" style="margin-top: 14px; align-items: flex-start;">${icon("bang", 16)}
          <span>This needs ${x.needs} Anything it produces is a proposal a person confirms — it never decides on its own, and turning this back off is always safe.</span></div>`,
        actions: [{ label: "Not yet", value: null, tone: "sec" }, { label: "Turn it on", value: "on", tone: "cta", primary: true }],
      });
      // `sheet()` resolves to `{ value, data }` whatever was pressed — "Not yet", Esc and a click
      // outside included — so testing the object itself turned the feature ON every time.
      if (!ok || ok.value !== "on") return;
    }
    try {
      const out = await api.put(`/api/admin/features/${name}`, { on: turningOn });
      S.features = { features: out.features, locked: S.features.locked, note: S.features.note };
      toast(`${x.label} is ${turningOn ? "on" : "off"}.`, "ok");
      paint();
    } catch (err) { showError(err); }
  });
}
