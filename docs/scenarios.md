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
`acc` = `accounts.db.test.ts`, `bill` = `billing.db.test.ts`, `not` = `notifications.db.test.ts`.

Notifications (task 10): every notification below is written in-app, and for the events of the
delivery catalogue also as an email delivery, in the same transaction as the change (the outbox,
decision 65); emails are sent after the response and retried by the daily job (decision 67). SMS and
WhatsApp stay deferred: they need a paid provider (NOT-03, decision 74).

## 11.1 Design principles

| Principle | How | Tests | Status |
| --- | --- | --- | --- |
| Every stage has a deadline, reminders and escalation | Daily job (rules 20-21): meter, owner review, payment, slip check; open disputes too (owner day 3 and 5, admin day 7, rule 52) | U `decide.test.ts`, `deadlines.test.ts`; DB `cron` | done |
| No automatic approval | Readings, estimates and slips wait for the owner; the job never confirms (rules 21-22) | DB `cron` ("never confirmed automatically") | done |
| The owner can always override, with a reason in the audit log | Cancel, reopen, new due date, manual entry, correction after confirmation, credit, baseline: each needs a reason (TS and SQL) | U `transitions.test.ts`; DB `scen`, `cron`, `pay` | done |
| Idempotent submissions | Keys on readings, slips, manual payments, returns, disputes and comments; retries return the first result | DB `wf`, `meter`, `pay`, `scen` (dispute, comment replays) | done |
| Money records never silently edited or deleted | Corrections cancel and reissue (new number, `replaces_invoice_id`, revision 2; rule 49); credits are new rows and lines; reversals and moves are new events (rule 43) | DB `scen`, `pay` | done |
| Every rejection needs a reason and returns to a clear earlier stage | Reading, slip, estimate and dispute rejections | DB `meter`, `pay`, `scen` | done |
| Fallback channels; the in-app ticket is the source of truth | In-app and email for every hand-over (spec 9, decision 66); a failed email is retried, then the owner is alerted; the ticket and its bill are always in the portal | U `outbox.test.ts`; DB `not`; E2E `notifications.spec.ts` | partial: SMS / WhatsApp as further channels need a paid provider (NOT-03) |

## 11.2 Meter submission stage

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Customer does not open or submit the ticket | Reminders day 2 and 4; day 5 Overdue and the owner alerted; the owner waits, enters the reading, or (if enabled in Settings › Billing) an estimated draft is prepared for review | Customer Home, owner Tickets, Settings › Billing | U `decide.test.ts`; DB `cron` (meter stage, estimates) | done |
| Notification not delivered | **Task 10.** The in-app notification is always written and the ticket stays in the portal; the email is retried with backoff (5 min, 20 min, 80 min, about 5 h; decision 67); a bad address fails at once; a bounce or spam complaint reported by Resend (webhook) fails it too. Then the **owner is alerted** in-app ("Email to X could not be delivered", link to the customer) and can correct the address; everything is in the delivery log | Owner notifications, Settings › Emails › Delivery log, customer profile | U `outbox.test.ts`, `policy.test.ts` (webhook); DB `not` (retries → FAILED → owner alert, 4xx, bounce) | partial: no SMS / WhatsApp fallback channel (NOT-03, paid provider) |
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
| Owner suspended or deactivated mid-cycle | Open tickets pause and resume with deadlines moved forward (rule 24); the owner's customers are blocked at sign-in with "Your provider's account is not active right now". **Task 10:** the owner's active customers are told by email (and in-app) when the owner is suspended, reactivated or closed (decision 75) | Login; the customers' email | DB `cron`, `acc`, `not` (customers told); E2E `account-management.spec.ts` | done |
| Agreement edited during an open cycle | Applies from the next cycle; open tickets keep their terms (rule 3) | Agreement page | DB `mach`, `rules` | done |

## 11.4 Invoice and dispute stage

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Customer disputes a confirmed invoice | **Task 8.** "Dispute this bill": reason (required) and an optional photo or PDF (slip checks, own private bucket); once per bill (rule 47). Ticket and bill Disputed; reminders and late fee pause; the owner is told; owner reminders day 3 and 5, admin day 7 (rule 52). The owner answers: **reject** (explanation, optional new due date), **correct the bill** (cancel and reissue, rule 49) or **give a credit** (taken off the bill, the rest kept as credit, rule 48). Customer told at each step; audited (`DISPUTE_*`, `INVOICE_CORRECTED`) | Customer bill › Dispute, customer ticket; owner ticket (dispute panel), "Correct the bill" | U `dispute.test.ts`, `decide.test.ts`, `transitions.test.ts`; DB `scen` (raise, reject, credit, covered → closed, corrected, cancel ends it, escalation); E2E `disputes.spec.ts` | done |
| Calculation or rate error after confirmation | **Task 8.** "Correct the bill": corrected reading(s) or adjustment lines, recalculated by the engine; the old invoice is cancelled (number voided, CANCELLED PDF version) and the corrected one issued with a new number; money already paid becomes a credit taken off it; a paid (closed) ticket is reopened first; a reading can change only while it is the latest (later readings or baselines: adjustment lines) | Owner ticket › Correct the bill; invoice pages show "Corrected, replaces …" / "Pay the corrected bill … instead" | U `dispute.test.ts`; DB `scen` (reopen + paid → credit, adjustment with part payment, refusals, later reading, estimate) | done |
| Dispute after the meter photo was deleted | The owner's dispute panel shows the reading on record: values, who confirmed and when, the photo deleted on confirmation (INV-10). The owner may **ask for a fresh meter photo**: the customer gets a Home task and takes it with the live camera, typing what the meter shows; the photo is deleted when the dispute ends | Owner dispute panel; customer Home task, ticket › Take a fresh meter photo | DB `scen` (fresh photo, storage rule, deletion) | done |
| Invoice notification not delivered | The bill stays in the portal; the bill email (PDF attached) is retried (decision 67) and the owner alerted when it fails; **"Send the bill again"** on the owner's invoice page sends it again with the PDF (ticket event, audit, not twice within 10 minutes) | Owner invoice page, delivery log | DB `scen` (resend), `not` (retries, PDF attached) | done |
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
| Customer changes phone or email | The owner updates the details; **task 10:** a new email address gets a test message at once ("From now on, emails … will be sent to …", decision 75), in the delivery log | Owner customer profile, delivery log | DB `acc`, `not` (test message written with the change) | partial: a test SMS for a new phone number needs NOT-03 (paid provider) |
| Machine replaced or swapped | Return the old machine with its closing reading (final bill), assign the replacement with its own starting reading (or Reassign) | Return, Assign | DB `scen` (swap), `mach`, `rules` | done |
| Temporary replacement while a machine is repaired | Not in the spec | — | — | deferred: not in the spec; a permanent swap (above) or a baseline covers today's cases |
| Meter replaced or reset | **Task 8:** "Record new meter baseline" with a reason; the old meter's last reading (optional) carries the copies printed on it into the next bill (rule 51); blocked while a reading waits for review; ticket event, audit, customer told | Agreement › Meter | U `dispute.test.ts`; DB `scen`; E2E `baseline.spec.ts` | done |
| Customer leaves with an unpaid balance | Deactivated; the balance stays on record and in Outstanding | Owner customer profile, Outstanding | DB `acc`, `mach` (balances) | done |
| Owner leaves the platform | Admin deactivates; data kept; the owner's customers are blocked with a message at sign-in and told by email that the company has left RentDesk (decision 75) | Admin › Owners | DB `acc`, `not`; E2E `account-management.spec.ts` | done |

## Service requests (spec 7; task 9)

Section 11 has no service rows; these are the service request paths that could otherwise be left waiting, held
to the same principle (a defined status, a reason, a notification and an audit entry). `srv` = `service.db.test.ts`.

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| Owner does not acknowledge a request | Reminder to the owner, then the admins, by urgency: URGENT and HIGH 4 h / 8 h, NORMAL and LOW 24 h / 48 h (owner settings; rule 61); at the daily run, so up to a day late on Vercel Hobby | Owner service list (Not acknowledged in time, Escalated), Admin › Escalations | U `rules.test.ts`, `daily.test.ts`; DB `srv` | done |
| Double tap or lost connection when sending a request | Idempotency key checked under a lock: the retry returns the first request; "Tap Send again: it is never sent twice" on a slow connection (rule 47's pattern) | Request service | DB `srv` | done |
| Photo invalid, too large or not a picture | Checked on the phone and again on the stored bytes; the file is removed and the customer adds it again (rule 58) | Request service | U `slip-check.test.ts`; DB `srv` (folder) | done |
| Request for a machine not rented to the customer | Refused (another customer's machine, a spare one, a returned one) | — | DB `srv` | done |
| The fix did not work | Customer: "No, still not fixed" with what is wrong → In progress, counted, owner told | Customer request page | DB `srv`; E2E `service.spec.ts` | done |
| Customer never confirms the fix | Home keeps asking ("Is it fixed?"); the owner can close it | Customer Home, owner request page | DB `srv` | done |
| Request no longer needed | Cancel with a reason: the customer while New, the owner at any open step; a charge not yet billed is dropped, one already on a bill blocks the cancel (correct that bill) | Request pages | DB `srv` | done |
| Charge decided after the machine went back | Refused with a clear message (no next bill); the final invoice on return bills charges still waiting | Owner request page, Return | DB `srv` | done |
| Charge while a reading waits for review | The charge waits for the next bill; a rejected draft frees the charges it held | — | DB `srv` | done |
| Owner suspended or customer suspended | Their requests stop escalating; the owner can still act | — | DB `srv` | done |

## Reports, settings and support access (task 11)

Not section 11 rows, but paths with the same risk (wrong data shown, a silent change, access without a trace).
`rpt` = `reports.db.test.ts`.

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| An owner asks for another tenant's report | Report functions are security invoker (RLS) and answer only that owner or an admin (0035); the export route uses the signed-in user's client and refuses another owner's id | Reports, exports | DB `rpt`; E2E `reports.spec.ts` | done |
| A customer calls an owner report directly | Nothing comes back (null), not even totals of their own rows | — | DB `rpt` | done |
| An admin needs to see an owner's business | Support view: read only, amber banner, every page and export logged (`SUPPORT_VIEW`: admin, owner, page, optional reason) before anything shows (decision 81) | Admin › Owners › Open support view | DB `rpt`; E2E `reports.spec.ts` | done |
| An admin tries to change an owner's data | No forms in the support view; the owner portal redirects admins; no admin write policies; workflow functions refuse an admin actor | — | DB `rpt`; E2E `reports.spec.ts` | done |
| A setting is set to something that breaks the schedule (a reminder after its deadline, an escalation before the reminder) | Refused with the field and the reason, in the form and again in the database; nothing saved (decision 82) | Admin › Settings, Settings › Reminders and deadlines | U `rules.test.ts`; DB `rpt` (SQL = TS); E2E `reports.spec.ts` | done |
| The admin changes a default so that an owner's overrides no longer fit | The owner's page says which ones; the daily job skips a reminder that falls after its deadline; the owner's next save must fix it | Settings › Reminders and deadlines | U `rules.test.ts` | done |
| Who changed a setting, and from what | Audit entry with old → new and the actor for every change; Admin › Audit log, Settings › Change history | Admin › Audit log | DB `rpt`; E2E `reports.spec.ts` | done |
| An agreement ends without anyone noticing | The owner is told once, within their notice (default 30 days), in-app and by email; "Ending soon" on the agreement, the customer profile and Rental information (decision 86) | Notifications, agreement, Reports › Rental information | U `daily.test.ts`; DB `rpt` | done |
| A text cell in an export looks like a formula | Kept as text with a leading apostrophe (decision 83) | Excel exports | U `export.test.ts` | done |

## PWA, offline, security and failures (task 12)

Not section 11 rows, but paths where a phone, a deployment or the network could show wrong or someone else's data.
`pwa` = `e2e/pwa.spec.ts`, `sec` = `e2e/security-headers.spec.ts`, `a11y` = `e2e/a11y.spec.ts`.

| Scenario | How RentDesk handles it | Screens | Tests | Status |
| --- | --- | --- | --- | --- |
| The phone is offline when a page is opened | The service worker shows "No internet connection" at the address the user wanted, with Try again; the page reloads by itself when the connection returns. Nothing personal is ever stored by the worker (decision 88) | Offline page | U `pwa.test.ts`; E2E `pwa` (offline, then back online) | done |
| A shared phone: the next person opens RentDesk | Signing out (or being signed out) clears drafts, session data and every non-static cache; pages, API answers, PDFs and signed URLs were never cached (decision 88) | Sign in | U `pwa.test.ts`; E2E `pwa` (sign-out clears; only static files cached) | done |
| A new version is deployed while a page is open | "New version available — tap to refresh" (on focus, every 15 minutes, or when an action fails); the tap reloads the same page; a typed meter reading stays on the phone (decision 89) | Any page | U `pwa.test.ts`; E2E `pwa` | done |
| A Server Action times out or the answer is lost | The message says whether tapping again is safe ("it is never done twice") or the user should reload and check first; a failed read never shows an empty list or "not found" (decision 92) | Every form | U `errors.test.ts` | done |
| A page cannot load (database stall, server error) | "This page could not load" with Try again and Go to Home, inside the portal's navigation; unknown addresses and other accounts' records get "We could not find this page" (rule 54 still logs the attempt) | Every portal | E2E `comments.spec.ts`, `account-management.spec.ts` (not found) | done |
| Another site frames RentDesk, injects a script or a form target | CSP `frame-ancestors 'none'`, scripts and forms from this site only, `X-Frame-Options: DENY`, HSTS, nosniff (decision 87) | — | U `headers.test.ts`; E2E `sec` (headers on every kind of response; no CSP violation in any portal) | done |
| A secret ends up in the browser | `npm run check:bundle` scans every browser file for the server secrets' values, service-role JWTs and server-only modules (clean; proven to catch a planted value) | — | `scripts/check-bundle-secrets.ts` | done |
| A payment slip is kept longer than needed | The file is deleted after the retention period (7 years by default, admin setting); the payment, its hash and an audit entry stay (decision 91) | Payment pages ("the slip file was deleted on …") | U `daily.test.ts`; DB `pay` | done |
| A keyboard or screen-reader user | Skip to content, labelled fields, focus order, contrast 4.5:1 or more; axe on every main page (decision 93) | All | E2E `a11y` | done |
