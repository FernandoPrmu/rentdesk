/**
 * The production lock (decision 95): `platform_settings.environment`, read through
 * `public.rentdesk_environment()`. Developer tools that write test or demo data, and
 * `npm run dev`, refuse to run when any database they can reach says "production".
 * There is deliberately no environment variable that overrides it.
 *
 * Pure and dependency-free (relative imports only): the scripts run it under Node, the
 * health route through fetch. The pg reader lives in scripts/lib/production-lock.ts.
 */

export type Environment = "development" | "production";

/** One way a tool reaches a database: a Postgres URL, or the Data API with a key. */
export type Target = { kind: "pg"; url: string; label: string } | { kind: "rest"; url: string; key: string; label: string };

export type Probe = { target: Target; ok: true; environment: Environment } | { target: Target; ok: false; error: string };

export type Decision = { allowed: true; checked: number } | { allowed: false; message: string };

export function parseEnvironment(value: unknown): Environment {
  return value === "production" ? "production" : "development";
}

/**
 * The flag's function or column does not exist yet: a database without migration 0041.
 * That is never production: the go-live wipe applies every migration before setting it.
 */
export function isMissingLockError(code: string | undefined | null): boolean {
  return code === "42883" || code === "42703" || code === "PGRST202";
}

/** A Supabase project ref from an API URL (https://<ref>.supabase.co). */
export function apiProjectRef(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    const match = /^([a-z0-9]+)\.supabase\.(co|in)$/.exec(host);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/** A Supabase project ref from a Postgres URL: the pooler user `postgres.<ref>` or the host `db.<ref>.supabase.co`. */
export function dbProjectRef(url: string): string | null {
  try {
    const parsed = new URL(url);
    const user = /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(parsed.username));
    if (user) return user[1];
    const host = /^db\.([a-z0-9]+)\.supabase\.(co|in)$/.exec(parsed.hostname);
    return host ? host[1] : null;
  } catch {
    return null;
  }
}

/** Where a target points, for messages (never the key or the password). */
function describe(url: string, kind: Target["kind"]): string {
  const ref = kind === "pg" ? dbProjectRef(url) : apiProjectRef(url);
  if (ref) return `project ${ref}`;
  try {
    return new URL(url).host;
  } catch {
    return "an unreadable URL";
  }
}

/**
 * Every database these variables reach. Several env sources (for example what `next dev`
 * and `next start` would load) are merged; the same target is checked once.
 */
export function targetsFrom(envs: Array<Record<string, string | undefined>>): Target[] {
  const targets = new Map<string, Target>();
  for (const env of envs) {
    const dbUrl = env.SUPABASE_DB_URL?.trim();
    if (dbUrl) targets.set(`pg ${dbUrl}`, { kind: "pg", url: dbUrl, label: `SUPABASE_DB_URL (${describe(dbUrl, "pg")})` });
    const apiUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() || env.SUPABASE_SERVICE_ROLE_KEY?.trim();
    if (apiUrl && key) {
      const url = apiUrl.replace(/\/+$/, "");
      targets.set(`rest ${url}`, { kind: "rest", url, key, label: `NEXT_PUBLIC_SUPABASE_URL (${describe(url, "rest")})` });
    }
  }
  return [...targets.values()];
}

/** Headers for the Data API: new keys (sb_...) go in `apikey` only, legacy JWT keys also as the bearer. */
export function restHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (key.split(".").length === 3) headers.Authorization = `Bearer ${key}`;
  return headers;
}

/** Reads the flag through the Data API (the anon key is enough). */
export async function readViaRest(url: string, key: string, fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): Promise<Environment> {
  const response = await fetchImpl(`${url.replace(/\/+$/, "")}/rest/v1/rpc/rentdesk_environment`, {
    method: "POST",
    headers: restHeaders(key),
    body: "{}",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (response.ok) return parseEnvironment(body);
  const code = body && typeof body === "object" && "code" in body ? String((body as { code: unknown }).code) : null;
  if (isMissingLockError(code)) return "development";
  throw new Error(`the Data API answered ${response.status}${code ? ` (${code})` : ""}`);
}

/**
 * Refuse when any database says production, and when a configured one could not be
 * checked (fail closed). With nothing configured there is nothing to protect.
 */
export function decide(tool: string, probes: Probe[]): Decision {
  const production = probes.filter((p) => p.ok && p.environment === "production");
  if (production.length > 0) {
    return {
      allowed: false,
      message: [
        `Refusing to run ${tool}: this points at the PRODUCTION database.`,
        ...production.map((p) => `  - ${p.target.label} is marked production (platform_settings.environment).`),
        "Tests, demo data and local dev sessions must never touch production.",
        "Point .env.local at a development project (docs/go-live.md, \"Your laptop after go-live\").",
        "Admin scripts read .env.admin.local instead. No setting overrides this check.",
      ].join("\n"),
    };
  }
  const failed = probes.filter((p): p is Extract<Probe, { ok: false }> => !p.ok);
  if (failed.length > 0) {
    return {
      allowed: false,
      message: [
        `Refusing to run ${tool}: could not confirm that the database is not production.`,
        ...failed.map((p) => `  - ${p.target.label}: ${p.error}`),
        "Check the connection and try again.",
      ].join("\n"),
    };
  }
  return { allowed: true, checked: probes.length };
}
