"""Build the form's vendored typeface from the upstream Carlito release.

The AFE Form is set in Carlito, which is metrically identical to the template's Calibri and
licensed OFL — so the generated form breaks lines exactly where Acme's own form breaks
them, without redistributing a Microsoft font.

Two things this has to get right:

  * **A real sfnt, not a WOFF.** `@pdf-lib/fontkit` reads a WOFF's header but cannot reach the
    glyph data inside one, and embeds a font whose outlines are mostly missing — the page
    renders with letters dropped out. fontTools unwraps it properly.
  * **Subset here, not at render time.** pdf-lib's own subsetter mis-writes this font (same
    dropped letters), so the vendored file is cut down to the characters the form can print
    and `afeForm.js` embeds it whole with `subset: false`.

    python tools/build_form_font.py <Carlito-Regular.woff> <Carlito-Bold.woff>

The upstream files come from the OFL release (`npm pack @openfonts/carlito_all`); they are not
committed, the subset is. Re-run it if the character range ever needs to grow.
"""
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

OUT = Path(__file__).resolve().parent.parent / "lib" / "pdf" / "assets"

# Everything lib/pdf/afeForm.js can put on the page: WinAnsi, which is Latin-1 plus the
# CP1252 punctuation. Text is folded to this range before drawing, so nothing else can reach
# the font.
UNICODES = (
    list(range(0x20, 0x7F))
    + list(range(0xA0, 0x100))
    + [0x20AC, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160,
       0x2039, 0x0152, 0x017D, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
       0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x017E, 0x0178]
)


def build(src, dst):
    font = TTFont(src)                       # fontTools reads WOFF and OTF as well as TTF
    font.flavor = None                       # write a plain sfnt
    options = subset.Options()
    # Kerning only. Carlito carries Calibri's ti/fi/ffi ligatures, and a ligature in a cell is
    # both wrong for a spreadsheet form (Excel does not form them) and mis-advanced by pdf-lib,
    # which leaves a gap in the middle of "Estimated" and "Location".
    options.layout_features = ["kern"]
    options.name_IDs = ["*"]                 # keep the licence and family names in the file
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables = ["DSIG"]
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=UNICODES)
    subsetter.subset(font)
    font.save(dst)
    font.close()
    kept = TTFont(dst)
    n = kept["maxp"].numGlyphs
    kept.close()
    return n


if __name__ == "__main__":
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    for src, name in zip(sys.argv[1:3], ("Carlito-Regular.ttf", "Carlito-Bold.ttf")):
        dst = OUT / name
        glyphs = build(src, dst)
        print("%-22s %7d bytes  %d glyphs" % (name, dst.stat().st_size, glyphs))
