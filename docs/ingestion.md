# Shared-mailbox ingestion — options, recommendation, and setup

**Version:** 0.1 (2026-08-31) · **Companion:** [PRD.md](PRD.md), [ERD.md](ERD.md)

The question: can cases be created automatically from `RTR_FA@example.com` instead of an FA
member uploading the package by hand? Yes — and the four routes below all converge on **one
endpoint**, so choosing between them is an operations decision, not an architecture one.

---

## 1. One pipeline, four triggers

```
Upload (browser)   ─┐
Power Automate     ─┤→  POST /api/ingest/email  →  normalize → correlate → persist → extract
Graph poller       ─┤       (shared secret for machine callers;
Outlook add-in     ─┘        session auth for browser upload)
```

Everything normalizes to one envelope before anything else happens:

```jsonc
{
  "source": "power-automate",           // | graph | outlook-addin | upload
  "externalId": "AAMkAG…",              // provider message id, for idempotency
  "conversationId": "AAQkAD…",          // the thread — how follow-ups find their case
  "inReplyTo": "<...@example.com>",
  "from": "chakradev.rhodes@example.com",
  "to": ["rtr_fa@example.com"],
  "subject": "Line 5 filler — updated AFE (redline)",
  "receivedAt": "2026-08-31T09:14:00Z",
  "bodyText": "Resending with the corrected total…",
  "attachments": [{ "filename": "AFE_v3.pdf", "mimeType": "application/pdf", "contentBytes": "<base64>" }]
}
```

Switching trigger later changes **which service posts this**, nothing downstream.

## 2. The options compared

| | **A · Power Automate** | **B · Graph poller / webhook** | **C · Outlook add-in** | **D · Manual upload** |
|---|---|---|---|---|
| How it fires | Flow on "when a new email arrives in a shared mailbox (V2)" → HTTP POST | App polls or subscribes to `RTR_FA` via Microsoft Graph | FA clicks "Send to Workbench" on a mail | FA drags files into the workbench |
| Permissions needed | A licensed account with RTR_FA access — **no app registration** | Entra app registration + `Mail.Read`(+`Mail.Send`) **application** permissions + admin consent | Add-in manifest deployment (M365 admin) | None |
| Lead time | Hours | Weeks (IT/security review — this is PRD **Q22**) | Days–weeks | **Already working** |
| Automatic? | Yes | Yes | No — deliberate human trigger | No |
| Noise risk | Ingests everything matching the filter | Same | None | None |
| Good for | **Getting automation demoed now** | The production end-state | Ambiguous mail FA wants to route by hand | Fallback + one-offs |

**Recommendation:** ship **D** (done), wire **A** to demonstrate real auto-ingestion without
waiting on IT, keep **B** dormant behind the mailbox seam so it activates the day permissions
land, and offer **C** for mail that shouldn't auto-ingest. All four post the same envelope.

## 3. Correlation — new case, or more of an existing one?

Deterministic, first match wins. This matters because **follow-up emails routinely carry the
next version of a document**: the real Line 5 Filler case arrived as *"Resending with the
corrected total per finance. Redline attached."*

| # | Rule | Outcome |
|---|---|---|
| 1 | An attachment's SHA-256 already exists on a case | `duplicate` — attach the mail, flag it, create nothing |
| 2 | `conversationId` / `inReplyTo` matches a case thread | `append` |
| 3 | An AFE number in the subject or body matches a case | `append` |
| 4 | Normalized subject (strip `RE:`/`FW:`) matches a case | `append`, marked as a suggestion FA can split |
| 5 | Has attachments and looks AFE-shaped | **new case** |
| 6 | Anything else | `triage` — parked, never a full case |

Appending adds the documents to the case, re-runs extraction on the new ones, records the
message in Correspondence, and marks superseded versions rather than deleting them.

## 4. Not everything in a shared mailbox is an AFE

Auto-ingestion is only safe if FA can say "this isn't ours". Two mechanisms:

- **Triage bucket** — rule 6 above. Mail with no attachments and no AFE signal parks in
  *Needs triage* instead of polluting the queue.
- **"Not an AFE to FA request"** — `POST /api/cases/:id/dismiss {reason}` moves a case to
  `Not an AFE request`, drops it from the active queue, audits who dismissed it and why, and
  flags the source message so re-ingestion won't resurrect it. `…/restore` reverses it.

Dismissal is a judgement, so it is recorded like every other one — not a silent delete.

## 5. Setting up Power Automate (option A)

1. **Cloud flow**, trigger *"When a new email arrives in a shared mailbox (V2)"*.
   Mailbox: `RTR_FA@example.com`. Include attachments: **Yes**.
2. *(Optional filter)* Condition on subject/body — e.g. contains `AFE`, `IO`, or `capital`.
   Skipping the filter is fine: unmatched mail lands in triage rather than the queue.
3. **HTTP** action:
   - Method `POST`, URI `https://<app-host>/api/ingest/email`
   - Headers: `Content-Type: application/json`, `X-Ingest-Secret: <INGEST_SECRET>`
   - Body: map the trigger outputs onto the envelope in §1 (`Attachments` → `attachments`,
     `ContentBytes` → `contentBytes`).
4. Set `INGEST_SECRET` in App Service configuration to match. It is a shared secret, so it
   lives in app settings — never in source (ADC rule).

The endpoint is idempotent on `externalId`, so a flow that retries cannot double-create.

## 6. Graph poller (option B) — dormant until permissions land

`lib/mailbox/graphMailbox.js` sits behind the same seam as the Dev Mailbox. It needs an Entra
app registration with **application** permissions `Mail.Read` (ingest) and `Mail.Send`
(follow-ups sent as the mailbox), plus admin consent — PRD **Q22**, sponsor Euan. Client id,
tenant id and secret come from app settings; **no GUID is ever written into source**.

Prefer a webhook subscription over polling once it is live; polling every few minutes is the
simpler start and needs no public callback.

## 7. Outlook add-in (option C)

A task-pane add-in with one button, "Send to AFE Workbench", which posts the selected message
through the same endpoint. Manifest and pane are served from `/addin/`. Best for mail FA wants
to route deliberately, and it needs no auto-ingest filter tuning.

## 8. Current status

| Piece | State |
|---|---|
| Manual upload → live Document Intelligence → populated case | **Working** (`tools/smoke-intake.js`) |
| Adding documents to an open case (same pipeline, confirmations kept) | **Working** |
| Duplicate detection by content hash | **Working** |
| Outbound: follow-up as an Outlook-ready `.eml` with the case documents attached | **Working** — the only real mail path until Graph `Mail.Send` lands |
| Ingest endpoint, correlation rules, triage, dismissal | Designed — next build phase |
| Power Automate flow definition | Next build phase |
| Graph poller, Outlook add-in | Next build phase |
