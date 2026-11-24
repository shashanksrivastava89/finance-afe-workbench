"use strict";
// The text layer of a PDF, read out of the file itself — shared by the suites that need to
// assert what a document SAYS rather than what our own model meant it to say (smoke-envelope
// for the form, smoke-fa for the issued AFE). A helper, not a suite: nothing here runs on its own.
const zlib = require("zlib");

/**
 * Every piece of text in a PDF, read out of the file itself rather than from our own model.
 *
 * Content streams are Flate-compressed; inside them pdf-lib writes each string as a hex
 * operand of `Tj` (`<48656C6C6F> Tj`). Decoding those is how a PDF reader — and DocuSign's
 * anchor search — sees the words, so an assertion here is an assertion about the real file.
 */
/**
 * The text layer, read the way a reader reads it.
 *
 * The form is set in an embedded subset of Carlito, so the strings in the content stream are
 * glyph ids, not letters; what turns them back into words is the font's ToUnicode map. That is
 * exactly the path Acrobat and DocuSign take, so extracting through it tests the thing that
 * matters — including whether DocuSign can find its anchor strings.
 */
function pdfText(buf) {
  const raw = buf.toString("latin1");
  const objs = {};
  for (const m of raw.matchAll(/(\d+)\s+0\s+obj([\s\S]*?)endobj/g)) objs[m[1]] = m[2];

  const streamOf = (body) => {
    if (!body) return null;
    const i = body.indexOf("stream");
    if (i === -1) return null;
    let s = i + 6;
    if (body[s] === "\r") s += 1;
    if (body[s] === "\n") s += 1;
    const end = body.indexOf("endstream", s);
    if (end === -1) return null;
    const chunk = Buffer.from(body.slice(s, end), "latin1");
    try { return zlib.inflateSync(chunk).toString("latin1"); } catch { return chunk.toString("latin1"); }
  };

  /** glyph code -> characters, from a ToUnicode CMap. */
  const cmapOf = (num) => {
    const cmap = streamOf(objs[num]);
    const out = new Map();
    if (!cmap) return out;
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        out.set(parseInt(pair[1], 16), Buffer.from(pair[2], "hex").swap16 ? decodeUtf16(pair[2]) : decodeUtf16(pair[2]));
      }
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const row of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
        const lo = parseInt(row[1], 16), hi = parseInt(row[2], 16), start = parseInt(row[3], 16);
        for (let c = lo; c <= hi && c - lo < 4096; c++) out.set(c, String.fromCodePoint(start + (c - lo)));
      }
    }
    return out;
  };
  const decodeUtf16 = (hex) => {
    let s = "";
    for (let i = 0; i + 3 < hex.length + 1; i += 4) s += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
    return s;
  };

  // resource name -> ToUnicode map, per font referenced anywhere in the file
  const fonts = new Map();
  for (const body of Object.values(objs)) {
    const res = body.match(/\/Font\s*<<([\s\S]*?)>>/);
    if (!res) continue;
    for (const ref of res[1].matchAll(/\/([^\s/<>\[\]]+)\s+(\d+)\s+0\s+R/g)) {
      const fontBody = objs[ref[2]] || "";
      const tu = fontBody.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
      const desc = fontBody.match(/\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/);
      const src = tu ? tu[1] : (desc && (objs[desc[1]] || "").match(/\/ToUnicode\s+(\d+)\s+0\s+R/) || [])[1];
      if (src) fonts.set(ref[1], cmapOf(src));
    }
  }

  // walk the page content, tracking the selected font
  let content = "";
  for (const [num, body] of Object.entries(objs)) {
    const s = streamOf(body);
    if (s && (s.includes("BT") || s.includes(" re"))) content += s + "\n";
  }
  const words = [];
  let current = null;
  const tokens = content.matchAll(/\/([^\s/<>\[\]]+)\s+[\d.]+\s+Tf|<([0-9A-Fa-f\s]+)>\s*T[jJ]|\(((?:\\.|[^()\\])*)\)\s*T[jJ]|\[((?:[^\][]|\\.)*)\]\s*TJ/g);
  for (const t of tokens) {
    if (t[1]) { current = fonts.get(t[1]) || null; continue; }
    // An embedded subset is Identity-H — two bytes a glyph, decoded through its ToUnicode map.
    // A standard font has no map and writes one byte a character.
    const decodeHex = (hex) => {
      const clean = hex.replace(/\s+/g, "");
      let out = "";
      if (!current) {
        for (let i = 0; i + 1 < clean.length; i += 2) out += String.fromCharCode(parseInt(clean.slice(i, i + 2), 16));
        return out;
      }
      for (let i = 0; i + 3 < clean.length; i += 4) {
        const code = parseInt(clean.slice(i, i + 4), 16);
        out += current.has(code) ? current.get(code) : "";
      }
      return out;
    };
    if (t[2] !== undefined) words.push(decodeHex(t[2]));
    else if (t[3] !== undefined) words.push(t[3].replace(/\\([()\\])/g, "$1"));
    else if (t[4] !== undefined) {
      let s = "";
      for (const part of t[4].matchAll(/<([0-9A-Fa-f\s]+)>|\(((?:\\.|[^()\\])*)\)/g)) {
        s += part[1] !== undefined ? decodeHex(part[1]) : part[2].replace(/\\([()\\])/g, "$1");
      }
      words.push(s);
    }
  }
  return words.join("\n");
}

module.exports = { pdfText };
