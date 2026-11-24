"use strict";
// Show me, for something the quote reader read (R170, design rule 5): the one page the figure came
// from, with the place it was read from ringed in red, so a person confirms against the document
// rather than against a number on a screen.
//
// The reader measures a page in its own unit — inches for a PDF, pixels for an image — from the top
// left; PDF draws from the bottom left in points. Scaling by the page's OWN size, as the reader
// reported it, makes the unit irrelevant: the ring lands on the same fraction of the page either way.
//
// Nothing here is stored or hashed: it is drawn for the person looking, each time they look.
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const RED = rgb(0.753, 0, 0);          // the red Fixed Assets' own marks are drawn in
const PAD = 3;

/** WinAnsi only — the standard Helvetica cannot draw anything else, and a label must not throw. */
const plain = (s) => String(s || "").normalize("NFKD").replace(/[^\x20-\x7E]/g, "").slice(0, 120);

/**
 * @param {Buffer} bytes      the attached file
 * @param {string} mimeType   application/pdf, image/png or image/jpeg
 * @param {object} where      { page, polygon: [x1,y1,…,x4,y4], width, height } as the reader gave it
 * @param {string} label      printed above the ring
 * @returns {Promise<Buffer>}
 */
async function ringRead(bytes, mimeType, where, label) {
  const out = await PDFDocument.create();
  let page, box;
  if (mimeType === "application/pdf") {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const index = Math.min(Math.max(1, Number(where.page) || 1), src.getPageCount()) - 1;
    [page] = await out.copyPages(src, [index]);
    out.addPage(page);
    box = page.getCropBox();
  } else {
    const image = mimeType === "image/png" ? await out.embedPng(bytes) : await out.embedJpg(bytes);
    page = out.addPage([image.width, image.height]);
    page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    box = { x: 0, y: 0, width: image.width, height: image.height };
  }
  const sx = box.width / (Number(where.width) || box.width);
  const sy = box.height / (Number(where.height) || box.height);
  const xs = [], ys = [];
  (where.polygon || []).forEach((v, i) => (i % 2 ? ys : xs).push(Number(v)));
  const x = box.x + Math.min(...xs) * sx - PAD;
  const w = (Math.max(...xs) - Math.min(...xs)) * sx + 2 * PAD;
  const top = box.y + box.height - Math.min(...ys) * sy + PAD;
  const h = (Math.max(...ys) - Math.min(...ys)) * sy + 2 * PAD;
  page.drawRectangle({ x, y: top - h, width: w, height: h, borderColor: RED, borderWidth: 2 });

  const font = await out.embedFont(StandardFonts.HelveticaBold);
  const text = plain(label);
  const size = 9;
  const tw = font.widthOfTextAtSize(text, size);
  // Above the ring where there is room, below it where there is not; never off the page.
  const ty = top + 4 + size <= box.y + box.height ? top + 4 : top - h - size - 4;
  const tx = Math.max(box.x + 2, Math.min(x, box.x + box.width - tw - 2));
  page.drawRectangle({ x: tx - 2, y: ty - 2, width: tw + 4, height: size + 4, color: rgb(1, 1, 1), opacity: 0.85 });
  page.drawText(text, { x: tx, y: ty, size, font, color: RED });
  return Buffer.from(await out.save());
}

module.exports = { ringRead };
