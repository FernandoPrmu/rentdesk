import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import pg from "pg";

/**
 * Helpers for database tests that run against the linked Supabase dev database.
 *
 * Tests connect as `postgres` (SUPABASE_DB_URL), build fixtures inside a
 * transaction, then switch to the `authenticated` / `anon` / `service_role`
 * database role with simulated JWT claims, exactly as PostgREST does. Everything
 * is rolled back afterwards, so no data is left behind.
 */

export const DB_URL = process.env.SUPABASE_DB_URL;

/**
 * DB_TEST_APPLY_MIGRATIONS=1 applies local migrations that the linked database
 * has not recorded yet inside the test transaction, so they can be tested before
 * `npm run db:push` without changing the database. Tests that need committed
 * data (the concurrency test) are skipped in this mode.
 */
export const APPLY_MIGRATIONS = process.env.DB_TEST_APPLY_MIGRATIONS === "1";

export async function connect(): Promise<pg.Client> {
  if (!DB_URL) throw new Error("SUPABASE_DB_URL is not set (see .env.example)");
  const client = new pg.Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  return client;
}

/** BEGIN, plus the local migrations when APPLY_MIGRATIONS is set. */
export async function begin(db: pg.Client) {
  await db.query("begin");
  if (!APPLY_MIGRATIONS) return;
  const applied = new Set<string>();
  const { rows: exists } = await db.query("select to_regclass('supabase_migrations.schema_migrations') as t");
  if (exists[0].t) {
    const { rows } = await db.query<{ version: string }>("select version from supabase_migrations.schema_migrations");
    for (const row of rows) applied.add(row.version);
  }
  const dir = path.join(process.cwd(), "supabase", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (!applied.has(file.split("_")[0])) {
      await db.query(readFileSync(path.join(dir, file), "utf8"));
    }
  }
}

async function setClaims(db: pg.Client, role: string, claims: Record<string, unknown>) {
  await db.query(`set local role ${role}`);
  await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
}

/** Act as a signed-in user (RLS applies). Must be inside a transaction. */
export function asUser(db: pg.Client, userId: string) {
  return setClaims(db, "authenticated", { sub: userId, role: "authenticated" });
}

export function asAnon(db: pg.Client) {
  return setClaims(db, "anon", { role: "anon" });
}

/** Act as server code using the service-role key. */
export function asService(db: pg.Client) {
  return setClaims(db, "service_role", { role: "service_role" });
}

/** Back to the privileged connection role with no JWT. */
export async function asPostgres(db: pg.Client) {
  await db.query("reset role");
  await db.query("select set_config('request.jwt.claims', '', true)");
  await db.query("select set_config('request.headers', '', true)");
}

export interface SqlError {
  code: string;
  message: string;
}

/**
 * Runs a statement expected to fail, inside a savepoint so the surrounding
 * transaction stays usable. Returns the error, or null if it succeeded.
 */
export async function sqlError(db: pg.Client, sql: string, params: unknown[] = []): Promise<SqlError | null> {
  await db.query("savepoint expect_error");
  try {
    await db.query(sql, params);
    await db.query("release savepoint expect_error");
    return null;
  } catch (error) {
    await db.query("rollback to savepoint expect_error");
    const { code, message } = error as { code: string; message: string };
    return { code, message };
  }
}

/**
 * Runs `fn` in a savepoint and always rolls it back (including role changes),
 * so each test starts from the same fixture state.
 */
export async function isolated(db: pg.Client, fn: () => Promise<void>) {
  await db.query("savepoint test_case");
  try {
    await fn();
  } finally {
    await db.query("rollback to savepoint test_case");
    await db.query("release savepoint test_case");
  }
}

export async function count(db: pg.Client, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await db.query<{ n: string }>(`select count(*)::text as n from (${sql}) q`, params);
  return Number(rows[0].n);
}
