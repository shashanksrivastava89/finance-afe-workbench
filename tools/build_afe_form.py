"""Generate lib/pdf/afeFormLayout.js from the Global AFE Template.

The Filled AFE Form has to look like the form Acme already signs — the same rules, the
same tints, the same type, in the same places. Rather than transcribe that by eye, this
reads the template itself and the PDF Excel prints from it, and emits the printed page as
data: every rule and tint as a rectangle, every printed label at its own coordinates, and a
box for each value the tool fills in.

    1. Open the V7 template in Excel, select the "AFE Form" sheet, Save as PDF.
    2. python tools/build_afe_form.py <template.xlsx> <that.pdf>

The template lives with the other source exports (see CLAUDE.md, Data & privacy) and is
never committed; the generated layout is. Re-run it when the template version changes.
"""
import json, re, sys, zlib, colorsys, datetime
from pathlib import Path

import openpyxl
from openpyxl.utils import range_boundaries

L = "ABCDEFG"
OUT = Path(__file__).resolve().parent.parent / "lib" / "pdf" / "afeFormLayout.js"

# ---- the value slots ---------------------------------------------------------------------
# Which cells the tool fills in, and what it puts there. Everything else on the sheet is the
# form's own printing. Keys are resolved by lib/pdf/formModel.js.
SLOTS = {
    (2, 2): "header.afeNo",            (2, 4): "header.costCenter",   (2, 6): "header.projectType",
    (3, 2): "header.preparedBy",       (3, 4): "header.startDate",    (3, 6): "header.location",
    (4, 2): "header.projectCode",      (4, 4): "header.finishDate",
    (5, 2): "header.title",            (6, 2): "header.description",
    (8, 2): "money.totalUsd",
    (9, 2): "money.roi",               (9, 4): "money.paybackYears",  (9, 7): "money.fxRate",
    (12, 2): "money.capexUsd",         (12, 3): "money.opexUsd",      (12, 4): "money.cloudCapexUsd",
    (12, 5): "money.capexLc",          (12, 6): "money.opexLc",       (12, 7): "money.cloudCapexLc",
    (13, 2): "money.totalCapexUsd",    (13, 3): "money.totalOpexUsd", (13, 4): "money.totalCloudCapexUsd",
    (13, 5): "money.totalCapexLc",     (13, 6): "money.totalOpexLc",  (13, 7): "money.totalCloudCapexLc",
    (15, 7): "budget.budgetedCheck",
    (16, 2): "budget.capexUsd",        (16, 3): "budget.opexUsd",     (16, 4): "budget.cloudCapexUsd",
    (17, 2): "budget.additionUsd",
    (18, 7): "supplemental.check",
    (19, 2): "supplemental.originalUsd", (19, 4): "supplemental.amountUsd",
    (21, 7): "assist.check",
    # Row 23 is the Controllership heading; the signer goes on the row below it.
    (24, 3): "controllership.name",    (24, 5): "controllership.signature", (24, 7): "controllership.date",
}
CHECK_SLOTS = {(15, 7), (18, 7), (21, 7)}          # Yes/No captions, one of them marked
# The signing blocks, filled row by row from the routing.
PROJECT_APPROVAL_ROWS = list(range(27, 31))        # four rows, under the Project Approvals head
FINANCIAL_ROWS = list(range(33, 47))               # fourteen rows, the form's own bands
SIGN_COLS = {"group": 2, "name": 3, "signature": 5, "date": 7}


# ---- reading the printed page -------------------------------------------------------------
def objects(buf):
    out = {}
    for m in re.finditer(rb"(\d+)\s+(\d+)\s+obj(.*?)endobj", buf, re.S):
        out[int(m.group(1))] = m.group(3)
    return out


def stream_of(body):
    if body is None:
        return None
    sm = re.search(rb"stream\r?\n(.*?)\r?\nendstream", body, re.S)
    if not sm:
        return None
    data = sm.group(1)
    if b"FlateDecode" in body:
        try:
            data = zlib.decompress(data)
        except Exception:
            return None
    return data


def page_streams(buf):
    """The page content streams, and only those — a font program can contain `BT` too."""
    objs = objects(buf)
    out = []
    for body in objs.values():
        if not re.search(rb"/Type\s*/Page[^s]", body):
            continue
        for ref in re.findall(rb"/Contents\s+(\d+)\s+0\s+R", body):
            data = stream_of(objs.get(int(ref)))
            if data:
                out.append(data)
        for arr in re.findall(rb"/Contents\s*\[([^\]]*)\]", body):
            for ref in re.findall(rb"(\d+)\s+0\s+R", arr):
                data = stream_of(objs.get(int(ref)))
                if data:
                    out.append(data)
    return out


def to_unicode_maps(buf):
    """Resource name -> {glyph code: text}, read from each font's ToUnicode CMap.

    Excel embeds subsets whose codes are not the characters — the footnote block comes out as
    a Caesar-shifted mess without this — so every string has to be decoded through the map the
    font carries, which is what a reader does.
    """
    objs = objects(buf)

    def cmap_for(num):
        data = stream_of(objs.get(num))
        table = {}
        if not data:
            return table
        text = data.decode("latin-1")
        for block in re.findall(r"beginbfchar(.*?)endbfchar", text, re.S):
            for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
                table[int(src, 16)] = utf16(dst)
        for block in re.findall(r"beginbfrange(.*?)endbfrange", text, re.S):
            for lo, hi, start in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", block):
                a, b, c = int(lo, 16), int(hi, 16), int(start, 16)
                for code in range(a, min(b, a + 4096) + 1):
                    table[code] = chr(c + (code - a))
        return table

    def utf16(hexs):
        return "".join(chr(int(hexs[i:i + 4], 16)) for i in range(0, len(hexs) - 3, 4))

    fonts = {}
    for body in objs.values():
        res = re.search(rb"/Font\s*<<(.*?)>>", body, re.S)
        if not res:
            continue
        for name, num in re.findall(rb"/([^\s/<>\[\]]+)\s+(\d+)\s+0\s+R", res.group(1)):
            font_body = objs.get(int(num), b"")
            tu = re.search(rb"/ToUnicode\s+(\d+)\s+0\s+R", font_body)
            if not tu:
                desc = re.search(rb"/DescendantFonts\s*\[\s*(\d+)\s+0\s+R", font_body)
                if desc:
                    tu = re.search(rb"/ToUnicode\s+(\d+)\s+0\s+R", objs.get(int(desc.group(1)), b""))
            if tu:
                fonts[name.decode("latin-1")] = cmap_for(int(tu.group(1)))
    return fonts


def tokenize(data):
    i, n = 0, len(data)
    while i < n:
        ch = data[i:i + 1]
        if ch in b" \t\r\n":
            i += 1
            continue
        if ch == b"(":
            depth, i, buf = 1, i + 1, bytearray()
            while i < n and depth:
                c = data[i:i + 1]
                if c == b"\\":
                    nxt = data[i + 1:i + 2]
                    mapped = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f"}
                    if nxt in mapped:
                        buf += mapped[nxt]
                        i += 2
                    elif nxt in b"01234567":
                        oct_ = b""
                        while len(oct_) < 3 and data[i + 1 + len(oct_):i + 2 + len(oct_)] in b"01234567":
                            oct_ += data[i + 1 + len(oct_):i + 2 + len(oct_)]
                        buf.append(int(oct_, 8) & 0xFF)
                        i += 1 + len(oct_)
                    else:
                        buf += nxt
                        i += 2
                    continue
                if c == b"(":
                    depth += 1
                elif c == b")":
                    depth -= 1
                    if not depth:
                        i += 1
                        break
                buf += c
                i += 1
            yield ("lit", bytes(buf))
            continue
        if ch == b"<" and data[i + 1:i + 2] != b"<":
            j = data.find(b">", i)
            hexs = re.sub(rb"\s", b"", data[i + 1:j])
            if len(hexs) % 2:
                hexs += b"0"
            yield ("hex", hexs.decode())
            i = j + 1
            continue
        if data[i:i + 2] in (b"<<", b">>"):
            i += 2
            continue
        if ch == b"[":
            depth, j = 1, i + 1
            while j < n and depth:
                if data[j:j + 1] == b"[":
                    depth += 1
                elif data[j:j + 1] == b"]":
                    depth -= 1
                j += 1
            yield ("arr", data[i + 1:j - 1])
            i = j
            continue
        if ch == b"/":
            j = i + 1
            while j < n and data[j:j + 1] not in b" \t\r\n/[]<>()":
                j += 1
            yield ("name", data[i + 1:j].decode("latin-1"))
            i = j
            continue
        m = re.match(rb"[-+]?[0-9]*\.?[0-9]+", data[i:i + 40])
        if m:
            yield ("num", float(m.group(0)))
            i += m.end()
            continue
        m = re.match(rb"[A-Za-z'\"*]+[01*]?", data[i:i + 20])
        if m:
            yield ("op", m.group(0).decode("latin-1"))
            i += m.end()
            continue
        i += 1


def read_pdf(path):
    text, fills = [], []
    raw = Path(path).read_bytes()
    cmaps = to_unicode_maps(raw)

    def decode(kind, value, font_name):
        table = cmaps.get(font_name or "", {})
        if kind == "hex":
            codes = [int(value[i:i + 4], 16) for i in range(0, len(value) - 3, 4)] if table else []
            if not table:
                try:
                    return bytes.fromhex(value).decode("utf-16-be", "replace")
                except Exception:
                    return ""
            # Excel leaves the space out of some of its CMaps; a code the map does not carry
            # is a space in every run this reads, and dropping it would run the words together.
            return "".join(table.get(c, " ") for c in codes)
        if table:
            return "".join(table.get(b, " ") for b in value)
        return value.decode("latin-1")
    mb = re.search(rb"/MediaBox\s*\[\s*([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)", raw)
    page_w = round(float(mb.group(3)), 2) if mb else 595.32
    page_h = round(float(mb.group(4)), 2) if mb else 841.92
    for data in page_streams(raw):
        tm = [1, 0, 0, 1, 0, 0]
        tlm = list(tm)
        ctm = [1, 0, 0, 1, 0, 0]
        size, font, fill_rgb = 0.0, None, (0, 0, 0)
        pend, stack, gs = [], [], []
        for kind, val in tokenize(data):
            if kind != "op":
                stack.append((kind, val))
                continue
            nums = [v for k, v in stack if k == "num"]
            strs = [(k, v) for k, v in stack if k in ("lit", "hex")]
            names = [v for k, v in stack if k == "name"]
            arrs = [v for k, v in stack if k == "arr"]
            op = val

            def place(txt):
                if txt.strip():
                    text.append({"t": txt,
                                 "x": round(tm[4] * ctm[0] + ctm[4], 2),
                                 "y": round(tm[5] * ctm[3] + ctm[5], 2),
                                 "size": round(size * abs(tm[0] or 1) * abs(ctm[0] or 1), 2),
                                 "font": font})

            if op == "q":
                gs.append((list(ctm), fill_rgb))
            elif op == "Q" and gs:
                ctm, fill_rgb = gs.pop()
                ctm = list(ctm)
            elif op == "cm" and len(nums) >= 6:
                a, b, c, d, e, f = nums[-6:]
                ctm = [ctm[0] * a, 0, 0, ctm[3] * d, ctm[0] * e + ctm[4], ctm[3] * f + ctm[5]]
            elif op == "BT":
                tm = [1, 0, 0, 1, 0, 0]
                tlm = list(tm)
            elif op == "Tf" and nums:
                size = nums[-1]
                font = names[-1] if names else font
            elif op == "Tm" and len(nums) >= 6:
                tm = list(nums[-6:])
                tlm = list(tm)
            elif op in ("Td", "TD") and len(nums) >= 2:
                tlm = [tlm[0], tlm[1], tlm[2], tlm[3], tlm[4] + nums[-2], tlm[5] + nums[-1]]
                tm = list(tlm)
            elif op == "T*":
                tlm[5] -= size
                tm = list(tlm)
            elif op == "rg" and len(nums) >= 3:
                fill_rgb = tuple(round(v, 4) for v in nums[-3:])
            elif op == "g" and nums:
                fill_rgb = (round(nums[-1], 4),) * 3
            elif op == "re" and len(nums) >= 4:
                x, y, w, h = nums[-4:]
                pend.append([x * ctm[0] + ctm[4], y * ctm[3] + ctm[5], w * ctm[0], h * ctm[3]])
            elif op in ("f", "f*", "F", "b", "b*"):
                for r in pend:
                    fills.append({"x": round(r[0], 2), "y": round(r[1], 2),
                                  "w": round(r[2], 2), "h": round(r[3], 2), "rgb": fill_rgb})
                pend = []
            elif op in ("S", "s", "B", "B*", "n"):
                pend = []
            elif op in ("Tj", "'", '"') and strs:
                place(decode(strs[-1][0], strs[-1][1], font))
            elif op == "TJ" and arrs:
                place("".join(decode(k, v, font) for k, v in tokenize(arrs[-1]) if k in ("lit", "hex")))
            stack = []
    return {"text": text, "fills": fills, "page_w": page_w, "page_h": page_h}


# ---- reading the template ------------------------------------------------------------------
def tinted(hex6, tint):
    if not tint:
        return hex6
    r, g, b = (int(hex6[i:i + 2], 16) / 255 for i in (0, 2, 4))
    h, l, s = colorsys.rgb_to_hls(r, g, b)
    l = l * (1 + tint) if tint < 0 else l * (1 - tint) + tint
    r, g, b = colorsys.hls_to_rgb(h, max(0.0, min(1.0, l)), s)
    return "".join("%02X" % round(c * 255) for c in (r, g, b))


def read_sheet(path):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb["AFE Form"]
    theme_xml = wb.loaded_theme.decode("utf-8", "replace") if wb.loaded_theme else ""
    scheme = re.search(r"<a:clrScheme[^>]*>(.*?)</a:clrScheme>", theme_xml, re.S)
    by_name = {}
    if scheme:
        for m in re.finditer(r"<a:(\w+)>\s*<a:(srgbClr|sysClr)([^/>]*)/?>", scheme.group(1), re.S):
            attrs = m.group(3)
            v = re.search(r'lastClr="([0-9A-Fa-f]{6})"', attrs) or re.search(r'val="([0-9A-Fa-f]{6})"', attrs)
            by_name[m.group(1)] = v.group(1).upper() if v else "000000"
    theme = [by_name.get(n, "000000") for n in
             ("lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "hlink", "folHlink")]

    def color_of(c):
        if c is None:
            return None
        if c.type == "rgb" and isinstance(c.rgb, str):
            v = c.rgb
            if len(v) == 8:
                if v[:2] == "00":
                    return None
                v = v[2:]
            return "#" + tinted(v.upper(), c.tint or 0)
        if c.type == "theme" and c.theme is not None and c.theme < len(theme):
            return "#" + tinted(theme[c.theme], c.tint or 0)
        return None

    merges = []
    for rng in ws.merged_cells.ranges:
        c1, r1, c2, r2 = range_boundaries(str(rng))
        merges.append((r1, c1, r2, c2))

    cells = {}
    for r in range(1, 51):
        for c in range(1, 8):
            cell = ws.cell(row=r, column=c)
            v = cell.value
            if isinstance(v, datetime.datetime):
                v = v.date().isoformat()
            cells[(r, c)] = {
                "v": v,
                "fill": color_of(cell.fill.fgColor) if cell.fill and cell.fill.patternType == "solid" else None,
                "size": cell.font.size or 11, "bold": bool(cell.font.bold),
                "h": cell.alignment.horizontal, "vert": cell.alignment.vertical,
                "wrap": bool(cell.alignment.wrap_text), "indent": cell.alignment.indent or 0,
                "fmt": cell.number_format,
            }
    default_h = ws.sheet_format.defaultRowHeight or 15.0
    heights = {}
    for r in range(1, 51):
        d = ws.row_dimensions.get(r)
        heights[r] = round(d.height, 3) if d and d.height else default_h
    footer_text = []
    for side in ("left", "center", "right"):
        t = getattr(ws.oddFooter, side).text
        if t:
            footer_text.append({"side": side, "text": t})
    return cells, merges, heights, footer_text


# ---- putting the two together ---------------------------------------------------------------
def cluster(vals, tol):
    vals = sorted(vals)
    out = []
    for v in vals:
        if out and v - out[-1][-1] <= tol:
            out[-1].append(v)
        else:
            out.append([v])
    return [sum(g) / len(g) for g in out]


def build(xlsx, pdf):
    cells, merges, sheet_h, footer_text = read_sheet(xlsx)
    ref = read_pdf(pdf)

    black = [f for f in ref["fills"] if tuple(f["rgb"]) == (0, 0, 0)]
    vert = [f for f in black if f["w"] <= 1.6 and f["h"] > 2]
    horiz = [f for f in black if f["h"] <= 1.6 and f["w"] > 2]
    colx = cluster([f["x"] + f["w"] / 2 for f in vert], 1.0)
    if len(colx) != 8:
        raise SystemExit("expected 8 column boundaries, found %d: %r" % (len(colx), colx))

    # Row bands: the horizontal rules tile the sheet. Excel draws the bottom of one row and
    # the top of the next as separate hairlines about 1.2pt apart; merge those into one
    # boundary, then walk the boundaries down the page assigning them to rows that have a
    # rule. Rows without one (the blank spacers) take what is left between their neighbours.
    bounds = sorted(cluster([f["y"] + f["h"] / 2 for f in horiz], 2.0), reverse=True)

    # anchor rows by the text printed in them
    def norm(s):
        return re.sub(r"\s+", " ", str(s)).strip().lower()

    label_at = {}
    for (r, c), cell in cells.items():
        v = cell["v"]
        if isinstance(v, str) and v.strip():
            label_at.setdefault(norm(v)[:40], []).append(r)
    anchor = {}
    for run in ref["text"]:
        hit = label_at.get(norm(run["t"])[:40])
        if hit and len(set(hit)) == 1:
            anchor.setdefault(hit[0], []).append(run["y"])

    band = {}
    for r, ys in anchor.items():
        y = sum(ys) / len(ys)
        top = min([q for q in bounds if q > y - 0.5], default=None)
        bot = max([q for q in bounds if q < y - 0.5], default=None)
        if top is not None and bot is not None:
            band[r] = (bot, top)
    # rows 1 and the tail carry a fill but no anchor text — take them from the tint rects
    for f in ref["fills"]:
        if tuple(f["rgb"]) in ((0, 0, 0),):
            continue
        for r in range(1, 51):
            if r in band:
                continue
    known = sorted(band)
    for r in range(1, 51):                      # fill the gaps proportionally
        if r in band:
            continue
        below = [q for q in known if q < r]
        above = [q for q in known if q > r]
        if not below or not above:
            continue
        lo, hi = below[-1], above[0]
        top_of_gap, bot_of_gap = band[lo][0], band[hi][1]
        n = hi - lo - 1
        step = (top_of_gap - bot_of_gap) / n if n else 0
        i = r - lo - 1
        band[r] = (top_of_gap - step * (i + 1), top_of_gap - step * i)

    # Row 1 carries a tint but has no rule above it, so take its band from the fill itself.
    if 1 not in band:
        top_row = max((f for f in ref["fills"]
                       if tuple(f["rgb"]) not in ((0, 0, 0), (1, 1, 1)) and f["w"] > 400),
                      key=lambda f: f["y"], default=None)
        if top_row:
            band[1] = (round(top_row["y"], 2), round(top_row["y"] + top_row["h"], 2))

    # The tail rows (the footnotes and the closing line) carry no rules, so extend the grid
    # downwards using their stored heights at the scale the bordered rows printed at.
    ratios = [(band[r][1] - band[r][0]) / sheet_h[r] for r in band if sheet_h.get(r)]
    ratio = sorted(ratios)[len(ratios) // 2] if ratios else 0.59
    last = max(band)
    y = band[last][0]
    for r in range(last + 1, 51):
        h = sheet_h.get(r, 15.0) * ratio
        band[r] = (round(y - h, 2), round(y, 2))
        y -= h

    top_of_grid = max(f["y"] + f["h"] for f in ref["fills"])
    ref["header"] = [{"x": t["x"], "y": t["y"], "s": t["size"], "t": t["t"]}
                     for t in sorted(ref["text"], key=lambda t: (-t["y"], t["x"]))
                     if t["y"] > top_of_grid + 1]
    ref["gridTop"] = top_of_grid
    # The Excel page footer. Its glyphs come through the PDF re-encoded, so take the wording
    # from the sheet's own footer definition and only the positions from the print.
    bottom = min(band[r][0] for r in band)
    ref["footer"] = [{"x": t["x"], "y": t["y"], "s": t["size"]}
                     for t in sorted(ref["text"], key=lambda t: (-t["y"], t["x"]))
                     if t["y"] < bottom - 1]
    ref["footerText"] = footer_text
    return cells, merges, ref, colx, band


def js(v):
    return json.dumps(v, ensure_ascii=False)


def js_rows(v, indent="  "):
    """A list, one element per line — so the generated file reviews and diffs like source."""
    if not v:
        return "[]"
    nl = chr(10)
    body = ("," + nl).join(indent + json.dumps(x, ensure_ascii=False) for x in v)
    return "[" + nl + body + nl + "]"


def emit(xlsx, pdf):
    cells, merges, ref, colx, band = build(xlsx, pdf)

    def merged_of(r, c):
        for (r1, c1, r2, c2) in merges:
            if r1 <= r <= r2 and c1 <= c <= c2:
                return (r1, c1, r2, c2)
        return (r, c, r, c)

    def box(r, c):
        r1, c1, r2, c2 = merged_of(r, c)
        x0, x1 = colx[c1 - 1], colx[c2]
        top = band.get(r1, (0, 0))[1]
        bot = band.get(r2, (0, 0))[0]
        return [round(x0, 2), round(bot, 2), round(x1 - x0, 2), round(top - bot, 2)]

    # every rule and tint, exactly as Excel drew them
    rects = [{"x": f["x"], "y": f["y"], "w": f["w"], "h": f["h"],
              "c": "#%02X%02X%02X" % tuple(round(v * 255) for v in f["rgb"])}
             for f in ref["fills"]]

    def repair(run_text, cell_text):
        """Take the wording from the sheet, the position from the print.

        A CMap can be missing an entry — Excel's subsets often omit the space, and the
        footnote block loses the "A" of "All acquisitions" — so line the decoded run up
        against the cell it came from and lift the real characters.
        """
        if not isinstance(cell_text, str) or len(run_text) < 4:
            return run_text
        flat = cell_text.replace("\n", " ")
        n = len(run_text)
        if n > len(flat):
            return run_text
        best, score_best = None, 0
        for start in range(len(flat) - n + 1):
            window = flat[start:start + n]
            score = sum(1 for a, b in zip(run_text, window) if a == b or a == " ")
            if score > score_best:
                score_best, best = score, window
        return best if best is not None and score_best >= n * 0.85 else run_text

    # the printed labels: text runs that are not one of ours to fill in
    slot_rows = set(PROJECT_APPROVAL_ROWS) | set(FINANCIAL_ROWS)

    def is_ours(r, c):
        if (r, c) in SLOTS:
            return True
        if r in slot_rows and c in (3, 5, 7):
            return True
        if r in PROJECT_APPROVAL_ROWS and c == 2:
            return True
        return False

    # Which cell a printed run sits in — not what it says — decides whether it is the form's
    # own printing or the sample's data, and it carries the cell's weight across.
    def cell_at(x, y):
        col = next((c for c in range(1, 8) if colx[c - 1] - 0.5 <= x < colx[c] + 0.5), None)
        row = next((r for r in sorted(band) if band[r][0] - 1.0 <= y < band[r][1] + 1.0), None)
        return (row, col) if row and col else (None, None)

    grid_bottom = min(band[r][0] for r in band)
    labels, skipped, captions = [], [], {}
    for run in ref["text"]:
        if run["y"] > ref["gridTop"] + 1 or run["y"] < grid_bottom - 1:
            continue                              # the page header and footer, kept separately
        r, c = cell_at(run["x"], run["y"])
        if r is None:
            labels.append({"x": run["x"], "y": run["y"], "s": run["size"], "b": 0, "t": run["t"]})
            continue
        r1, c1 = merged_of(r, c)[0], merged_of(r, c)[1]
        # The Yes/No beside a checkbox is the form's own printing; the tool only marks one.
        if (r1, c1) in CHECK_SLOTS and run["t"].strip() in ("Yes", "No"):
            captions.setdefault((r1, c1), {})[run["t"].strip().lower()] = \
                {"x": run["x"], "y": run["y"], "s": run["size"]}
            labels.append({"x": run["x"], "y": run["y"], "s": run["size"], "b": 0, "t": run["t"]})
            continue
        if is_ours(r1, c1) or is_ours(r, c):
            skipped.append((r, c, run["t"]))
            continue                              # the sample's own value — ours to fill
        cell = cells[(r1, c1)]
        labels.append({"x": run["x"], "y": run["y"], "s": run["size"],
                       "b": 1 if cell["bold"] else 0, "t": repair(run["t"], cell["v"])})

    # Excel's "general" alignment is not left: it left-aligns text and right-aligns numbers
    # and dates. The form leans on that — the dates and the figures line up on the right of
    # their cells — so resolve it here rather than defaulting everything to left.
    def effective_align(cell):
        if cell["h"]:
            return cell["h"]
        v = cell["v"]
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return "right"
        if isinstance(v, str) and re.match(r"^\d{4}-\d\d-\d\d", v):
            return "right"
        fmt = cell["fmt"] or "General"
        if fmt != "General" and re.search(r"[0#]", fmt):
            return "right"
        return "left"

    slots = []
    for (r, c), key in sorted(SLOTS.items()):
        cell = cells[(r, c)]
        fmt = cell["fmt"] or ""
        slot = {"key": key, "box": box(r, c), "size": round(cell["size"] * 0.61, 2),
                "b": 1 if cell["bold"] else 0, "align": effective_align(cell),
                "wrap": 1 if cell["wrap"] else 0, "fmt": fmt}
        # Accounting format: the currency mark sits against the left edge and the figure
        # against the right, with a bare dash for nothing. That is why the form's money
        # columns line up, so it is worth reproducing rather than approximating.
        if "* " in fmt or '"$"*' in fmt:
            slot["accounting"] = 1
            slot["currency"] = "$" if '"$"' in fmt else ""
        if (r, c) in CHECK_SLOTS:
            slot["check"] = captions.get((r, c), {})
        slots.append(slot)

    # The form's own band table, read off column A and B rather than retyped. A band that
    # spans two rows (two signatures for one band) is merged in the sheet, so the second row
    # carries no band of its own.
    financial_rows = []
    for r in FINANCIAL_ROWS:
        a, b = cells[(r, 1)], cells[(r, 2)]
        r1, c1, r2, c2 = merged_of(r, 1)
        band_text = a["v"] if (r1, c1) == (r, 1) else None
        role = (b["v"] or "").rstrip() if isinstance(b["v"], str) else ""
        m = re.search(r"\(([AM]\d)\)", role)
        level = m.group(1) if m else ("BOARD" if "Board of Directors" in role else None)
        row = {"band": band_text if isinstance(band_text, str) else None,
               "role": b["v"] if isinstance(b["v"], str) else "", "level": level}
        if (r1, c1) == (r, 1) and r2 > r1:
            row["bandSpan"] = r2 - r1 + 1
        financial_rows.append(row)

    def sign_block(rows, kind):
        out = []
        for r in rows:
            row = {"row": r, "kind": kind}
            for name, c in SIGN_COLS.items():
                if kind == "financial" and name == "group":
                    continue
                cell = cells[(r, c)]
                row[name] = {"box": box(r, c), "size": round(cell["size"] * 0.61, 2),
                             "align": effective_align(cell)}
            out.append(row)
        return out

    body = f"""\
"use strict";
// The Filled AFE Form, as the printed page.
//
// GENERATED by tools/build_afe_form.py from the Global AFE Template (BR-DOC-08744 V7.0) and
// the PDF Excel prints from it. Do not edit by hand — change the template, re-export, re-run.
//
// Everything here is in PDF points on the template's own page, origin bottom-left. RECTS are
// the rules and tints exactly as Excel drew them; LABELS are the form's own printing at the
// coordinates Excel gave them; SLOTS and the two signing blocks are the boxes the tool fills.
const PAGE = {{ width: {ref['page_w']}, height: {ref['page_h']} }};

// The Excel page header, printed above the grid.
const DOC_HEADER = {js(ref['header'])};

// The Excel page footer: where the print puts it, and what the sheet says it says. Excel's
// own field codes (&K colour, &P page, &N of) are stripped; the lines are printed as they are.
const DOC_FOOTER = {{ boxes: {js(ref['footer'])}, lines: {js(ref['footerText'])} }};

// Column boundaries A..G (left edge of A through right edge of G).
const COLS = {js([round(v, 2) for v in colx])};

// Row bands: [bottom, top] per sheet row 1..50.
const ROWS = {js({str(r): [round(band[r][0], 2), round(band[r][1], 2)] for r in sorted(band)})};

const RECTS = {js_rows(rects)};

const LABELS = {js_rows(labels)};

const SLOTS = {js_rows(slots)};

// The form's own band table: which levels sign at which threshold, in the form's order.
const FINANCIAL_ROWS = {js_rows(financial_rows)};

// How many Group / Approver Name rows the Project Approvals block prints.
const PROJECT_APPROVAL_ROWS = {len(PROJECT_APPROVAL_ROWS)};

const PROJECT_APPROVALS = {js_rows(sign_block(PROJECT_APPROVAL_ROWS, 'project'))};

const FINANCIAL_APPROVALS = {js_rows(sign_block(FINANCIAL_ROWS, 'financial'))};

// DocuSign anchor strings, drawn in white inside each signer's own Signature and Date box so
// the tabs land on that person's row and nowhere else (R59).
const ANCHOR = {{ sig: (n) => `\\\\s${{n}}\\\\`, date: (n) => `\\\\d${{n}}\\\\` }};

module.exports = {{
  PAGE, DOC_HEADER, DOC_FOOTER, COLS, ROWS, RECTS, LABELS, SLOTS,
  FINANCIAL_ROWS, PROJECT_APPROVAL_ROWS, PROJECT_APPROVALS, FINANCIAL_APPROVALS, ANCHOR,
}};
"""
    OUT.write_text(body, encoding="utf-8", newline="\n")
    print("wrote %s" % OUT)
    print("  the sample's own values, left as slots to fill: %d" % len(skipped))
    for r, c, t in skipped:
        print("     %s%-3d %r" % (L[c - 1], r, t[:44]))
    print("  rects %d | labels %d | slots %d | rows %d" % (len(rects), len(labels), len(slots), len(band)))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    emit(sys.argv[1], sys.argv[2])
