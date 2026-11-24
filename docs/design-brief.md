# Design Brief — AFE to Fixed Asset Workbench (for Claude Design)

**Purpose of this brief:** input for a Claude Design session to shape the FA-facing UI before further code is written. Refine freely; the build implements what the canvas locks. Companion context: [PRD.md](PRD.md) §4–6, [attachment-review.md](attachment-review.md).

---

## 1. What this product is

An internal workbench for Acme's Fixed Asset (FA) team. Capital-expenditure requests arrive as **emails with document packages** (AFE forms in two regional variants, vendor quotes, DocuSign certificates, rental contracts, scans). Today the team reads everything manually, checks approval signatures against a matrix by hand, chases gaps over email, keys SAP, and maintains a 21-sheet Excel tracker. The workbench turns each email into a **case** that arrives *pre-analyzed* — fields extracted from the documents, arithmetic checked, the required approver chain computed, signatures verified against it, gaps flagged — and gives FA one place to review, chase (AI-drafted, FA-approved emails), hand off to SAP, and track through capitalization.

**One-line design goal:** an FA analyst opens a case and *knows in ten seconds* what's wrong, what's missing, and what to do next — without opening a single PDF unless they want to verify.

## 2. Users

- **FA Preparer** (primary; 90% of screen time): processes intake cases end-to-end. Finance-operations professional; lives in Excel/Outlook/SAP; values density, keyboard speed, and trust in what the system claims.
- **FA Checker**: independent reviewer; audit trail and four-eyes close-out.
- **Finance Leadership**: dashboard + drill-down, read-only.
- Requesters/approvers never see this UI (parked) — they stay in email.

## 3. Design principles

1. **Meet them at the mailbox.** The queue looks and sorts like an inbox that got smarter — not a form-first app.
2. **Flags, not gates.** The system highlights concerns; FA decides. Nothing auto-advances; nothing hard-blocks (until stakeholders say otherwise).
3. **Two kinds of truth, visually distinct.** *AI-suggested* (extraction values, draft emails, checklist suggestions) vs *FA-confirmed*. Suggested = tentative styling + confidence; confirmed = solid. The transition (confirm action) should feel deliberate and satisfying.
4. **Evidence at arm's reach.** Every claim ("A2 signature verified", "quote ≈ 93% of CapEx") links to its source — page anchor, certificate line, matrix row.
5. **Ops density, calm surface.** Data-dense tables and checklists, generous scan lines, restrained color reserved for state and severity.

## 4. Visual identity direction

- **Tone:** precise, institutional, quietly confident — audit-grade software, not a consumer app.
- **Color:** light-first. Paper-white ground with a slight green-grey bias; **deep Acme-adjacent green** as the single accent (primary actions, confirmed states); semantic set: amber = attention/flag, red = blocking-severity finding, blue = SAP/system-external, violet = AI-suggested. Dark mode optional later.
- **Type:** a clear grotesque for UI (system stack acceptable — final build is framework-free HTML/CSS), tabular numerals everywhere amounts/dates appear; monospace for T-codes, IO/AUC numbers, envelope IDs.
- **Iconography:** minimal, line-style; document-type glyphs (form, quote, certificate, contract, scan).
- **Status language:** chips for case state; small "pills" for confidence (e.g. `98%`), verification (`✓ M1 Balvan Nicholson`), and flags (`≥180d`, `>$100K`, `band: A1 missing`).

## 5. Screen inventory

### S1 — Case queue (home, P0)
Inbox-like list of cases: type badge (Normal/Demo/RRC), title/requester, amount, age, state chip, **top flag summary** ("2 signatures missing", "duplicate intake"), assignee. Bucket tabs mirroring FA's day: New · In review · Waiting on others · Ready for SAP · In construction · Pending capitalization. Counts on tabs. Global search. "New case from upload" button; mailbox entry point visible.

### S2 — Dev Mailbox (P0, demo-critical)
Two-pane simulated shared inbox (`RTR_FA`): message list (sender, subject, attachment count/icons, received) + reading pane with attachment cards. Primary action: **Create case** (or "attach to existing case" when dedupe matches). Sent tab shows outbound follow-ups labeled **SIMULATED — Dev Mailbox** (a visible, honest banner; Graph swap later removes it). This screen must make stakeholders *see* the mailbox-integration story.

### S3 — Case workspace (P0 — THE screen, spend most design effort here)
- **Header:** case number/title, type badge, state chip, amount, cost center → company code, requester, age, primary action button (context-sensitive: Confirm fields / Send follow-up / Accept → SAP handoff).
- **Layout:** split view. **Left: document viewer** — package file list (doc-type glyph + name + text/scan indicator), page thumbnails, main page render with **highlight overlays** on regions that produced flagged/low-confidence fields. **Right: work panel** with tabs:
  1. **Review** (default): extracted fields grouped as on the form (header, financials, budget classification, line items) — each row: label · value (editable) · confidence pill · page anchor (click → viewer jumps) · state (suggested/confirmed/corrected). Sticky "Confirm all reviewed" bar.
  2. **Checks:** the deterministic findings list — pass/warn rows with plain-English detail ("CapEx+OpEx ≠ Total: $25,600 vs $25,000") and severity.
  3. **Approvals:** the required chain as a vertical ladder (band brackets visible: "$25,001–$100,000 adds A1+A2") — per level: required name from matrix · evidence found (DocuSign signer, timestamp, envelope) · status (✓ satisfied / ✗ missing / ⚠ mismatched person / delegated-with-evidence). Gap rows carry a "Draft chase" shortcut.
  4. **Checklist:** type-aware document checklist — template items + FA-added + AI-suggested (distinct styling); satisfy-by-linking-a-document interaction; waive with note.
  5. **Correspondence:** the case's email thread (in/out), follow-up statuses, reminders.
  6. **SAP handoff / Tracking / Audit:** carry-over designs from the current build (keep structure, restyle).

### S4 — Follow-up composer (P0; modal or side sheet from S3)
Context header ("Missing: A1 signature · vendor quote"). **Draft with AI** produces a body in the team's voice (violet "AI draft" banner until edited); recipients pre-filled from case; FA edits inline; **Send** (labeled simulated in Dev Mailbox mode); "save as draft". After send: lands in Correspondence + Sent mailbox. Design the trust moment: FA must feel in control of every word.

### S5 — Dashboard (P1, restyle of existing)
BlackLine-style tiles (open AUC balance, flagged counts by reason, aging buckets, cases by state, oldest pending) → every tile drills to a filtered queue/tracker. Data is real: $10.2M open balance, 60 flagged, 47 aged 180+.

### S6 — AUC Tracker (P1, restyle of existing)
Dense reconciliation grid replacing the 21-sheet workbook: IO, description, contact, balances, consumed %, age, flags; row → case. CSV export. Filters = flag reasons.

### S7 — Imports (P2) & S8 — Admin (P2)
Imports: SAP budget-export upload + batch history + matched/unmatched report. Admin: role registry, checklist templates editor, mailbox connection state, AI settings (model, confidence threshold), demo reset, act-as (with persistent banner).

## 6. Component inventory (design once, reuse)

Case card/row · state chip set (11 states) · flag pill set (severity + reason) · **confidence pill** (suggested/confirmed/corrected variants) · verification ladder row · checklist item (3 sources × 3 states) · document card (type glyph, text/scan tag) · page-anchor link · doc viewer with highlight overlay · composer sheet with AI-draft banner · correspondence timeline item (in/out/simulated) · audit row (actor, acting-as, event, from→to) · dashboard tile · dense data table (sortable, sticky header, tabular numerals).

## 7. Interaction rules

- Confirm-fields is the only way values become case-of-record; bulk confirm allowed only for rows already viewed.
- Every AI artifact (value, draft, suggestion) shows its origin and can be discarded in one action.
- Simulated sends are always labeled; never let a demo viewer believe an email actually left.
- Keyboard-first review: up/down through fields, Enter to confirm, E to edit, V to jump to source page.
- Empty/edge states to design: extraction failed (manual-entry invitation, not an error wall) · scan-only document · duplicate-intake banner · RRC case (no AFE form — checklist leads) · AI unconfigured (Wave-1 mode: Review tab starts empty-editable).

## 8. Content & tone

Plain finance English, no ML jargon on the surface ("Read from page 3" not "inference"; "Needs attention" not "anomaly"). Buttons say what happens: "Confirm 14 fields", "Draft chase email", "Mark N/A with reason". Flag copy states the rule: "Balance $268,081 exceeds $100K — quarterly review trigger".

## 9. Real content to design with (do not lorem-ipsum)

Use the four real cases: **Banjo** ($24,315, M1-only band, signed, number-assignment ask), **ID-Centrifuge** (APAC/Demo 1-pager, INR 274,722 → $3,057, duplicate email), **Line 5 Filler** ($25,600 — $600 over band → 3 signers, redline history), **Federal Medical Center rental** (RRC, no AFE, $273K/5yr contract package incl. one scanned approval). Details in [attachment-review.md](attachment-review.md).

## 10. Constraints for the eventual build (design within these)

Framework-free implementation (vanilla HTML/CSS/JS, single-page, hash routes) on the Acme ADC pattern — favor systematic tokens/components over bespoke per-screen art; no webfont dependence required (system stack acceptable); tables must survive 1366×768 laptops; WCAG-AA contrast; the doc viewer renders PDF pages as images with absolutely-positioned highlight divs (design the overlay language accordingly).

## 11. Open design questions (decide on the canvas)

1. Queue: single list with bucket tabs vs kanban-style columns?
2. Case workspace: tabs (proposed) vs single scrolling dossier with sticky section nav?
3. Doc viewer: persistent split vs collapsible drawer (more room for the work panel)?
4. Confidence display: percentage pills vs three-tier dots (high/med/low) — what reads calmer at density?
5. Where does the band ladder live best: Approvals tab (proposed) vs always-visible header strip?
6. How loud should the AI-suggested styling be — violet tint per row vs a single section banner?
