# Demo guide — AFE to Fixed Asset Workbench

**URL:** https://your-app.azurewebsites.net · **Version:** 2026-10-14 (v1.0, after the UAT review)
**Audience:** Judithmelanie · Jarrod · Ebony · Imogen · Manaia · Lyndsay · Praveen · Aiden-Mulqueeny

Acts 1–4 are the spine and run about twenty minutes. Acts 5–8 are what you show if the room
wants more. The words worth saying out loud are in *italics*.

---

## Before you start (3 minutes)

Open **/health** in a tab. You want:

```
"status":"ok"   "storage":"postgres"   "storageAuth":"password"   "docusign":"simulated"   "ai":"quote-reading"
```

`"ai"` answers a question the security review will ask. It is `"none"` until somebody switches
the quote reader on in Admin › Features, and on UAT that is allowed from 14 October — the one
recorded exception to "no AI before the review" (CLAUDE.md, non-negotiable #1). Production keeps it
locked. If it reads `quote-reading switched on, not ready: …`, the reason follows the colon.

Put it back to a clean slate: **`POST /api/admin/reset`**. It reseeds the matrix (1,197 rows),
the AuC recon file (528 lines), the routing rules, the budget pots and the eleven people. The
matrix and the recon file are real; the budget-pot amounts are dummies until a division loads
its own.

Two ways to stage the later acts — click through Acts 1 to 4, or run `node tools/smoke-fa.js`
and `node tools/smoke-projects.js` against a local server, which leave the same state behind
in about fifteen seconds. On a freshly reset store the leadership timings are empty, because
no AFE has been through yet; run Acts 1–4 first if you want them filled.

> **One caveat to state up front, once:** there is no sign-in yet. Everyone who opens the link
> arrives as the same identity, so the persona switcher is how two people test at once — and it
> belongs to the BROWSER now, not to everybody: switching in your browser does not move anybody
> else's (it did until 14 October, which is how a send-back came to be recorded as Aiden). Use one
> browser per person; a private window counts as a browser of its own. ADC adds single sign-on
> when it onboards the app, and the switcher disappears the same day. Everything else is real: a
> real database, a real generated form, a real signing chain, real approval rules.

---

## The story in one line

*Today a project manager fills in a nine-sheet Excel template, a coordinator fixes it and
works out who signs, it becomes a PDF, it goes round DocuSign, Fixed Assets checks it by eye
and types it into SAP, and someone keeps a 21-sheet workbook to know what happened next. This
does all of that except the SAP typing — and it hands Fixed Assets that on a plate.*

---

## Act 1 · The requester's five minutes (5 min)

**Requests → Raise an AFE.** One question a screen, three controls at most.

- **The title.** Type a long one. *"Forty characters, because that is what fits in the DocuSign
  subject line. It tells you while you type, not after you submit."*
- **Cost centre.** Type `30145`. Say: *"Division, plant and the whole approval chain come off
  this one field. Nobody is asked which division they are in — the matrix already knows."*
  Type something the matrix does not hold and it goes amber, not red: *"an unknown cost centre
  does not stop a draft. It stops the send."*
- **Location.** Type three letters of a city. *"One field, and it carries the building number,
  because that is what property tax needs and that is how the template's own list is written.
  A hundred and fifty sites, straight out of the template. You can still type your own — it is
  allowed, and it is flagged."* (Lyndsay's ask, Meeting #5.)
- **How much.** Add the seven APAC lines — South Korea 30,000 · Japan 30,000 · Singapore MFG,
  DC and GCO · Australia · India — **215,000**. *"The total is never typed. It is the sum of
  the lines, and those lines become the child internal orders later."*
- Watch the chips under the answer as you cross **$25,001**: *"the consequences of the answer,
  under the answer that caused them. He finds out who signs while he types, not a week later."*
- **CapEx and OpEx together.** Turn on OpEx beside the capital amount and put in a figure.
  *"Lyndsay and Euan both said it in the meeting: one project buys the hardware and pays for
  three years of support. It was one classification; now it is two amounts on one AFE. Cloud
  CapEx is still exclusive with CapEx, because Imogen is right that a thing cannot be both."*
  The band reads the sum, and both columns print.
- **The quote.** Attach the PDF, then type the vendor and the amount. *"A person types two
  fields today, and Fixed Assets can open the quote next to them. Imogen asked whether the tool
  could read it — that is designed, it sits behind a switch that is off, and it will propose
  rather than decide."* Put in a quote worth a third of the AFE: **Send is not blocked**, and
  the flag shows the arithmetic. *"Imogen's correction. One quote of three is normal. It is a
  red flag, not a wall."* Then type the reason in the box under the flag: *"that sentence
  travels — the approver sees it before anything else, and it prints on the signed form."*
- **Review** shows the real generated form — the same bytes that will be signed.

Then say what the act is for: *"That was five minutes, and the result is structured data. The
template is nine sheets and it comes back wrong."*

---

## Act 2 · The coordinator (5 min) ← *this is Aiden's screen*

**Act as Aiden-Mulqueeny Crilly → Prepare.** Say: *"IT does not let an AFE go out without Aiden. That
is a rule per division, not a rule in the code."* **And nobody skips him (R157)** — the requester
submits, even one who also coordinates the division; only Aiden (or a colleague standing in who
did not raise it) sends.

- **Edit the AFE** is the strip on the right: every wizard step, Financials included. Change one,
  come back, and open the requester's record — *What happened* says "Edited the Financials step ·
  Aiden-Mulqueeny Crilly", one line however many fields were saved.

- Open the AFE. The chain is on the right, and **it is not stored yet** — *"this is recomputed
  every time you open it, from the matrix, the rules and the amount. It stays a preview until
  you press send. Then it is frozen for good."*
- Every row carries its own sentence: *"each recipient says why they are there — the matrix
  row, the rule, or the person who added them."*
- **Annette Sandhu is first**, above the financial ladder: *"pre-approvers print in the Project
  Approvals rows and sign before the money people. Today that is somebody remembering."*
- **Atwal appears once.** *"The matrix names him at M1 and again at A1. He signs once, at the
  highest row that applies, and the lower row says so. Two thousand three hundred of the two
  and a half thousand matrix rows repeat a person like that."*
- **Add a second A2** — Lekha Rogerson. *"The matrix is the minimum chain, never the maximum. A
  finance partner it omits is normal, and the tool labels her with the row she signs."*
- **The mailbox.** One row is a guess. Type the real address. *"Neither the matrix nor the
  recon file holds an email address. The tool guesses First_Last, the coordinator confirms it,
  and it is remembered for everyone next time. A guess cannot be sent."*
- **Segregation of duties.** Try to add yourself. *"The requester, the preparer and the
  coordinator can never sign their own AFE. It is blocked when the chain is built and again
  when the envelope is created, and the exclusion goes in the audit either way."*
- **Send.** The form is generated, hashed, and frozen together with the chain.

---

## Act 3 · The approver (3 min)

**Act as Annette Sandhu → Approvals.**

- The decision screen leads with **why this is in front of them**: budgeted or not, which pot
  and year, what happens if it slips, whether the quote covers the estimate. *"This is what
  Aiden types into the DocuSign message by hand today."*
- **Ask a question.** It goes on hold, the thread carries it, the requester is notified, and
  the clock note says how long it sat. *"Today that is a reply-all nobody can find in
  December."*
- Answer it, then sign. Sign as the rest of the chain. On the last signature it hands over to
  Fixed Assets by itself.
- **Send back, and nothing is lost (R148).** As the second signer, send it back for the wording.
  As the requester, the banner already says *Goes straight back to them · Daryl's signature
  stands*; change the CapEx and watch it turn into *Goes round again · the CapEx changed*, then
  put it back. Fix the wording and resubmit: it is the same envelope, Daryl's signature is still
  on it, and the next signer is told what changed. *"Judithmelanie's rule: if the money, the cost
  centre, the budget, the documents or who signs change, it is a new decision and goes round
  again. Wording does not."* Say the honest half out loud: the document in the envelope is the
  one first sent, so the corrected wording is on the AFE and not in the signed file. That is
  the question for this meeting.

Say once: *"In UAT the signing happens in the tool, because there is no DocuSign account yet.
When there is, the identical chain becomes an envelope, they sign in DocuSign, and a poll job
brings each signature back through the same guarded transition. The signature, the certificate
and the tamper evidence stay DocuSign's — we never rebuild that."*

---

## Act 4 · Fixed Assets — red flags, judgment, the internal order (5 min)

*(Stage the drift first: `POST /api/admin/matrix/simulate-extract` with
`{"batchId":"MX-2026-09-15","changes":[{"costCenter":"30145","level":"A2","name":"Lekha Rogerson"}]}`.
`tools/smoke-fa.js` does exactly this if you would rather watch it than click it.)*

**Act as Judithmelanie Ware → Fixed Assets.** Say: *"Nothing on this screen was typed. It is the
AFE, the chain frozen when it was sent, and the SAP matrix as it stands today."*

- **The red chip on the row** — *"the matrix changed at A2 after this went out. Kai signed;
  SAP now holds Lekha accountable. The chain was frozen, so nothing moved — the difference is
  a red flag here, at receipt, which is where Judithmelanie asked for it."*
- **Show me** on the flag — the matrix then and now, with the changed row ringed.
- **Attach the email approval** — *"a note cannot clear drift; evidence does."* Then **draft
  the red-flag email**: one email, every flag, addressed to the coordinator. *"It is a draft
  in the outbox and it downloads as a file that opens unsent in Outlook. The tool has no way
  to send it. That was the ask."*
- **Your judgment** — the five rows that are still a person's call: asset or expense, the
  amount reasonable, the classification, no duplicate order, and **Z002 or Z005**, which is
  chosen and never guessed. *"The presence checks are gone. The wizard did them at source,
  which is where Judithmelanie said they belong."*
- **Key it into SAP** stays off, with the reason, until the flag is cleared, the rows are
  ticked and the order type is chosen. Then the KO01 sheet: copy per field, then **Saved in
  SAP — record the order number**, the parent first and a child per country. *"That number is
  the AFE number. Nobody was ever asked to type one in, and the requester and Aiden have just
  been told what it is."* KO22, AS01 and KO02 tick off underneath.
- **The issued pack, and the mail that goes with it.** Once KO22 and AS01 are done, open the
  pack card's sheet. The signed AFE sits at the top as one fixed block with the quote inside it.
  Only what goes behind it has a checkbox. Preview it, then send it. *"This is the signed file,
  page for page, with nothing redrawn. The red marks Imogen and Lyndsay write by hand are drawn on
  top of it: the order number in the AFE NO box, the AuC, plant and budget along the top, and
  the SAP table in its box. Then one page says which pages are the signed ones and where
  everything Fixed Assets added is. Nothing the approvers signed is re-made, and nothing is in
  it twice."* Open the Mailbox and
  read the mail out loud: it is Lyndsay's own hand-back paragraph, GL 602620 and all, to the
  requester and the coordinator with Fixed Assets copied. *"Lyndsay writes that by hand today."*
- **Send back** — *"if the wording is wrong the signatures stand and it comes straight back.
  Change the money and it is a new round, because that is a different AFE."*

---

## Act 5 · The project, and the night the extract arrives (4 min)

Say: *"The tool never writes to SAP. It reads what SAP reports and puts it next to what was
approved."*

- **Projects → the AFE, now four orders.** *"The cost lines the requester typed became child
  orders. The parent holds only what has not been split out."*
- **Open Singapore.** Budget, spent, committed, available. **Click Spent** and the invoiced
  purchase orders are behind it. *"Every number on this page is a control. Nothing on it was
  typed."*
- **The 80% mark on the bar** — *"that is the AuC review's own population rule, not a new one.
  Cross it and Fixed Assets asks for the in-service date."*
- **Move budget between the orders** — *"a reduction on one and an addition on the other, the
  way the tracker does it by hand. The approved total cannot change by moving money about."*
- **Export the tracker** and open it in Excel. *"Aiden's own column order, straight out of the
  tool."*
- **Load tonight's extract** in Admin and reload. *"Same page, new numbers. Nothing was stored
  — the figures are joined when you open the page, so one extract moves every screen at once.
  Send the same file twice and nothing happens. Send half a file and it is refused before it
  can replace a good one."*
- **Need more? Raise a supplemental.** Ask for $200,000 more on the $215,000 AFE.
  *"The chain is rebuilt on $415,000, not on the $200,000, so two more levels sign. The AFE
  that was signed is never edited."*

---

## Act 6 · The AuC quarterly review (5 min) ← *the one Judithmelanie asked for first*

**Fixed Assets → AuC review.** Say: *"When I asked what to automate outside SAP, the first
thing Judithmelanie said was the confirmation email. This is that."*

- The roll-forward across the top: **$58.9M forward + $38.7M additions − $26.8M capitalized =
  $70.7M open.** *"That is the Summary tab's own reconciliation, and it ties to the GL. The
  tool did not invent a number."*
- **188 lines are in this quarter's review, out of 289 open.** *"Not our rule — the workbook's
  own header: over 80% consumed, aged six months from the order being issued, or over $100K,
  less anything already confirmed for a future go-live."*
- **Chasing is grouped per person, not per line.** Open **Facilities → Priscilla Lyden**: 40
  projects, one email, the line list with it. *"Forty separate chases become one, and the same
  person is not emailed three times by three divisions."*
- The pack shows whether it went out and whether it came back. *"An answer only counts once
  this period's pack has gone out. A comment from March cannot make a control look like it
  ran."*
- **Click any line.** The order opens: the recon figures, why it has not capitalized, the date
  history, and the comment log going back years.
- **Record an update** → a date, tick *they committed to this date*, save. The line leaves the
  population. *"That is the workbook's fourth rule, applied when the answer arrives instead of
  by hand three weeks later."*

---

## Act 7 · Leadership (2 min)

**Act as Manaia Ginty — Leadership.** *(Jarrod Dane is set up the same way and titled
Manager: same view, his designation.)* The navigation shrinks; there is no queue and nothing
to edit.

- The roll-forward again, then **why has this not capitalized** — 111 awaiting an in-service
  date, 103 waiting on a final invoice, 60 with a go-live beyond this period, 7 on hold.
  **Click a number** and the lines are behind it. *"Jarrod, Manaia — this is the question you
  said leadership actually asks, and the answer is a list of names, not a number."*
- **The process the tool now measures** — how long approval took, how long until the order was
  issued, and what is sitting still. *"None of that was measurable while it was an email
  chain."*

---

## Act 8 · Admin — the rules are data (2 min)

**Admin.** Worth two minutes with Judithmelanie and Lyndsay in the room.

- **Routing rules.** Daryl as a pre-approver, the IT override, the copies. Change one, and say:
  *"This is why 'every IT AFE also goes to Erik' is not a code change. Retiring a rule asks for
  the reason and keeps the old one, because an AFE signed under it must still be able to
  explain itself."*
- **Budget pots** — CORP_IT for FY2026 is $6.94M across the categories and regions the IT
  dashboard already uses. *"Dummy amounts. The division loads the real ones."*
- **Master data** — the point Judithmelanie made about the cost-centre list going out of date. Download
  `locations`, open it in Excel, change a row, add a row, set one to `N`, upload it back. The tool
  shows the three deltas before it applies anything. *"Export and import are the same file. Your
  team edits in Excel because that is what your team does, and nobody in this room has to raise a
  ticket to correct a location. Every import is a version, and the previous one is one tap away."*
  Say which masters we own and which SAP owns: *"the approver matrix is read-only here, because
  SAP is its system of record. Technical Accounting Review is not, so you edit that one directly."*
- **Features** — the switches. *"Everything on them is off. The quote reading Imogen asked for is
  one of these, and it stays off until the security review has seen it. An environment can be told
  to refuse a switch outright, so production cannot turn on what UAT was only trying out."*
- **Extracts** — the four SAP reports, when each last arrived, and which one is stale.
- **What changed lately** — the audit, in the order it happened.

---

## Questions you should expect, and the honest answers

| Question | Answer |
|---|---|
| "Can it write to SAP?" | No, and not soon. SAP GUI is a desktop application behind the VPN; there is nothing to automate against from a browser. The keying sheet is the bridge, and the extracts come back the other way. What we would like to pilot is the tool filling that screen for you and stopping before Save, so the person still checks it and still presses the button. That needs Basis to allow desktop scripting, and it is still not a write by us. |
| "Is any of this AI?" | In one place, behind an administrator's switch. Everything you have seen — the routing, the thresholds, the segregation of duties, the drift check, the reminders, the form, every email — is ordinary code in this repository, and the boot suite fails the build if a model turns up in any of it. The one genuinely probabilistic job is reading the vendor, total and date off a quote, which is what Imogen asked for: it proposes rather than decides, nothing counts until the requester presses *Use these*, and the proposal, the decision and any later edit are each on the record. It raises no flag of its own — a proposal nobody confirmed counts for nothing; Fixed Assets simply sees an unused reading beside the typed figure. It may be switched on in UAT by a recorded exception (14 October) so Fixed Assets can judge it on their own quotes; production waits for the security review. |
| "So what happens if the machine reads it wrong?" | Then a person catches it, because nothing it produces is a value until somebody taps *use these* — and if they type something different, the tool asks why and shows that reason to every approver. A weak read is not offered at all. The failure we designed against is not a wrong number; it is a wrong number nobody noticed. |
| "Can it send the emails itself?" | It drafts them and hands you a file that opens unsent in Outlook. Sending as the Fixed Assets mailbox needs a Graph app registration; that code is written and dormant until one exists. The red-flag digest stays draft-only whatever happens, because that was the ask. |
| "What stops someone approving their own AFE?" | The requester, preparer and coordinator are excluded when the chain is built and again when the envelope is created. Where that empties a matrix level, the next level up stands in, and the exclusion is in the audit. |
| "What if the matrix changes while it is out for signature?" | Nothing moves. The chain is frozen at send, and the difference is raised as a red flag when Fixed Assets receives it — which takes email evidence to clear, not a tick. |
| "How do we know what was signed is what we are looking at?" | The form is generated deterministically and hashed at send. Anyone can ask the tool to re-render it and compare. The signature and the certificate are DocuSign's. |
| "Why is a recipient's mailbox blank?" | Because neither the matrix nor the recon file holds email addresses. We would rather leave it blank than chase the wrong person. The coordinator confirms it once and the tool remembers it. |
| "What happens if this application disappears?" | SAP is still the system of record and DocuSign still holds the signatures. This holds the request, the routing decisions, and the evidence around them. |

## What Meeting #5 asked for, and where it is

| Asked for | Where to see it |
|---|---|
| CapEx **and** OpEx on one AFE (Lyndsay, Euan) | Step 3 — two amounts, one band. The form prints both columns. |
| Quote coverage as a flag, not a block (Imogen) | Step 6 — the shortfall shows the arithmetic and Send is not stopped. |
| A box to explain a red flag, carried to the approvers (Imogen, Euan) | On the step that raised it, under the flag — a past start date on *Why*, a pot that does not fit on *How much*, an old quote on *Quote*. Then Act 3: the approver sees it in yellow above everything else, and it prints in *Exceptions accepted*. |
| Technical Accounting Review above $1M (Imogen, Judithmelanie, Lyndsay) | Raise one over $1M in Act 2 — two reviewers appear after the financial signers, and Send is blocked until somebody confirms a mailbox for the name we only heard on a call. |
| An expected date, not a year (Lyndsay) | Step 4, and page 2 of the form. |
| Location with the building number (Lyndsay) | Step 2 — type three letters of a city; it is the template's own list of 150 sites. |
| Sixty-page facilities packs (Imogen) | 25 MB a file, 100 MB an AFE. |
| The AFE number, AuC number and plant appended after approval (Imogen) | Act 4, after *Key into SAP* — download the issued pack. It is the red-ink page, generated. |
| The hand-back mail FA writes today (Lyndsay, Imogen) | The same moment. GL 602620 and all, to the requester and coordinator, Fixed Assets copied. |
| Requesters seeing their own projects (Euan) | Act as anyone and open Projects. |
| Emails that reach people who never open the tool (Judithmelanie) | Every link in the Mailbox is absolute. |
| The cost-centre list staying current (Judithmelanie) | Admin › Master data — download it, edit it in Excel, upload it back. |

## What Meeting #7 asked for, and where it is

| Asked for | Where to see it |
|---|---|
| The coordinator reviews and edits before approvers see it (Aiden) | Act 2 — Submit as the requester, Prepare as Aiden, *Edit the AFE*. The history names the steps he touched. |
| AFEs are capital; nothing at $2,500 or less (Aiden, Ebony) | Step 3 — no "Neither"; type 2,500 and the block says to raise a purchase requisition. |
| Technical accounting reviews first above $1M (Aiden, Judithmelanie) | Raise one over $1M: the reviewer is signer 1, and their page opens on *What you are checking*. |
| Adding associate directors or another department's owner (Aiden) | Act 2 — *+ Add a signer*: "First, before the cost-centre ladder" or at a level. |
| Local currency at Global Finance's rate (Judithmelanie, Ebony, Aiden) | Admin › Master data › FX rates — upload their monthly workbook; then Step 3 › Local currency. Page 1 prints the rate and the local columns; Fixed Assets can set the rate they key SAP at. |
| Financials from the AFE's own year (Ebony) | *Financials*, straight after *Why* — *Set it up*: the first column is the start year, with the capital in it. *Remove the financial case* takes it back off. |
| Fewer mails (Judithmelanie) | Comments e-mail nobody; *Ask* e-mails the other side once and waits for the answer. Every event is one mail, everyone else copied. |
| The AFE description in the AuC tracker (Imogen, Lyndsay) | Fixed Assets › Tracker — *The AFE* column, searchable, and in the CSV. |
| The send sheet keeping what was typed (the demo glitch) | Act 4 — type a profit centre, Preview, and it is still there. |

## Aiden's UAT — the IT round (from 14 October)

The UAT review's next step: "first Aiden will do the UAT, then that will be okay from the IT side"
(Imogen). One real IT AFE, end to end, by the people who will run it. About forty minutes.

1. **As the requester** (switch to them in *View as*, in your own browser): raise an IT AFE through
   the wizard. On *How much*, answer the budget with a pot, or **Other** and say which budget in
   words — the pot's balance is not shown to a requester any more; Aiden sees it on Prepare.
2. **The quote**: attach it, type the vendor and total, and its **date**. A quote more than 90
   days old when the AFE is sent is flagged — explain it in the box if the vendor holds the price.
   With the reader on, the card offers what it read, each value with its confidence and a *Show
   me*; press **Use these** or **Not right**. Until the app's identity is granted its role on the
   reader, the card says "Not read automatically — type the figures" and the typed figures are
   the whole story — that is expected, not a fault. The reason is in Admin › Features, not in the
   requester's history.
3. **As Aiden**: Prepare → review and edit, confirm any mailbox the chain asks about, send.
4. **As each approver**: open the approval and press **Approve and sign**.
5. **As Fixed Assets**: Judithmelanie (or Jarrod, or Manaia) approves for issue; somebody else records
   the order, KO22 with the screenshot, and AS01. **Preview** the issued AFE before sending: the red
   strip at the top of page one names who approved the issue, and the page after the index records
   it. The profit centre is optional and says so.
6. **As the requester**: open the AFE — the issued AFE is the first card.

**What to send back:** a screenshot of anything that looks wrong, with the AFE number and the step
you were on. If a field refuses a value it should take — the profit centre was reported that way —
the screenshot of the message is the most useful thing you can send, because nothing in the code
produces one today.

## What the UAT review asked for, and where it is

| Asked for | Where to see it |
|---|---|
| "One option for other" for the budget (Judithmelanie) | Step 3 — **Other**, and a line for which budget. On the form's Budget line as "Other: …". |
| Requesters not seeing how much is left in a pot | Step 3 as a requester shows the pot, not its balance; Aiden, Fixed Assets and the signers still see it. |
| The FA approver's name on the issued AFE, "for the audit perspective" (Lyndsay) | Act 4 — Preview the issued AFE: the red strip names the approver; the *Approval for issue* page follows the index. |
| AI reading the quote's amount and date (Judithmelanie, Imogen, Jarrod) | Step 6 with the reader on — the offer under the quote; Fixed Assets' *The amount is reasonable* row says where the total came from. |
| The quotation should be the latest one (Imogen) | Step 6 — type the quote's date; over 90 days at sending is flagged. |
| Profit centre optional (Judithmelanie, Imogen) | Act 4 — the issue sheet marks it *optional*. |
| Title longer than 40 | Kept at 40 by decision: it becomes SAP's order description, which holds 40. The counter says so. |

## What is still open

1. **Z002 vs Z005** — which nature of AFE maps to which order type. Both are offered; nothing
   is guessed.
2. **The closure window** — "no cost for the last three…" years, months or quarters?
3. **Supplemental basis** — the tool rebuilds the chain on the cumulative total. Confirm that
   is right.
4. **The override above its own limit** — Erik signs for visibility today. Should he?
5. **Which SAP field carries the parent reference** on a child internal order.
6. **The two Technical Accounting Review names** — one was heard on the call as "Janine", one as
   "Juan Gandhi", and neither mailbox is known. Anything above $1M is blocked from sending until
   somebody confirms them, which is the behaviour we want from a half-heard name.
7. **The value at which issuing an internal order needs a second pair of eyes** — Judithmelanie and
   Jarrod gave different answers in the room.
8. **Twenty real vendor quotes**, a couple of them scanned — the reader is built, and the 80%
   threshold under which it offers nothing is a starting point until UAT's readings measure it.
9. **The role that lets the reader run on UAT** (*Cognitive Services User* on
   `di-afe-workbench-uat`) — an Owner's grant, asked for; and the security review of quote
   reading, which is what lets production have it at all.

## Checking contrast yourself

Paste this into the browser console on any screen. It walks every text node, resolves the
background actually behind it, and flags anything under WCAG AA:

```js
function lum(c){const[r,g,b]=c.match(/\d+/g).map(n=>n/255);const f=x=>x<=0.03928?x/12.92:((x+0.055)/1.055)**2.4;return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b)}
function bg(e){for(let n=e;n&&n!==document.documentElement;n=n.parentElement){const b=getComputedStyle(n).backgroundColor;if(b&&!b.startsWith('rgba(0, 0, 0, 0'))return b}return 'rgb(255,255,255)'}
[...document.querySelectorAll('*')].filter(e=>[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim().length>2)).map(e=>{const s=getComputedStyle(e),a=lum(s.color),b=lum(bg(e)),r=(Math.max(a,b)+.05)/(Math.min(a,b)+.05),p=parseFloat(s.fontSize);return{t:e.textContent.trim().slice(0,30),ratio:+r.toFixed(2),floor:(p>=24||(p>=18.66&&+s.fontWeight>=700))?3:4.5}}).filter(x=>x.ratio<x.floor)
```

An empty array means the screen passes. Every screen currently returns empty.

## If something breaks

- **The app feels asleep** — the first request after idle takes about twenty seconds to wake
  App Service. Open `/health` a minute before you start.
- **The data looks wrong** — `POST /api/admin/reset` puts it back to seed state in a second or
  two, and it is safe to run in front of people.
- **A signature will not go through** — check you are acting as the recipient whose turn it is.
  The chain is sequential on purpose, and the button is hidden rather than failing.
- **Nothing is in the Fixed Assets queue** — an AFE only arrives there on the last signature.
  Run `node tools/smoke-fa.js` against the local server to put one in it.
