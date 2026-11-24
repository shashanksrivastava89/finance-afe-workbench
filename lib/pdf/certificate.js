"use strict";
// A Certificate of Completion for a SIMULATED envelope.
//
// A live envelope's certificate comes from DocuSign and is stored as it arrives — this is
// only for the stand-in. It is laid out in DocuSign's own structure (Record Tracking,
// Signer Events with Sent / Viewed / Signed timestamps, Envelope Summary Events) for one
// reason: the deterministic parser that reads real certificates
// (`lib/integrations/docusignCert.js`) must read this one too, so the verification code that
// runs in UAT is the same code that will run in production.
//
// Every page says SIMULATED. Nobody should be able to mistake this for signed evidence.
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const { PAGE, INK, SIZE } = require("./extraPages");
const { winAnsi, DOC_DATE } = require("./afeForm");

const colour = (c) => rgb(c[0], c[1], c[2]);
const M = PAGE.marginX;
const W = PAGE.width - M * 2;

/** DocuSign prints US-format timestamps; the parser expects exactly this shape. */
function stamp(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  let h = d.getUTCHours();
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${h}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} ${ampm}`;
}
const eventAt = (rec, type) => {
  const ev = (rec.events || []).find((e) => e.type === type);
  return ev ? stamp(ev.at) : "";
};

/**
 * @param {object} afe
 * @param {object} routing
 * @param {object} envelope  a completed simulated envelope
 * @returns {Promise<{bytes: Buffer, text: string}>} `text` is what the parser will see
 */
async function renderCertificate(afe, routing, envelope) {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - PAGE.marginTop;
  const lines = [];                                   // the same text, for the smoke test and the parser

  const write = (text, o) => {
    const opt = o || {};
    const size = opt.size || 8;
    const f = opt.bold ? bold : font;
    const s = winAnsi(text);
    if (y < PAGE.marginBottom + 30) { page = doc.addPage([PAGE.width, PAGE.height]); y = PAGE.height - PAGE.marginTop; }
    if (s) page.drawText(s, { x: M + (opt.indent || 0), y, size, font: f, color: colour(opt.colour || INK.text) });
    lines.push(s);
    y -= size + (opt.gap === undefined ? 3 : opt.gap);
  };
  const rule = () => { page.drawLine({ start: { x: M, y: y + 4 }, end: { x: M + W, y: y + 4 }, thickness: 0.5, color: colour(INK.rule) }); y -= 6; };

  const signers = (envelope.recipients || []).filter((r) => r.type === "signer");
  const copies = (envelope.recipients || []).filter((r) => r.type === "cc");
  const signed = signers.filter((r) => r.status === "completed");

  write("Certificate Of Completion", { size: 15, bold: true, gap: 8 });
  write("SIMULATED — produced by the AFE Workbench stand-in, not by DocuSign. Not signature evidence.",
    { size: 7.5, bold: true, colour: [0.70, 0.21, 0.18], gap: 8 });
  write(`Envelope Id: ${envelope.envelopeId}`, { bold: true });
  write(`Subject: ${envelope.emailSubject || ""}`);
  write(`Source Envelope: ${envelope.provider}`);
  write(`Documents: ${(envelope.documents || []).length}   Signatures: ${signed.length}`);
  write(`Certificate Pages: 1   Initials: 0`);
  write(`Status: ${envelope.status === "completed" ? "Completed" : envelope.status}`);
  write(`AutoNav: Enabled   EnvelopeId Stamping: Enabled   Time Zone: (UTC) Coordinated Universal Time`, { gap: 8 });

  write("Record Tracking", { bold: true, size: 10, gap: 5 });
  write(`Status: Original             ${stamp(envelope.sentAt)}`);
  write(`Holder: ${(afe.coordinator && afe.coordinator.name) || (afe.preparer && afe.preparer.name) || "AFE Workbench"}`);
  write(`${(afe.coordinator && afe.coordinator.email) || (afe.preparer && afe.preparer.email) || ""}`);
  write("Location: DocuSign (simulated)", { gap: 8 });

  write("Signer Events", { bold: true, size: 10, gap: 5 });
  rule();
  for (const rec of signers) {
    const chainRow = ((routing && routing.recipients) || []).find((r) => r.id === rec.routingRecipientId) || {};
    write(rec.name || "", { bold: true });
    write(rec.email || "");
    write(chainRow.level ? `${chainRow.level} — ${chainRow.group || chainRow.role || ""}`.trim() : (chainRow.group || chainRow.role || ""));
    write("Acme Life Sciences");
    write("Security Level: Email, Account Authentication (None)", { indent: 0 });
    write(`Sent: ${eventAt(rec, "sent")}`);
    write(`Viewed: ${eventAt(rec, "signed")}`);
    write(`Signed: ${eventAt(rec, rec.status === "completed" ? "signed" : "none")}`);
    write(rec.status === "completed" ? "Signature Adoption: Pre-selected Style" : `Status: ${rec.status}`, { gap: 7 });
  }

  write("In Person Signer Events", { bold: true, size: 10, gap: 3 });
  write("Not Offered", { gap: 7 });
  write("Editor Delivery Events", { bold: true, size: 10, gap: 3 });
  write("Not Offered", { gap: 7 });
  write("Carbon Copy Events", { bold: true, size: 10, gap: 3 });
  for (const c of copies) write(`${c.name || ""}  ${c.email || ""}  ${c.status === "completed" ? "Copied" : c.status}`);
  write("", { gap: 5 });

  write("Envelope Summary Events", { bold: true, size: 10, gap: 5 });
  rule();
  write(`Envelope Sent: Hashed/Encrypted          ${stamp(envelope.sentAt)}`);
  write(`Certified Delivered: Security Checked    ${stamp(envelope.sentAt)}`);
  write(`Signing Complete: Security Checked       ${stamp(envelope.completedAt)}`);
  write(`Completed: Security Checked              ${stamp(envelope.completedAt)}`, { gap: 8 });
  write(`Form hash at send (SHA-256): ${envelope.formHash || "—"}`, { size: 6.5, colour: INK.hint });
  write("This certificate proves nothing about a real signature. It exists so the tool's verification runs identically once DocuSign is connected.",
    { size: 6.5, colour: INK.hint });

  doc.setTitle(`Certificate of Completion — ${envelope.envelopeId}`);
  doc.setProducer("AFE Workbench");
  doc.setCreator("AFE Workbench");
  doc.setCreationDate(DOC_DATE);
  doc.setModificationDate(DOC_DATE);
  return { bytes: Buffer.from(await doc.save({ useObjectStreams: false })), text: lines.join("\n") };
}

module.exports = { renderCertificate, stamp };
