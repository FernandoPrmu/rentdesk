import { readViaRest } from "./environment";

/**
 * /api/health (decision 99): for a free uptime monitor. Says whether the app runs, which
 * version and build, and whether the database answers: nothing secret, no user data,
 * not even whether the database is production. 200 when the database answers, 503 when
 * it does not (or the deployment has no database, e.g. a preview without Supabase vars).
 */

export type DbState = "ok" | "down" | "not_configured";

export interface HealthBody {
  ok: boolean;
  version: string;
  build: string;
  db: DbState;
  checkedAt: string;
}

export async function checkHealth(input: {
  supabaseUrl: string | undefined;
  anonKey: string | undefined;
  version: string;
  build: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ status: 200 | 503; body: HealthBody }> {
  let db: DbState = "not_configured";
  if (input.supabaseUrl && input.anonKey) {
    try {
      // The cheapest call the anon key may make: one row, one column (0041).
      await readViaRest(input.supabaseUrl, input.anonKey, input.fetchImpl, input.timeoutMs ?? 3_000);
      db = "ok";
    } catch {
      db = "down";
    }
  }
  const ok = db === "ok";
  return {
    status: ok ? 200 : 503,
    body: { ok, version: input.version, build: input.build, db, checkedAt: (input.now ?? new Date()).toISOString() },
  };
}
