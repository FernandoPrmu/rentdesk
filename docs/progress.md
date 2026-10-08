# RentDesk — Progress

Tracks every requirement ID in `docs/spec.md` (v1.1). Update at the end of every task.

**Status values:** `todo` · `partial` · `done` (implemented **and** tested) · `deferred` (with reason)

## Task log

| Date | Task | Summary |
| --- | --- | --- |
| 2026-10-07 | 0. Setup | Next.js 16.4 (App Router, TS strict, Turbopack), Tailwind v4, shadcn/ui, Zod 4, Supabase JS + SSR helpers (browser / server / service-role with `server-only`), Serwist PWA (config mode: `serwist build` after `next build`), manifest and placeholder icons, mobile-first landing and login placeholder, Vitest + Playwright (Pixel 7) with sample tests, Supabase CLI for the cloud project (`supabase init`; link / db push / gen types), Vercel Cron in `vercel.json` with a stub `/api/cron/daily` secured by `CRON_SECRET`, Node 24. No requirement IDs are complete yet. |
| 2026-10-07 | 1. Database schema + RLS | 12 migrations (`supabase/migrations/0001`–`0012`): enums for every spec status, all section 12 entities plus branding, settings (global + per owner), gap-free per-owner invoice counters, templates, idempotency keys, login attempts, audit log. Composite tenant FKs, RLS on every table, explicit grants (nothing to anon). Private `app` schema (not exposed in the Data API) with 4 RLS helpers and atomic workflow functions (row lock + status re-check), called by server code through service-role-only `public.rpc_*` wrappers. Audit triggers, 3 private storage buckets with policies. `npm run test:db`: 23 RLS/workflow tests against the linked dev DB (rolled back; the concurrency test cleans up). `scripts/seed.ts` (`npm run db:seed`) seeded and re-run safely. Types regenerated. See `docs/database.md`. No UI. |
| 2026-10-07 | Spec v1.1 + Section 17 | Added BRD-01..07 (owner branding) as `todo`. Tenant isolation stays one shared schema with `owner_id` + RLS. |
| 2026-10-08 | 2. Auth + accounts + company setup | Migration `0013`: login lockout / IP limit and session timeout settings in `platform_settings`; atomic account functions (`login_gate_state`, `record_login_attempt`, `session_state`, `set_account_status`, `reset_account_password`, `complete_password_change`, `update_owner`, `update_customer`, `save_company_profile`) behind service-role `rpc_*` wrappers; status-change reasons in the audit log; `custom_access_token_hook` (refuses tokens to blocked or locked accounts; enable in the dashboard, see `docs/database.md`). Username login with the synthetic email, one generic error, lockout and IP limit; `src/proxy.ts` refreshes sessions, signs out blocked or timed-out users, forces password change then owner setup, and guards `/admin`, `/owner`, `/customer`. Admin owner management and owner customer management (create with one-time credentials dialog, edit, suspend / reactivate / deactivate with reason, reset password), owner company setup gate and Settings › Company with logo upload (magic bytes, SVG safety check, rasterised and resized to PNG with `sharp`, signed URLs). Portal shells: customer bottom nav with "What you need to do now"; owner/admin sidebar on desktop, bottom nav on mobile. Tests: 73 unit, 33 DB (10 new), 20 Playwright at 360 px. Seed re-runs restore demo login state. |
| 2026-10-08 | 3. Machines, agreements, customer profile | Migration `0014`: `first_billing_date` (start date may be in the past for migrated rentals; first billing date today or later; no ticket before it), `billing_day` unused, `agreement_terms_history` (append-only versions effective from the next cycle; `open_billing_cycle` snapshots the version in force, tickets also snapshot `due_days`), `customer_balances` view. Atomic `rpc_assign_machine` / `rpc_return_machine` / `rpc_reassign_machine` / `rpc_update_agreement_terms` / `rpc_set_machine_status` (owner + tenant checks, audit, customer notifications). Owners can no longer write agreements or machine status directly; triggers keep RENTED tied to a live agreement. Owner portal: machines (search, type/status filters, cards on mobile, table on desktop), register/edit, status change with reason, detail with rental history, assign with first-billing-date preview, return (closing readings, blocked with a clear list while a ticket is open or an invoice unpaid), guided reassign, agreement page with "from next cycle" edits and the full terms history, customer profile (machines, agreements, balance, tickets, invoices), customer list balance filter. Customer portal: read-only Machines tab. Rupees typed in the UI, integer cents everywhere else. Tests: 146 unit, 44 DB (11 new for machines and agreements, RLS tests updated for the tighter grants), 26 Playwright at 360 px (6 new; e2e removes its `E2E-*` machines). `npm audit`: 9 high findings, all one `braces` advisory reached only through the `shadcn` CLI and `eslint-config-next` (build/dev tooling, not runtime code). |
| 2026-10-08 | 3a. UI polish | Dev overlay "1 Issue" on `/owner/machines`: the GET filter forms stayed mounted when the URL filters changed (e.g. tapping the nav link to clear a search), so Base UI saw a changed `defaultValue` on an uncontrolled input and logged an error (and the box kept the old text). Filter forms on machines, customers and owners are now keyed by the URL filters; a crawl of every owner/admin/customer page at 360 and 1280 px shows no console errors. UI components import `cn` from `@/lib/utils` (the shadcn base-nova registry hard-codes `from "cn"`; an ESLint rule now flags it). Every native `<select>` replaced with the shadcn Select (48 px trigger and options, popup anchored below and kept inside a 360 px viewport, value submitted via `name`). New e2e: filter reset without console errors, machine status change with reason (MAC-03 UI). Tests: 146 unit, 44 DB, 28 Playwright. |
| 2026-10-08 | 3b. Sign-out / expired-session actions | Root cause: `src/proxy.ts` answered Server Action POSTs with 307 redirects (idle/max-age timeout, blocked, signed out, gates) or a plain 503; fetch re-POSTed to `/login` and React threw "An unexpected response was received from the server" (reproduced by signing out after the idle limit). The proxy now passes action requests through (after any forced sign-out) with the target in an internal header; `currentActor()` redirects with `redirect()` instead of returning null, and `signOutAction` keeps the `?reason=` when the proxy ended the session. New e2e at 360 px: sign out from all three portals, form submit and sign-out after the idle timeout, all without console errors. Tests: 149 unit, 44 DB, 33 Playwright. |
| 2026-10-08 | 4. Billing engine | `src/lib/billing/`: integer arithmetic (BigInt, one rounding rule: half up), usage per counter (previous = newest of initial / confirmed / baseline; rollover only when plausible, flagged, owner-confirmed), invoice lines (commitment × cycles, excess per counter, proration on return, estimated + reconciliation credits, customer credits, adjustments), late fee, anomaly flags. One source of truth: migration 0015 stores the engine's calculation and re-checks its inputs and arithmetic, never calculating itself; deterministic previous-reading ties; rollover confirmation stored on the reading. Seed and DB fixtures build invoices with the engine (seed re-run bug from task 3 fixed: agreements inserted only when missing). `docs/decisions.md` lists every rule the spec left open. `shadcn` moved to devDependencies (`npm audit --omit=dev`: 0 vulnerabilities; build passes). Tests: unit (all spec 6.3 examples by name + edge cases), DB (wiring, tampering, stale baseline, rollover confirmation). |

## Requirements

### 4.1 Authentication and Security (AUTH)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| AUTH-01 | No public registration; accounts created only by the role above | Must | done | No sign-up page. `app.provision_account` allows only Admin → Owner → Customer (DB tests); admin and owner create accounts in the portals (e2e) |
| AUTH-02 | System generates username and temporary password on account creation | Must | done | Usernames from the business name (`owner.…`, `cust.…`, number added on a clash) and 14-character temporary passwords from `crypto`, both server-side (`src/lib/auth/username.ts`, `temporary-password.ts`; unit + e2e) |
| AUTH-03 | Forced change of temporary password at first login | Must | done | `must_change_password` sends every route to `/change-password` (proxy + DAL); live strength checklist; `rpc_complete_password_change` clears the flag. Rules: 10+ characters, a letter, a number, no part of the username, not a common password (the spec gives none). Unit + e2e (`cust.bandara`, new customer, new owner) |
| AUTH-04 | Passwords stored as salted hashes; temp password shown once | Must | done | Supabase Auth stores bcrypt hashes; RentDesk never stores passwords. The credentials dialog shows them once and closes only after "I have saved these details" (e2e) |
| AUTH-05 | Parent role resets passwords (Admin → owners, Owner → customers) | Must | done | `rpc_reset_account_password` (permission check, forces a change, clears lockout, audit) then the Auth Admin API sets a new temporary password. DB tests for both parents and refusals; e2e: owner resets a customer, old password stops working |
| AUTH-06 | Role-based access control for ADMIN, OWNER, CUSTOMER | Must | done | RLS per role (task 1) + `src/proxy.ts` route guards + role checks in every page and Server Action (`requireUser` / `currentActor`). Unit (`routeDecision`) + e2e (owner → /admin, customer → /owner, signed-out → /login) |
| AUTH-07 | Tenant isolation by role and owner | Must | done | DB layer from task 1. Portal queries run as the signed-in user so RLS decides; the service role is used only in server code for credentials and rpc calls. e2e: an owner opening another tenant's customer gets "not found". Every later feature must keep this |
| AUTH-08 | Login rate limiting and temporary lockout | Must | done | 5 wrong passwords → 15 min lockout; 30 failures per IP per 15 min (spec gives no numbers; in `platform_settings`). Unknown usernames lock the same way; one generic error for wrong details. Pure gate `login-gate.ts` (unit), atomic `record_login_attempt` (DB), e2e lockout. Access token hook also refuses locked accounts. Raise Supabase's own sign-in rate limit before production (`docs/database.md`) |
| AUTH-09 | Secure sessions with expiry; HTTPS everywhere | Must | done | Supabase session limits are paid, so the proxy signs out after 30 min idle and 12 h after sign-in (settings), with a message on /login. Unit (`sessionTimeout`) + e2e (idle page load, and a form submit or sign-out after the idle limit lands on /login with the message). HTTPS: Vercel |
| AUTH-10 | Suspending an owner blocks that owner's customers | Must | done | Blocked in four places: RLS helpers (task 1), login (clear message after a correct password), proxy on every request, and the access token hook (sign-in and refresh). Unit (`blockReason`), DB (`session_state.owner_status`, hook), e2e (suspended customer and owner cannot sign in) |
| AUTH-11 | Audit log for account creation, resets, status changes, logins | Should | done | Audit entries: account creation, `LOGIN`, `LOGIN_FAILED` (username, IP, reason), `LOCKOUT`, `LOGOUT`, `PASSWORD_RESET`, `PASSWORD_CHANGED`, `STATUS_CHANGE` with reason, detail edits (DB tests). Viewing them is ADM-05 |
| AUTH-12 | Optional OTP/2FA for Admin and Owner | Could | deferred | Left out of task 2 by decision. Supabase Auth TOTP MFA is free when it is picked up |

### 4.2 Admin Portal (ADM)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| ADM-01 | Create, view, edit owner accounts | Must | done | List with search (business, contact, phone, email, username) and status filter; create; view; edit (e2e) |
| ADM-02 | Activate, suspend, deactivate owners | Must | done | Suspend / reactivate / deactivate with reason and confirm dialog; owner notified in-app; suspending an owner blocks their customers (AUTH-10). DB + e2e |
| ADM-03 | Reset owner passwords and deliver credentials | Must | done | Reset with a new temporary password shown once in the copy dialog (spec 3.2 allows one-time on-screen display). Sending credentials by email waits for NOT-02 |
| ADM-04 | System dashboard: owners, customers, machines, invoices, open requests | Should | todo | |
| ADM-05 | View audit logs and notification delivery logs | Should | todo | |
| ADM-06 | Global settings: reminder schedule, templates, branding | Should | todo | |
| ADM-07 | Owner subscription plans and platform billing | Could | todo | |
| ADM-08 | Read-only, logged support view of an owner's data | Could | todo | |

### 4.3 Customer Management (CUS)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| CUS-01 | Owner creates, edits, views customers | Must | done | Owner creates, views and edits customers; list with search and status filter (e2e). Full customer profile is CUS-04 |
| CUS-02 | System generates customer login; owner passes it on | Must | done | Login generated on creation and shown once (e2e: the new customer signs in and must change the password) |
| CUS-03 | Owner suspends, reactivates, deactivates customers and resets passwords | Must | done | Suspend / reactivate / deactivate with reason, and password reset, own customers only (DB: other tenants refused; e2e) |
| CUS-04 | Customer profile: machines, agreements, invoices, payments, requests | Must | partial | Done: contact details, account status and actions, machines and agreements (live + earlier), outstanding balance, recent billing tickets and issued invoices (RLS-scoped). Pending: payment history (PAY-08) and service requests (SRV), shown as placeholders |
| CUS-05 | Search and filter customers by name, status, outstanding balance | Should | partial | Search and status filter (task 2); balance filter (has balance due / nothing due) and the balance on each row from the `customer_balances` view (DB test). Partial until credits and payment allocation (PAY-08, PAY-12) settle the exact balance definition |

### 4.4 Machine Management (MAC)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| MAC-01 | Register machines: brand, model, serial, type (MONO/COLOUR), purchase date, status | Must | done | Register and edit (brand, model, serial unique per owner, type fixed once chosen, purchase date, counter maxima for rollover, notes); list with search by brand/model/serial and type/status filters, cards at 360 px and a table on desktop. Unit (schemas), DB (RLS, guards), e2e |
| MAC-02 | Assign machine to customer with location and initial meter readings | Must | done | One atomic `rpc_assign_machine` from the machine or the customer page: own available machine + own active customer, location, initial B&W (+ colour) readings, terms, first billing date. Cross-tenant links refused (rpc + composite FKs). DB + e2e |
| MAC-03 | Machine status: Available, Rented, Under Repair, Retired | Must | done | Available / Under repair / Retired by hand with a reason (`rpc_set_machine_status`, audited); RENTED only through an agreement (trigger guard, no client grant on status). Unit + DB + e2e |
| MAC-04 | Return or reassign a machine with closing readings | Must | done | Return: closing reading(s) not below the last known reading (unless the counter has a maximum: rollover) and a reason; agreement terminated, machine available, atomic. Reassign: return + new assignment in one guided form and one transaction. Blocked with a list of what to resolve while a ticket is open or an invoice is unpaid. DB (atomicity, blockers) + e2e. The final invoice for a mid-cycle return (spec 11.4) comes with the billing flow |
| MAC-05 | Machine history: rentals, service, toner, spare parts | Should | partial | Rental history (customer, dates, closing readings, reason) on the machine page. Service, toner and spare parts wait for SRV; meter history placeholder |
| MAC-06 | QR code on machine opens a pre-filled service request | Could | deferred | Deferred by decision in task 3: the pre-filled service request (SRV) does not exist yet |

### 4.5 Rental Agreements (AGR)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| AGR-01 | Create agreement with all billing terms (commitment, included copies, rates) | Must | done | Start date, first billing date, cycle length (default 30), due days, commitment, included copies and excess rate per counter (colour only for colour machines), location, end date. Rupees in the UI, bigint cents stored. `billing_day` not used (spec: every N days). Unit + DB + e2e |
| AGR-02 | Edit or terminate; changes apply from next period; history kept | Must | done | Pricing and due-day edits create a new version effective from the cycle after the one in progress; open tickets keep their snapshot; history shows who, when, from which cycle, note, pending/replaced. Location and end date change at once. Terminate = return (MAC-04). Unit (effective cycle, version rules) + DB (cycle 2 old terms, cycle 3 new) + e2e |
| AGR-03 | Track end/renewal dates with reminders to owner | Should | partial | End date on the agreement and an "Ending soon" badge (30 days) on the agreement and customer pages (unit). Reminders to the owner need the daily cron and notifications |

### 4.6 Billing Cycle Tickets (TKT)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| TKT-01 | Create a Billing Cycle Ticket per active machine every 30 days (configurable); notify customer | Must | todo | Vercel Cron → `/api/cron/daily` (stub in place) |
| TKT-02 | One ticket per machine per cycle carries the whole cycle | Must | todo | |
| TKT-03 | Statuses: Meter Requested → Pending Owner Review → Awaiting Payment → Payment Submitted → Closed | Must | todo | |
| TKT-04 | Each hand-over sends app notification and email | Must | todo | |
| TKT-05 | Stage deadlines, reminders, escalation (spec 5.4) | Must | todo | |
| TKT-06 | Ticket shows stage, who must act, due date, full history | Must | todo | |
| TKT-07 | Next cycle scheduled from cycle calendar, not close date | Must | partial | Calendar: cycle n due on `first_billing_date + (n − 1) × length`; `open_billing_cycle` advances by the calendar (DB tests); TS mirror unit-tested (month ends, 29 Feb, 30-day cycles, missed days). Daily cron not built yet |
| TKT-08 | Duplicate tickets per agreement and cycle prevented | Must | partial | Unique `(agreement_id, cycle_no)` + replay-safe `app.open_billing_cycle` (tested). Daily cron not built yet |
| TKT-09 | Every ticket action logged with user, time, reason | Must | partial | Every workflow function writes `ticket_events` (actor, from, to, reason) in the same transaction (tested). TS state machine pending |
| TKT-10 | Owner cancels or reopens a ticket with mandatory reason | Should | todo | |
| TKT-11 | Customer and owner comments on a ticket | Should | todo | |
| TKT-12 | Tickets paused for suspended accounts; resume on reactivation | Should | todo | |
| TKT-13 | All section 11 negative scenarios end in a defined status with reason, notification, audit | Must | partial | Calculation rules of section 11 done in the billing engine (unit-tested): reading lower than previous refused, rollover with plausibility guard and owner confirmation, baseline after meter reset, zero usage flagged, estimated invoice and reconciliation (11.6), several cycles combined (11.6), final prorated/full invoice on return (11.4). Status flows, reminders and notifications for the other scenarios pending |

### 4.7 Meter Reading and Invoicing (INV)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| INV-01 | "Enter meter" shows reading box(es) and live camera capture | Must | todo | |
| INV-02 | Mono: one reading; Colour: B&W and colour readings | Must | todo | |
| INV-03 | Live camera only; no gallery or file upload | Must | todo | `getUserMedia` + canvas; no `<input type="file">` |
| INV-04 | Validate readings (not lower than previous, rollover, one submission per ticket) | Must | done | `counterUsage`: lower reading refused unless a plausible rollover on a counter with a maximum (guard: not above the HIGH threshold, or at most half the maximum without history); reading above the maximum refused; rollover flagged and must be confirmed by the owner (`rpc_confirm_meter_submission(p_rollover_confirmed)`, stored on the reading). The database refuses a calculation whose previous reading is not `app.last_known_reading` (stale after a new baseline). One submission per ticket from task 1. Unit + DB |
| INV-05 | Backend calculates usage and invoice amount (spec 6) | Must | done | `src/lib/billing/` is the only calculation (integer cents via BigInt, no floats): every spec 6.3 worked example as a named test, B&W and colour separately, excess lines hidden at zero, multi-cycle, estimated + reconciliation, proration, credits, adjustments, anomaly flag. Migration 0015: `rpc_submit_meter_reading` stores the engine's `calculation` and refuses it unless its inputs are the ticket's facts (terms snapshot, cycles since the last confirmed reading, previous readings, readings, anomaly) and every line is quantity × rate and adds up. Loader `context.ts` shared by server code and the seed. Unit + DB + seed |
| INV-06 | Submit creates draft invoice; ticket sent to owner (app + email) | Must | todo | |
| INV-07 | Owner confirms or rejects (mandatory reason) | Must | todo | |
| INV-08 | Owner corrects a mistyped reading with audit note; recalculated; customer notified | Should | partial | Recalculation is the same engine call with the corrected reading. Correction flow and screen pending |
| INV-09 | On confirm: photo deleted, invoice issued, sent to customer with PDF | Must | todo | |
| INV-10 | Reading values, confirming user, timestamps kept permanently | Must | todo | |
| INV-11 | Unique invoice numbers per owner | Must | partial | Per-owner `invoice_counters` + `app.assign_invoice_number` inside the issuing transaction: unique, ordered, gap-free (rollback test). Invoice flow / PDF pending |
| INV-12 | Owner enters a reading manually with a note | Should | partial | Same loader + engine as the customer path (`source OWNER_MANUAL` already accepted by the rpc). Screen pending |
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
| PAY-12 | Overpayments held as credit; applied or refunded | Should | partial | Engine applies credits oldest first, never below zero, remainder kept (unit). Recording credits and the owner's apply/refund choice pending |
| PAY-13 | Optional late fee after grace period | Could | partial | `lateFeeDue` / `addLateFee`: flat fee once, after due date + grace, not while a slip awaits verification or while disputed (unit). Applying it from the daily cron pending |
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
| CP-08 | Notification centre and profile with password change | Must | partial | Password change and sign-out from Help (task 2). Notification centre pending (NOT-01) |
| CP-09 | Mobile-first responsive design (installable PWA) | Should | todo | Shell, manifest, icons and service worker in place (setup); not verified as done until the portal exists |

### 17. Owner Branding (BRD)

| ID | Description | Priority | Status | Notes |
| --- | --- | --- | --- | --- |
| BRD-01 | Owner must complete company setup (name, logo, address, phone, email, bank details) after first password change, before the dashboard | Must | done | After the password change an owner without `onboarding_completed_at` is sent to `/setup` (company, address, phone, email, bank details, optional logo with initials fallback) and cannot reach any owner page until saved (DB + e2e `owner.ceylon`) |
| BRD-02 | Logo upload (JPG/PNG/SVG), validated, resized, stored privately; shown in portals, emails, invoices | Must | partial | Done: JPG/PNG/SVG up to 2 MB, magic-byte check, unsafe SVGs refused, every logo rasterised/resized to a 512 px PNG at `branding/{owner_id}/logo.png` (raw SVG never stored), signed URLs in the owner header and that owner's customer portal (unit + e2e). Pending: emails (NOT-02) and invoices (BRD-06) |
| BRD-03 | Edit company details and logo from Settings; applies to new invoices only | Must | partial | Done: Settings › Company edits details and replaces or removes the logo (e2e). "Issued invoices keep their branding": `invoices.branding_snapshot` and the confirm rpc parameter exist; the snapshot is taken when invoice issuing is built |
| BRD-04 | Upload invoice letterhead (A4 image or 1-page PDF) as invoice PDF background | Should | todo | |
| BRD-05 | Position invoice data area on letterhead (presets or drag); saved per owner | Should | todo | |
| BRD-06 | Without a letterhead, invoices use the built-in template with owner logo and details | Must | todo | |
| BRD-07 | Preview a sample invoice before saving template changes | Should | todo | |
