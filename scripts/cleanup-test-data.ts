/**
 * npm run db:cleanup-test-data [-- --days=7] [--dry-run]
 *
 * Trims what the tests leave on the DEV project (free tier: a smaller database stays
 * faster; CLAUDE.md "Testing on the free tier"):
 *   - e2e leftovers older than a day: machines `E2E-*` with everything they produced,
 *     accounts `owner.e2e-*` / `cust.e2e-*` (the same clean-up the e2e global setup does,
 *     but never anything a running suite may still use);
 *   - audit_logs older than --days (default 7) that tests created: sign-in, session and
 *     export entries (the seed never writes these) and entries about rows that no
 *     longer exist (deleted test data). The audit trail of live seed data stays;
 *   - notifications older than --days about rows that no longer exist (their deliveries
 *     go with them), and direct sends (login details) older than --days.
 *
 * Refuses to run unless SUPABASE_DB_URL and NEXT_PUBLIC_SUPABASE_URL both point at the
 * dev project. --dry-run reports the counts and changes nothing.
 */
import pg from "pg";

import { deleteE2eAccounts, deleteE2eMachines, E2E_SERIAL_PREFIX } from "../e2e/support/demo.ts";

const DEV_PROJECT_REF = "gpviraoifdnakkigrfga";

/** Audit actions only sign-ins, sessions and exports write; the seed writes none of them. */
const SESSION_ACTIONS = [
  "LOGIN",
  "LOGIN_FAILED",
  "LOGOUT",
  "LOCKOUT",
  "PASSWORD_CHANGED",
  "PASSWORD_RESET",
  "SUPPORT_VIEW",
  "REPORT_EXPORTED",
  "ACCESS_DENIED",
];

const LEFTOVER_AGE_MS = 24 * 3_600_000;

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=")] as const;
  }),
);
const dryRun = args.has("dry-run");
const days = Number(args.get("days") || 7);
if (!Number.isInteger(days) || days < 1) fail("--days must be a whole number of at least 1.");

const dbUrl = process.env.SUPABASE_DB_URL;
const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
if (!dbUrl || !apiUrl) fail("SUPABASE_DB_URL and NEXT_PUBLIC_SUPABASE_URL must be set (.env.local).");
if (dbProjectRef(dbUrl) !== DEV_PROJECT_REF || apiProjectRef(apiUrl) !== DEV_PROJECT_REF) {
  fail(`Refusing to run: SUPABASE_DB_URL and NEXT_PUBLIC_SUPABASE_URL must point at the dev project (${DEV_PROJECT_REF}).`);
}

const logsBefore = new Date(Date.now() - days * 86_400_000);
const leftoversBefore = new Date(Date.now() - LEFTOVER_AGE_MS);
console.log(`${dryRun ? "Dry run on" : "Cleaning"} dev project ${DEV_PROJECT_REF}`);
console.log(`  leftovers created before ${leftoversBefore.toISOString()}, logs before ${logsBefore.toISOString()}`);

const db = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
await db.connect();
try {
  if (dryRun) {
    const machines = await count("select count(*) from public.machines where serial_no like $1 and created_at < $2", [`${E2E_SERIAL_PREFIX}%`, leftoversBefore]);
    const accounts = await count(
      "select count(*) from public.profiles where (username like 'owner.e2e-%' or username like 'cust.e2e-%') and created_at < $1",
      [leftoversBefore],
    );
    console.log(`  e2e machines: ${machines}, e2e accounts: ${accounts}`);
  } else {
    // Machines first: their agreements may belong to e2e customers.
    const machines = await deleteE2eMachines(undefined, leftoversBefore);
    const accounts = await deleteE2eAccounts(leftoversBefore);
    console.log(`  e2e machines deleted: ${machines}, e2e accounts deleted: ${accounts}`);
  }

  await db.query("begin");
  const session = await db.query("delete from public.audit_logs where created_at < $1 and action = any($2)", [logsBefore, SESSION_ACTIONS]);
  let orphanAudit = 0;
  for (const [entity, table] of await entityTables("select distinct entity from public.audit_logs where created_at < $1 and entity_id is not null", [logsBefore])) {
    const deleted = await db.query(
      `delete from public.audit_logs a where a.created_at < $1 and a.entity = $2 and a.entity_id is not null
         and not exists (select 1 from public.${ident(table)} t where t.id = a.entity_id)`,
      [logsBefore, entity],
    );
    orphanAudit += deleted.rowCount ?? 0;
  }
  let orphanNotifications = 0;
  for (const [entity, table] of await entityTables(
    "select distinct entity_type from public.notifications where created_at < $1 and entity_id is not null and entity_type is not null",
    [logsBefore],
  )) {
    const deleted = await db.query(
      `delete from public.notifications n where n.created_at < $1 and n.entity_type = $2 and n.entity_id is not null
         and not exists (select 1 from public.${ident(table)} t where t.id = n.entity_id)`,
      [logsBefore, entity],
    );
    orphanNotifications += deleted.rowCount ?? 0;
  }
  const direct = await db.query("delete from public.notification_deliveries where notification_id is null and created_at < $1", [logsBefore]);
  await db.query(dryRun ? "rollback" : "commit");

  const verb = dryRun ? "would delete" : "deleted";
  console.log(`  audit_logs ${verb}: ${session.rowCount ?? 0} sign-in/session/export, ${orphanAudit} about deleted rows`);
  console.log(`  notifications ${verb}: ${orphanNotifications} about deleted rows, ${direct.rowCount ?? 0} direct sends`);
} catch (error) {
  await db.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await db.end();
}

/** [entity name, public table with a uuid `id`] for each entity the query lists (`ticket` -> `tickets` too); unknown ones are kept. */
async function entityTables(sql: string, params: unknown[]): Promise<[string, string][]> {
  const names = (await db.query<{ name: string }>(`select x.name from (${sql}) as x(name)`, params)).rows.map((r) => r.name);
  const { rows } = await db.query<{ entity: string; table_name: string }>(
    `select distinct on (c.entity) c.entity, c.table_name
       from unnest($1::text[]) as e(entity)
       cross join lateral (values (e.entity, e.entity), (e.entity, e.entity || 's')) as c(entity, table_name)
       join information_schema.columns col
         on col.table_schema = 'public' and col.table_name = c.table_name and col.column_name = 'id' and col.udt_name = 'uuid'
      order by c.entity, c.table_name = c.entity desc`,
    [names],
  );
  return rows.map((r) => [r.entity, r.table_name]);
}

async function count(sql: string, params: unknown[]): Promise<number> {
  return Number((await db.query<{ count: string }>(sql, params)).rows[0]!.count);
}

function ident(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Project ref of a Supabase Postgres URL: the pooler's `postgres.<ref>` user or the direct `db.<ref>.supabase.co` host. */
function dbProjectRef(url: string): string | null {
  try {
    const { username, hostname } = new URL(url);
    const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(hostname);
    if (direct) return direct[1]!;
    const pooler = /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(username));
    return hostname.endsWith(".pooler.supabase.com") && pooler ? pooler[1]! : null;
  } catch {
    return null;
  }
}

/** Project ref of the Supabase API URL (`https://<ref>.supabase.co`). */
function apiProjectRef(url: string): string | null {
  try {
    return /^([a-z0-9]+)\.supabase\.co$/.exec(new URL(url).hostname)?.[1] ?? null;
  } catch {
    return null;
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
