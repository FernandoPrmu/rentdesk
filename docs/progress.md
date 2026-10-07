# RentDesk — Progress

Tracks every requirement ID in `docs/spec.md` (v1.1). Update at the end of every task.

**Status values:** `todo` · `partial` · `done` (implemented **and** tested) · `deferred` (with reason)

## Task log

| Date | Task | Summary |
| --- | --- | --- |
| 2026-10-07 | 0. Setup | Next.js 16.4 (App Router, TS strict, Turbopack), Tailwind v4, shadcn/ui, Zod 4, Supabase JS + SSR helpers (browser / server / service-role with `server-only`), Serwist PWA (config mode: `serwist build` after `next build`), manifest and placeholder icons, mobile-first landing and login placeholder, Vitest + Playwright (Pixel 7) with sample tests, Supabase CLI for the cloud project (`supabase init`; link / db push / gen types), Vercel Cron in `vercel.json` with a stub `/api/cron/daily` secured by `CRON_SECRET`, Node 24. No requirement IDs are complete yet. |
| 2026-10-07 | 1. Database schema + RLS | 12 migrations (`supabase/migrations/0001`–`0012`): enums for every spec status, all section 12 entities plus branding, settings (global + per owner), gap-free per-owner invoice counters, templates, idempotency keys, login attempts, audit log. Composite tenant FKs, RLS on every table, explicit grants (nothing to anon). Private `app` schema (not exposed in the Data API) with 4 RLS helpers and atomic workflow functions (row lock + status re-check), called by server code through service-role-only `public.rpc_*` wrappers. Audit triggers, 3 private storage buckets with policies. `npm run test:db`: 23 RLS/workflow tests against the linked dev DB (rolled back; the concurrency test cleans up). `scripts/seed.ts` (`npm run db:seed`) seeded and re-run safely. Types regenerated. See `docs/database.md`. No UI. |
| 2026-10-07 | Spec v1.1 + Section 17 | Added BRD-01..07 (owner branding) as `todo`. Tenant isolation stays one shared schema with `owner_id` + RLS. |

## Requirements

### 4.1 Authentication and Security (AUTH)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| AUTH-01 | No public registration; accounts created only by the role above | Must | todo | |
| AUTH-02 | System generates username and temporary password on account creation | Must | todo | |
| AUTH-03 | Forced change of temporary password at first login | Must | todo | |
| AUTH-04 | Passwords stored as salted hashes; temp password shown once | Must | todo | Hashing handled by Supabase Auth (bcrypt) |
| AUTH-05 | Parent role resets passwords (Admin → owners, Owner → customers) | Must | todo | |
| AUTH-06 | Role-based access control for ADMIN, OWNER, CUSTOMER | Must | partial | DB layer done and tested: `profiles.role` and per-role RLS policies via `app.current_user_role()` (`supabase/tests/rls.db.test.ts`). Route guards in `src/proxy.ts` pending (task 2) |
| AUTH-07 | Tenant isolation by role and owner | Must | partial | DB layer done and tested: `owner_id` + RLS on every table, composite tenant FKs, storage policies by `{owner_id}/` prefix; owner / customer / anon isolation tests. App queries pending |
| AUTH-08 | Login rate limiting and temporary lockout | Must | todo | |
| AUTH-09 | Secure sessions with expiry; HTTPS everywhere | Must | todo | Vercel serves HTTPS; session expiry via Supabase Auth settings |
| AUTH-10 | Suspending an owner blocks that owner's customers | Must | partial | DB layer done and tested: RLS helpers return NULL for a suspended owner and their customers, so they see nothing. Login blocking pending (task 2) |
| AUTH-11 | Audit log for account creation, resets, status changes, logins | Should | partial | Audit triggers on account tables (create, status, password change/reset, lockout, `last_login_at` → LOGIN) and on ticket / invoice / payment / request status; `app.write_audit()` for server events; actor attribution tested. Login and reset events must be written by the auth flow (task 2) |
| AUTH-12 | Optional OTP/2FA for Admin and Owner | Could | todo | Supabase Auth TOTP MFA is free |

### 4.2 Admin Portal (ADM)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| ADM-01 | Create, view, edit owner accounts | Must | todo | |
| ADM-02 | Activate, suspend, deactivate owners | Must | todo | |
| ADM-03 | Reset owner passwords and deliver credentials | Must | todo | |
| ADM-04 | System dashboard: owners, customers, machines, invoices, open requests | Should | todo | |
| ADM-05 | View audit logs and notification delivery logs | Should | todo | |
| ADM-06 | Global settings: reminder schedule, templates, branding | Should | todo | |
| ADM-07 | Owner subscription plans and platform billing | Could | todo | |
| ADM-08 | Read-only, logged support view of an owner's data | Could | todo | |

### 4.3 Customer Management (CUS)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| CUS-01 | Owner creates, edits, views customers | Must | todo | |
| CUS-02 | System generates customer login; owner passes it on | Must | todo | |
| CUS-03 | Owner suspends, reactivates, deactivates customers and resets passwords | Must | todo | |
| CUS-04 | Customer profile: machines, agreements, invoices, payments, requests | Must | todo | |
| CUS-05 | Search and filter customers by name, status, outstanding balance | Should | todo | |

### 4.4 Machine Management (MAC)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| MAC-01 | Register machines: brand, model, serial, type (MONO/COLOUR), purchase date, status | Must | todo | |
| MAC-02 | Assign machine to customer with location and initial meter readings | Must | todo | |
| MAC-03 | Machine status: Available, Rented, Under Repair, Retired | Must | todo | |
| MAC-04 | Return or reassign a machine with closing readings | Must | todo | |
| MAC-05 | Machine history: rentals, service, toner, spare parts | Should | todo | |
| MAC-06 | QR code on machine opens a pre-filled service request | Could | todo | |

### 4.5 Rental Agreements (AGR)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| AGR-01 | Create agreement with all billing terms (commitment, included copies, rates) | Must | todo | |
| AGR-02 | Edit or terminate; changes apply from next period; history kept | Must | todo | |
| AGR-03 | Track end/renewal dates with reminders to owner | Should | todo | |

### 4.6 Billing Cycle Tickets (TKT)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| TKT-01 | Create a Billing Cycle Ticket per active machine every 30 days (configurable); notify customer | Must | todo | Vercel Cron → `/api/cron/daily` (stub in place) |
| TKT-02 | One ticket per machine per cycle carries the whole cycle | Must | todo | |
| TKT-03 | Statuses: Meter Requested → Pending Owner Review → Awaiting Payment → Payment Submitted → Closed | Must | todo | |
| TKT-04 | Each hand-over sends app notification and email | Must | todo | |
| TKT-05 | Stage deadlines, reminders, escalation (spec 5.4) | Must | todo | |
| TKT-06 | Ticket shows stage, who must act, due date, full history | Must | todo | |
| TKT-07 | Next cycle scheduled from cycle calendar, not close date | Must | todo | |
| TKT-08 | Duplicate tickets per agreement and cycle prevented | Must | partial | Unique `(agreement_id, cycle_no)` + replay-safe `app.open_billing_cycle` (tested). Daily cron not built yet |
| TKT-09 | Every ticket action logged with user, time, reason | Must | partial | Every workflow function writes `ticket_events` (actor, from, to, reason) in the same transaction (tested). TS state machine pending |
| TKT-10 | Owner cancels or reopens a ticket with mandatory reason | Should | todo | |
| TKT-11 | Customer and owner comments on a ticket | Should | todo | |
| TKT-12 | Tickets paused for suspended accounts; resume on reactivation | Should | todo | |
| TKT-13 | All section 11 negative scenarios end in a defined status with reason, notification, audit | Must | todo | |

### 4.7 Meter Reading and Invoicing (INV)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| INV-01 | "Enter meter" shows reading box(es) and live camera capture | Must | todo | |
| INV-02 | Mono: one reading; Colour: B&W and colour readings | Must | todo | |
| INV-03 | Live camera only; no gallery or file upload | Must | todo | `getUserMedia` + canvas; no `<input type="file">` |
| INV-04 | Validate readings (not lower than previous, rollover, one submission per ticket) | Must | todo | |
| INV-05 | Backend calculates usage and invoice amount (spec 6) | Must | todo | Pure functions in `src/lib/billing/`, integer cents |
| INV-06 | Submit creates draft invoice; ticket sent to owner (app + email) | Must | todo | |
| INV-07 | Owner confirms or rejects (mandatory reason) | Must | todo | |
| INV-08 | Owner corrects a mistyped reading with audit note; recalculated; customer notified | Should | todo | |
| INV-09 | On confirm: photo deleted, invoice issued, sent to customer with PDF | Must | todo | |
| INV-10 | Reading values, confirming user, timestamps kept permanently | Must | todo | |
| INV-11 | Unique invoice numbers per owner | Must | partial | Per-owner `invoice_counters` + `app.assign_invoice_number` inside the issuing transaction: unique, ordered, gap-free (rollback test). Invoice flow / PDF pending |
| INV-12 | Owner enters a reading manually with a note | Should | todo | |
| INV-13 | Idempotent submissions; drafts survive poor connections | Must | partial | Unique idempotency keys on submissions / payments; workflow functions replay instead of duplicating (tested); `idempotency_keys` table for server actions. Client offline queue pending |
| INV-14 | Server-side timestamp per submission and photo | Should | todo | |

### 4.8 Payments and Payment Slips (PAY)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| PAY-01 | Invoice statuses: Draft … Cancelled (9 statuses) | Must | todo | |
| PAY-02 | Customer attaches slip with amount, date, reference | Must | todo | |
| PAY-03 | Slip JPG/PNG/PDF, size limit, scanned before storage | Must | todo | Magic-byte + size checks are free; a true virus scan may need a paid/hosted scanner — decide when built |
| PAY-04 | Slip submission notifies owner (app + email) | Must | todo | |
| PAY-05 | Owner accepts, rejects (reason), or accepts as partial | Must | todo | |
| PAY-06 | Full verification closes ticket; customer gets receipt notification | Must | todo | |
| PAY-07 | Owner records cash/cheque payments manually | Must | todo | |
| PAY-08 | Payment history per customer and per invoice | Must | todo | |
| PAY-09 | Outstanding list with ageing (current, 1-30, 31-60, 60+) | Must | todo | |
| PAY-10 | Automated reminders before, on, and after due date | Must | todo | Via daily cron |
| PAY-11 | Duplicate slip detection by bank reference and file hash | Should | todo | SHA-256 of file |
| PAY-12 | Overpayments held as credit; applied or refunded | Should | todo | |
| PAY-13 | Optional late fee after grace period | Could | todo | |
| PAY-14 | Online payment gateway (PayHere) | Could | todo | Likely deferred — needs paid provider |

### 4.9 Service Requests (SRV)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| SRV-01 | Customer raises request: Breakdown/Repair, Toner, Spare Part, Maintenance, Other | Must | todo | |
| SRV-02 | Fields: machine, type, description, urgency | Must | todo | |
| SRV-03 | Workflow: New → Acknowledged → Assigned → In Progress → Resolved → Closed (or Cancelled) | Must | todo | |
| SRV-04 | Owner acknowledges, assigns, adds notes | Must | todo | |
| SRV-05 | Customer tracks status; notified on every change | Must | todo | |
| SRV-06 | Toner request records toner colour(s) for colour machines | Should | todo | |
| SRV-07 | Record work done, parts used, cost | Should | todo | |
| SRV-08 | Escalate to owner then Admin when not acknowledged in time | Should | todo | Daily cron granularity only on Vercel Hobby; sub-day escalation (e.g. 4 h) needs another trigger |
| SRV-09 | Customer rating after close | Could | todo | |

### 4.10 Notifications (NOT)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| NOT-01 | In-app notification centre for all users | Must | todo | Supabase Realtime |
| NOT-02 | Email notifications including invoice emails | Must | todo | Resend |
| NOT-03 | SMS and WhatsApp for reminders and urgent events | Should | todo | Likely deferred — needs paid provider (stub interface) |
| NOT-04 | Editable message templates | Should | todo | |
| NOT-05 | Delivery log: sent, failed, read | Should | todo | |

### 4.11 Reports and Dashboards (RPT)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| RPT-01 | Owner dashboard: income, outstanding, overdue, pending approvals, open requests | Must | todo | |
| RPT-02 | Monthly income and sales report | Must | todo | |
| RPT-03 | Machine-wise report: revenue, copies, excess, service/toner cost | Must | todo | |
| RPT-04 | Outstanding and ageing report | Must | todo | |
| RPT-05 | Customer-wise report | Should | todo | |
| RPT-06 | Service and toner demand report | Should | todo | |
| RPT-07 | Export reports to PDF and Excel | Should | todo | |
| RPT-08 | Admin report: owner activity and platform usage | Should | todo | |

### 4.12 Customer Portal (CP)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| CP-01 | Dashboard: machines, balance, next cycle date, open tickets | Must | todo | |
| CP-02 | Ticket inbox with current stage and next action | Must | todo | |
| CP-03 | Enter meter from ticket: readings + live camera, then Submit | Must | todo | |
| CP-04 | View confirmed invoice and submit payment slip | Must | todo | |
| CP-05 | View/download past invoices, receipts, payment history | Must | todo | |
| CP-06 | Raise a dispute and comment on a ticket | Should | todo | |
| CP-07 | Raise and track service requests | Must | todo | |
| CP-08 | Notification centre and profile with password change | Must | todo | |
| CP-09 | Mobile-first responsive design (installable PWA) | Should | todo | Shell, manifest, icons and service worker in place (setup); not verified as done until the portal exists |

### 17. Owner Branding (BRD)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| BRD-01 | Owner must complete company setup (name, logo, address, phone, email, bank details) after first password change, before the dashboard | Must | todo | Gate in proxy after AUTH-03 |
| BRD-02 | Logo upload (JPG/PNG/SVG), validated, resized, stored privately; shown in portals, emails, invoices | Must | todo | SVG must be sanitised (script/XSS risk) and rasterised for PDFs |
| BRD-03 | Edit company details and logo from Settings; applies to new invoices only | Must | todo | Issued invoices keep their stored PDF / snapshot |
| BRD-04 | Upload invoice letterhead (A4 image or 1-page PDF) as invoice PDF background | Should | todo | |
| BRD-05 | Position invoice data area on letterhead (presets or drag); saved per owner | Should | todo | |
| BRD-06 | Without a letterhead, invoices use the built-in template with owner logo and details | Must | todo | |
| BRD-07 | Preview a sample invoice before saving template changes | Should | todo | |
