// Line icons, inline SVG, 16-unit grid — the set the design canvas uses. `icon("tick", 18)`.
import { raw } from "./dom.js";

const PATHS = {
  tick: "M3 8.5l3 3 7-7.5",
  chevR: "M6 3l5 5-5 5",
  chevL: "M9.5 3.5 5 8l4.5 4.5",
  chevD: "M3.5 6 8 10.5 12.5 6",
  x: "M4 4l8 8M12 4l-8 8",
  plus: "M8 3v10M3 8h10",
  pen: "M2 13.5h12 M4 10.8 10.8 4a1.6 1.6 0 0 1 2.3 2.3L6.3 13H4z",
  doc: "M4 1.5h5.5L13 5v9.5H4z M9.5 1.5V5H13",
  upload: "M4 1.5h5.5L13 5v9.5H4z M8 7v5 M6 9l2-2 2 2",
  mail: "M2.5 4h11v8h-11z M2.5 4l5.5 4.5L13.5 4",
  chat: "M2.5 3h11v7.5H8l-3.5 3v-3h-2z M5.5 6.2h5 M5.5 8.2h3",
  shield: "M8 1.5 13 3.5v4c0 3.5-2.2 5.8-5 7-2.8-1.2-5-3.5-5-7v-4z",
  home: "M2 13.5h12 M4 13.5V6l4-3 4 3v7.5 M6.5 13.5v-3h3v3",
  arrowR: "M2.5 8h11 M9 3.5 13.5 8 9 12.5",
  arrowIn: "M2.5 8h8.5 M7.5 4.5 11 8l-3.5 3.5 M13.5 3v10",
  bang: "M8 3.5v5.5M8 12v.5",
  info: "M8 7v5 M8 4.5v.5",
  clock: "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11z M8 5v3.5l2.5 1.5",
  user: "M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M2.5 14a5.5 5.5 0 0 1 11 0",
  users: "M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M1.5 13.5a4.5 4.5 0 0 1 9 0 M10.5 2.7a2.5 2.5 0 0 1 0 4.6 M12 9.3a4.5 4.5 0 0 1 2.5 4.2",
  external: "M6.5 3.5H3v9.5h9.5V9 M9 3h4v4 M13 3 7.5 8.5",
  copy: "M5.5 5.5h7v8h-7z M3.5 10.5v-8h7",
  refresh: "M13 8a5 5 0 1 1-1.5-3.6 M13 2.5v3h-3",
  swap: "M3 6h9 M9.5 3.5 12 6 9.5 8.5 M13 10H4 M6.5 7.5 4 10l2.5 2.5",
  minus: "M4 8h8",
  question: "M6 6a2 2 0 1 1 3 1.7c-.7.4-1 .9-1 1.6 M8 12v.5",
  back: "M13 8H3 M7 3.5 2.5 8 7 12.5",
  bell: "M4 11.5h8l-1-1.5V7a3 3 0 0 0-6 0v3z M6.5 13.5a1.5 1.5 0 0 0 3 0",
  // R109. A glyph is read before the word beside it, so a screen with none of them asks to be
  // read rather than looked at. Same 16-unit grid, same weight, no fills -- these are drawn to
  // sit inside a 28px medallion at 15px and in a nav tab at 15px without thickening.
  chart: "M2.5 13.5h11 M5 13.5V8 M8 13.5V4 M11 13.5v-3.5",
  coins: "M8 5.5c3 0 5.5-.9 5.5-2S11 1.5 8 1.5 2.5 2.4 2.5 3.5 5 5.5 8 5.5z M2.5 3.5v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-4 M2.5 7.5v4c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-4",
  box: "M8 1.8 14 5v6l-6 3.2L2 11V5z M2 5l6 3.2L14 5 M8 8.2v6",
  flag: "M4 14V2.5 M4 3h8l-2 2.75L12 8.5H4",
  calendar: "M2.5 4h11v10h-11z M2.5 7h11 M5.5 2v3 M10.5 2v3",
  lock: "M3.5 7.5h9v6h-9z M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5",
  search: "M7.2 12.4a5.2 5.2 0 1 0 0-10.4 5.2 5.2 0 0 0 0 10.4z M11 11l3 3",
  cog: "M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z M8 1.5l.9 1.8 2-.4.4 2 1.8.9-.9 1.8.9 1.8-1.8.9-.4 2-2-.4L8 14.5l-.9-1.8-2 .4-.4-2-1.8-.9.9-1.8-.9-1.8 1.8-.9.4-2 2 .4z",
  send: "M14 2 2 7l4.5 2.2L9 14z M6.5 9.2 14 2",
  inbox: "M2.5 9h3l1 2h3l1-2h3 M2.5 9 4 2.5h8L13.5 9v4.5h-11z",
  filter: "M2.5 3.5h11L9.5 8.4v4.6l-3 1.5V8.4z",
  trend: "M2.5 11.5 6 7.5l2.5 2.5L13.5 4 M13.5 4h-3.5 M13.5 4v3.5",
  pin: "M8 14.5s5-4.6 5-8a5 5 0 0 0-10 0c0 3.4 5 8 5 8z M8 8.3a1.8 1.8 0 1 0 0-3.6 1.8 1.8 0 0 0 0 3.6z",
};

export function icon(name, size, opts) {
  const o = opts || {};
  const d = PATHS[name] || PATHS.info;
  const w = size || 16;
  return raw(`<svg viewBox="0 0 16 16" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="${o.stroke || 2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"></path></svg>`);
}
