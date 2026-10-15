/**
 * The production lock for Node tools (decision 95): test:db, the e2e suites, db:seed,
 * db:cleanup-test-data and `npm run dev` call `assertNotProduction` first; the go-live
 * scripts call `readEnvironment`. Relative imports only (runs under Node type stripping).
 */
import { createRequire } from "node:module";

import pg from "pg";

import {
  decide,
  type Environment,
  isMissingLockError,
  parseEnvironment,
  type Probe,
  readViaRest,
  type Target,
  targetsFrom,
} from "../../src/lib/ops/environment.ts";

type Env = Record<string, string | undefined>;

/** Reads the flag over a direct Postgres connection. */
export async function readViaPg(url: string): Promise<Environment> {
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
  await client.connect();
  try {
    const { rows } = await client.query<{ environment: string }>("select public.rentdesk_environment() as environment");
    return parseEnvironment(rows[0]?.environment);
  } catch (error) {
    if (isMissingLockError((error as { code?: string }).code)) return "development";
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function probe(target: Target): Promise<Probe> {
  try {
    const environment = target.kind === "pg" ? await readViaPg(target.url) : await readViaRest(target.url, target.key);
    return { target, ok: true, environment };
  } catch (error) {
    return { target, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Every database the given env sources reach, checked in parallel. */
export function probeAll(envs: Env[]): Promise<Probe[]> {
  return Promise.all(targetsFrom(envs).map(probe));
}

/**
 * Throws (with the message to show) when any database is production or could not be
 * checked. Call it before anything else touches a database.
 */
export async function assertNotProduction(tool: string, envs: Env[]): Promise<void> {
  const decision = decide(tool, await probeAll(envs));
  if (!decision.allowed) throw new ProductionLockError(decision.message);
}

export class ProductionLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProductionLockError";
  }
}

/** For scripts: print the refusal and exit 1, without a stack trace. */
export async function exitIfProduction(tool: string, envs: Env[]): Promise<void> {
  try {
    await assertNotProduction(tool, envs);
  } catch (error) {
    console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/**
 * The variables Next.js itself would load for `next dev` (dev = true) or `next start` /
 * `next build` (dev = false), without touching process.env. Mirrors Next's own loader,
 * so a stray .env.production.local is seen too.
 */
export function nextEnv(dev: boolean, dir = process.cwd()): Env {
  const require = createRequire(import.meta.url);
  const { loadEnvConfig } = require("@next/env") as {
    loadEnvConfig: (dir: string, dev?: boolean, log?: { info: () => void; error: (...a: unknown[]) => void }, forceReload?: boolean) => {
      combinedEnv: Env;
      parsedEnv?: Env;
    };
  };
  const saved = { ...process.env };
  // NODE_ENV=test makes Next read .env.test* instead; `next dev` / `next start` do not.
  delete (process.env as Env).NODE_ENV;
  try {
    const quiet = { info: () => {}, error: (...a: unknown[]) => console.error(...a) };
    return { ...loadEnvConfig(dir, dev, quiet, true).combinedEnv };
  } finally {
    // loadEnvConfig writes into process.env; leave the caller's environment as it was.
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}
