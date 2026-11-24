# Implementation Plan — AFE to Fixed Asset Automation

**Version:** 0.2 (2026-08-27) · **Companion:** [PRD.md](PRD.md), [ERD.md](ERD.md), [attachment-review.md](attachment-review.md), [design-brief.md](design-brief.md)
**Mode:** FDE / vibe-coded, single engineer. **v0.2 pivot:** FA-first, document-first; design refined in Claude Design before further UI build (pointer 10).

## 0. Where we stand

The v0.1 scaffold is built, smoke-tested (34/34) and ADC-compliant: state machine, chain builder (band × 2,561-cc matrix), validation checks, SAP handoff capture, tracker + dashboard on real data, SAP-export import, outbox, audit, act-as demo roles. **All of it carries forward** — the chain engine now powers *verification*, the outbox gains a mailbox sibling, and the AFE record becomes the case's financial core.

## 1. Sequence (design-gated)

| Step | Theme | Exit criteria |
|---|---|---|
| **D0** | Docs v0.2 + design brief → Claude Design | ✅ done — canvas approved as `AFE Workbench v2.dc.html` |
| **D1 (done)** | **Design implemented** | ✅ All six screens live on the real backend: case queue, Dev Mailbox (create-case / duplicate-attach), case workspace (doc viewer + overlays, field ledger with confirm/correct + keyboard review, checks, approvals ladder, checklist, correspondence, SAP handoff, audit), AI-draft composer with simulated send, dashboard + tracker on the real 71-IO dataset. `tools/smoke-cases.js` 41/41; v0.1 suite 34/34; ADC checks clean |
| **D2 (done)** | **Live Document Intelligence + FA usability pass** | ✅ Upload → `afe-docintel-dev` → populated case, reconstructed pages from DI word polygons, resizable/zoomable document pane. Usability fixes from the first real FA session: reading-in-progress banner, border-only highlights with hover labels and one-at-a-time focus mode, highlight → field-row linking, add-documents-to-an-open-case, the exact KO01/KO22/AS01/KO02 keying sheet built from confirmed values, and a follow-up composer that attaches the real documents and exports an Outlook-ready `.eml`. `tools/smoke-intake.js` green against live DI |
| **D3 (2026-09-02)** | **Direction change → requester-first** | ⏸ The Early Review re-set the starting point: the requester creates the AFE in a wizard, approvals route from cost centre × cost and are decided in-tool, FA does a judgmental check and issues; a project page per IO tracks committed / actual / balance from a scheduled SAP extract; SOX chasing is automated. Requirements R15–R35 and Q30–Q40 in `docs/v0.3-requester-first.md`; screens on the *AFE Requester-First Workbench* canvas. W1/W2 below are superseded; ⑤ (AUC review) and the KO01 sheet carry forward unchanged. Next: Aiden session (form rules), PM co-design (Sayeenath / Troy / Anaru), Euan × SAP (extracts), then Phase A build for management approval |
| **W1-a** | Case & mailbox spine | `cases` aggregate (refactor from `afes`), Dev Mailbox seeded with the 4 real packages, create-case-from-email + upload, dedupe (P10), case queue |
| **W1-b** | Deterministic analysis | DocuSign certificate parser + `verifyChain` (per-level satisfied/missing/mismatch), arithmetic/classification checks on case fields, type-aware checklists (static), AFE number registry (pending Q4) |
| **W1-c** | Coordination v1 | Follow-up composer (manual text), send via Dev Mailbox (visibly simulated), thread on case, reminder resurfacing; **Wave-1 demo** on the four real packages |
| **W2-a** | Extraction | `aiClient` (env-gated) + tier0 xlsx + tier1 pdf-text + tier2 vision against `extractSchemas`; async extraction; side-by-side review UI (per Claude Design); confirm-fields flow with dual-value audit |
| **W2-b** | Intelligence assists | AI-drafted follow-ups (FA edits/approves), completeness suggestions, concern highlighting on the doc viewer; **Wave-2 demo** + eval-set scoring |
| **W3** | Post-review | Requester exposure decision, Graph mailbox go-live (Q22), OSS model trial behind `aiClient`, Postgres/Blob graduation, Phase-2 SAP seam |

Wave-1 has **zero AI dependency** — it demos even if AOAI config lags. Wave-2 flips on via app settings (`AOAI_ENDPOINT`/key), never a code change.

## 2. Demo script v0.2 (~20 min, FA-centric, the four real packages)

1. **Dev Mailbox** shows the real inbox shapes: Banjo (number-assignment ask), Centrifuge ×2 (duplicate!), Line 5 Filler, FedMed rental. Create case from the Centrifuge email — the duplicate auto-attaches with a flag (P10).
2. **Case opens pre-analyzed** (W2) / with checks on entered fields (W1): band says *$25,600 → M1+A1+A2*; DocuSign certificate parsed — all three signatures verified against the named chain for CC 10658 (P1+P3, on the L5 case). Show the mismatch demo: remove one signer → "A1 signature missing" flag.
3. **Checklist per type**: open the FedMed RRC case — contract + CPQ + internal approval + IAL ticked; note the internal approval is a scan (tier-2 path). No AFE form required for RRC (P6).
4. **Follow-up composer**: on a case with a gap, click draft — the template draft opens instantly from the case's gaps (badged TEMPLATE); *Rewrite with AI* replaces it with a gpt-4.1 draft (badged AI DRAFT); FA edits a line. Either send it simulated — it lands in the Dev Mailbox "Sent" view and on the case thread (P8) — or **Open in Outlook (.eml)**, which downloads the draft with the case documents attached and `X-Unsent: 1` so Outlook opens it ready to edit and send for real.
5. **Extraction review** (W2): Banjo AFE side-by-side — fields, confidences, page anchors; one low-confidence field highlighted; FA corrects, confirms; audit shows ai_suggested → fa_confirmed.
6. **Unchanged spine**: accept → SAP handoff → tracker row → dashboard tiles ($10.2M open AUC balance, 60 flagged) → capitalize → four-eyes close. The handoff is not a sample any more: it is the field-by-field KO01 sheet (Order Type Z002 · Controlling Area BR00 · Order = AFE# · 40-char description · Work Start = the day you key it, which is what the SOX aging clock measures) built from the values the FA confirmed, each row copyable, followed by KO22 (budget), AS01 (AUC) and KO02 (settlement rule). Anything the documents did not yield reads *— not extracted* in red.
7. Close on the guardrails slide: in-tenant AI, HITL gates, dual-value audit — and the wave plan.

## 3. Dependencies & stakeholder actions

1. **Q23 (Judithmelanie/Ebony):** 2–3 real sent follow-up emails per situation type — grounds the AI drafts in the team's voice.
2. **Q22 (Euan):** sponsor the Graph permission request for `RTR_FA` (Mail.Read + Mail.Send as mailbox).
3. **Q24 (Euan/IT):** confirm in-tenant Azure OpenAI use for finance documents (accounts already exist in the sandbox).
4. **Q4/Q1/Q6/Q7:** numbering scheme, chain ordering, quote tolerance, R&D-exemption rule — same as v0.1.
5. Shashank: refine [design-brief.md](design-brief.md) in Claude Design; lock screens before W1-a UI work.

## 4. Risk register (v0.2 top adds)

| Risk | L×I | Mitigation |
|---|---|---|
| Extraction accuracy on table-heavy variants disappoints | M×H | Labeled eval set from the 4 real packages before Wave-2 sign-off; Document Intelligence layout as Tier-2 fallback; FA correction always available |
| AOAI config/permissions lag | M×M | Wave-1 is AI-free by design; `aiClient` null-object keeps the app whole |
| Graph access slips (Q22) | M×L | Dev Mailbox demos the full read/send story; adapter swap later |
| Case refactor destabilizes the tested scaffold | L×M | Smoke suite (34 checks) re-run after refactor; state machine untouched |
| AI drafts leak tone/facts FA wouldn't send | L×H | HITL always; drafts grounded only in case data; Q23 examples; dual-text audit |

## 5. Phase 1 / Phase 2 (unchanged frames, corrected stack)

Phase 1 graduation = **App Service + PostgreSQL Flexible Server + Key Vault + managed identity** (the live pattern used by Resume Screener / DIMS / Sample Ordering UATs), Blob for documents, Graph mailbox, Entra app roles, scheduled SAP extract. Phase 2 = SAP write integration behind the existing `sapClient` seam; SAP cost cross-check automation (P7).
