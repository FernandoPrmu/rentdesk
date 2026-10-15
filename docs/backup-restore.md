# RentDesk — Backups and restore

Supabase Free keeps no backups you can restore. RentDesk backs up its production database itself, for free
(decision 97):

| What | How |
| --- | --- |
| Schedule | Daily at 20:30 UTC (02:00 Asia/Colombo, after the daily job), and on demand (Actions › Database backup › Run workflow) |
| Contents | `pg_dump` 17, custom format: schemas `public`, `app`, `auth` (sign-in accounts, password hashes), `storage` (file records) and `supabase_migrations`, plus `manifest.txt` (row count of every table and the last migration) |
| Not included | The **files** in Storage (payment slips, logos, letterheads, invoice and receipt PDFs). See part E |
| Protection | gpg symmetric encryption, AES-256, passphrase from the `BACKUP_PASSPHRASE` secret. The job checks that the file decrypts before uploading it |
| Where | A workflow artifact named `rentdesk-YYYYMMDD-HHMM`, file `rentdesk-YYYYMMDD-HHMM.tar.gpg`, kept **30 days** |
| Workflow | `.github/workflows/backup.yml`; manifest query `scripts/backup/manifest.sql` |

A backup holds personal data and password hashes. Keep downloaded copies encrypted, and delete decrypted files when
you are done.

## A. Set up (once)

1. GitHub › the repository › **Settings › Secrets and variables › Actions › Secrets › New repository secret**:
   - `SUPABASE_DB_URL_PROD`: Supabase › Project Settings › Database › **Connection string** › **Session pooler**
     (port 5432), with the database password filled in. Not the direct connection: GitHub's runners have no IPv6.
   - `BACKUP_PASSPHRASE`: make one with
     `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
     **Save it in your password manager first.** Without it no backup can ever be opened, and GitHub never shows a
     secret again.
2. Actions › **Database backup** › **Run workflow** (branch `main`).
3. Check: the run is green; its log shows `Tables: 79 (data in the dump: 79); last migration: 2026…` (the numbers grow
   with new migrations); the run's **Artifacts** list `rentdesk-…` (about 1 MB at the start).

The schedule runs only from the default branch. If the repository is private, the job uses about 3 of the 2,000 free
Actions minutes a month per run, and the artifacts a few MB of the 500 MB free storage.

## B. Download and decrypt

```bash
gh run list --workflow backup.yml --limit 5                  # pick a run id
gh run download <run-id> --dir restore-work                   # or download the artifact in the browser and unzip it
cd restore-work/rentdesk-YYYYMMDD-HHMM
gpg --batch --pinentry-mode loopback --passphrase-fd 0 \
    --decrypt --output backup.tar rentdesk-YYYYMMDD-HHMM.tar.gpg <<< "<BACKUP_PASSPHRASE>"
tar -xf backup.tar                                            # rentdesk.dump and manifest.txt
```

(`gpg` comes with Git for Windows: use Git Bash. Without `<<<` the passphrase is asked for.) A wrong passphrase ends
with `decryption failed: Bad session key`.

## C. Restore test into a throwaway local Postgres (do this after the first backup, then every few months)

This proves a backup can be read and restored completely, without touching any Supabase project. It needs Docker
Desktop running. All commands from the folder with `rentdesk.dump` and `manifest.txt`, with the repository at
`$REPO`:

```bash
cp "$REPO/scripts/backup/manifest.sql" "$REPO/scripts/backup/restore-prelude.sql" .
docker run -d --name rentdesk-restore-test -e POSTGRES_PASSWORD=restore-test -v "$PWD:/work" postgres:17
sleep 5
# Git Bash on Windows: put MSYS_NO_PATHCONV=1 in front of each docker exec.
docker exec rentdesk-restore-test createdb -U postgres restore
docker exec rentdesk-restore-test psql -U postgres -d restore -q -v ON_ERROR_STOP=1 -f /work/restore-prelude.sql
docker exec rentdesk-restore-test sh -c 'pg_restore -U postgres --no-owner --no-privileges --dbname=restore /work/rentdesk.dump 2> /work/restore-errors.txt; grep "^pg_restore: error" /work/restore-errors.txt'
docker exec rentdesk-restore-test sh -c 'psql -U postgres -d restore -At -F "	" -v ON_ERROR_STOP=1 -f /work/manifest.sql > /work/manifest-restored.txt'
diff manifest.txt manifest-restored.txt && echo "RESTORE TEST PASSED"
```

(The `-F "	"` argument is a tab character, as in the workflow.)

Expected:

- exactly **one** error, `schema "public" already exists` (a new database always has one). Any other error is a
  failure: keep the output and investigate;
- `diff` prints nothing and `RESTORE TEST PASSED`: every table has the same number of rows and the last migration
  matches;
- optional spot checks:
  `docker exec rentdesk-restore-test psql -U postgres -d restore -c "select username, role from public.profiles where role = 'ADMIN'"`.

`restore-prelude.sql` creates the roles and extensions a Supabase database has (`anon`, `authenticated`,
`service_role`, …; `pgcrypto`, `uuid-ossp`), so the policies and defaults in the dump resolve. A plain Postgres cannot
run the app; this test checks the backup only.

Clean up:

```bash
docker rm -f rentdesk-restore-test
cd .. && rm -rf rentdesk-YYYYMMDD-HHMM        # the decrypted dump holds personal data
```

Write the date and result in the table at the end of this file.

## D. Disaster restore into a new Supabase project

When the production project is lost or damaged beyond repair. **Not yet rehearsed**: rehearse it once on a
temporary free project (Supabase Free allows two active projects) and delete that project afterwards.

1. **New project.** Supabase › New project, region close to Sri Lanka (as the old one), Postgres 17. Note its ref and
   database password.
2. **Schema from the migrations** (from a checkout whose last migration equals `last_migration` in the manifest):

   ```bash
   git checkout <the release tag or commit with that migration>
   npx supabase link --project-ref <new-ref>
   npx supabase db push                     # tables, functions, RLS, storage buckets and policies
   ```

3. **Empty the rows the migrations created** (settings row, notification catalogue, plans) so the data restore does
   not collide, in the new project's SQL editor:

   ```sql
   do $$ declare r record; begin
     for r in select tablename from pg_tables where schemaname = 'public' loop
       execute format('truncate public.%I cascade', r.tablename);
     end loop;
   end $$;
   ```

4. **Data only**, without the migration history and the buckets (both already there), with triggers and foreign-key
   checks off for the session:

   ```bash
   pg_restore --list rentdesk.dump \
     | grep -v -E 'TABLE DATA (supabase_migrations|auth schema_migrations|storage buckets|storage migrations)' > restore.list
   PGOPTIONS='-c session_replication_role=replica' \
     pg_restore --data-only --no-owner --no-privileges --use-list=restore.list \
     --dbname "<new project's session pooler URL>" rentdesk.dump
   ```

   (`pg_restore` 17: from the Postgres 17 client tools, or `docker run --rm -it -v "$PWD:/work" postgres:17 …`.) If an
   `auth` table fails because the new project's Auth version has other columns, restore `public` first
   (`--schema=public`) and ask Supabase support about the `auth` data; owners and customers can otherwise be given
   new passwords with "Reset password".

5. **Check** with `scripts/backup/manifest.sql` against the new project: the counts must equal `manifest.txt` (except
   the skipped tables). `select public.rentdesk_environment()` must say `production` (it comes with the data).
6. **Files**: copy them back from the latest file backup (part E) with `npx supabase storage cp -r ./<bucket>
   ss:///<bucket> --experimental --linked` per bucket (the CLI linked to the new project).
7. Do steps e and f of `docs/go-live.md` for the new project (hook, rate limits, Site URL), point Vercel Production at
   the new URL and keys (step c), redeploy, sign in, and update `SUPABASE_DB_URL_PROD`.

## E. Files in Storage (manual, until it is automated)

A database dump keeps the file *records* only. Copy the files themselves now and then (monthly, and before any risky
change), with the CLI linked to production and logged in:

```bash
for b in payment-slips invoices receipts branding dispute-files service-photos; do
  npx supabase storage cp -r "ss:///$b" "./files-backup/$b" --experimental --linked
done
```

Meter photos are deleted on confirmation by design, so there is nothing to keep. Invoice and receipt PDFs can be made
again from the database (they are versioned records), so the slips, logos and letterheads matter most. Keep the
folder encrypted (for example a password-protected 7-Zip archive).

## Restore tests

| Date | Backup | Where | Result |
| --- | --- | --- | --- |
| 2026-10-15 | Read-only `pg_dump` 17 of the (pre-go-live) dev database, encrypted and decrypted with the workflow's gpg commands | Local Docker `postgres:17` (part C) | Passed: 1 expected error (`schema "public" already exists`); all 79 tables' row counts and the last migration matched the manifest; 43 of 43 public tables with RLS, 61 policies. Dump, container and decrypted files deleted afterwards |
