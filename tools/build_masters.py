#!/usr/bin/env python3
"""Generate the reference-data seeds the business maintains, from the AFE template itself.

    python tools/build_masters.py "<Global AFE Template .xlsx>"

Writes seed/locations.json, seed/reference-lists.json, seed/asset-classes.json and
seed/asset-lives.json. All of it is REFERENCE data straight out of the template's own hidden
sheets — the `Reference` sheet's Location List (150 sites, the spelling that prints on the form,
building number included) and Type List (16 project types), and the `DataVal` sheet's Asset Class
(35 values) and Asset Life in years (13). Nothing here comes from the personnel exports, so
unlike `build_seeds.py` this one's inputs are safe to keep.

Run it again when the template changes. Do not hand-edit the output: the whole point of
lib/mdm is that the business edits these lists in Excel, through the app, where every change is
versioned — and a hand-edit in the repo would be silently overwritten by the first import.
"""
import json
import pathlib
import sys

try:
    import openpyxl
except ImportError:
    sys.exit("openpyxl is needed locally: pip install openpyxl")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SEED = ROOT / "seed"

# How many years each asset-life band actually depreciates over (R96).
#
# The band's own label carries the number — "7-Machinery and Equipment" is seven years — but two
# of the thirteen are RANGES, and a range cannot divide a cost. The template answers that itself:
# its worked example picks `3-5-Softwares` and puts 5 in the Life column, so the upper bound is
# what Acme uses. Both are marked `openRange` so the two that were decided here rather than
# read off the label are visible, and the column is editable master data — Jarrod can change a
# number without a deploy, which is the point of it being data at all.
LIFE_YEARS = {
    "3-Automobiles": (3, False),
    "3-Personal Computers": (3, False),
    "3-5-Softwares": (5, True),
    "3-5-Computer equipment": (5, True),
    "5-Research equipment": (5, False),
    "5-Engineering equipment": (5, False),
    "5-Trade Shows Exhibits": (5, False),
    "5-Office Equipment mechanical": (5, False),
    "7-Machinery and Equipment(Production, Warehousing, Shipping)": (7, False),
    "10-Office Furniture and Fixtures": (10, False),
    "10-Building Improvements": (10, False),
    "39-New Prefabricated Buildings and Old Conventional Buildings": (39, False),
    "39-New Conventional Buildings": (39, False),
}

# The drop-downs that are NOT in the template's Reference sheet but are business config all the
# same: the tool has carried them in code, and they belong with the rest of the master data so a
# change does not need a deploy. Sources are noted per list.
EXTRA_LISTS = [
    # Regions the approval matrix and the budget pots both key off.
    ("region", "NLAM", "North America and Latin America", 1),
    ("region", "EMEA", "Europe, Middle East and Africa", 2),
    ("region", "APAC", "Asia Pacific", 3),
    ("region", "Global", "More than one region", 4),
    # SAP internal-order types. Z005's selection rule is still open (PRD Q25) — both are offered
    # and nothing is guessed.
    ("order_type", "Z002", "Capital Investment Order", 1),
    ("order_type", "Z005", "Second order type in use — selection rule pending (Q25)", 2),
    # The form's own Yes/No/NA answers.
    ("buy_vs_lease", "Yes", "Yes, reviewed with Procurement", 1),
    ("buy_vs_lease", "No", "No", 2),
    ("buy_vs_lease", "N/A", "Not applicable", 3),
    ("new_equipment", "New", "New equipment", 1),
    ("new_equipment", "Used", "Used or refurbished", 2),
    ("new_equipment", "N/A", "Not an equipment purchase", 3),
    ("yes_no_na", "Yes", "Yes", 1),
    ("yes_no_na", "No", "No", 2),
    ("yes_no_na", "N/A", "Not applicable", 3),
]


def column(rows, header_text):
    """Values under the header cell whose text starts with `header_text`."""
    header = rows[0]
    for c, h in enumerate(header):
        if h and str(h).strip().lower().startswith(header_text.lower()):
            out = []
            for r in rows[1:]:
                v = r[c] if c < len(r) else None
                if v not in (None, ""):
                    out.append(str(v).strip())
            return out
    raise SystemExit(f'the Reference sheet has no "{header_text}" column')


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    template = pathlib.Path(sys.argv[1])
    if not template.exists():
        sys.exit(f"no such file: {template}")

    wb = openpyxl.load_workbook(template, read_only=True, data_only=True)
    if "Reference" not in wb.sheetnames:
        sys.exit(f"{template.name} has no Reference sheet — is it the Global AFE Template?")
    rows = list(wb["Reference"].iter_rows(values_only=True))

    # --- locations -------------------------------------------------------------------------
    codes = column(rows, "Location List")
    seen, locations = set(), []
    for code in codes:
        if code in seen:
            continue
        seen.add(code)
        parts = code.split("_")
        locations.append({
            "code": code,
            "country": parts[0] if len(parts) > 1 else "",
            "city": parts[1] if len(parts) > 2 else "",
            "active": True,
        })
    locations.sort(key=lambda x: x["code"])

    (SEED / "locations.json").write_text(json.dumps({
        "_note": "Generated by tools/build_masters.py from the Global AFE Template's Reference "
                 "sheet (Location List). The code is what prints in the form's Location cell and "
                 "carries the building number Fixed Assets files property tax against. Maintained "
                 "from here on in Admin > Master data; regenerate only when the template changes.",
        "source": template.name,
        "locations": locations,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # --- reference lists -------------------------------------------------------------------
    entries = []
    for i, value in enumerate(column(rows, "Type List"), start=1):
        entries.append({"list": "project_type", "value": value, "label": value, "sortOrder": i, "active": True})
    for name, value, label, order in EXTRA_LISTS:
        entries.append({"list": name, "value": value, "label": label, "sortOrder": order, "active": True})
    for e in entries:
        e["list_value"] = f'{e["list"]}|{e["value"]}'

    (SEED / "reference-lists.json").write_text(json.dumps({
        "_note": "The drop-downs. project_type comes from the Global AFE Template's Reference "
                 "sheet (Type List); the rest were business config held in code until v0.5. "
                 "Maintained in Admin > Master data.",
        "source": template.name,
        "entries": entries,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # ---- the two SAP designations the Asset Acquisition block asks for (R96) ----------------
    dataval = wb["DataVal"]
    classes = []
    lives = []
    for i, row in enumerate(dataval.iter_rows(min_row=2, values_only=True), start=1):
        life = (row[0] or "").strip() if row and len(row) > 0 and row[0] else ""
        klass = (row[2] or "").strip() if row and len(row) > 2 and row[2] else ""
        if life:
            years, open_range = LIFE_YEARS.get(life, (None, False))
            if years is None:
                sys.exit(f"DataVal has an asset life this generator has no year for: {life!r}. "
                         "Add it to LIFE_YEARS — a life without a number cannot depreciate a cost.")
            lives.append({
                "value": life,
                "label": life,
                # The number the depreciation is actually divided by. Never parsed from the label
                # at read time: a band like "3-5-Softwares" has no single right answer, and the
                # answer is a business decision, made once, here.
                "years": years,
                "openRange": open_range,
                "sortOrder": len(lives) + 1,
                "active": True,
            })
        if klass:
            code, _, name = klass.partition("-")
            classes.append({
                "value": klass,
                "code": code.strip(),
                "label": name.strip() or klass,
                "sortOrder": len(classes) + 1,
                "active": True,
            })

    (SEED / "asset-lives.json").write_text(json.dumps({
        "_note": "Asset Life in years, from the template's DataVal sheet. `years` is what the "
                 "cost is divided by to get the annual depreciation; two bands are ranges and "
                 "take their upper bound, which is what the template's own worked example does. "
                 "Maintained in Admin > Master data.",
        "source": template.name,
        "entries": lives,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    (SEED / "asset-classes.json").write_text(json.dumps({
        "_note": "SAP asset classes, from the template's DataVal sheet. The value is what prints "
                 "on the form and what Fixed Assets keys at AS01. Maintained in Admin > Master data.",
        "source": template.name,
        "entries": classes,
    }, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    by_list = {}
    for e in entries:
        by_list[e["list"]] = by_list.get(e["list"], 0) + 1
    print(f"seed/asset-classes.json    {len(classes)} classes")
    print(f"seed/asset-lives.json      {len(lives)} lives — "
          + ", ".join(f"{x['years']}y" for x in lives))
    print(f"seed/locations.json        {len(locations)} sites")
    print(f"seed/reference-lists.json  {len(entries)} values — " + ", ".join(f"{k} {v}" for k, v in sorted(by_list.items())))
    print("\nNext: node tools/build-master-workbooks.js   (the prefilled .xlsx the team edits)")


if __name__ == "__main__":
    main()
