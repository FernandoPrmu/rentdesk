/**
 * Shared, testable pieces of the go-live scripts (scripts/go-live-wipe.ts,
 * scripts/create-admin.ts; docs/go-live.md). Relative imports only.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import pg from "pg";

import { apiProjectRef, dbProjectRef } from "../../src/lib/ops/environment.ts";

export const ADMIN_ENV_FILE = ".env.admin.local";

/** The variables both go-live scripts need, from .env.admin.local. */
export function adminEnv(env: Record<string, string | undefined> = process.env): { dbUrl: string; apiUrl: string; serviceKey: string } {
  const dbUrl = env.SUPABASE_DB_URL?.trim();
  const apiUrl = env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!dbUrl || !apiUrl || !serviceKey) {
    throw new Error(
      `SUPABASE_DB_URL, NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in ${ADMIN_ENV_FILE} ` +
        "(the production values; docs/go-live.md, step d).",
    );
  }
  return { dbUrl, apiUrl, serviceKey };
}

/** The project the Supabase CLI is linked to (`npx supabase link`), or null. */
export function linkedProjectRef(root = process.cwd()): string | null {
  try {
    return readFileSync(path.join(root, "supabase", ".temp", "project-ref"), "utf8").trim() || null;
  } catch {
    return null;
  }
}

/**
 * The project ref you typed must be the one the CLI is linked to (the reset runs on the
 * linked project) and the one both URLs in .env.admin.local point at. Returns the
 * problems; empty = all agree.
 */
export function refProblems(input: { typed: string; linked: string | null; dbUrl: string; apiUrl: string }): string[] {
  const typed = input.typed.trim();
  const problems: string[] = [];
  if (!typed) problems.push("No project ref was typed.");
  const dbRef = dbProjectRef(input.dbUrl);
  const apiRef = apiProjectRef(input.apiUrl);
  if (!input.linked) problems.push("The Supabase CLI is not linked to a project (run: npx supabase link --project-ref <ref>).");
  else if (input.linked !== typed) problems.push(`The CLI is linked to ${input.linked}, not ${typed}.`);
  if (dbRef !== typed) problems.push(`SUPABASE_DB_URL points at ${dbRef ?? "an unknown project"}, not ${typed}.`);
  if (apiRef !== typed) problems.push(`NEXT_PUBLIC_SUPABASE_URL points at ${apiRef ?? "an unknown project"}, not ${typed}.`);
  return problems;
}

/** Local migration versions (file name prefix), in order. */
export function localMigrations(root = process.cwd()): string[] {
  return readdirSync(path.join(root, "supabase", "migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => f.split("_")[0]!);
}

export function pgClient(url: string): pg.Client {
  return new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15_000 });
}

/** Asks one question on the terminal. */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function fail(message: string): never {
  console.error(`\n${message}\n`);
  process.exit(1);
}

export interface AdminInput {
  username: string;
  fullName: string;
  email: string;
}

/** The real admin's details: the same username rule as the database, English only (decision 33), a valid email. */
export function adminInputProblems(input: AdminInput, rules: { usernamePattern: RegExp; isEnglish: (v: string) => boolean }): string[] {
  const problems: string[] = [];
  if (!rules.usernamePattern.test(input.username)) {
    problems.push("Username: 3-40 characters, lower-case letters, digits, dot, dash or underscore, starting with a letter or digit.");
  }
  if (input.fullName.length < 2 || input.fullName.length > 100) problems.push("Full name: 2-100 characters.");
  else if (!rules.isEnglish(input.fullName)) problems.push("Full name: please use English letters only.");
  if (input.email.length > 200 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) problems.push("Email: enter a valid email address.");
  return problems;
}
