"use strict";
// Stand-ins for the two Azure services the quote reader talks to (R170), for smoke-boot: the App
// Service identity endpoint, and the reader itself. Plain node:http on a free local port — nothing
// here reaches a network, and nothing here is shipped (the upload carries no tools/).
const http = require("http");

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

/**
 * The identity endpoint: a token for whoever presents the right header, as App Service's does.
 * @param {{ header: string, token: string, lifetime?: number }} o   lifetime in seconds
 */
async function identity(o) {
  const hits = [];
  const svc = await listen((req, res) => {
    const u = new URL(req.url, "http://local");
    hits.push({ resource: u.searchParams.get("resource"), apiVersion: u.searchParams.get("api-version") });
    if (req.headers["x-identity-header"] !== o.header) {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized", error_description: "the identity header is not this container's" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: o.token, token_type: "Bearer", resource: u.searchParams.get("resource"),
      expires_on: String(Math.floor(Date.now() / 1000) + (o.lifetime === undefined ? 3600 : o.lifetime)) }));
  });
  return Object.assign(svc, { hits, endpoint: `${svc.url}/msi/token` });
}

/**
 * The reader: accepts a document, answers 202 with an operation to follow, and returns `o.result`
 * for it. A document that says `%scenario:forbidden` about itself is refused with 403, which is what
 * the real service does to an identity with no role on the resource.
 * @param {{ token: string, result: (text) => object, foreign?: boolean }} o
 */
async function reader(o) {
  const hits = [];
  const results = new Map();
  let n = 0;
  let base = "";
  const svc = await listen((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      hits.push({ method: req.method, path: req.url, authorised: req.headers.authorization === `Bearer ${o.token}` });
      if (req.headers.authorization !== `Bearer ${o.token}`) { res.writeHead(401, { "content-type": "application/json" }); return res.end("{}"); }
      if (req.method === "POST") {
        let text = "";
        try { text = Buffer.from(JSON.parse(body || "{}").base64Source || "", "base64").toString("latin1"); } catch { text = ""; }
        if (/%scenario:forbidden/.test(text)) {
          res.writeHead(403, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: { code: "PermissionDenied", message: "no role on this resource" } }));
        }
        const id = `r${++n}`;
        results.set(id, o.result(text));
        res.writeHead(202, {
          "operation-location": `${o.foreign ? "http://elsewhere.invalid" : base}/documentintelligence/documentModels/prebuilt-invoice/analyzeResults/${id}?api-version=2024-11-30`,
          "retry-after": "0",
        });
        return res.end();
      }
      const id = (req.url.match(/analyzeResults\/([^?]+)/) || [])[1];
      res.writeHead(200, { "content-type": "application/json", "retry-after": "0" });
      res.end(JSON.stringify(results.has(id) ? { status: "succeeded", analyzeResult: results.get(id) } : { status: "failed", error: { message: "no such operation" } }));
    });
  });
  base = svc.url;
  return Object.assign(svc, { hits });
}

/** A quote as the invoice model returns it: a total, a date and a vendor, each where it was read. */
function invoiceResult({ total, currency, date, vendor, confidences }) {
  const c = Object.assign({ total: 0.94, date: 0.91, vendor: 0.62 }, confidences || {});
  const at = (x, y) => [{ pageNumber: 1, polygon: [x, y, x + 2, y, x + 2, y + 0.3, x, y + 0.3] }];
  return {
    apiVersion: "2024-11-30", modelId: "prebuilt-invoice",
    pages: [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch" }],
    documents: [{ docType: "invoice", confidence: 0.97, fields: Object.assign({},
      total === undefined ? {} : { InvoiceTotal: { type: "currency", valueCurrency: { amount: total, currencyCode: currency || "USD" }, confidence: c.total, boundingRegions: at(5.5, 9) } },
      date === undefined ? {} : { InvoiceDate: { type: "date", valueDate: date, confidence: c.date, boundingRegions: at(5.5, 1.2) } },
      vendor === undefined ? {} : { VendorName: { type: "string", valueString: vendor, content: vendor, confidence: c.vendor, boundingRegions: at(1, 1) } }) }],
  };
}

module.exports = { identity, reader, invoiceResult };
