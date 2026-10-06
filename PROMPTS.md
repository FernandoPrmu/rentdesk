# RentDesk — Claude Code Prompts (run in order)

Run one prompt per session, or use `/clear` between them. After each step:
- test the app yourself on your phone,
- commit to git,
- then move on.

If something breaks, describe what you saw instead of re-running the whole prompt.

---

## 0. Setup
```
Read CLAUDE.md and docs/spec.md fully. Then:
1. Scaffold a Next.js (App Router, TypeScript strict, Tailwind) app in this folder.
   Add shadcn/ui, Zod, Vitest, Playwright, Serwist PWA, and the Supabase JS + SSR packages.
2. Set up the Supabase CLI for the Supabase cloud project (supabase/ folder). No local
   Docker: link the project, push migrations with `supabase db push`, generate types
   with `supabase gen types typescript --linked`.
3. Add npm scripts: lint, typecheck, test, test:e2e.
4. Create docs/progress.md: a table of EVERY requirement ID in the spec
   (AUTH, ADM, CUS, MAC, AGR, TKT, INV, PAY, SRV, NOT, RPT, CP) with status "todo".
5. Create .env.example listing all needed environment variables.
Show me your plan first, then do it.
```

## 1. Database schema + RLS
```
Using spec section 12 (Data Model) plus sections 3, 5 and 11, write the full Postgres
schema as Supabase migrations:
- All tables, enums for every status in the spec, foreign keys and indexes.
- A unique constraint on (agreement_id, cycle_no).
- RLS on every table, with policies for ADMIN, OWNER and CUSTOMER.
- Helper SQL functions to get the current user's role and owner_id.
- A seed.sql file with demo data, as described in CLAUDE.md.
Apply the migrations to the linked Supabase cloud project with `npm run db:push`
(seed with `--include-seed`).
Write tests (SQL or Vitest against the linked Supabase cloud dev project) that prove:
- an owner cannot read another owner's data,
- a customer sees only their own records.
Generate the TypeScript types with `npm run db:types`.
```

## 2. Auth + account hierarchy (AUTH-01..12, ADM-01..03, CUS-01..03)
```
Implement:
- Login.
- Forced password change at first login.
- Role-based route groups with middleware guards.
- Admin creates, edits, suspends and reactivates owners, and resets their passwords.
- Owner does the same for customers.
- Temporary password shown once in a copy-able dialog.
- Suspension cascade (a suspended owner blocks their customers).
- Login rate limiting and lockout.
- Audit log entries.
Use the Supabase admin API only on the server.
```

## 3. Machines + agreements (MAC-01..05, AGR-01..03, CUS-04..05)
```
Owner portal:
- Machine CRUD (MONO/COLOUR, statuses).
- Assign a machine to a customer with initial meter readings.
- Return or reassign with closing readings.
- Agreement CRUD with all pricing fields. Changes apply from the next period and keep history.
- Customer profile page.
- Search and filters.
Mobile-friendly tables (card layout under 640px).
```

## 4. Billing engine (INV-04, INV-05, spec section 6)
```
Build src/lib/billing as pure functions:
- Usage per counter.
- Excess calculation with no cross-counter offset.
- Invoice total.
- Validation (reading must not go backwards; meter rollover and reset rules from section 11).
- High/low usage warning versus history.
Use integer cents. Write Vitest tests for EVERY worked example in section 6.3, plus edge
cases. All tests must pass.
```

## 5. Billing cycle tickets + daily cron (TKT-01..13, spec 5.4)
```
Build src/lib/tickets as the state machine, with all statuses and transitions from
sections 5.3 and 11. Every transition checks the role, writes ticket_events, and queues
notifications.
Build /api/cron/daily, secured by CRON_SECRET. It must:
- create due tickets from the cycle calendar (catch-up safe, idempotent, Asia/Colombo time),
- send stage reminders,
- mark tickets Overdue,
- escalate to the owner and then the admin,
- clean up expired photos,
- pause tickets for suspended accounts.
It is called once a day by Vercel Cron (already registered in vercel.json; Hobby allows
one run per day and may fire anywhere within the scheduled hour).
Unit-test the state machine and the cron logic, including running it twice and missing days.
```

## 6. Meter entry with live camera (INV-01..14, CP-02, CP-03)
```
Customer flow, mobile-first:
1. Ticket inbox.
2. Open the Meter Requested ticket and tap "Enter meter".
3. Full-screen live camera (getUserMedia, rear camera) with capture/retake. NO file input.
4. Reading box(es): one for mono, B&W + colour for colour machines.
5. Submit with an idempotency key; drafts survive a lost connection.
Server side: validate, compute the draft invoice, store the photo in a private bucket, and
notify the owner.
Owner review screen: photo (signed URL) next to the typed readings and draft invoice,
with Confirm / Reject (reason required) / Correct (audit note).
On Confirm:
- delete the photo,
- issue the invoice number (unique per owner),
- generate the PDF,
- email it.
Handle camera permission denied with clear guidance.
```

## 7. Payments + slips (PAY-01..13)
```
Customer uploads a payment slip (JPG/PNG/PDF, size limit, magic-byte check, SHA-256 hash for
duplicate detection) with amount, date and reference.
Owner can Accept, Reject (with reason), or Accept as partial; close the ticket; and record
cash or cheque payments manually.
Also build:
- receipt notification,
- credits for overpayments applied to the next invoice,
- outstanding list with ageing (current, 1-30, 31-60, 60+),
- payment reminders (via the daily cron),
- optional late fee setting.
```

## 8. Negative scenarios (spec section 11)
```
Go through spec section 11 scenario by scenario. For each one, confirm it is handled.
Every scenario must end in a defined status with a reason, a notification and an audit entry.
Cover in particular:
- disputes,
- estimated billing with reconciliation,
- skipped or multiple cycles,
- meter replacement and baseline reset,
- reopen and cancel with a reason,
- duplicate or fake slips.
Write a test per scenario. List any gaps in docs/progress.md.
```

## 9. Service requests (SRV-01..09, CP-07)
```
Customer raises a request (type, machine, description, urgency, toner colours for colour
machines).
Owner workflow: New → Acknowledged → Assigned → In Progress → Resolved → Closed/Cancelled,
with assignment, notes, work done, parts and cost.
Status history and notifications on every change.
Escalate when a request is not acknowledged in time (via the cron).
Customer rating after close.
```

## 10. Notifications (NOT-01..05)
```
- In-app notification centre with Supabase Realtime and an unread badge.
- Email through a single sendNotification() service with editable templates stored in the DB.
- Delivery log with sent / failed / read status.
- Retry for failed emails.
- SMS/WhatsApp behind the same interface as stub providers, marked deferred.
```

## 11. Dashboards + reports (RPT-01..08, CP-01, ADM-04..08)
```
Build:
- Owner dashboard: income this month, outstanding, overdue, pending approvals, open requests.
- Reports: monthly income, machine-wise, ageing, customer-wise, service/toner demand.
- Export to PDF and Excel (xlsx).
- Customer dashboard.
- Admin dashboard, audit log viewer, global settings, and a logged read-only support view.
Keep charts simple and readable on mobile.
```

## 12. PWA polish + final audit
```
1. PWA: manifest, icons, install prompt, offline fallback page, and offline draft saving
   for meter entry.
2. Lighthouse mobile audit; fix performance and accessibility issues
   (target: load in under 3 s).
3. Security pass: RLS review, no service key in the client, CSRF/XSS checks, upload checks,
   rate limits.
4. Playwright e2e test of one full cycle on a mobile viewport:
   meter → confirm → slip → close.
5. Go through docs/progress.md and verify EVERY requirement ID. Implement anything still
   "todo". List what is deferred and why.
```

## 13. Deploy (free)
```
Prepare for deployment:
- Supabase cloud production project setup steps (separate from the dev project).
- Migrations push (`supabase link` to production, then `npm run db:push`).
- Vercel environment variables, including CRON_SECRET for Vercel Cron.
- Vercel Cron check: the daily job in vercel.json is active and authorised.
- A GitHub Actions workflow for a daily pg_dump backup, with its secrets. This backup is
  the only GitHub Actions job; the daily app job runs on Vercel Cron.
- Resend domain/sender setup.
Write docs/deploy.md as a step-by-step checklist, then help me run it.
```
