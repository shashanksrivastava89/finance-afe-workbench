"use strict";
// Express 4 does not route a rejected promise to the error handler.
//
// Every route in this application is `async (req, res)`. If one awaits something that throws —
// a database that will not answer, a PDF that will not assemble — Express 4 never sees it, Node
// reports an unhandled rejection, and since Node 15 that TERMINATES THE PROCESS. One failed
// write takes the whole site down, and App Service restarts it mid-request.
//
// Found on 2026-09-21, and not theoretically: the local Postgres pool is four connections, a
// matrix import deletes a row at a time, and those fire-and-forget writes starved the pool until
// an awaited attachment write timed out after fifteen seconds and killed the server. It also
// left the database holding 970 matrix rows of 1,197 — the partial-write hazard CLAUDE.md
// records, arriving by a route nobody had thought about. The pool exhaustion is its own problem;
// a process that dies because of it is a worse one.
//
// This is what `express-async-errors` does, in the dozen lines it takes, rather than as a fifth
// runtime dependency.

/**
 * Wrap every handler on a router so a rejection reaches `next(err)`.
 *
 * Walks the router's layers rather than asking route modules to opt in: fifteen files each
 * remembering to use a special Router is fifteen chances to forget, and the one that forgets is
 * the one that takes the site down.
 *
 * @param {object} router an express.Router()
 * @returns the same router
 */
function catchAsync(router) {
  for (const layer of (router && router.stack) || []) {
    const handlers = (layer.route && layer.route.stack) || [];
    for (const h of handlers) {
      const fn = h.handle;
      // Arity 4 is error middleware — `(err, req, res, next)` — and must keep its shape.
      if (typeof fn !== "function" || fn.length >= 4 || fn.__wrapped) continue;
      const wrapped = function wrappedHandler(req, res, next) {
        let out;
        try { out = fn.call(this, req, res, next); } catch (e) { next(e); return undefined; }
        // Return the HANDLED promise, not the rejected one. Express ignores a handler's return
        // value, but anything else that adopts it — a test, a future wrapper — would otherwise
        // re-raise the rejection this function exists to contain.
        if (out && typeof out.then === "function") return out.catch(next);
        return out;
      };
      wrapped.__wrapped = true;
      h.handle = wrapped;
    }
  }
  return router;
}

module.exports = { catchAsync };
