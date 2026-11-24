"use strict";
// DocuSign "Certificate of Completion" parsing — DETERMINISTIC, never AI.
// Signature evidence decides whether an approval band is satisfied, so it is parsed by
// rule from the certificate text and is reproducible byte-for-byte.
//
// Verified against the real certificates in the intake packages (Banjo, Line 5 Filler),
// which carry: envelope id, subject, per-signer name/email/title, and sent/viewed/signed
// timestamps.

function isCertificate(text) {
  const t = String(text || "");
  return /certificate\s+of\s+completion/i.test(t) && /envelope\s*id/i.test(t);
}

function firstMatch(text, re) {
  const m = re.exec(text);
  return m ? m[1].trim() : null;
}

// Only the "Signer Events" section holds actual signers. The envelope originator,
// the record-tracking holder and the disclosure footer all carry example.com addresses
// too, so parsing the whole document would invent approvers that never signed.
function signerSection(text) {
  const start = text.search(/Signer\s+Events/i);
  if (start < 0) return "";
  const rest = text.slice(start);
  const end = rest.search(/In\s+Person\s+Signer\s+Events|Editor\s+Delivery\s+Events|Envelope\s+Summary\s+Events/i);
  return end > 0 ? rest.slice(0, end) : rest;
}

// Within that section a signer block runs: Name / email / title / "Acme …" /
// … / "Signed: <timestamp>". We anchor on the email and read outward.
function parseSigners(text) {
  const section = signerSection(text);
  if (!section) return [];
  const signers = [];
  const emailRe = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
  const seen = new Set();
  let m;
  while ((m = emailRe.exec(section)) !== null) {
    const email = m[1];
    if (seen.has(email.toLowerCase()) || /docusign/i.test(email)) continue;
    seen.add(email.toLowerCase());

    // Name: the nearest preceding line that reads like a person, not a label.
    const before = section.slice(Math.max(0, m.index - 300), m.index)
      .split(/\r?\n/).map((l) => l.trim())
      .filter((l) => l && !/^(sent|viewed|signed|security level|status|holder|location|signature|timestamp)\b/i.test(l));
    const name = before.length ? before[before.length - 1] : null;

    const after = section.slice(m.index, m.index + 700);
    signers.push({
      name: name && name.length < 60 && /[A-Za-z]/.test(name) ? name : null,
      email,
      title: firstMatch(after, /\n\s*([A-Z][A-Za-z /&.,'-]{2,60})\s*\n\s*Acme/i),
      sentAt: firstMatch(after, /Sent:\s*([0-9/]+\s+[0-9:]+\s*[AP]M)/i),
      viewedAt: firstMatch(after, /Viewed:\s*([0-9/]+\s+[0-9:]+\s*[AP]M)/i),
      signedAt: firstMatch(after, /Signed:\s*([0-9/]+\s+[0-9:]+\s*[AP]M)/i),
    });
  }
  // A signer without a signature timestamp did not sign — drop it rather than imply approval.
  return signers.filter((s) => s.signedAt);
}

function parse(text) {
  const t = String(text || "");
  if (!isCertificate(t)) return null;
  const signers = parseSigners(t);
  return {
    // DocuSign's own ids are GUIDs; a simulated envelope's id says SIM- so nobody mistakes
    // it for one. Both are read here, because the same verification runs over either.
    envelopeId: firstMatch(t, /Envelope\s*Id:\s*([A-Za-z0-9-]{6,})/),
    subject: firstMatch(t, /Subject:\s*(.+)/),
    status: firstMatch(t, /Status:\s*(\w+)/),
    signatureCount: Number(firstMatch(t, /Signatures:\s*(\d+)/) || signers.length) || signers.length,
    signers,
  };
}

// Match certificate signers against the required approval chain. Name comparison is
// loose on purpose (certificates print "J. Whitfield" where the matrix holds
// "James Whitfield") but a partial match is reported as such, never as satisfied.
function verifyAgainstChain(cert, requiredChain) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z ]/g, "").trim();
  const lastName = (s) => norm(s).split(/\s+/).filter(Boolean).pop() || "";

  return (requiredChain || []).map((step) => {
    const want = norm(step.approverName);
    const wantLast = lastName(step.approverName);
    const exact = (cert.signers || []).find((s) => norm(s.name) === want);
    const loose = exact || (cert.signers || []).find((s) => wantLast && lastName(s.name) === wantLast);
    if (exact) {
      return Object.assign({}, step, {
        st: "ok",
        ev: `DocuSign · ${exact.name} · ${exact.signedAt || "signed"}`,
        env: cert.envelopeId || "",
      });
    }
    if (loose) {
      return Object.assign({}, step, {
        st: "ok",
        ev: `DocuSign · ${loose.name} · ${loose.signedAt || "signed"}`,
        env: cert.envelopeId || "",
        note: `Matched on surname — certificate reads "${loose.name}", matrix holds "${step.approverName}".`,
      });
    }
    return Object.assign({}, step, { st: "miss" });
  });
}

module.exports = { isCertificate, parse, verifyAgainstChain };
