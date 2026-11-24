// The API client. JSON in, JSON out, and one error shape the screens can show as-is.

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.error) || `request failed (${status})`);
    this.status = status;
    this.body = body || {};
    this.detail = (body && body.detail) || null;
  }
}

async function call(method, path, body, opts) {
  const o = opts || {};
  const headers = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (o.etag) headers["if-none-match"] = o.etag;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin" });
  if (res.status === 304) return { notModified: true };
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new ApiError(res.status, data);
  if (o.withHeaders) return { data, etag: res.headers.get("etag") };
  return data;
}

export const api = {
  get: (path, opts) => call("GET", path, undefined, opts),
  post: (path, body) => call("POST", path, body === undefined ? {} : body),
  put: (path, body) => call("PUT", path, body),
  patch: (path, body) => call("PATCH", path, body),
  del: (path, body) => call("DELETE", path, body),
};

/** Read a file as base64 for the documents endpoint. */
/**
 * An AFE document, read for upload — or refused, in words, BEFORE it is read and sent. A file over
 * the limit used to travel all the way to the server and come back as a bare error.
 * `limits` is `refdata.attachmentLimits`; 25 MB when it is not to hand.
 */
export function documentToBase64(file, limits) {
  const max = (limits && limits.perFileBytes) || 25 * 1048576;
  if (file && file.size > max) {
    return Promise.reject(new Error(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB — each attachment can be up to ${Math.round(max / 1048576)} MB. Save a smaller copy, or split it.`));
  }
  return fileToBase64(file);
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("could not read the file"));
    r.readAsDataURL(file);
  });
}
