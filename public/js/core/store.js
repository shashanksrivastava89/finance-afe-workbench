// Resources by API path, with a short freshness window and request de-duplication, plus a bag
// of per-screen UI state that survives navigating away and back (which bucket was open, which
// tab). Nothing here is the source of truth — the server is; this is what is on screen.
import { api } from "./api.js";

const cache = new Map();          // path -> { data, at, promise }
const listeners = new Set();

/** Go to the server, and let anyone who asks meanwhile wait on the same request. */
function fetchInto(path) {
  const c = cache.get(path);
  if (c && c.promise) return c.promise;
  const promise = api.get(path).then((data) => { cache.set(path, { data, at: Date.now() }); notify(path); return data; })
    .catch((e) => { cache.delete(path); throw e; });
  cache.set(path, Object.assign({}, c || {}, { promise }));
  return promise;
}

export const store = {
  /**
   * Fetch a resource; returns the cached copy when it is under `maxAge` ms old.
   *
   * `swr` is the interesting one: hand back what we already have so the screen paints at once,
   * and go to the server behind it — `onFresh` fires when the answer lands, and the screen
   * repaints. A queue you are coming back to appears immediately and then corrects itself,
   * instead of showing nothing for a round trip. At 225 ms from India that is the difference
   * between a screen that answers and a screen that waits (R92). Nothing goes stale: the
   * request always happens, it just does not block the paint.
   */
  async get(path, opts) {
    const o = opts || {};
    const c = cache.get(path);
    const ttl = o.maxAge === undefined ? 3000 : o.maxAge;
    if (c && c.data !== undefined && !o.fresh && !o.swr && Date.now() - c.at < ttl) return c.data;
    if (o.swr && c && c.data !== undefined) {
      fetchInto(path).then((data) => { if (o.onFresh) o.onFresh(data); }).catch(() => { /* keep what we have */ });
      return c.data;
    }
    return fetchInto(path);
  },
  peek(path) { const c = cache.get(path); return c ? c.data : undefined; },
  put(path, data) { cache.set(path, { data, at: Date.now() }); notify(path); },
  bust(prefix) { for (const k of Array.from(cache.keys())) if (k.startsWith(prefix)) cache.delete(k); },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
};

function notify(path) { for (const fn of listeners) fn(path); }

/** Per-screen UI state: `ui.hub.open = "inApproval"` and it is still open when you come back. */
export const ui = {};
export function uiFor(screen) { return ui[screen] || (ui[screen] = {}); }
