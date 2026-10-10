# RentDesk — Project Guide for Claude Code

Photocopy machine rental management platform. The full requirements are in `docs/spec.md`
(Ciigus Software, v1.1). That file is the source of truth: requirement IDs such as TKT-03 or
INV-09 refer to it. Read the relevant section before building any feature.

Progress is tracked in `docs/progress.md`. Update it at the end of every task: which
requirement IDs are done, partial, or deferred, and why.

## Product in one paragraph
Multi-tenant web app with three roles: ADMIN (Ciigus) creates OWNERS, and OWNERS create
CUSTOMERS. There is no public registration. Every 30 days the system opens one Billing Cycle
Ticket per rented machine. The ticket moves through these stages:
1. Customer submits a live-camera meter photo and the reading(s).
2. The system calculates a draft invoice.
3. Owner confirms, rejects, or corrects it. The photo is deleted on confirm.
4. Customer uploads a payment slip.
5. Owner verifies the slip and closes the ticket.

Service requests, notifications, and reports sit around this core.

## Stack (free tiers only)
- **App:** Next.js (App Router, TypeScript, strict mode), Tailwind CSS, shadcn/ui
- **PWA:** Serwist (`@serwist/next`); installable, mobile-first, works on poor connections
- **DB/Auth/Storage/Realtime:** Supabase cloud, free tier (Postgres + RLS, Auth, private
  Storage buckets, Realtime). No local Docker. The Supabase CLI is used only to link the
  cloud project, push migrations, and generate types.
- **Scheduler:** one daily job — a secured route `/api/cron/daily` called by Vercel Cron
  (`vercel.json`, once a day; Hobby allows one run per day, which is enough). Vercel sends
  `Authorization: Bearer $CRON_SECRET`. Hobby may fire anywhere within the scheduled hour,
  so the schedule `0 19 * * *` UTC lands at 00:30–01:29 Asia/Colombo.
- **Email:** Resend (fall back to Brevo SMTP)
- **PDF:** `pdf-lib` (server-side) with embedded Noto Sans; English only (decision 33)
- **Validation:** Zod for every input, on the server
- **Tests:** Vitest (unit), Playwright (key flows on a mobile viewport)
- **Hosting:** Vercel Hobby (free), Node.js 24 (`engines` in package.json, `.nvmrc`).
  Cloudflare Pages/Workers if the app is used commercially.

Do not add paid services. If a requirement truly needs a paid service (SMS/WhatsApp, PayHere),
build a clean interface with a stub or console implementation, and mark it "deferred — needs
paid provider" in `docs/progress.md`.

## Non-negotiable rules
1. **Tenant isolation:** every tenant table has `owner_id`. RLS is enabled on every table, and
   policies enforce role and ownership. Never rely on frontend filtering for security. The
   service-role key is used only in server code, never in client bundles.
2. **Billing engine** is a pure function in `src/lib/billing/` with full unit tests. It must
   cover every worked example in spec section 6.3 and the rollover/reset rules. Use integer
   cents (or `numeric` in the DB). Never use floats for money.
3. **Ticket state machine** lives in one module, `src/lib/tickets/`. Every transition:
   - checks the actor's role,
   - writes a `ticket_events` row (actor, from, to, reason),
   - triggers notifications.

   Statuses and allowed transitions are exactly those in spec section 5.3 and section 11.
4. **Idempotency:**
   - The unique constraint on `(agreement_id, cycle_no)` prevents duplicate tickets.
   - Submissions carry a client-generated idempotency key.
   - The daily cron is safe to run twice and catches up after missed days. The next cycle is
     scheduled from the cycle calendar, not from the close date.
5. **Live camera only** for meter photos. Use `getUserMedia` with a canvas capture. Do NOT use
   `<input type="file">` for meter photos, because phones allow choosing from the gallery.
   Compress to about 200 KB JPEG on the client. Record a server-side timestamp.
6. **Files:**
   - Use private buckets only, accessed through short-lived signed URLs.
   - Meter photos are deleted when the owner confirms.
   - Payment slips: JPG, PNG, or PDF; size-limited; checked by magic bytes; SHA-256 hash
     stored for duplicate detection.
7. **Passwords:**
   - Temporary passwords are generated server-side and shown once.
   - `must_change_password` forces a change at first login.
   - Login is rate-limited, with lockout after repeated failures.
   - Suspending an owner blocks all of that owner's customers.
8. **Time zone:** all scheduling and deadlines use `Asia/Colombo`. Store `timestamptz`.
9. **Audit:** account changes, logins, and every ticket, payment, and invoice action write
   `audit_logs`.
10. **Mobile-first UI:**
    - Design for a 360 px width first.
    - Large tap targets and simple language.
    - The customer home screen shows "what you need to do now".
    - The owner and admin portals are responsive but can be denser.
11. **Single shared schema:** Tenant isolation uses one shared schema with owner_id + RLS.
    Never create per-company schemas.

## Code conventions
- `src/app/(admin)`, `src/app/(owner)`, and `src/app/(customer)` are route groups, each with
  its own layout and role guard in proxy (src/proxy.ts, Next 16).
- Use Server Actions or Route Handlers for mutations. Validate input with Zod. Return typed
  results.
- Store database changes only as SQL migrations in `supabase/migrations/`. Never edit the
  database by hand. Generate TypeScript types from the schema.
- Keep components small. No business logic in components; put it in `src/lib/`.
- Seed script (`scripts/seed.ts`, `npm run db:seed`; a TypeScript script because auth users
  must be created through the Auth Admin API) creates:
  - 1 admin,
  - 2 owners,
  - customers,
  - mono and colour machines,
  - agreements,
  - tickets in different stages, for demos and tests.

## Workflow for every task
1. Read the spec sections and requirement IDs for the task.
2. Propose a short plan (files, migrations, tests) before writing code.
3. Implement, write or update tests, and run `npm run lint`, `npm run typecheck`, and
   `npm test`. Fix all failures.
4. Update `docs/progress.md` with the requirement IDs covered.
5. Never mark a requirement done unless it is implemented and tested.

## Git workflow
- Every prompt/task starts from an up-to-date `main` on a new branch named
  `feat/NN-short-name` (NN = prompt number, e.g. `feat/02-auth`):
  `git checkout main && git pull && git checkout -b feat/NN-short-name`.
- Commit in small logical steps with clear messages in Conventional Commits style
  (e.g. `feat(auth): username login with lockout`).
- Before the final commit, run `npm run lint`, `npm run typecheck`, `npm test` and
  `npm run test:db`. All must pass.
- At the end, push the branch to `origin`. Never merge into `main` and never push to
  `main`: the user reviews and merges.
- Never commit `.env.local` or any secret.
- Line endings are LF everywhere (`.gitattributes`: `* text=auto eol=lf`).

## Commands
- `npm run dev` / `npm run build`
- `npm run lint` / `npm run typecheck` / `npm test` / `npm run test:e2e`
  (e2e signs in with the seed accounts on the linked dev DB at a 360 px viewport; it restores
  them afterwards and needs `SUPABASE_DB_URL` to delete the accounts it creates)
- `npx supabase link --project-ref <ref>` (once; links the CLI to the cloud project)
- `npm run db:push` = `supabase db push` (apply new migrations to the linked cloud DB;
  add `--dry-run` to preview)
- `npm run db:types` = `supabase gen types typescript --linked > src/types/db.ts`
- `npm run db:seed` = demo data via `scripts/seed.ts` (safe to re-run; prints demo logins)
- `npm run test:db` = RLS and workflow tests against the linked dev DB (needs `SUPABASE_DB_URL`;
  everything is rolled back). `DB_TEST_APPLY_MIGRATIONS=1` also tests unpushed migrations.
- Schema and access rules: `docs/database.md`. Multi-table writes go through the atomic `app.*`
  workflow functions, called with the service-role client through their `public.rpc_*`
  wrappers (`admin.rpc("rpc_...")`), never through separate client calls. The `app` schema
  stays private (not exposed in the Data API).
