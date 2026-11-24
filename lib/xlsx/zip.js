"use strict";
// The ZIP container an .xlsx is, on Node's own `zlib` and nothing else.
//
// A workbook is a zip of XML parts. Reading and writing that container is about eighty lines of
// buffer arithmetic, which is why this file exists instead of a fifth runtime dependency: the
// dependency rule in CLAUDE.md is there to keep the ADC supply chain reviewable, and "we need to
// read a spreadsheet" is not a good enough reason to widen it.
//
// Only what a workbook actually uses is implemented: stored and deflated entries, no encryption,
// no zip64, no multi-disk. A file that needs any of those is not one Excel wrote from our
// template, and `read` says so rather than guessing.
const zlib = require("zlib");

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// CRC-32 (IEEE), table-built once. `zlib.crc32` exists on newer Node but not on every runtime
// this might be run under, and the table is cheaper than the version check.
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// MS-DOS date and time. Fixed, not `new Date()`: a workbook generated twice from the same data
// must be byte-identical, the same discipline the form PDF keeps.
const DOS_TIME = 0;                       // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;   // 2020-01-01

/**
 * Build a zip from `[{ name, data }]`, deflated.
 * @param {Array<{name: string, data: Buffer|string}>} entries
 * @returns {Buffer}
 */
function write(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), "utf8");
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Storing is only better for the very small parts; deflate everything so the output is
    // predictable, except when deflate actually grew the part.
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);              // version needed
    local.writeUInt16LE(0, 6);               // flags
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);              // extra length
    name.copy(local, 30);
    locals.push(local, body);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);            // version made by
    central.writeUInt16LE(20, 6);            // version needed
    central.writeUInt16LE(0, 8);             // flags
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);            // extra
    central.writeUInt16LE(0, 32);            // comment
    central.writeUInt16LE(0, 34);            // disk
    central.writeUInt16LE(0, 36);            // internal attrs
    central.writeUInt32LE(0, 38);            // external attrs
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/**
 * Read a zip into `{ name: Buffer }`.
 *
 * Entries are found through the CENTRAL DIRECTORY, never by scanning for local headers: Excel
 * writes data descriptors (the sizes in the local header are then zero), so the local header is
 * not to be trusted for length. The central directory is the index and is always correct.
 */
function read(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("not a zip file");
  // The EOCD is at the end, after a comment of up to 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip file — no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error("zip64 archives are not supported");

  const out = {};
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) throw new Error("corrupt zip central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localAt) !== LOCAL_SIG) throw new Error(`corrupt zip entry: ${name}`);
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const start = localAt + 30 + lNameLen + lExtraLen;
    const body = buf.subarray(start, start + compSize);

    if (method === 0) out[name] = Buffer.from(body);
    else if (method === 8) out[name] = zlib.inflateRawSync(body);
    else throw new Error(`unsupported zip compression method ${method} for ${name}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

module.exports = { read, write, crc32 };
