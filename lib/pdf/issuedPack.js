"use strict";
// The issued AFE: one PDF Fixed Assets can send back without opening a PDF editor.
//
// What it replaces, in Imogen's own description of the job (Meeting #5, 62:04): "we are through
// the text box, we are editing the PDF and that is taking a little bit of 4, 5 minutes. We are
// merging the approval of our supervisor. We are combining the PDF, that is again a manual
// task... then we are putting through red color the AFE number, AUC number." Every one of those
// steps is derivable from what the tool already holds, so none of them should be a person's
// afternoon.
//
// THE PACK IS THE SIGNED FILE, WITH FIXED ASSETS' MARKS ON IT (R156). That is exactly what the
// FA team produce by hand — they open the signed PDF, write in red, and append — and it is the
// only answer to "post FA finalization also, the document remains untampered (no different
// versions)" (Shashank, 2026-09-22). It used to be a fresh drawing of the form from the AFE as
// it stands now, with the tool's own simulation of the signatures on it and the attachments
// re-bound behind: a document nobody signed. So now:
//   1. the signed set, page for page — its own content untouched, the form and everything the
//      approvers were given, with the order number in the AFE NO box and the red band at the
//      top of page one drawn OVER it (`afeForm.markIssued`);
//   2. one index page saying where the signed part ends and what was added;
//   3. what Fixed Assets add behind it: the certificate, their evidence, and any document the
//      signed set does not already carry.
//
// MERGING IS STILL A CHOICE for what is added. Imogen wanted everything in one file; a 60-page
// facilities pack inside a signed form is not one file, it is a signed form nobody will scroll to
// the end of. What the approvers signed is not a choice: it is in, because it is the signed set.
const { PDFDocument } = require("pdf-lib");
const { markIssued, drawAddedIndex, drawIssueApproval, DOC_DATE } = require("./afeForm");
const { fileSize, istStamp, DOC_ROLE_LABEL } = require("./formModel");
const notify = require("../notify");

// The rules for what can go inside a PDF, and the code that puts it there, are `bindIn`'s —
// shared with the send package, which does the same job at the other end of the AFE's life
// (R112). Two copies of "can this be merged" would have drifted the first time one of them
// learned something, and the send package learned images on its first day.
const bindIn = require("./bindIn");
const { mergeability, MERGEABLE_BYTES, MERGEABLE_PAGES, MERGE_ORDER } = bindIn;

// Merging is OPT-OUT for the things that belong with a signed AFE and opt-in for everything
// else. The certificate is the evidence it was signed and the KO22 table the evidence it was
// issued; a supporting document the signed set does not carry (attached afterwards, or too
// big to bind at send) belongs with it too.
const MERGE_BY_DEFAULT = ["quote", "internal_quote", "material_evidence", "sow", "certificate", "budget_evidence"];

// The tool's own generations of the AFE. The newest signed set is the base; the others are the
// same document at an earlier moment, and none of them is ever bound into it.
const GENERATIONS = ["afe_form_pdf", "sent_packet", "envelope_pdf", "issued_pack"];

/** The signed set this AFE is issued on: the newest one, which is the round that completed. */
const signedSetOf = (afe) => (afe.documents || []).filter((d) => d.role === "envelope_pdf").pop() || null;

// How many pages a stored PDF has, remembered by attachment: stored bytes never change, so the
// answer never does. Bounded and in-process — a cache of a pure function, never a store.
const pageCache = new Map();
async function pagesOf(repos, doc) {
  if (!doc) return null;
  if (doc.pages) return doc.pages;
  if (pageCache.has(doc.attachmentId)) return pageCache.get(doc.attachmentId);
  let n = null;
  try {
    const bytes = await repos.attachmentStore.get(doc.attachmentId);
    if (bytes) n = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount();
  } catch (e) { n = null; }
  if (pageCache.size >= 500) pageCache.delete(pageCache.keys().next().value);
  pageCache.set(doc.attachmentId, n);
  return n;
}

/**
 * Which of the AFE's documents are already INSIDE the signed set.
 *
 * Recorded as `carries` on the signed set from 2026-09-23. Before that it is worked out, and the
 * two providers differ:
 *   · DocuSign's combined PDF is every document on the envelope, so it carries everything the
 *     approvers were given, whether it was bound into the packet or sent beside it;
 *   · the simulation's signed set was the FORM ALONE until R156 (2026-09-22) and the whole
 *     packet since. The packet is longer than the form whenever anything was bound in, so the
 *     page count settles which one a given file is — against the sent packet's recorded count
 *     where there is one, and the form's own where there is not.
 *
 * The builder and the Fixed Assets view BOTH ask this, and it opens the file to be exact. The
 * view used to assume the packet rather than open a PDF, and UAT held exactly the case that
 * breaks: a 5-page signed set from before the fix, sent as a 55-page packet, whose quotes the
 * send sheet called "inside it" while the builder — correctly — bound them in behind.
 */
async function carriedBy(repos, afe, envelope, signed) {
  if (!signed) return [];
  if (Array.isArray(signed.carries)) return signed.carries;
  if (envelope && envelope.provider && envelope.provider !== "simulated") {
    return envelope.supportingDocumentIds || envelope.boundDocumentIds || [];
  }
  const bound = (envelope && envelope.boundDocumentIds) || [];
  if (!bound.length) return [];
  const signedPages = await pagesOf(repos, signed);
  if (!signedPages) return bound;
  const latest = (role) => (afe.documents || []).filter((d) => d.role === role).pop() || null;
  const sent = latest("sent_packet");
  if (sent && sent.pages) return signedPages >= sent.pages ? bound : [];
  const formPages = await pagesOf(repos, latest("afe_form_pdf"));
  if (formPages) return signedPages > formPages ? bound : [];
  return bound;
}

const pagesText = (from, to) => (from === to ? `Page ${from}` : `Pages ${from}–${to}`);

/**
 * Fixed Assets' approval for issue, as the pack prints it (R168): the approver at the head of the
 * red note strip on page one, and a page of its own straight after the index — the digital form of
 * the supervisor's "Approved. Please proceed" e-mail that is bound in by hand today. The Fixed
 * Assets view asks this too, so the screen cannot describe an approval the builder would not print.
 *
 * @returns {null|{ byName, byEmail, group, at, note, when }}  `when` is India time, as printed
 */
function approvalOf(afe) {
  const ap = afe && afe.fa && afe.fa.issueApproval;
  if (!ap || !ap.byName) return null;
  return {
    byName: ap.byName, byEmail: ap.byEmail || null, group: ap.group || null, at: ap.at || null,
    note: ap.note || null, when: istStamp(ap.at).long || null,
  };
}

/**
 * Build the pack.
 *
 * @param {object}   repos
 * @param {object}   afe
 * @param {object}   routing     the frozen chain
 * @param {object}   issued      { ioNumber, aucNumber, plant, orderType, issuedAt, approvedBy, … }
 * @param {object}   [opts]      { merge: [attachmentId], exclude: [attachmentId] }
 * @returns {{bytes, pages, signedPages, carried, merged, listed, drawnId, filename}}
 */
async function buildIssuedPack(repos, afe, routing, issued, opts) {
  const o = opts || {};
  const signed = signedSetOf(afe);
  if (!signed) throw new Error("there is no signed AFE to issue");
  const signedBytes = await repos.attachmentStore.get(signed.attachmentId);
  if (!signedBytes) throw new Error("the signed AFE is no longer in the store");
  const base = await PDFDocument.load(signedBytes, { ignoreEncryption: true });
  const signedPages = base.getPageCount();
  const envelope = afe.envelopeId ? await repos.envelopes.get(afe.envelopeId) : null;
  const carried = new Set(await carriedBy(repos, afe, envelope, Object.assign({}, signed, { pages: signed.pages || signedPages })));

  // Opt-out (R93). `merge` names what to add when it is given; `exclude` takes something out of
  // the default set. Passing neither adds the certificate, the KO22 evidence and any supporting
  // document the signed set does not already carry.
  const excluded = new Set(o.exclude || []);
  const explicit = Array.isArray(o.merge) ? new Set(o.merge) : null;
  const wantedFor = (d) => (explicit ? explicit.has(d.attachmentId)
    : MERGE_BY_DEFAULT.includes(d.role) && !excluded.has(d.attachmentId));

  // Decide what can actually be added BEFORE building, so the index tells the truth about its
  // own document rather than describing an intention.
  const decisions = [];
  for (const d of afe.documents || []) {
    if (GENERATIONS.includes(d.role) || carried.has(d.attachmentId)) continue;
    const meta = await repos.attachmentsMeta.get(d.attachmentId);
    const asked = wantedFor(d);
    const m = mergeability(d, meta);
    decisions.push({ doc: d, meta, merge: asked && m.can, why: asked && !m.can ? m.why : null });
  }
  // The KO22 screenshot rides with the issued facts so it can be drawn beside the numbers it is
  // evidence for. The newest one wins: a budget reloaded is a table re-run. It is drawn, never
  // ALSO appended — drawn-and-bound is the same picture twice.
  const shot = decisions.slice().reverse().find((x) => x.doc.role === "budget_evidence" && x.meta
    && /^image\/(png|jpeg)$/.test(x.meta.mimeType || ""));
  const issuedWithEvidence = Object.assign({}, issued);
  const approval = approvalOf(afe);
  if (approval) issuedWithEvidence.approval = approval;
  if (shot) {
    const bytes = await repos.attachmentStore.get(shot.doc.attachmentId);
    if (bytes) {
      issuedWithEvidence.evidenceBytes = bytes;
      issuedWithEvidence.evidenceType = shot.meta.mimeType;
      shot.merge = false;
    }
  }

  // 1. The signed set, page for page, and the marks over page one.
  const out = await PDFDocument.create({ updateMetadata: false });
  const copied = await out.copyPages(base, base.getPageIndices());
  for (const p of copied) out.addPage(p);
  const marks = await markIssued(out, copied[0], afe, routing, issuedWithEvidence);
  const drawn = Boolean(shot && marks.evidence);
  if (shot) shot.drawn = drawn;

  // 2. The index, straight after the signed pages. Drawn once the page numbers are known.
  const indexPage = out.addPage([copied[0].getWidth(), copied[0].getHeight()]);
  const rows = [];
  const row = (d, where, extraProps) => {
    rows.push(Object.assign({ filename: d.filename, roleLabel: DOC_ROLE_LABEL[d.role] || d.role || "attachment",
      size: fileSize(d.sizeBytes), where }, extraProps || {}));
  };
  // 2b. The approval for issue, on a page of its own straight after the index (R168). It is
  // Fixed Assets' own record, so it comes before anything they add; an AFE issued with no
  // approval on it (the gate switched off) simply has no such page.
  let approvalPage = null;
  if (approval) {
    const page = out.addPage([copied[0].getWidth(), copied[0].getHeight()]);
    approvalPage = out.getPageCount();
    const events = repos.auditEvents ? await repos.auditEvents.all((e) => e.afeId === afe.id && e.type === "fa_approve_issue") : [];
    events.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const keyed = (afe.fa && afe.fa.steps && afe.fa.steps.KO01_IO) || null;
    await drawIssueApproval(out, page, {
      afeId: afe.id, title: (afe.project && afe.project.title) || "", ioNumber: issued.ioNumber,
      byName: approval.byName, group: approval.group, byEmail: approval.byEmail, at: approval.when, note: approval.note,
      orderBy: keyed && keyed.byName, orderAt: keyed && istStamp(keyed.doneAt).long,
      auditId: events.length ? events[events.length - 1].id : null,
    });
    rows.push({ filename: `Approval for issue — ${approval.byName}`, roleLabel: "Fixed Assets approval", size: "",
      where: pagesText(approvalPage, approvalPage) });
  }

  let evidencePage = null;
  if (drawn) {
    if (marks.evidence.onPageOne) row(shot.doc, "On page 1, top right", { red: true });
    else if (marks.addEvidencePage) {
      marks.addEvidencePage();
      evidencePage = out.getPageCount();
      row(shot.doc, pagesText(evidencePage, evidencePage));
    }
  }

  // 3. What is added behind it, by the shared code, in reading order.
  const items = [];
  for (const d of decisions.filter((x) => x.merge)) {
    items.push({
      attachmentId: d.doc.attachmentId, filename: d.doc.filename, role: d.doc.role,
      bytes: await repos.attachmentStore.get(d.doc.attachmentId),
      mimeType: (d.meta && d.meta.mimeType) || "application/pdf",
    });
  }
  let next = out.getPageCount() + 1;
  const bound = await bindIn.bindInto(out, items);
  for (const m of bound.merged) {
    const d = (afe.documents || []).find((x) => x.attachmentId === m.attachmentId) || m;
    row(d, `${pagesText(next, next + m.pages - 1)}${m.truncated ? ` (first ${m.pages})` : ""}`);
    next += m.pages;
  }

  // What is NOT going in is said too, with the reason, so the index is complete.
  const listed = decisions.filter((d) => !d.merge && !d.drawn).map((d) => ({
    attachmentId: d.doc.attachmentId, filename: d.doc.filename, role: d.doc.role,
    drawn: false, why: d.why || (d.doc.role === "budget_evidence" && d === shot ? "could not be drawn as an image" : "listed, not merged"),
  }));
  listed.push(...bound.listed);
  if (drawn) listed.push({ attachmentId: shot.doc.attachmentId, filename: shot.doc.filename, role: shot.doc.role, drawn: true, why: "drawn at the top of page 1" });
  for (const l of listed.filter((x) => !x.drawn)) {
    const d = (afe.documents || []).find((x) => x.attachmentId === l.attachmentId) || l;
    row(d, "In the AFE record", { record: true });
  }

  if (rows.length) {
    // The address of the AFE, for what could not be bound in. Only on the issued copy — the
    // signed pages carry no link, because their bytes are hashed.
    await drawAddedIndex(out, indexPage, rows, { signedPages, link: notify.link(`/afe/${afe.id}`) });
  } else {
    out.removePage(signedPages);
  }

  // Same determinism as the form: the same AFE issued the same way produces the same bytes, so
  // the pack can be re-made and compared rather than having to be kept for ever.
  out.setTitle(`AFE ${issued.ioNumber} — ${(afe.project && afe.project.title) || ""}`);
  out.setSubject(`Issued internal order ${issued.ioNumber} · cost centre ${afe.costCenter || ""}`);
  out.setProducer("AFE Workbench");
  out.setCreator("AFE Workbench");
  out.setCreationDate(DOC_DATE);
  out.setModificationDate(DOC_DATE);

  const bytes = Buffer.from(await out.save({ useObjectStreams: false }));
  return {
    bytes,
    pages: out.getPageCount(),
    // The signed part, and which of the AFE's documents are inside it — the base the marks were
    // drawn on, so a reader can be told which pages are the signed ones.
    signedPages,
    signedAttachmentId: signed.attachmentId,
    carried: Array.from(carried),
    merged: bound.merged,
    listed,
    drawnId: drawn ? shot.doc.attachmentId : null,
    // Where the screenshot went when it would not fit the box on page one: a page of its own,
    // after the index and the approval, never among the signed pages.
    evidencePage,
    // The page recording Fixed Assets' approval for issue (R168), straight after the index.
    approvalPage,
    // What Fixed Assets names the file when they send it by hand today: the order number and
    // the project, so it is findable in a mailbox a year later.
    filename: `${issued.ioNumber} ${(afe.project && afe.project.title) || "AFE"}.pdf`.replace(/[\\/:*?"<>|]/g, "-"),
  };
}

module.exports = {
  buildIssuedPack, signedSetOf, carriedBy, pagesOf, mergeability, approvalOf,
  MERGEABLE_BYTES, MERGEABLE_PAGES, MERGE_BY_DEFAULT, MERGE_ORDER, GENERATIONS,
};
