// History (path) routing. Each route names a screen module loaded on first use with a dynamic
// import; the module exports `render(root, ctx)` and, optionally, `unmount()`. Deep links work
// because server.js serves the shell for every non-API, non-file path.

const routes = [];
let current = null;
let token = 0;
let root = null;
let host = null;                    // the element the current screen owns
const hooks = { before: null, notFound: null, screenChanged: null };

function compile(pattern) {
  const keys = [];
  const re = pattern.replace(/\/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "/([^/]+)"; });
  return { regex: new RegExp("^" + re + "/?$"), keys };
}

export function route(pattern, load, meta) {
  const { regex, keys } = compile(pattern);
  routes.push({ pattern, regex, keys, load, meta: meta || {} });
}

export function match(pathname) {
  for (const r of routes) {
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    return { route: r, params };
  }
  return null;
}

export function currentPath() { return location.pathname + location.search; }

export async function navigate(path, opts) {
  const o = opts || {};
  if (o.replace) history.replaceState({}, "", path); else history.pushState({}, "", path);
  await dispatch();
}

// Renders run one at a time. Two of them interleaving is what used to leave a screen painted but
// inert, and how a slow screen could paint its numbers over the screen that replaced it.
//
// A render is allowed to navigate — `/afe/new` creates the AFE and then replaces the URL with
// `/afe/:id/edit/1` — so this must not be a promise chain. Chaining made that call wait for a
// render that was itself waiting for the call: the screen simply never appeared. Instead a
// navigation raised from inside a render just asks for another pass, and gets it as soon as the
// current one returns.
let running = false;
let again = false;

export async function dispatch() {
  ++token;
  if (running) { again = true; return; }            // re-entrant: go round again when this pass ends
  running = true;
  try {
    do {
      again = false;
      await run(token);
    } while (again);
  } catch (e) {
    console.error(e);
  } finally {
    running = false;
  }
}

async function run(my) {
  if (my !== token) return;                                     // a newer navigation won while queued
  const url = new URL(location.href);
  const m = match(url.pathname);
  const ctx = { path: url.pathname, query: Object.fromEntries(url.searchParams.entries()), params: m ? m.params : {}, route: m ? m.route : null };
  if (hooks.before) await hooks.before(ctx);
  if (!m) { if (hooks.notFound) hooks.notFound(root, ctx); return; }
  let mod;
  try { mod = await m.route.load(); }
  catch (e) { console.error("screen failed to load", e); if (hooks.notFound) hooks.notFound(root, Object.assign(ctx, { error: e })); return; }
  if (my !== token) return;                                     // a newer navigation won
  // A screen gets its own element, and a new one whenever the screen changes.
  //
  // Screens bind delegated listeners to the element they are handed and nothing ever takes them
  // off again. Handing every screen the same root meant those listeners accumulated on it: a
  // click on Prepare's "To send" was caught by the requests hub's own `[data-bucket]` handler,
  // left over from an earlier visit, which repainted the root as the hub — the right URL, the
  // right nav, somebody else's buckets. Listeners die with the element, so a fresh element per
  // screen ends that by construction.
  //
  // The element is reused while the screen stays the same, so moving between wizard steps still
  // morphs one DOM rather than rebuilding it, and scroll and focus survive (design rule 2).
  if (current !== mod) {
    if (current && current.unmount) { try { current.unmount(); } catch (e) { console.error(e); } }
    // Chrome that belongs to a screen rather than to the app — the context bar's record — is
    // dropped HERE and not on every dispatch. A wizard step is the same screen, and clearing it
    // per navigation would blank the bar for the length of a fetch on every Continue, which is
    // the flicker this bar exists to remove.
    if (hooks.screenChanged) { try { hooks.screenChanged(); } catch (e) { console.error(e); } }
    host = document.createElement("div");
    host.className = "screen";
    root.replaceChildren(host);
    current = mod;
    // Only when the screen itself changed. A re-render of the screen you are already on — a
    // wizard step, a repaint after a save — should leave you where you were reading.
    window.scrollTo(0, 0);
  }
  await mod.render(host, ctx);
  // The motion every screen gets for free, from the marks in the shared vocabulary. It runs after
  // the render rather than inside it, so a screen never has to remember — and it is idempotent,
  // so a screen that repaints itself does not re-animate what is already there.
  if (hooks.painted) { try { hooks.painted(host); } catch (e) { console.error(e); } }
}

/** Same-origin links navigate in place; everything else is left to the browser. */
function intercept(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
  if (!a || a.target || a.hasAttribute("download") || a.getAttribute("rel") === "external") return;
  const href = a.getAttribute("href");
  if (!href || !href.startsWith("/") || href.startsWith("//") || href.startsWith("/api/") || /\.[a-z0-9]+($|\?)/i.test(href)) return;
  e.preventDefault();
  navigate(href);
}

export function start(appRoot, opts) {
  root = appRoot;
  Object.assign(hooks, opts || {});
  window.addEventListener("popstate", dispatch);
  document.addEventListener("click", intercept);
  return dispatch();
}

/** Screens call this to re-render themselves after a mutation without touching history. */
export function rerender() { return dispatch(); }
