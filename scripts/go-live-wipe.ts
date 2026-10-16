/**
 * npm run golive:wipe [-- --dry-run]          (docs/go-live.md, step d; decision 95)
 *
 * Turns the linked Supabase project into an EMPTY PRODUCTION database, once:
 *   a. deletes every file in every storage bucket (Storage API; buckets stay);
 *   c. resets the database: every migration re-applied from zero, NO seed
 *      (`supabase db reset --linked --no-seed`; it also empties the auth tables);
 *   b. checks that no auth user is left and deletes any that are (Auth admin API);
 *   d. sets platform_settings.environment = 'production' (the production lock).
 * (b runs after c: before the reset, owners and customers still reference their
 * profiles, so the Auth API cannot delete them.)
 *
 * Reads .env.admin.local only (never .env.local). Asks you to type the project ref and
 * the word WIPE. Refuses when the flag is already 'production' (no second wipe), when the
 * ref you type is not the linked one or not the one in both URLs, or when this checkout
 * is not main. If a step fails, the flag is still 'development': fix the cause and run
 * it again. --dry-run only reports what is there.
 */
import { execSync, spawnSync } from "node:child_process";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";

import { adminEnv, ask, fail, linkedProjectRef, localMigrations, pgClient, refProblems } from "./lib/go-live.ts";
import { readViaPg } from "./lib/production-lock.ts";

const dryRun = process.argv.includes("--dry-run");

let env: ReturnType<typeof adminEnv>;
try {
  env = adminEnv();
} catch (error) {
  fail((error as Error).message);
}

// The migrations in this checkout are what production gets.
const branch = git("rev-parse --abbrev-ref HEAD");
const checkoutProblem =
  branch !== "main"
    ? `This checkout is on "${branch}". Check out main (with the release merged and pulled) first.`
    : git("status --porcelain -- supabase/migrations")
      ? "supabase/migrations has local changes. Commit or discard them first."
      : null;
if (checkoutProblem && !dryRun) fail(checkoutProblem);
if (checkoutProblem) console.log(`Note: ${checkoutProblem}`);

const linked = linkedProjectRef();

let flag: string;
try {
  flag = await readViaPg(env.dbUrl);
} catch (error) {
  fail(`Could not read the database's environment flag: ${(error as Error).message}`);
}
if (flag === "production") {
  fail("Refusing to wipe: this database is already PRODUCTION (platform_settings.environment). The go-live wipe runs once.");
}

const local = localMigrations();
const before = await inventory();
console.log(`\nProject ${linked ?? "(not linked)"}: environment ${flag}`);
console.log(`  files:      ${before.files} in ${before.buckets.length} buckets (${before.buckets.map((b) => `${b.id} ${b.files}`).join(", ") || "none"})`);
console.log(`  auth users: ${before.users}`);
console.log(`  migrations: ${before.applied} applied; this checkout has ${local.length} (last ${local.at(-1)})`);

if (dryRun) {
  const problems = refProblems({ typed: linked ?? "", linked, dbUrl: env.dbUrl, apiUrl: env.apiUrl });
  console.log(problems.length ? `\nProblems:\n  - ${problems.join("\n  - ")}` : "\nThe linked project and both URLs agree.");
  console.log("Dry run: nothing was changed.\n");
  process.exit(0);
}

console.log("\nThis DELETES every file, every user and every row in this project. It cannot be undone.");
const typed = await ask("Type the project ref to wipe: ");
const problems = refProblems({ typed, linked, dbUrl: env.dbUrl, apiUrl: env.apiUrl });
if (problems.length) fail(`Refusing to wipe. Nothing was changed.\n  - ${problems.join("\n  - ")}`);
if ((await ask(`Type WIPE to wipe ${typed}: `)) !== "WIPE") fail("You did not type WIPE. Nothing was changed.");

const admin = createClient(env.apiUrl, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

// a. Every file, through the Storage API (deleting rows in storage.objects would leave the files).
console.log("\na. Deleting files…");
let filesDeleted = 0;
for (const bucket of before.buckets) {
  for (;;) {
    const names = await query<{ name: string }>("select name from storage.objects where bucket_id = $1 order by name limit 100", [bucket.id]);
    if (names.length === 0) break;
    const { data, error } = await admin.storage.from(bucket.id).remove(names.map((n) => n.name));
    if (error) fail(`Could not delete files in ${bucket.id}: ${error.message}. Run golive:wipe again.`);
    if (!data?.length) fail(`The Storage API deleted nothing in ${bucket.id} although files are listed. Run golive:wipe again.`);
    filesDeleted += data.length;
  }
  console.log(`   ${bucket.id}: emptied`);
}

// c. Every migration from zero, no seed. The CLI's remote reset drops public and app,
// every policy, and empties the auth tables; storage buckets stay (the migrations upsert them).
console.log("\nc. Resetting the database (all migrations from zero, no seed)…");
const cli = path.join(process.cwd(), "node_modules", "supabase", "dist", "supabase.js");
const reset = spawnSync(process.execPath, [cli, "db", "reset", "--linked", "--no-seed", "--yes"], { stdio: "inherit" });
if (reset.status !== 0) {
  fail("The reset failed (see above). The environment flag is still 'development': fix the cause and run golive:wipe again.");
}

// b. No auth user may be left (the reset empties auth.users; this checks and cleans up).
console.log("\nb. Checking auth users…");
let usersDeleted = 0;
for (let round = 0; round < 50; round += 1) {
  // Always page 1: each round deletes what it lists.
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) fail(`Could not list auth users: ${error.message}. Run golive:wipe again.`);
  if (data.users.length === 0) break;
  for (const user of data.users) {
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
    if (deleteError) fail(`Could not delete auth user ${user.id}: ${deleteError.message}. Run golive:wipe again.`);
    usersDeleted += 1;
  }
}

// Every migration of this checkout is applied, nothing else.
const applied = (await query<{ version: string }>("select version from supabase_migrations.schema_migrations order by version")).map((r) => r.version);
if (applied.join(",") !== local.join(",")) {
  fail(`The applied migrations (${applied.length}) do not match this checkout (${local.length}). The flag is still 'development'; run golive:wipe again.`);
}

// d. The production lock: from now on no test, seed or dev session may touch this database.
console.log("\nd. Setting the production flag…");
await query("update public.platform_settings set environment = 'production'");
await query("notify pgrst, 'reload schema'");

const after = await inventory();
const left = (await query<{ n: string }>("select (select count(*) from public.profiles) + (select count(*) from public.owners) as n"))[0]!.n;
const final = await readViaPg(env.dbUrl);
console.log(`
Done: ${typed} is now an empty PRODUCTION database.
  files deleted:       ${filesDeleted} (left: ${after.files})
  auth users:          ${after.users} left (${usersDeleted} deleted after the reset)
  accounts left:       ${left}
  buckets:             ${after.buckets.map((b) => b.id).join(", ")}
  migrations applied:  ${applied.length} (last ${applied.at(-1)}), no seed
  environment:         ${final}

Next (docs/go-live.md): step e (the access token hook and Auth rate limits), step f, then
npm run golive:admin to create the admin.
`);
if (after.files !== 0 || after.users !== 0 || left !== "0" || final !== "production") {
  fail("Something is left over (see above). Check it before going on.");
}

function git(args: string): string {
  return execSync(`git ${args}`, { encoding: "utf8" }).trim();
}

async function query<T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = pgClient(env.dbUrl);
  await db.connect();
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.end();
  }
}

async function inventory() {
  const buckets = (
    await query<{ id: string; files: string }>(
      "select b.id, count(o.id)::text as files from storage.buckets b left join storage.objects o on o.bucket_id = b.id group by b.id order by b.id",
    )
  ).map((b) => ({ id: b.id, files: Number(b.files) }));
  const users = (await query<{ users: string }>("select count(*)::text as users from auth.users"))[0]!.users;
  const exists = (await query<{ t: string | null }>("select to_regclass('supabase_migrations.schema_migrations')::text as t"))[0]!.t;
  const applied = exists ? Number((await query<{ n: string }>("select count(*)::text as n from supabase_migrations.schema_migrations"))[0]!.n) : 0;
  return { buckets, files: buckets.reduce((sum, b) => sum + b.files, 0), users: Number(users), applied };
}
