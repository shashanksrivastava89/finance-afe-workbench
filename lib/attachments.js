"use strict";
// Storing bytes against an AFE. Metadata goes to `attachmentsMeta`, the bytes to the
// attachment store (Postgres bytea, or memory without a database) — the two are always
// written together, so there is one place that does it.
const crypto = require("crypto");

/**
 * @param {object} repos
 * @param {object} spec { afeId, filename, role, bytes, byEmail, mimeType?, generated? }
 * @returns the stored metadata row
 */
async function put(repos, spec) {
  const bytes = Buffer.isBuffer(spec.bytes) ? spec.bytes : Buffer.from(spec.bytes);
  const meta = await repos.attachmentsMeta.insert({
    afeId: spec.afeId || null,
    filename: spec.filename,
    role: spec.role,
    mimeType: spec.mimeType || "application/pdf",
    sizeBytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    // Generated documents say so: nobody uploaded the AFE Form or the certificate.
    generated: spec.generated === undefined ? true : Boolean(spec.generated),
    uploadedByEmail: spec.byEmail || "system",
    uploadedAt: new Date().toISOString(),
  });
  await repos.attachmentStore.put(meta.id, bytes);
  return meta;
}

async function bytesOf(repos, attachmentId) {
  return repos.attachmentStore.get(attachmentId);
}

module.exports = { put, bytesOf };
