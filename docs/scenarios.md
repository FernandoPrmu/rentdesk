# RentDesk — Section 11 scenarios

Every "what can go wrong" scenario of `docs/spec.md` section 11 (v1.1), how RentDesk handles it,
the screens involved, and the tests that prove it (TKT-13). Each one ends in a defined ticket status,
with a reason, a notification and an audit entry (`ticket_events` and `audit_logs`) unless the row
says otherwise. Written in task 8; decision numbers refer to `docs/decisions.md`.

**Status:** `done` (built and tested) · `partial` (built; the part named is deferred) · `deferred` (with the reason)

**Tests:** `U` = unit test (`src/lib/**/*.test.ts`), `DB` = database test (`supabase/tests/*.db.test.ts`,
rolled back), `E2E` = Playwright at 360 px (`e2e/*.spec.ts`). Short names: `scen` = `scenarios.db.test.ts`,
`cron` = `cron.db.test.ts`, `meter` = `meter-review.db.test.ts`, `pay` = `payments.db.test.ts`,
`rules` = `business-rules.db.test.ts`, `mach` = `machines.db.test.ts`, `wf` = `workflow.db.test.ts`,
`acc` = `accounts.db.test.ts`, `bill` = `billing.db.test.ts`.

Deferred across the board, because email, SMS and WhatsApp need NOT-02/NOT-03 (SMS and WhatsApp
need a paid provider): every notification below is written in-app in the same transaction as the
change (the outbox, `src/lib/notifications/service.ts`); email delivery, retries and channel
fallback plug into that one place later.

## 11.1 Design principles

| Principle | How | Tests | Status |
| --- | --- | --- | --- |
| Every stage has a deadline, reminders and escalation | Daily job (rules 20-21): meter, owner review, payment, slip check; open disputes too (owner day 3 and 5, admin day 7, rule 52) | U `decide.test.ts`, `deadlines.test.ts`; DB `cron` | done |
| No automatic approval | Readings, estimates and slips wait for the owner; the job never confirms (rules 21-22) | DB `cron` ("never confirmed automatically") | done |
| The owner can always override, with a reason in the audit log | Cancel, reopen, new due date, manual entry, correction after confirmation, credit, baseline: each needs a reason (TS and SQL) | U `transitions.test.ts`; DB `scen`, `cron`, `pay` | done |
| Idempotent submissions | Keys on readings, slips, manual payments, returns, disputes and comments; retries return the first result | DB `wf`, `meter`, `pay`, `scen` (dispute, comment replays) | done |
| Money records never silently edited or deleted | Corrections cancel and reissue (new number, `replaces_invoice_id`, revision 2; rule 49); credits are new rows and lines; reversals and moves are new events (rule 43) | DB `scen`, `pay` | done |
| Every rejection needs a reason and returns to a clear earlier stage | Reading, slip, estimate and dispute rejections | DB `meter`, `pay`, `scen` | done |
| Fallback channels; the in-app ticket is the source of truth | In-app now; the ticket and its bill are always in the portal | — | partial: fallback channels wait for NOT-02/03 |

## 11.2 Meter submission stage

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Customer does not open or submit the ticket | Reminders day 2 and 4; day 5 Overdue and the owner alerted; the owner waits, enters the reading, or (if enabled in Settings › Billing) an estimated draft is prepared for review | Customer Home, owner Tickets, Settings › Billing | U `decide.test.ts`; DB `cron` (meter stage, estimates) | done |
| Notification not delivered | Ticket stays visible in the portal; in-app notification written | Customer Home | — | partial: retries, other channel and "all channels failed" alert need NOT-02/03/05 |
| Camera denied, missing or broken | Step-by-step help, never a file picker; the customer writes to the owner in the ticket's **messages** (TKT-11); the owner enters the reading with a note | Meter page, ticket messages, owner "Enter the reading" | E2E `meter.spec.ts` (denied), `comments.spec.ts`; DB `meter` (manual entry), `scen` (comments) | done |
| Photo blurry, dark or unreadable | Capture guide, retake, dark/blank frames refused (rule 37); the owner rejects with a reason | Meter page, owner review | U `frame-check.test.ts`; E2E `meter.spec.ts` (reject → resend) | done |
| Reading lower than the previous one | Blocked with a clear message, no invoice; after a meter reset or replacement the owner records a **new baseline** (rule 51) and the reading is accepted | Meter page, agreement › Meter › "Record new meter baseline" | U `usage.test.ts`, `dispute.test.ts`; DB `scen` (reset); E2E `baseline.spec.ts` | done |
| Reading unusually high or low | Warning on the preview and the customer must tick "the number is right" before sending (task 8); flagged to the owner, who sees earlier months' usage next to it | Meter page, owner review | U `anomaly.test.ts`, `readings.test.ts` | done |
| Counter rolled over | Counter maximum per machine; plausible rollover added and flagged; the owner must confirm it (rules 9-10) | Machine form, owner review | U `usage.test.ts`; DB `bill` | done |
| Typed reading does not match the photo | Photo and reading side by side; correct with a note (customer sees old → new) or reject | Owner review | DB `meter` (corrections) | done |
| Total counter typed instead of B&W or colour | Labels say "not the Total"; a sample counter screen ("Which numbers do I type?", task 8); the owner corrects or rejects | Meter page, owner review | DB `meter` (corrections); the labels and the guide are display only | done |
| Double tap or repeated Submit | One submission per key, one draft per ticket | Meter page | DB `wf`, `meter` | done |
| Connection lost while submitting | Readings and key kept on the phone; success only after the server confirms (rule 31) | Meter page | U `draft.test.ts`; E2E `meter.spec.ts` | done |
| Old or non-live photo suspected | Live camera only, server timestamps; the review shows usage of earlier months (task 8); the owner rejects and may ask again | Owner review | U `frame-check.test.ts`; DB `meter` | done |
| Customer rents several machines | One ticket per machine | Customer Home | DB `cron`, U `view.test.ts` | done |

## 11.3 Owner review stage

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Owner does not review in time | Reminders 24 h and 48 h, admin after 72 h; never confirmed automatically | Owner Approvals, Admin › Escalations | DB `cron` | done |
| Owner rejects the reading | Reason required; back to Meter requested; after 3 rejections the owner enters it (rule 28) | Owner review, customer ticket | DB `meter`; E2E `meter.spec.ts` | done |
| Owner corrects the reading | Draft recalculated, note saved, customer sees old and new values; **the customer may dispute** the issued bill (task 8) | Owner review, customer ticket and bill | DB `meter`, `scen` | done |
| Confirmation fails (system error) | One transaction; the photo is deleted only after the invoice is issued | — | DB `meter` | done |
| Owner suspended or deactivated mid-cycle | Open tickets pause and resume with deadlines moved forward (rule 24); the owner's customers are blocked at sign-in with "Your provider's account is not active right now" | Login | DB `cron`, `acc`; E2E `account-management.spec.ts` | partial: telling customers by email waits for NOT-02 |
| Agreement edited during an open cycle | Applies from the next cycle; open tickets keep their terms (rule 3) | Agreement page | DB `mach`, `rules` | done |

## 11.4 Invoice and dispute stage

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Customer disputes a confirmed invoice | **Task 8.** "Dispute this bill": reason (required) and an optional photo or PDF (slip checks, own private bucket); once per bill (rule 47). Ticket and bill Disputed; reminders and late fee pause; the owner is told; owner reminders day 3 and 5, admin day 7 (rule 52). The owner answers: **reject** (explanation, optional new due date), **correct the bill** (cancel and reissue, rule 49) or **give a credit** (taken off the bill, the rest kept as credit, rule 48). Customer told at each step; audited (`DISPUTE_*`, `INVOICE_CORRECTED`) | Customer bill › Dispute, customer ticket; owner ticket (dispute panel), "Correct the bill" | U `dispute.test.ts`, `decide.test.ts`, `transitions.test.ts`; DB `scen` (raise, reject, credit, covered → closed, corrected, cancel ends it, escalation); E2E `disputes.spec.ts` | done |
| Calculation or rate error after confirmation | **Task 8.** "Correct the bill": corrected reading(s) or adjustment lines, recalculated by the engine; the old invoice is cancelled (number voided, CANCELLED PDF version) and the corrected one issued with a new number; money already paid becomes a credit taken off it; a paid (closed) ticket is reopened first; a reading can change only while it is the latest (later readings or baselines: adjustment lines) | Owner ticket › Correct the bill; invoice pages show "Corrected, replaces …" / "Pay the corrected bill … instead" | U `dispute.test.ts`; DB `scen` (reopen + paid → credit, adjustment with part payment, refusals, later reading, estimate) | done |
| Dispute after the meter photo was deleted | The owner's dispute panel shows the reading on record: values, who confirmed and when, the photo deleted on confirmation (INV-10). The owner may **ask for a fresh meter photo**: the customer gets a Home task and takes it with the live camera, typing what the meter shows; the photo is deleted when the dispute ends | Owner dispute panel; customer Home task, ticket › Take a fresh meter photo | DB `scen` (fresh photo, storage rule, deletion) | done |
| Invoice notification not delivered | The bill stays in the portal; **"Send the bill again"** on the owner's invoice page (ticket event, audit, not twice within 10 minutes) | Owner invoice page | DB `scen` (resend) | partial: retries wait for NOT-02 |
| Zero usage in the cycle | Commitment charged; ZERO anomaly flag | Owner review | U `anomaly.test.ts`, `invoice.test.ts` | done |
| Machine returned or agreement ended mid-cycle | Closing reading, final invoice (prorated or full, rule 5), machine Available; unpaid bills stay payable (RET-01) | Return form | DB `mach`, `rules`; E2E `machines.spec.ts`, `deposits.spec.ts` | done |

## 11.5 Payment stage

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Customer does not pay by the due date | Reminders 3 days before and on the day; Overdue the day after (owner told); days 7 and 14; weekly summary; optional late fee | Customer Home and Bills, owner Outstanding | DB `cron` | done |
| Customer pays but forgets the slip | Payment reminders ask to send the slip; the owner records the payment after checking it arrived | Owner › Record a payment | DB `pay`; E2E `payments.spec.ts` | done |
| Slip file invalid, unreadable or too large | Refused with a clear message (type by magic bytes, 5 MB, decodes, safe PDF) | Pay page | U `slip-check.test.ts`, `slip-prepare.test.ts` | done |
| Slip amount less than the invoice | "Received less": part payment, balance shown, ticket open | Owner payment page | DB `pay`; E2E `payments.spec.ts` | done |
| Slip amount more than the invoice | The rest becomes a credit, taken off the next invoice or refunded | Customer profile › Credits | DB `pay` | done |
| Slip details wrong or suspected fake | Rejected with a reason; back to Awaiting payment; the customer sends again | Owner payment page | DB `pay`; E2E `payments.spec.ts` | done |
| Same slip or reference used twice | "Possible duplicate" warning to the customer and the owner (rule 40) | Pay page, owner payment page | U `duplicates.test.ts`; DB `pay`; E2E `payments.spec.ts` | done |
| Owner does not verify the slip in time | Reminders 24 h and 48 h, admin after 72 h; never overdue while it waits | Owner Payments, Admin › Escalations | DB `cron` | done |
| Payment reversed after closing (cheque returned) | "Reverse payment": ticket reopened, bill owed again, receipt REVERSED (rule 43) | Owner payment page | DB `pay`; E2E `payments.spec.ts` | done |
| Payment applied to the wrong invoice | "Move to other bills" with a note; balances corrected; audited | Owner payment page | DB `pay` | done |
| Customer wants to pay before the invoice is confirmed | No payable bill; the owner records an advance (credit) | Owner › Record a payment | DB `pay`, `rules` | done |
| Customer pays in cash | Recorded by the owner with a receipt; ticket closes (two steps) | Owner › Record a payment | DB `pay`; E2E `payments.spec.ts` | done |

## 11.6 Missed and multi-cycle billing

| Situation | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Customer submits after the window, before the next ticket | Accepted and marked Late ("Reading came late") | Owner ticket | DB `meter`, `cron` | done |
| Customer never submits; owner enters the reading | Manual entry with a note | Owner › Enter the reading | DB `meter`; E2E `baseline.spec.ts` | done |
| Customer never submits; estimated billing (if enabled) | **Task 8:** the switch is now in Settings › Billing. Draft estimate (commitment only) for the owner's review; the next real reading measures from the last confirmed reading, covers both months and credits the estimate; **the database now checks the estimate is credited** (migration 0028) | Settings › Billing, owner review | U `invoice.test.ts`, `billing-schema.test.ts`; DB `cron` (estimate), `scen` (reconciliation and its check, correcting an estimate) | done |
| Readings of two cycles combined without an estimate | One invoice for both cycles, commitment and included copies doubled, older ticket closed ("Billed in the cycle N invoice") | Owner review ("covers 2 months") | DB `cron` | done |
| Next cycle due while the previous one is open | New ticket opens; the older one is flagged Overdue; previous reading = last verified | Owner Tickets | DB `cron` | done |

## 11.7 Ticket, notification and system failures

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Ticket stuck in a stage | Deadlines, reminders and escalation, including open disputes (rule 52) | Admin › Escalations | DB `cron`, `scen` | done |
| Scheduler fails or runs late | Restartable, catches up every missed cycle; **admins alerted** when a run fails or has errors, and when no run finished for 30 hours (task 8, rule 53) | Admin › Daily job | U `daily.test.ts`; DB `cron`, `scen` (alerts) | done |
| Ticket due for an inactive or terminated agreement | Skipped | — | DB `cron` | done |
| Duplicate ticket for the same cycle | Unique `(agreement_id, cycle_no)` | — | DB `wf`, `cron` | done |
| Upload or storage failure | Nothing recorded until the server checked the stored file; clear message; retry reuses the upload | Meter, pay and dispute pages | DB `meter`, `pay` | done |
| Malicious or oversized slip file | Type and size checks, active PDF content refused, private buckets | Pay page, dispute page | U `slip-check.test.ts` | partial: a real virus scan needs a hosted or paid scanner |
| User opens another tenant's ticket, photo or slip | RLS and storage policies; short-lived signed links; **the attempt is logged** (`ACCESS_DENIED`, task 8, rule 54) on ticket, invoice and payment pages and the PDF links | Any detail page | DB `rls`, `scen` (storage); E2E `comments.spec.ts` (another customer opens the ticket: not found, logged), `account-management.spec.ts` | done |
| Owner cancels a ticket created in error | Reason required, customer told; an open dispute ends as Cancelled | Owner ticket | DB `pay`, `scen` | done |
| Owner reopens a closed ticket | Owner only, with a reason; then "Ask for payment again" or "Correct the bill" | Owner ticket | DB `pay`, `scen` | done |

## 11.8 Account and agreement changes

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Customer account suspended | No new tickets; open tickets frozen; the owner can still act; resumes on reactivation | Owner customer profile | DB `cron`, `acc` | done |
| Customer forgets the password | Owner resets: new temporary password, forced change | Owner customer profile | DB `acc`; E2E `account-management.spec.ts` | done |
| Customer changes phone or email | The owner updates the details | Owner customer profile | DB `acc` | partial: the test notification needs NOT-02/03 |
| Machine replaced or swapped | Return the old machine with its closing reading (final bill), assign the replacement with its own starting reading (or Reassign) | Return, Assign | DB `scen` (swap), `mach`, `rules` | done |
| Temporary replacement while a machine is repaired | Not in the spec | — | — | deferred: not in the spec; a permanent swap (above) or a baseline covers today's cases |
| Meter replaced or reset | **Task 8:** "Record new meter baseline" with a reason; the old meter's last reading (optional) carries the copies printed on it into the next bill (rule 51); blocked while a reading waits for review; ticket event, audit, customer told | Agreement › Meter | U `dispute.test.ts`; DB `scen`; E2E `baseline.spec.ts` | done |
| Customer leaves with an unpaid balance | Deactivated; the balance stays on record and in Outstanding | Owner customer profile, Outstanding | DB `acc`, `mach` (balances) | done |
| Owner leaves the platform | Admin deactivates; data kept; the owner's customers are blocked with a message at sign-in | Admin › Owners | DB `acc`; E2E `account-management.spec.ts` | partial: telling customers by email needs NOT-02 |
