/**
 * npm run golive:admin [-- --another]          (docs/go-live.md, step g)
 *
 * Creates the real RentDesk admin on the PRODUCTION database, after golive:wipe:
 *   - asks for the username, full name and email (where admin alerts go);
 *   - generates a strong temporary password on this machine, shows it ONCE and never
 *     stores it (Supabase Auth keeps only a hash); the first sign-in must change it;
 *   - uses the same steps as the app: Auth admin createUser with the synthetic login
 *     email, then rpc_provision_account (ADMIN, must_change_password) and
 *     rpc_set_admin_email. If provisioning fails, the auth user is deleted again.
 *
 * Reads .env.admin.local only. Works only when the database is marked production (the
 * flag golive:wipe sets). Refuses when an admin already exists, unless --another.
 */
import { createClient } from "@supabase/supabase-js";

import { generateTemporaryPassword } from "../src/lib/auth/temporary-password.ts";
import { normalizeUsername, USERNAME_PATTERN, usernameToEmail } from "../src/lib/auth/username.ts";
import { apiProjectRef, dbProjectRef } from "../src/lib/ops/environment.ts";
import { isEnglishText } from "../src/lib/text/english.ts";
import type { Database } from "../src/types/db";
import { adminEnv, adminInputProblems, ask, fail, pgClient } from "./lib/go-live.ts";
import { readViaPg } from "./lib/production-lock.ts";

let env: ReturnType<typeof adminEnv>;
try {
  env = adminEnv();
} catch (error) {
  fail((error as Error).message);
}
const ref = dbProjectRef(env.dbUrl);
if (!ref || ref !== apiProjectRef(env.apiUrl)) fail("SUPABASE_DB_URL and NEXT_PUBLIC_SUPABASE_URL in .env.admin.local must point at the same project.");

let flag: string;
try {
  flag = await readViaPg(env.dbUrl);
} catch (error) {
  fail(`Could not read the database's environment flag: ${(error as Error).message}`);
}
if (flag !== "production") fail(`Project ${ref} is not marked production. Run npm run golive:wipe first (docs/go-live.md, step d).`);

const db = pgClient(env.dbUrl);
await db.connect();
const admins = (await db.query<{ username: string }>("select username from public.profiles where role = 'ADMIN' order by created_at")).rows;
if (admins.length > 0 && !process.argv.includes("--another")) {
  await db.end();
  fail(`An admin already exists (${admins.map((a) => a.username).join(", ")}). To add another one, run: npm run golive:admin -- --another`);
}

console.log(`\nCreate the RentDesk admin on production project ${ref}.\n`);
const username = normalizeUsername(await ask("Username (for signing in, e.g. ciigus.admin): "));
const fullName = (await ask("Full name: ")).replace(/\s+/g, " ");
const email = (await ask("Email (admin alerts go here): ")).toLowerCase();
const problems = adminInputProblems({ username, fullName, email }, { usernamePattern: USERNAME_PATTERN, isEnglish: isEnglishText });
if ((await db.query("select 1 from public.profiles where username = $1", [username])).rowCount) problems.push(`Username: ${username} is taken.`);
await db.end();
if (problems.length) fail(`Nothing was created.\n  - ${problems.join("\n  - ")}`);
if ((await ask(`Create admin "${username}" (${fullName}, ${email})? Type yes: `)).toLowerCase() !== "yes") fail("Nothing was created.");

const supabase = createClient<Database>(env.apiUrl, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const temporaryPassword = generateTemporaryPassword();
const { data: created, error: authError } = await supabase.auth.admin.createUser({
  email: usernameToEmail(username),
  password: temporaryPassword,
  email_confirm: true,
  user_metadata: { username },
});
if (authError || !created.user) fail(`The sign-in account could not be created: ${authError?.message ?? "no user returned"}. Nothing else was changed.`);
const userId = created.user.id;

// The system creates the first admin: no creating actor (as the seed does).
const SYSTEM = null as unknown as string;
const { error: provisionError } = await supabase.rpc("rpc_provision_account", {
  p_user_id: userId,
  p_role: "ADMIN",
  p_username: username,
  p_full_name: fullName,
  p_owner_id: SYSTEM,
  p_created_by: SYSTEM,
  p_must_change_password: true,
  p_details: {},
});
if (provisionError) {
  const { error: undoError } = await supabase.auth.admin.deleteUser(userId);
  fail(
    `The admin profile could not be created: ${provisionError.message}. ` +
      (undoError ? `The sign-in account ${userId} is left over: delete it in Supabase › Authentication › Users.` : "The sign-in account was removed again."),
  );
}
const { error: emailError } = await supabase.rpc("rpc_set_admin_email", { p_actor_id: userId, p_email: email });

console.log(`
Admin created. The temporary password is shown ONCE and is not stored anywhere.
Write it down or hand it over now; it must be changed at the first sign-in.

  Sign in at:          <your Vercel URL>/login
  Username:            ${username}
  Temporary password:  ${temporaryPassword}
${emailError ? `\nThe email could not be saved (${emailError.message}): add it in Admin › Emails after signing in.\n` : ""}`);
