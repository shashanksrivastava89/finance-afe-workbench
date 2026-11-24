"use strict";
// Binding the supporting documents INTO one PDF.
//
// "Approvers see one single PDF — not supporting docs etc. They sign the one PDF, they can't look
// at multiple attachments... just like you saw all the SOWs appended in the BriCare AFE.
// Similarly quotes and additional docs are appended (facility plans or any other supporting
// docs) — that's how one AFE becomes a 60 pager or more." (Shashank, 2026-09-21)
//
// That is how the paper process works and it is not a preference: an approver signs ONE document
// in DocuSign, on a phone, in a hurry. A quote that arrives as envelope document 2 is a quote
// most of them will never open, and "I signed it" then means less than everyone assumes.
//
// The logic lived inside `issuedPack.js`, which built the pack Fixed Assets send back AFTER
// signing. It is the same job at both ends of the AFE's life, so it lives here now and both
// callers use it: the send package (`envelopeDocs`) and the issued pack.
//
// Two things this deliberately does NOT do.
//   · It never silently drops anything. A file that cannot be bound in — not a PDF or an image,
//     too big, encrypted, corrupt — comes back in `listed` with the reason, and the caller sends
//     it as its own document rather than losing it. A reader always knows the whole set.
//   · It never re-encodes a page. Pages are copied, so a 27-page quote is the same 27 pages, at
//     the same resolution, that the vendor sent. Pasting a screenshot into a form is how the
//     Banjo AFE ended up with an image cut off at the margin.
const { PDFDocument } = require("pdf-lib");

// What a person was allowed to attach, they are allowed to bind in: these are the upload limits.
// 60 pages is Imogen's own worst case — "I have received a PDF over mail with 60 or 65 pages".
const MERGEABLE_BYTES = 25 * 1024 * 1024;
const MERGEABLE_PAGES = 60;

// An image is a page. Facility plans, floor layouts and marked-up photographs arrive as PNG or
// JPEG, and the alternative to placing one on a page of its own is asking the approver to open
// it somewhere else — which is the thing this whole change exists to stop.
const IMAGE_TYPES = ["image/png", "image/jpeg"];
const A4 = [595.28, 841.89];
const IMAGE_MARGIN = 28;

/**
 * Can this attachment go inside the document, and if not, why not?
 * The reason is shown to a person, so it says what is wrong rather than that something is.
 */
function mergeability(doc, meta) {
  if (!meta) return { can: false, why: "the file is no longer in the store" };
  const type = meta.mimeType || "";
  if (type !== "application/pdf" && !IMAGE_TYPES.includes(type)) {
    return { can: false, why: `${type || "an unknown type"} — only PDFs and images can be bound in` };
  }
  if ((meta.sizeBytes || 0) > MERGEABLE_BYTES) {
    return { can: false, why: `${(meta.sizeBytes / 1048576).toFixed(1)} MB — too large to bind in` };
  }
  return { can: true };
}

/**
 * The order a bound document reads in, so it is filed the way a person would file it: what was
 * signed, then the proof of it, then what the approvers were looking at, then the rest.
 */
const MERGE_ORDER = ["certificate", "quote", "internal_quote", "material_evidence", "sow", "budget_evidence", "email_approval", "backup"];
const mergeRank = (role) => { const i = MERGE_ORDER.indexOf(role); return i < 0 ? MERGE_ORDER.length : i; };

/** One image, centred on its own A4 page at its own aspect ratio. Never stretched. */
async function addImagePage(out, bytes, mimeType) {
  const img = mimeType === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
  const page = out.addPage(A4);
  const maxW = A4[0] - IMAGE_MARGIN * 2;
  const maxH = A4[1] - IMAGE_MARGIN * 2;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * scale;
  const h = img.height * scale;
  page.drawImage(img, { x: (A4[0] - w) / 2, y: (A4[1] - h) / 2, width: w, height: h });
  return 1;
}

/**
 * Append `items` to `out`, in reading order.
 *
 * @param {PDFDocument} out      the document being built — the form is already in it
 * @param {Array} items         [{ attachmentId, filename, role, bytes, mimeType }]
 * @param {object} [opts]       { maxTotalBytes } — stop binding in before the document gets too
 *                              big for the channel that has to carry it (DocuSign refuses a
 *                              single document over 25 MB), leaving the rest to be sent beside it
 * @returns {{merged, listed}}
 */
async function bindInto(out, items, opts) {
  const o = opts || {};
  const merged = [];
  const listed = [];
  const sorted = items.slice().sort((a, b) => mergeRank(a.role) - mergeRank(b.role));
  // A running total rather than a final check: the caller needs to know WHICH document did not
  // fit, not that the result was too big after everything had already been copied in.
  let soFar = o.baseBytes || 0;
  for (const it of sorted) {
    const note = (why) => listed.push({ attachmentId: it.attachmentId, filename: it.filename, role: it.role, why });
    if (!it.bytes) { note("the file is no longer in the store"); continue; }
    if (o.maxTotalBytes && soFar + it.bytes.length > o.maxTotalBytes) {
      note(`sent as its own document — binding it in would take the file past ${(o.maxTotalBytes / 1048576).toFixed(0)} MB`);
      continue;
    }
    try {
      let pages;
      if (IMAGE_TYPES.includes(it.mimeType)) {
        pages = await addImagePage(out, it.bytes, it.mimeType);
      } else {
        const src = await PDFDocument.load(it.bytes, { ignoreEncryption: true });
        const idx = src.getPageIndices().slice(0, MERGEABLE_PAGES);
        for (const p of await out.copyPages(src, idx)) out.addPage(p);
        pages = idx.length;
        if (src.getPageCount() > idx.length) {
          merged.push({ attachmentId: it.attachmentId, filename: it.filename, role: it.role,
            pages, truncated: src.getPageCount() - idx.length });
          soFar += it.bytes.length;
          continue;
        }
      }
      merged.push({ attachmentId: it.attachmentId, filename: it.filename, role: it.role, pages, truncated: 0 });
      soFar += it.bytes.length;
    } catch (e) {
      // A file pdf-lib cannot open is LISTED, never dropped: the reader has to be able to tell
      // "not included" from "not mentioned".
      note(`could not be read (${String(e.message).slice(0, 60)})`);
    }
  }
  return { merged, listed };
}

module.exports = {
  bindInto, mergeability, addImagePage,
  MERGEABLE_BYTES, MERGEABLE_PAGES, MERGE_ORDER, IMAGE_TYPES,
};
