// The text a person can READ in a source file: every string literal and every piece of template
// text, with comments (including comments inside `${…}`) and regex literals skipped.
// Returns [{ line, text }]. Used to keep requirement ids (R164, Q47) out of what screens say.
function literals(src) {
  const out = [];
  let i = 0, line = 1;
  const stack = [];                         // "tpl" | "expr"; expr carries a brace depth
  const depth = [];
  let lastSig = "(";                        // the last significant character, for regex detection
  const regexCan = () => /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || lastSig === "";
  let cur = null;                           // { line, text } of the template text being read
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    const top = stack[stack.length - 1];
    if (top === "tpl") {
      if (c === "\\") { cur.text += src.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { out.push(cur); cur = null; stack.pop(); lastSig = "a"; i++; continue; }
      if (c === "$" && n === "{") { out.push(cur); cur = null; stack.push("expr"); depth.push(0); lastSig = "{"; i += 2; continue; }
      if (c === "\n") line++;
      cur.text += c; i++; continue;
    }
    // code (top level, or inside ${…})
    if (c === "\n") { line++; i++; continue; }
    if (c === "/" && n === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) { if (src[i] === "\n") line++; i++; } i += 2; continue; }
    if (c === "/" && regexCan()) {
      i++; let cls = false;
      while (i < src.length && src[i] !== "\n") { const d = src[i]; if (d === "\\") { i += 2; continue; } if (d === "[") cls = true; else if (d === "]") cls = false; else if (d === "/" && !cls) break; i++; }
      i++; while (/[a-z]/i.test(src[i] || "")) i++;
      lastSig = "a"; continue;
    }
    if (c === '"' || c === "'") {
      const start = line; let text = ""; i++;
      while (i < src.length && src[i] !== c) { if (src[i] === "\\") { text += src.slice(i, i + 2); i += 2; continue; } if (src[i] === "\n") line++; text += src[i]; i++; }
      i++; out.push({ line: start, text }); lastSig = "a"; continue;
    }
    if (c === "`") { stack.push("tpl"); cur = { line, text: "" }; i++; continue; }
    if (top === "expr") {
      if (c === "{") depth[depth.length - 1]++;
      if (c === "}") {
        if (depth[depth.length - 1] === 0) { stack.pop(); depth.pop(); cur = { line, text: "" }; i++; continue; }
        depth[depth.length - 1]--;
      }
    }
    if (/[A-Za-z_$0-9]/.test(c)) { while (/[\w$]/.test(src[i] || "")) i++; lastSig = "a"; const word = src.slice(0, i).match(/[\w$]+$/)[0]; if (["return", "typeof", "case", "in", "of", "else"].includes(word)) lastSig = "("; continue; }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.filter(Boolean);
}
module.exports = { literals };
