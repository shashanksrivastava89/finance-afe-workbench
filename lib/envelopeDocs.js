"use strict";
// The documents that ride on an envelope: the generated AFE Form on the way out, and the
// signed set plus certificate on the way back.
//
// Kept out of the state machine because both the in-tool completion and the DocuSign poll
// job need the same closing steps, and because "what was signed" is evidence — it deserves
// one place that stores it, hashes it and verifies it.
const crypto = require("crypto");
const { PDFDocument } = require("pdf-lib");
const attachments = require("./attachments");
const audit = require("./audit");
const { renderAfeForm, DOC_DATE } = require("./pdf/afeForm");
const bindIn = require("./pdf/bindIn");
const { FORM_LAYOUT_VERSION, ATTACHMENT_LIMITS } = require("./domain/refData");
const { renderCertificate } = require("./pdf/certificate");
const envelopeVerify = require("./domain/envelopeVerify");
const docusign = require("./integrations/docusign");

const slug = (s) => String(s || "AFE").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60) || "AFE";

// The AFE's own output. These are things the tool produced ABOUT the AFE and are never bound
// into the document being sent for signature: the form is the document, and the signed set and
// the certificate do not exist yet.
const OWN_OUTPUT = ["afe_form_pdf", "sent_packet", "envelope_pdf", "certificate", "issued_pack"];

/**
 * Render the Filled AFE Form, bind the supporting documents into it, store it, and gather
 * everything the envelope carries.
 *
 * ONE DOCUMENT (R112). "Approvers see one single PDF — not supporting docs etc. They sign the
 * one PDF, they can't look at multiple attachments... that's how one AFE becomes a 60 pager or
 * more" (Shashank, 2026-09-21). The quote, the SOW, the facility plan and anything else the
 * requester attached are appended behind the form, in reading order, exactly as the BriCare AFE
 * has them. They used to ride as envelope documents 2, 3, 4 — which an approver signing on a
 * phone never opens, and "I approved it" then means less than everyone downstream assumes.
 *
 * Two hashes come back, and they answer different questions.
 *   · `formHash` is over the FORM'S OWN BYTES, exactly as before, so `verifyFormHash` still
 *     re-renders the form and compares — "did anyone edit the AFE after it was signed?"
 *   · `packetHash` is over the whole document that was sent — "is this the file they signed?"
 * Folding the two together would have meant a tamper check that fails whenever an attachment is
 * added, which is a different and much less interesting question.
 *
 * @returns {{documents, formHash, packetHash, formAttachmentId, packetAttachmentId, anchors, pages, bound, listed}}
 */
/**
 * Assemble the file the approvers will be given: the form, then everything attached bound in
 * behind it. Stores NOTHING — `buildSendPackage` stores what this returns, and the preview
 * route serves it straight out. One assembler, so the PDF somebody looks at on the review
 * screen cannot be a different document from the one that is sent.
 *
 * @returns {{formBytes, formHash, anchors, formPages, packetBytes, packetHash, packetPages,
 *            bound, listed, boundIds}}
 */
async function assemblePacket(repos, afe, routing, opts) {
  const o = opts || {};
  // What could go inside, decided from the metadata: a type we can place on a page, and small
  // enough that what a person was allowed to upload they are allowed to bind in.
  const supporting = (afe.documents || []).filter((d) => !OWN_OUTPUT.includes(d.role));
  const items = [];
  const cannot = [];
  for (const d of supporting) {
    const can = bindIn.mergeability(d, d);
    if (!can.can) { cannot.push({ doc: d, why: can.why }); continue; }
    const bytes = await attachments.bytesOf(repos, d.attachmentId);
    if (!bytes) { cannot.push({ doc: d, why: "the file is no longer in the store" }); continue; }
    items.push({ attachmentId: d.attachmentId, filename: d.filename, role: d.role, bytes, mimeType: d.mimeType });
  }

  // Bind once into a throwaway to learn the outcome, because the FORM has to print it: the
  // Documents page says "Bound into this PDF" beside each file, and it can only say that about
  // files that actually went in. A PDF that will not open is only discovered by opening it. The
  // second pass takes the same inputs, so it cannot reach a different answer.
  const dry = await PDFDocument.create({ updateMetadata: false });
  const outcome = await bindIn.bindInto(dry, items, {
    maxTotalBytes: ATTACHMENT_LIMITS.docusignPerDocumentBytes, baseBytes: 0,
  });
  const boundIds = outcome.merged.map((m) => m.attachmentId);

  const rendered = await renderAfeForm(afe, routing, {
    documentsMerged: boundIds, validation: o.validation || null, stamped: Boolean(o.stamped),
  });

  const out = await PDFDocument.create({ updateMetadata: false });
  const cover = await PDFDocument.load(rendered.bytes);
  for (const p of await out.copyPages(cover, cover.getPageIndices())) out.addPage(p);
  const bound = await bindIn.bindInto(out, items.filter((it) => boundIds.includes(it.attachmentId)), {
    maxTotalBytes: ATTACHMENT_LIMITS.docusignPerDocumentBytes, baseBytes: rendered.bytes.length,
  });
  // Same determinism as the form: the same AFE sent the same way produces the same bytes.
  out.setTitle(`AFE — ${(afe.project && afe.project.title) || afe.id}`);
  out.setProducer("AFE Workbench");
  out.setCreator("AFE Workbench");
  out.setCreationDate(DOC_DATE);
  out.setModificationDate(DOC_DATE);
  const packetBytes = Buffer.from(await out.save({ useObjectStreams: false }));

  return {
    formBytes: rendered.bytes, formHash: rendered.formHash, anchors: rendered.anchors,
    formPages: rendered.pages, packetBytes, packetPages: out.getPageCount(),
    packetHash: crypto.createHash("sha256").update(packetBytes).digest("hex"),
    bound: bound.merged, boundIds,
    listed: outcome.listed.concat(bound.listed).concat(cannot.map((c) => ({
      attachmentId: c.doc.attachmentId, filename: c.doc.filename, role: c.doc.role, why: c.why }))),
  };
}

async function buildSendPackage(repos, ctx, afe, routing) {
  const by = ctx && ctx.user ? ctx.user.email : "system";
  const name = slug((afe.project && afe.project.title) || afe.id);
  const round = routing.round || 1;

  const built = await assemblePacket(repos, afe, routing);
  const { packetBytes, packetHash, bound, boundIds } = built;
  const rendered = { bytes: built.formBytes, formHash: built.formHash, anchors: built.anchors, pages: built.formPages };
  const supporting = (afe.documents || []).filter((d) => !OWN_OUTPUT.includes(d.role));
  const outcome = { listed: built.listed };

  const formMeta = await attachments.put(repos, {
    afeId: afe.id, filename: `AFE_${name}_R${round}.pdf`, role: "afe_form_pdf",
    bytes: rendered.bytes, byEmail: by,
  });
  const packetMeta = await attachments.put(repos, {
    afeId: afe.id, filename: `AFE_${name}_R${round}_for_signature.pdf`, role: "sent_packet",
    bytes: packetBytes, byEmail: by,
  });

  const documents = [{
    attachmentId: packetMeta.id, filename: packetMeta.filename, role: "sent_packet",
    sha256: packetMeta.sha256, bytes: packetBytes,
  }];
  // Anything that could NOT go inside still goes out — as its own document, named, rather than
  // quietly left behind. A reader always meets the whole set.
  const listed = outcome.listed;
  const seen = new Set();
  for (const l of listed) {
    if (seen.has(l.attachmentId)) continue;
    seen.add(l.attachmentId);
    const bytes = await attachments.bytesOf(repos, l.attachmentId);
    if (!bytes) continue;
    const doc = supporting.find((d) => d.attachmentId === l.attachmentId);
    documents.push({ attachmentId: l.attachmentId, filename: l.filename, role: l.role,
      sha256: doc ? doc.sha256 : null, bytes });
  }

  // The layout the hash was taken under travels with it (R102). Without it a later build has
  // no way to tell "somebody edited this" from "we changed the form".
  return { documents, formHash: rendered.formHash, packetHash, formLayoutVersion: FORM_LAYOUT_VERSION,
    formAttachmentId: formMeta.id, formFilename: formMeta.filename, formBytes: rendered.bytes,
    packetAttachmentId: packetMeta.id, packetPages: built.packetPages,
    anchors: rendered.anchors, pages: rendered.pages,
    bound, listed: Array.from(seen).map((id) => listed.find((l) => l.attachmentId === id)) };
}

/**
 * Close an envelope out: store the signed set and the certificate, check the people who
 * signed against the chain that was frozen at send, and record the answer on the envelope.
 * Runs for both providers — the simulation generates its documents, DocuSign supplies them.
 */
async function completeEnvelope(repos, ctx, afe, routing, envelope) {
  const title = slug((afe.project && afe.project.title) || afe.id);
  let combinedBytes = null;
  let certificateBytes = null;
  // WHICH of the AFE's documents are inside the signed set, recorded on it (R156). The issued AFE
  // is built ON this file, so it has to know what it already carries rather than bind a quote in
  // a second time — or leave out one it was assumed to carry.
  let carries = [];

  if (docusign.isSimulated(envelope)) {
    // The signed set is the PACKET with the signatures on it, not the form on its own (R156).
    //
    // It was `renderAfeForm({ stamped: true })` — the form alone — so on the simulated path,
    // which is every AFE until there is an integration key, the attachments that were bound in
    // at send DISAPPEARED at the moment of signing. Fixed Assets then did its judgment on a
    // document with no vendor quote in it, and the same AFE had a sent packet that carried the
    // quote and a "signed set" that did not. DocuSign's own combined PDF on the live path is
    // the whole envelope document, signatures included; the simulation has to mean the same
    // thing or the two providers produce different evidence from the same AFE.
    //
    // `assemblePacket` binds from the same inputs and is deterministic, so it reproduces the
    // send's own decision; we assert that below rather than assume it.
    const built = await assemblePacket(repos, afe, routing, { stamped: true });
    combinedBytes = built.packetBytes;
    carries = built.boundIds.slice();
    const frozen = (envelope.boundDocumentIds || []).slice().sort().join(",");
    const now = built.boundIds.slice().sort().join(",");
    if (frozen && frozen !== now) {
      throw new Error(`the signed set would bind ${now || "nothing"} but the envelope was sent with ${frozen}`);
    }
    certificateBytes = (await renderCertificate(afe, routing, envelope)).bytes;
  } else {
    const fetched = await docusign.fetchCompletedDocuments(envelope);
    combinedBytes = fetched.combined;
    certificateBytes = fetched.certificate;
    // DocuSign's combined PDF is every document on the envelope: the packet, and anything that
    // could not be bound into it and was sent beside it.
    carries = (envelope.supportingDocumentIds || envelope.boundDocumentIds || []).slice();
  }
  let pages = null;
  try { pages = (await PDFDocument.load(combinedBytes, { ignoreEncryption: true })).getPageCount(); } catch (e) { pages = null; }

  const combined = await attachments.put(repos, {
    afeId: afe.id, filename: `AFE_${title}_signed.pdf`, role: "envelope_pdf", bytes: combinedBytes,
    byEmail: ctx && ctx.user ? ctx.user.email : "system",
  });
  const certificate = await attachments.put(repos, {
    afeId: afe.id, filename: `AFE_${title}_certificate.pdf`, role: "certificate", bytes: certificateBytes,
    byEmail: ctx && ctx.user ? ctx.user.email : "system",
  });

  const verification = envelopeVerify.verifyRecipients(routing, envelope);
  envelope.completed = {
    combinedPdfAttachmentId: combined.id,
    certificateAttachmentId: certificate.id,
    combinedSha256: combined.sha256,
    certificateSha256: certificate.sha256,
    verification,
    verifiedAt: new Date().toISOString(),
  };

  // The signed set and its certificate belong on the AFE, where Fixed Assets opens them.
  afe.documents = (afe.documents || []).concat([
    { attachmentId: combined.id, role: "envelope_pdf", filename: combined.filename, sizeBytes: combined.sizeBytes, sha256: combined.sha256, generated: true, pages, carries },
    { attachmentId: certificate.id, role: "certificate", filename: certificate.filename, sizeBytes: certificate.sizeBytes, sha256: certificate.sha256, generated: true },
  ]);

  const problems = verification.filter((v) => v.st !== "ok");
  await audit.record(repos, ctx, {
    entity: "envelope", entityId: envelope.id, afeId: afe.id, type: "envelope_completed",
    payload: { provider: envelope.provider, envelopeId: envelope.envelopeId, formHash: envelope.formHash,
      combinedPdfAttachmentId: combined.id, certificateAttachmentId: certificate.id,
      verified: problems.length === 0, problems },
  });
  return envelope.completed;
}

/**
 * The answer to "does this still hash to what was signed" for one state of one AFE.
 *
 * Re-rendering the whole PDF is the only honest way to answer it, and it is not cheap — but the
 * answer cannot change unless what the form READS changes. So the answer is remembered against
 * that. Every FA queue row and every load of the judge and issue screens used to pay for a full
 * render; now the first one does (R92).
 *
 * The key was the AFE's version and `updatedAt`, which move on every write — so every judgment
 * tick, the order type, "form reviewed", a comment, a chosen issue approver, none of which the
 * form prints, missed the cache and re-rendered the whole form inside the request: ~65 ms here and
 * about a second on UAT's B1 (`/judgment` at p50 914 ms, the judge view at p95 2.3 s), while the
 * PDF frame beside it waited for the same CPU. That is the judge screen that "loads only on tile
 * click" (2026-09-28). The key is now the AFE as the renderer reads it, hashed with the WHOLE
 * routing, the envelope's hash, the documents it bound in and the layout. Left out are only fields
 * the render cannot reach: Fixed Assets' own record (`fa`, read solely for the ISSUED copy, which
 * this never renders), the conversation, the AFE number (masked below) and the bookkeeping. Any
 * field in doubt stays in, so the worst a key can do is miss — never answer for a form it did not
 * render.
 *
 * Bounded and in-process: it is a cache of a pure function, never a store.
 */
const verifyCache = new Map();
const VERIFY_CACHE_MAX = 300;
const NOT_PRINTED = ["fa", "thread", "afeNo", "updatedAt", "version"];

function verifyKey(afe, routing, envelope) {
  const printed = Object.assign({}, afe);
  for (const k of NOT_PRINTED) delete printed[k];
  return crypto.createHash("sha256").update(JSON.stringify([
    printed, routing || null, envelope.formHash, envelope.boundDocumentIds || [], FORM_LAYOUT_VERSION,
  ])).digest("hex");
}

/**
 * Re-render the form and compare it with the hash frozen at send: "what they signed is what
 * we hold". Used by the Fixed Assets screen in Stage 5 and by the smoke suite here.
 */
async function verifyFormHash(afe, routing, envelope) {
  if (!envelope || !envelope.formHash) return { checked: false, ok: null, reason: "no form hash was recorded for this envelope" };
  // The layout first, and only then the hash (R102). An envelope with no version on it was
  // sent before versions existed, which is layout 1.
  const signedUnder = envelope.formLayoutVersion || 1;
  if (signedUnder !== FORM_LAYOUT_VERSION) {
    return {
      checked: false, ok: null, layoutChanged: true,
      signedUnder, now: FORM_LAYOUT_VERSION,
      reason: `signed under form layout v${signedUnder}; this build prints v${FORM_LAYOUT_VERSION}, `
        + "so the two cannot be compared byte for byte. The signed copy is stored unchanged.",
    };
  }
  const key = verifyKey(afe, routing, envelope);
  if (verifyCache.has(key)) return verifyCache.get(key);
  // The AFE number is blank on every form that is signed — SAP assigns it at KO01, after
  // approval, and Fixed Assets writes it back. It is masked here so that write-back is never
  // mistaken for an edit to what was signed.
  const asSigned = Object.assign({}, afe, { afeNo: null });
  // ...and re-render with the SAME merge decision the envelope froze, or the Documents page says
  // "Attached to this AFE" where the signed one said "Bound into this PDF" and every AFE fails a
  // tamper check nobody tampered with.
  const again = await renderAfeForm(asSigned, routing, { documentsMerged: envelope.boundDocumentIds || [] });
  const out = { checked: true, ok: again.formHash === envelope.formHash, expected: envelope.formHash, actual: again.formHash };
  if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.delete(verifyCache.keys().next().value);
  verifyCache.set(key, out);
  return out;
}

/**
 * Which stored file is THE document for this AFE right now (R156), or null when it has to be
 * assembled because the round it belongs to has not gone out yet. `GET /afes/:id/document.pdf`
 * serves it, and the boot warm-up reads its bytes ahead of the first person to open it.
 *
 * An issued pack supersedes everything. Otherwise the document is the one from the round that
 * still covers the AFE: the signed set once that round is complete, the packet that was sent
 * while it is in flight. Before anything has gone out, and on a returned AFE that will go round
 * again, it is the packet a send would build now.
 *
 * It used to take the latest file of each kind, which is wrong twice over on an AFE that has
 * had more than one round: a returned AFE about to go out as round two served round one's
 * packet on the very screen that says "as it will be sent", and round two in flight served
 * round one's SIGNED set, because a completed round's signed set is never taken off the AFE.
 * A returned AFE that goes back into its own round (R148) keeps that round's file, because that
 * is what the next signer will sign.
 */
function storedDocument(afe, envelope, resumeCheck) {
  const docs = afe.documents || [];
  const byId = (id) => (id ? docs.find((d) => d.attachmentId === id) || null : null);
  const latest = (role) => docs.filter((d) => d.role === role).pop() || null;
  const pack = latest("issued_pack");
  if (pack) return pack;
  if (!envelope || ["draft", "submitted"].includes(afe.state)) return null;
  const signedSet = byId(envelope.completed && envelope.completed.combinedPdfAttachmentId);
  const sentPacket = byId(((envelope.documents || []).find((d) => d.role === "sent_packet") || {}).attachmentId) || latest("sent_packet");
  if (afe.state === "returned") {
    if (!(resumeCheck && resumeCheck.applies && resumeCheck.can)) return null;
    return resumeCheck.mode === "signed" ? signedSet || latest("envelope_pdf") : sentPacket;
  }
  return envelope.status === "completed" ? signedSet || latest("envelope_pdf") : sentPacket;
}

module.exports = { assemblePacket, buildSendPackage, completeEnvelope, verifyFormHash, storedDocument, OWN_OUTPUT };
