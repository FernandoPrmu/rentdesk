# RentDesk — Go-live checklist (free pilot)

Task 13. Follow the steps **in order**; each one says what to do and how to check it. Tick them off as you go.

**What go-live means here** (decisions 95-100):

- The Supabase project `gpviraoifdnakkigrfga` (until now "dev") is **wiped once** and becomes **production**. There is
  no development database until you create a new one (step m).
- The app runs on its Vercel address, `https://<project>.vercel.app`. There is no domain yet, so **email is off**: people
  get every notification in the app; emails are logged as skipped (`NO_SENDER_DOMAIN`) until a domain is added.
- Free tiers only: Supabase Free, Vercel Hobby, GitHub Free.
- The **production lock**: the wipe marks the database `production`. From then on `npm run dev`, every test suite,
  `db:seed` and `db:cleanup-test-data` refuse to run against it, and nothing can override that.

**You need:** a password manager, Git Bash (or another shell) in the repository folder, Node 24, the Supabase CLI
logged in (`npx supabase login`; check with `npx supabase projects list`), and a phone.

Below, `<ref>` is `gpviraoifdnakkigrfga` and `<app>` is your Vercel address without a trailing slash, for example
`https://rentdesk.vercel.app` (Vercel › the project › **Domains**).

---

## a. Merge the release

```bash
git checkout main && git pull
git merge --no-ff --no-edit feat/13-go-live
git push origin main
```

Vercel deploys `main` to Production by itself; that deployment still uses the old settings and the old data, which is
fine for a few minutes (step h redeploys).

**Check:** GitHub shows the merge on `main`; Vercel › Deployments shows a Production deployment of it as Ready.

## b. New secrets: database password, API keys, CRON_SECRET

The old values were used on laptops and in test runs; production gets new ones. Keep each new value in your password
manager as you make it.

1. **Database password.** Supabase › project `<ref>` › **Project Settings › Database › Database password › Reset
   database password** › generate one › save it.
2. **API keys.** Supabase › **Project Settings › API Keys**:
   - tab **Publishable and secret API keys**: copy the **publishable** key (`sb_publishable_…`); under **Secret keys**
     click **Add new secret key**, name it `vercel-production`, copy it (`sb_secret_…`);
   - do **not** disable the legacy keys yet: that is step i.8, after the smoke test, so a problem can be told apart from
     a key problem.
   The app's variable names stay as they are: the publishable key goes in `NEXT_PUBLIC_SUPABASE_ANON_KEY`, the secret
   key in `SUPABASE_SERVICE_ROLE_KEY`. The app reaches Supabase only through supabase-js (which accepts both kinds of
   key) and the health and lock checks send new keys as `apikey`, but the app has not yet run with the new keys (task 13
   could not create keys). If step h or the sign-in in step i fails with them, put the **legacy** `anon` and
   `service_role` keys (tab **Legacy API Keys**) in Vercel instead, redeploy, carry on, and skip step i.12.
3. **CRON_SECRET:** `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.
4. **The admin scripts' file.** Create `.env.admin.local` in the repository folder (git ignores every `.env*` file;
   check with `git check-ignore .env.admin.local`, which prints the name):

   ```dotenv
   # PRODUCTION. Read only by npm run golive:wipe and npm run golive:admin. Never copy into .env.local.
   NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co
   SUPABASE_SERVICE_ROLE_KEY=<the new sb_secret_ key>
   # Supabase › Project Settings › Database › Connection string › Session pooler, with the NEW password
   SUPABASE_DB_URL=postgresql://postgres.<ref>:<new password>@aws-0-<region>.pooler.supabase.com:5432/postgres
   ```

   Why not `.env.production.local`: Next.js loads that file by itself during `next build` and `next start`, so a local
   build (and the e2e server) would quietly connect to production (decision 98).

**Check:** `npm run golive:wipe -- --dry-run` (read-only) prints the project, `environment development`, the counts of
files, users and migrations, and "The linked project and both URLs agree". A wrong password shows a connection error.

## c. Vercel environment variables

Vercel › the project › **Settings › Environment Variables**. A variable is set per environment (Production, Preview,
Development); changes apply to **new** deployments only (step h).

**Production** (exactly these; mark the secrets **Sensitive**):

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | the new **publishable** key (`sb_publishable_…`) |
| `SUPABASE_SERVICE_ROLE_KEY` | the new **secret** key (`sb_secret_…`), Sensitive |
| `CRON_SECRET` | the new value from step b.3, Sensitive |
| `APP_URL` | `<app>` (no trailing slash) |

**Not set in Production** (delete them if they exist): `EMAIL_FROM` (empty = email off, decision 96), `RESEND_API_KEY`,
`EMAIL_DEV_REDIRECT`, `EMAIL_TRANSPORT`, `EMAIL_REPLY_TO`, `RESEND_WEBHOOK_SECRET`, `SUPABASE_DB_URL` (the app never
uses it; it stays on your laptop in `.env.admin.local` and in GitHub), `APP_ENV` (Vercel sets `VERCEL_ENV=production`
itself), and any `OUTBOX_*`, `QUERY_STATS*`, `DASHBOARDS`, `E2E_*` measurement switches.

**Preview: no Supabase variables.** Open each of `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and
`SUPABASE_SERVICE_ROLE_KEY` (and `CRON_SECRET`, `APP_URL`): if it is ticked for **Preview** (or **Development**),
untick it, or delete the Preview copy. Previews then still build, but every page answers *"This deployment has no
database"* (HTTP 503) and `/api/health` reports `"db":"not_configured"`: a branch can never reach production data
(tested locally with a production build without the variables).

*Or* switch previews off: **Settings › Git › Ignored Build Step**, Behavior **Custom**, command
`if [ "$VERCEL_ENV" = "production" ]; then exit 1; else exit 0; fi` (exit 0 = skip the build). Keeping previews with
the notice is fine too.

**Check:** the list shows the five Production variables, and none of the Supabase ones for Preview.

## d. Wipe: the database becomes production

This deletes **everything** in `<ref>`: files, users, all data. It refuses to run twice.

```bash
git checkout main && git pull           # the migrations of this checkout are what production gets
npx supabase link --project-ref <ref>   # if not linked yet (supabase/.temp/project-ref)
npm run golive:wipe
```

It shows what is there, asks you to type the project ref, then `WIPE`, and then:

1. **a.** deletes every file in every bucket (Storage API; the buckets stay);
2. **c.** runs `supabase db reset --linked --no-seed`: every migration from zero, **no seed**; this also empties the
   auth tables;
3. **b.** checks auth users with the Auth admin API and deletes any left (expected: none);
4. **d.** sets `platform_settings.environment = 'production'`.

(b runs after c because before the reset the owners' and customers' rows still point at their sign-in accounts, so
Auth cannot delete them.)

**Check:** the summary ends with `files deleted: … (left: 0)`, `auth users: 0 left`, `accounts left: 0`, the 7
buckets, `migrations applied: 42 (last 20261020000042), no seed` (or more if newer migrations were merged) and
`environment: production`. Running `npm run golive:wipe` again must refuse ("already PRODUCTION").

**If it stops halfway:** read the message. The flag is set only at the very end, so fix the cause (connection,
`npx supabase login`, the password in `.env.admin.local`) and run it again. If the reset says it needs Docker, start
Docker Desktop and run it again.

## e. Supabase Auth: the access token hook and rate limits

The reset dropped and re-created `public.custom_access_token_hook`; the hook setting points at it by name.

1. Supabase › **Authentication › Hooks**: **Customize Access Token (JWT) Claims** is listed and **enabled**, type
   **Postgres**, schema **public**, function **custom_access_token_hook**. If it is missing, add it as in
   `docs/database.md` › Custom Access Token hook.
2. SQL editor (read-only check):

   ```sql
   select has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'execute') as auth_can_run,
          has_function_privilege('authenticated', 'public.custom_access_token_hook(jsonb)', 'execute') as users_can_run,
          public.rentdesk_environment() as environment;
   ```

   Expected: `true`, `false`, `production`.
3. **Authentication › Rate Limits › Rate limit for sign-ups and sign-ins**: raise it to about **300** per 5 minutes
   (every sign-in comes from Vercel's servers, so Supabase sees few addresses; the app has its own per-account and
   per-IP limits, decision in `docs/database.md`). Leave the email limits as they are (no email is sent by Supabase).
4. **Authentication › Sign In / Providers › Email**: "Allow new users to sign up" **off** (there is no public sign-up;
   accounts are made by the admin and owners through the service role).

**Check:** the hook is enabled; the query shows `true | false | production`. The sign-in in step i proves it works.

## f. Auth Site URL

Supabase › **Authentication › URL Configuration** › **Site URL** = `<app>`. Remove `http://localhost:3000` from
**Redirect URLs** (the app signs in with a username and password, so no redirect is needed).

**Check:** the page shows the Vercel address as the Site URL.

## g. Create the admin

```bash
npm run golive:admin
```

It works only on the production database. Type the username (for example `ciigus.admin`), the full name and the email
where admin alerts should go (used once email is on), then `yes`. It prints the **temporary password once**. Nothing
stores it: write it in your password manager now. The first sign-in must change it.

**Check:** the output says "Admin created"; Supabase › Authentication › Users shows one user
`<username>@users.rentdesk.invalid`. Running it again refuses ("An admin already exists").

## h. Redeploy

Vercel › **Deployments** › the latest Production deployment › **⋯ › Redeploy** (leave "Use existing build cache"
unticked), so it picks up the variables from step c.

**Check:**

```bash
curl -s <app>/api/health
# {"ok":true,"version":"1.0.0","build":"…","db":"ok","checkedAt":"…"}
```

`db` must be `ok`. `not_configured` = the Production variables are missing; `down` = the URL or the publishable key is
wrong.

## i. Smoke test on a phone

Use a phone on mobile data, in a private tab. Name everything you create so it is obviously a test, e.g. owner
**"ZZ Pilot Test"**.

1. **Admin first sign-in.** Open `<app>` › Sign in with the admin username and temporary password › you must choose a
   new password › Admin Home opens.
2. **Email off is shown.** Admin › **Emails**: "Email is not set up yet (no domain)", From "Not set (EMAIL_FROM is
   empty)".
3. **Owner.** Admin › Owners › **New owner** "ZZ Pilot Test" (an email is fine): "Also send the login details by email"
   is greyed out with the note. Create › the username and temporary password are shown once.
4. **Owner first sign-in** (another private tab or the phone): sign in, change the password, complete the company
   setup.
5. **Customer and machine.** As the owner: Customers › New customer; Machines › Register a mono machine; Assign it to
   the customer with the **first billing date today**.
6. **Open the cycle.** As the admin: Admin › **Daily job** › **Run daily job now** › the run finishes OK. (Without
   this the ticket opens tonight at 00:30-01:29.)
7. **Meter reading.** Sign in as the customer on the phone: Home shows the meter task › the **live camera** opens (no
   gallery) › take the photo › type the reading › Send › "Sent".
8. **Review.** As the owner: Approvals › the reading › Confirm › the bill is issued (open its PDF); the meter photo is
   gone from the review.
9. **Payment.** As the customer: Pay › take a photo of any paper as the slip › Send. As the owner: Payments to verify ›
   Accept › the ticket closes and the receipt PDF opens.
10. **Notifications.** Each side's bell showed each step. Admin › Emails › log: the emails are listed as **Skipped**,
    reason `NO_SENDER_DOMAIN`.
11. **Install.** On the phone, "Install the app" (Android) or Share › Add to Home Screen (iPhone) opens RentDesk full
    screen.
12. **Old keys off.** Now that everything works: Supabase › Project Settings › **API Keys › Legacy API Keys** ›
    **Disable JWT-based API keys**. Reload the app on the phone and `curl <app>/api/health`: still `"db":"ok"`.

**Keep or delete the test records?** The production lock means there is no second wipe, and money records (bills,
payments, receipts) are never deleted by design. Recommended: **keep** them in the "ZZ Pilot Test" tenant and
**deactivate** that owner (Admin › Owners › ZZ Pilot Test › Deactivate, reason "go-live smoke test"). Its customers are
blocked with it, every number (invoices, receipts) is per owner so real owners start at 1, and owners never see another
tenant. Admin-wide totals (Admin Home and reports) include it; if that matters, note the test amounts. Deleting the
rows by hand in SQL is possible but not recommended.

**Check:** every step worked on the phone; nothing showed an error page.

## j. Backups on GitHub, the first backup and a restore test

1. GitHub › the repository › **Settings › Secrets and variables › Actions**:
   - **Secrets**: `SUPABASE_DB_URL_PROD` (the session pooler URL with the new password, as in `.env.admin.local`) and
     `BACKUP_PASSPHRASE` (new, from `docs/backup-restore.md` part A; in your password manager **first**).
   - Optional hourly run (decision 100): **Variables** `APP_URL` = `<app>` and `HOURLY_CRON_ENABLED` = `true`,
     **Secret** `CRON_SECRET` = the value from step b.3. Leave it off for now if you like; it can be turned on any
     time. Test it once with Actions › **Hourly daily-job run (optional)** › Run workflow (manual runs work even while
     it is off): the log shows `{"ok":true,"status":"…"}`.
2. Actions › **Database backup** › **Run workflow** › branch `main`.
   **Check:** green; the log says `Tables: 79 (data in the dump: 79)`; the run has an artifact `rentdesk-…`.
3. **Restore test** with that artifact: `docs/backup-restore.md` parts B and C (Docker Desktop, about 10 minutes).
   **Check:** `RESTORE TEST PASSED`; write the date in the table at the end of `docs/backup-restore.md`.
4. From now on a backup runs every night at 02:00. GitHub emails you when a scheduled run fails.

## k. Uptime monitor

Free with UptimeRobot (or any monitor that checks an HTTP status):

1. uptimerobot.com › sign up (free) › **Add New Monitor**: type **HTTP(s)**, name `RentDesk`, URL `<app>/api/health`,
   interval **5 minutes**. Optional: type **Keyword**, keyword `"db":"ok"`, alert when it does **not** exist.
2. Alert contact: your email (and the mobile app if you want push alerts).

`/api/health` answers 200 only when the database answers within 3 seconds; it shows the version and build, nothing
secret, no user data (decision 99). The monitor also keeps the free Supabase project active: Supabase pauses a free
project after 7 days without activity.

**Check:** the monitor shows **Up** after its first check.

## l. Tag the release

```bash
git checkout main && git pull
git tag -a v1.0.0 -m "RentDesk 1.0.0: free pilot go-live"
git push origin v1.0.0
```

**Check:** GitHub › Tags shows `v1.0.0`; `curl <app>/api/health` says `"version":"1.0.0"`.

---

## Your laptop after go-live

The production lock keeps tests and dev sessions away from production, but keep the files clean too:

- **`.env.local`**: remove `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` and
  `SUPABASE_DB_URL` (they point at production now). Keep `APP_URL=http://localhost:3000`, a local `CRON_SECRET` (not
  the production one) and the `EMAIL_*` development settings. Until a development project exists (step m), `npm run
  dev` and the e2e suites have no database; `npm test` (unit tests) works as before, and `npm run test:db` skips its
  suites.
- **`.env.admin.local`**: production, for `golive:wipe` (once) and `golive:admin` only. Delete it when you no longer
  need it, or keep it only on an encrypted disk.
- If `.env.local` ever points at production by mistake, `npm run dev`, `npm run test:e2e`, `npm run test:e2e:gate`,
  `npm run test:db`, `npm run db:seed` and `npm run db:cleanup-test-data` stop with *"Refusing to run …: this points at
  the PRODUCTION database"*.
- The Supabase CLI stays **linked to production** until step m. `npm run db:push` then changes production: always run
  `npm run db:push -- --dry-run` first and take a backup (Actions › Database backup › Run workflow) before a real push.

## m. Later

**A domain and email.**

1. Buy a domain; in Vercel › **Settings › Domains** add it (Vercel shows the DNS records) and make it the primary
   domain.
2. Resend (free: 100 emails a day, 3,000 a month) › **Domains › Add domain**, e.g. `mail.<domain>` › add the DNS
   records it shows (SPF, DKIM; DMARC recommended) at your DNS provider › **Verify**.
3. Resend › **API Keys** › create one (sending access).
4. Vercel Production: `EMAIL_FROM` = `notifications@mail.<domain>`, `RESEND_API_KEY` = the key, `APP_URL` = the new
   address; optional `RESEND_WEBHOOK_SECRET` with a Resend webhook to `<new address>/api/webhooks/resend` (bounces and
   complaints, decision 67). Redeploy.
5. Supabase Site URL (step f), the GitHub variable `APP_URL` and the uptime monitor URL: the new address.
6. **Check:** Admin › Emails shows "Production: emails go to the real addresses"; reset a test account's password with
   "Also send it by email". Nothing else changes in the code (decision 96). Emails skipped before this stay skipped.

**A new development database.**

1. Supabase › **New project** (Free allows two active projects), e.g. `rentdesk-dev`.
2. Link the CLI to it (so `db:push` and `db:types` hit development by default):
   `npx supabase link --project-ref <dev-ref>`, then `npm run db:push`. Production migrations from then on:
   `npx supabase db push --db-url "<production session pooler URL>"` after a backup.
3. `.env.local` with the dev project's URL, keys and session pooler `SUPABASE_DB_URL`; enable the access token hook and
   raise its sign-in rate limit (as in step e); `npm run db:seed`.
4. **Check:** `npm run dev` starts; `npm run test:db` runs. The dev database's flag stays `development` (only the
   go-live script sets production).

**When paying owners arrive** (the pilot is free):

- **Vercel Hobby is for non-commercial use only**: move to **Pro** before charging anyone (also allows more cron runs
  and longer functions).
- **Supabase Pro**: daily backups with point-in-time recovery, no pausing after a quiet week, more database and
  storage.
- **Resend**: a paid plan once more than 100 emails a day are needed.
- Then revisit the deferred items in `docs/progress.md` (SMS/WhatsApp, PayHere, slip virus scan).
