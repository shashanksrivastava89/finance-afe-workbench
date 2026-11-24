#!/usr/bin/env python3
"""
build_seeds.py — one-time, LOCAL-ONLY converter: real source exports -> committed seed/*.json

Run:  python tools/build_seeds.py [source_dir]
Default source_dir: C:/Users/Hello/Downloads/AFE-to-Asset-Capitalization

Deliberately deterministic (no now()/random): provenance dates are literals.
Raw source files are NEVER committed — only the JSON this script emits.
Requires: openpyxl (local dev machine only; the Node runtime never parses Excel).

STALE AS OF 2026-09-04 (v0.4 Stage 0). It still produces the three seeds the app uses —
approver-matrix.json, tracker.json, sap-budget-baseline.json — but its build_users /
build_afes / build_template / demo_tracker_rows functions write files that no longer exist
(cases.json, mailbox.json, afes.json, ui-tokens.json, afe-template.json, tracker-demo.json)
and will overwrite users.json with the old shape. Run the individual builders you need, not
main(). Stage 6 of docs/v0.4-blueprint.md replaces this script with lib/ingest/*, which
parses the same exports at run time behind POST /api/ingest/:kind.
"""
import json, re, sys, os

SRC = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\Hello\Downloads\AFE-to-Asset-Capitalization"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed")
SEED_CUT_DATE = "2026-08-26"          # the day this seed set was cut (provenance literal)
# Seeded cases point at cost centres that exist in BOTH the approver matrix and the
# AuC Recon file, so division, the approval chain and the recon all join up. Values
# that join to nothing make the app look integrated while proving nothing.
REAL_CC_FOR_CASE = {
    "C-2612": ("10423", "Facilities"), "C-2611": ("10224", "MFG"),
    "C-2614": ("10920", "LSG_R&D"),    "C-2613": ("10419", "Facilities"),
    "C-2610": ("10913", "LSG_R&D"),    "C-2607": ("10149", "CORP_IT"),
    "C-2589": ("10219", "MFG"),        "C-2581": ("10657", "MFG"),
    "C-2554": ("10418", "Facilities"),
}

LEVELS = ["M1", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9"]

def write(name, obj):
    os.makedirs(OUT, exist_ok=True)
    p = os.path.join(OUT, name)
    with open(p, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False)
    print(f"  wrote seed/{name}  ({os.path.getsize(p):,} bytes)")

# ---------------------------------------------------------------- matrix ----
def build_matrix():
    path = os.path.join(SRC, "List of Cost Center.xls")  # UTF-16 TSV despite .xls
    raw = open(path, "rb").read().decode("utf-16", errors="ignore")
    lines = raw.splitlines()
    rows, skipped, blank_level_rows, inactive = [], 0, 0, 0
    for ln in lines:
        parts = ln.split("\t")
        if len(parts) < 16 or not parts[1].strip().isdigit():
            skipped += 1
            continue
        levels = {}
        blanks = 0
        for i, lv in enumerate(LEVELS):
            name = parts[6 + i].strip()
            levels[lv] = {"name": name}
            if not name:
                blanks += 1
        if blanks:
            blank_level_rows += 1
        status = parts[3].strip()
        if status and status.lower() != "active":
            inactive += 1
        rows.append({
            "costCenter": parts[1].strip(),
            "status": status or "Unknown",
            "description": parts[4].strip(),
            "plant": parts[5].strip(),
            "levels": levels,
        })
    print(f"MATRIX quality report: {len(rows)} cost centers | {skipped} non-data lines skipped "
          f"| {blank_level_rows} rows with >=1 blank level | {inactive} non-active")
    write("approver-matrix.json", {
        "batchId": "mx-0001",
        "filename": "List of Cost Center.xls",
        "reportDate": "2026-08-18",
        "importedAt": SEED_CUT_DATE,
        "rows": rows,
    })
    return rows

# ---------------------------------------------------------------- tracker ---
def cell(ws_row, idx):
    v = ws_row[idx - 1] if idx - 1 < len(ws_row) else None
    return v

def iso(v):
    return str(v)[:10] if v not in (None, "") else None

def num(v):
    if v in (None, ""):
        return 0.0
    try:
        return round(float(v), 2)
    except (TypeError, ValueError):
        return 0.0

def build_tracker():
    import openpyxl
    path = os.path.join(SRC, "169000-169999_AuC Recon_2026 .08.xlsx")
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    # The master tab, not the monthly one: the monthly copy is filtered to a
    # single period, while "AuC Recon" carries every open line across all divisions.
    ws = wb["AuC Recon"]
    items = []
    n = 0
    for r in ws.iter_rows(min_row=10, max_col=73, values_only=True):
        io = cell(r, 4)
        if io in (None, ""):
            continue
        n += 1
        esd_history = []
        orig = iso(cell(r, 60))
        if orig:
            esd_history.append({"estimatedServiceDate": orig, "kind": "initial", "note": "from legacy tracker", "enteredByEmail": None, "enteredAt": SEED_CUT_DATE})
        subs = cell(r, 61)
        if subs not in (None, ""):
            for tok in re.split(r"[\n]+", str(subs)):
                tok = tok.strip()
                if tok and tok != orig:
                    esd_history.append({"estimatedServiceDate": tok, "kind": "reforecast", "note": "legacy re-forecast (imported text)", "enteredByEmail": None, "enteredAt": SEED_CUT_DATE})
        cur = iso(cell(r, 62))
        if cur and all(h["estimatedServiceDate"] != cur for h in esd_history):
            esd_history.append({"estimatedServiceDate": cur, "kind": "reforecast", "note": "current estimate at import", "enteredByEmail": None, "enteredAt": SEED_CUT_DATE})
        comments = []
        prep = cell(r, 68)
        if prep not in (None, ""):
            comments.append({"kind": "preparer_note", "body": str(prep).strip(), "authorEmail": None, "authorName": "FA (legacy import)", "createdAt": SEED_CUT_DATE})
        rev = cell(r, 70)
        if rev not in (None, ""):
            comments.append({"kind": "reviewer_note", "body": str(rev).strip(), "authorEmail": None, "authorName": "Reviewer (legacy import)", "createdAt": SEED_CUT_DATE})
        items.append({
            "id": f"trk-{n:04d}",
            "afeId": None,
            "companyCode": str(cell(r, 1) or "1000"),
            "contactPersonName": str(cell(r, 2) or "").strip(),
            "contactPersonEmail": None,
            "division": str(cell(r, 3) or "").strip(),
            "ioNumber": str(io).strip(),
            "ioDescription": str(cell(r, 5) or "").strip(),
            "openClosed": str(cell(r, 6) or "Open").strip(),
            "glAccount": str(cell(r, 7) or "").strip(),
            "glDescription": str(cell(r, 8) or "").strip(),
            "building": str(cell(r, 9) or "").strip(),
            "costCenter": str(cell(r, 10) or "").strip(),
            "aucNumber": str(cell(r, 11) or "").strip(),
            "aucStatus": str(cell(r, 12) or "").strip(),
            "faNumber": str(cell(r, 13) or "").strip(),
            "assetClass": str(cell(r, 14) or "").strip(),
            "capexUsd": num(cell(r, 49)),
            "opexUsd": num(cell(r, 50)),
            "balanceForward": num(cell(r, 51)),
            "additionsConsumed": num(cell(r, 52)),
            "transferToAsset": num(cell(r, 53)),
            "otherExpense": num(cell(r, 54)),
            "endingBalance": num(cell(r, 55)),
            "commitment": num(cell(r, 56)),
            "openAfeAmount": num(cell(r, 57)),
            "consumedPctFile": num(cell(r, 58)),
            "issueDate": iso(cell(r, 59)),
            "finalServiceDate": iso(cell(r, 63)),
            # Who the AUC confirmation actually goes to. Distinct from the Contact
            # Person (the project owner) and sometimes carries a cc list.
            "reviewerName": str(cell(r, 69) or "").strip(),
            "gt100kFlag": str(cell(r, 71) or "").strip(),
            "esdHistory": esd_history,
            "comments": comments,
            "version": 1,
        })
    open_count = sum(1 for i in items if i["openClosed"].lower() == "open")
    divisions = sorted({i["division"] for i in items if i["division"]})
    no_reviewer = sum(1 for i in items if not i["reviewerName"])
    print(f"TRACKER: {len(items)} rows from 'AuC Recon' (CO 1000) | {open_count} open "
          f"| {len(divisions)} divisions | {no_reviewer} rows with no responsible reviewer")
    print("         NOTE: workbook covers company code 1000 only - APAC codes arrive with Q2 answer")
    return items

# ------------------------------------------------------------ budget rows ---
def parse_amount(tok):
    tok = tok.strip().strip('"').replace(",", "")
    if tok in ("", "-"):
        return 0.0
    try:
        return round(float(tok), 2)
    except ValueError:
        return 0.0

def build_budget(tracker_ios):
    path = os.path.join(SRC, "Budget Details.xls")  # UTF-16 TSV despite .xls
    raw = open(path, "rb").read().decode("utf-16", errors="ignore")
    lines = raw.splitlines()
    keep, total_lines, matched = [], 0, 0
    io_re = re.compile(r'^\s*"?\s{0,4}(\d{6,10})\s+(.*)$')
    for ln in lines[1:]:
        if ln.startswith("*"):
            continue
        parts = ln.split("\t")
        if len(parts) < 6:
            continue
        m = io_re.match(parts[0])
        if not m:
            continue
        total_lines += 1
        io = m.group(1)
        if io not in tracker_ios:
            continue
        matched += 1
        keep.append({
            "ioNumber": io,
            "description": m.group(2).strip().strip('"'),
            "budget": parse_amount(parts[1]),
            "actual": parse_amount(parts[2]),
            "commitment": parse_amount(parts[3]),
            "allotted": parse_amount(parts[4]),
            "available": parse_amount(parts[5]),
        })
    print(f"BUDGET: {total_lines} IO rows in export | {matched} matched tracker IOs kept "
          f"| full raw file stays local for the live-upload demo")
    write("sap-budget-baseline.json", {
        "batchId": "imp-0001",
        "filename": "Budget Details.xls",
        "asOfDate": "2026-08-18",
        "importedByEmail": "seed",
        "importedAt": SEED_CUT_DATE,
        "rows": keep,
    })

if __name__ == "__main__":
    # Reference data only: the SAP approver matrix, the AuC recon lines and the per-IO budget
    # baseline, all straight from the real exports. The v0.2 demo generator that used to live
    # here — invented AFEs, invented AuC lines and `@demo.local` personas — is gone: v0.4 seeds
    # real Acme identities by hand in users.json (an ADC non-negotiable), and AFEs are
    # created through the wizard, which is the point of the rebuild.
    print(f"Source: {SRC}")
    build_matrix()
    tracker_items = build_tracker()
    write("tracker.json", {"items": tracker_items})
    build_budget({t["ioNumber"] for t in tracker_items})
    print("Done. Commit seed/*.json — never the raw source files.")
