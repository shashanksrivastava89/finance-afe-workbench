// Motion: the small amount of it this tool earns, and none of it from a package.
//
// "Introduce some animations (use any library if needed — ensure it's lightweight)… make it
// engaging to fill the form and even to review financial stuff, which is usually boring."
// (Shashank, 2026-09-21)
//
// NO LIBRARY, and that is not caution — it is the ADC rule (CLAUDE.md: no build step, no bundler,
// no frontend packages), and it costs nothing here. Everything below is the Web Animations API
// and CSS, which every browser this tool runs on has had for years. GSAP would be 70 KB on the
// request path of a tool whose whole performance story was "it was never slow, it was far away".
//
// THREE RULES, because animation is the easiest thing in an interface to get wrong:
//   1. NOTHING ANIMATES THAT CARRIES INFORMATION YOU HAVE TO WAIT FOR. A figure counts up over
//      420ms because seeing it move tells you it changed; it is readable the whole way and the
//      final value is in the DOM before the animation starts, so a screen reader and a copy-paste
//      both get the number, not the tween.
//   2. TRANSFORM AND OPACITY ONLY. Anything that animates width, height, top or left is asking
//      the browser to re-lay-out sixty times a second. The one exception is a keyframed
//      box-shadow on a single element, which does not reflow.
//   3. `prefers-reduced-motion` IS AN INSTRUCTION, not a hint. Every function here checks it and
//      takes the end state immediately — the interface still SAYS everything, it just stops
//      moving. Nobody loses a fact because they asked for stillness.
const EASE_OUT = "cubic-bezier(.2,.7,.2,1)";
const EASE_IN = "cubic-bezier(.6,0,.8,.4)";

/** Has this person asked for less movement? Read live, because they can change it mid-session. */
export const reduced = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Count a figure up to its value.
 *
 * The element's text is ALREADY the final value when this is called — this replaces it for a few
 * hundred milliseconds and puts it back. So nothing depends on the animation finishing: a render
 * that is interrupted, a person on reduced motion, an old browser, all end up looking at the
 * right number. `data-counted` stops a repaint counting the same figure again, which is what
 * would make a screen twitch on every keystroke.
 *
 * @param {Element} el
 * @param {number}  to
 * @param {function(number): string} fmt  how to write the number at each step
 */
export function countUp(el, to, fmt, opts) {
  const o = opts || {};
  const end = fmt(to);
  if (!el || el.dataset.counted === String(to)) return;
  el.dataset.counted = String(to);
  el.textContent = end;
  if (reduced() || !Number.isFinite(to) || Math.abs(to) < 1) return;

  const ms = o.ms || 480;
  const from = Number.isFinite(o.from) ? o.from : 0;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms);
    // easeOutExpo: fast at the start, so the figure is nearly right almost immediately and the
    // last tenth is the part that reads as "settling" rather than "still loading".
    const e = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    el.textContent = p === 1 ? end : fmt(from + (to - from) * e);
    if (p < 1 && el.isConnected && el.dataset.counted === String(to)) requestAnimationFrame(step);
    else el.textContent = end;
  };
  requestAnimationFrame(step);
}

/**
 * Bring a set of elements in one after another.
 *
 * Used where a LIST means something as a list — the approval chain in order, the buckets across
 * the top. 45ms apart is enough to read as a sequence and short enough that the whole set is
 * settled before anyone has moved the mouse.
 */
export function stagger(els, opts) {
  const o = opts || {};
  const list = Array.from(els || []);
  if (!list.length || reduced()) return;
  list.forEach((el, i) => {
    if (el.dataset.stag) return;
    el.dataset.stag = "1";
    el.animate(
      [{ opacity: 0, transform: `translateY(${o.dy === undefined ? 8 : o.dy}px)` }, { opacity: 1, transform: "none" }],
      { duration: o.ms || 260, delay: i * (o.step || 45), easing: EASE_OUT, fill: "backwards" },
    );
  });
}

/** A ring that expands and fades — "look here", used after scrolling something into view. */
export function pulse(el, opts) {
  if (!el) return;
  const o = opts || {};
  const colour = o.colour || "rgba(179,53,46,.55)";
  el.classList.add("pulsing");
  const stop = () => el.classList.remove("pulsing");
  if (reduced()) { setTimeout(stop, 1200); return; }
  const a = el.animate([
    { boxShadow: `0 0 0 0 ${colour}` },
    { boxShadow: `0 0 0 10px rgba(0,0,0,0)` },
  ], { duration: 900, iterations: o.times || 2, easing: "ease-out" });
  a.addEventListener("finish", stop);
  a.addEventListener("cancel", stop);
}

/** Scroll something into the middle of the screen and then say "this one". */
export function bringTo(el, opts) {
  if (!el) return;
  el.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "center" });
  setTimeout(() => pulse(el, opts), reduced() ? 0 : 320);
}

const PLANE = "M2 21 23 12 2 3l0 7 15 2-15 2z";

/**
 * The document takes off.
 *
 * Pressing Send is the one irreversible moment in the requester's journey — the envelope is
 * created, the mail goes, the chain is frozen. It deserves to feel like something happened, and
 * "the button went grey for two seconds" is not that.
 *
 * The panel shrinks towards its own centre while a paper plane lifts out of it, arcs up and
 * leaves to the right. It cannot be a picture of the PDF: that frame is a separate document and
 * this page cannot read a pixel of it. So the plane leaves FROM the panel, which is the same
 * story told with the one thing we are allowed to touch.
 *
 * It returns a promise that settles when the flight is over, and a `cancel()` for the case that
 * matters most: the send FAILED. Then the panel comes straight back and the error is the only
 * thing on screen. An animation that keeps playing over a failure is a lie.
 */
export function sendOff(panel) {
  const done = { cancel() {} };
  if (!panel || reduced()) return Object.assign(Promise.resolve(), done);

  const box = panel.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.className = "flylayer";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "plane");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", PLANE);
  svg.appendChild(path);
  layer.appendChild(svg);
  document.body.appendChild(layer);

  const x0 = box.left + box.width / 2;
  const y0 = box.top + box.height / 2;
  svg.style.left = `${x0}px`;
  svg.style.top = `${y0}px`;

  const shrink = panel.animate(
    [{ transform: "none", opacity: 1 }, { transform: "scale(.82)", opacity: 0 }],
    { duration: 420, easing: EASE_IN, fill: "forwards" },
  );
  // Up and away to the right, turning as it goes — three keyframes is all a paper plane needs.
  const flight = svg.animate([
    { transform: "translate(-50%, -50%) scale(.4) rotate(-18deg)", opacity: 0 },
    { transform: "translate(-40%, -160%) scale(1) rotate(-8deg)", opacity: 1, offset: 0.22 },
    { transform: `translate(${window.innerWidth - x0 + 160}px, ${-y0 - 220}px) scale(.55) rotate(16deg)`, opacity: 0 },
  ], { duration: 1000, easing: EASE_OUT, fill: "forwards" });

  let cancelled = false;
  // A MOTION HELPER MUST GIVE BACK WHAT IT BORROWED.
  //
  // `shrink` fills forwards, so when it ended the panel stayed at `scale(.82), opacity: 0` —
  // invisible and still occupying every pixel of its layout box. The requester's Send never
  // showed it because that screen navigates away the moment the flight lands; Fixed Assets'
  // Send repaints and stays, so the issued-AFE panel left a panel-shaped hole in the page
  // (Shashank, 2026-09-22). The element is restored when the flight finishes, and the caller's
  // repaint puts the new content into it.
  const restore = () => { shrink.cancel(); panel.style.transform = ""; panel.style.opacity = ""; };
  const clean = () => { layer.remove(); };
  const p = new Promise((resolve) => {
    flight.addEventListener("finish", () => { clean(); restore(); resolve(); });
    flight.addEventListener("cancel", () => { clean(); restore(); resolve(); });
  });
  return Object.assign(p, {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      flight.cancel();
      restore();
      clean();
    },
  });
}

/**
 * A number, a chip or a card that has just CHANGED says so with one short bounce.
 * Deliberately 220ms and 1.04 — any bigger and a form that validates on every keystroke becomes
 * a trampoline.
 */
export function nudge(el) {
  if (!el || reduced()) return;
  el.animate([{ transform: "none" }, { transform: "scale(1.04)" }, { transform: "none" }],
    { duration: 220, easing: EASE_OUT });
}

/**
 * The one hook every screen gets, run after the paint that produced it.
 *
 * Rather than each screen remembering to animate its own things, this looks for the FOUR marks
 * that mean "this moves" and does it — so a new screen gets the behaviour by using the shared
 * vocabulary, which is how every other convention in this frontend works.
 *
 *   [data-count]   a figure that should count up to its value
 *   .bucket        the aggregation a screen opens on — arrives as a strip
 *   .cstep         a step in a chain — arrives in order, because the order is the point
 *   .finfig        a figure in the financial case
 *
 * Idempotent on purpose. `paint()` runs on every keystroke in the wizard, and a screen that
 * re-animates on each one is a screen nobody can fill in: `countUp` keys on the value it last
 * counted to and `stagger` marks what it has already brought in.
 */
export function afterPaint(root) {
  const el = root || document;
  for (const n of el.querySelectorAll("[data-count]")) {
    // An empty value is not zero. Number("") is 0, so an empty data-count used to be counted
    // "up to 0" — replacing whatever the element showed with the digit 0.
    const raw = String(n.dataset.count || "").trim();
    if (!raw) continue;
    const to = Number(raw);
    if (!Number.isFinite(to)) continue;
    const money = n.dataset.countAs === "money";
    countUp(n, to, (v) => (money
      ? "$" + Math.round(v).toLocaleString("en-US")
      : String(Math.round(v))));
  }
  stagger(el.querySelectorAll(".bucket"), { step: 55, dy: 10 });
  stagger(el.querySelectorAll(".cstep"), { step: 40, dy: 6 });
  stagger(el.querySelectorAll(".finfig"), { step: 55, dy: 8 });
}
