import { createClient } from "@supabase/supabase-js";
import pg from "pg";

/**
 * Seed accounts used by the e2e tests (`npm run db:seed` creates them) and a
 * service-role helper that puts them back into their seed state, so the suite can
 * run again and again. Only for the dev project: the passwords are public.
 */

export const DEMO = {
  admin: { username: "admin", password: "RentDesk-Admin-2026!" },
  ownerLanka: { username: "owner.lanka", password: "RentDesk-Owner-2026!" },
  ownerCeylon: { username: "owner.ceylon", password: "RentDesk-Owner-2026!" },
  custPerera: { username: "cust.perera", password: "RentDesk-Customer-2026!" },
  custSilva: { username: "cust.silva", password: "RentDesk-Customer-2026!" },
  custFernando: { username: "cust.fernando", password: "RentDesk-Customer-2026!" },
  custBandara: { username: "cust.bandara", password: "RentDesk-Customer-2026!" },
} as const;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local)");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function profileId(username: string): Promise<string> {
  const { data, error } = await serviceClient().from("profiles").select("id").eq("username", username).single();
  if (error || !data) throw new Error(`e2e: seed account ${username} not found. Run npm run db:seed first.`);
  return data.id as string;
}

/**
 * Restores what the tests change:
 *   - cust.bandara: seed password and the forced password change;
 *   - owner.ceylon: not onboarded (no company profile, no logo);
 *   - every demo account: active and not locked, with no recent failed logins
 *     (the wrong-password test would otherwise build up to a lockout).
 */
export async function restoreDemoState(): Promise<void> {
  const admin = serviceClient();
  const usernames = Object.values(DEMO).map((a) => a.username);

  const bandara = await profileId(DEMO.custBandara.username);
  const { error: pwError } = await admin.auth.admin.updateUserById(bandara, { password: DEMO.custBandara.password });
  if (pwError) throw new Error(`e2e: restore bandara password: ${pwError.message}`);

  const { error: profilesError } = await admin
    .from("profiles")
    .update({ status: "ACTIVE", failed_login_count: 0, locked_until: null, must_change_password: false })
    .in("username", usernames);
  if (profilesError) throw new Error(`e2e: restore profiles: ${profilesError.message}`);
  const { error: flagError } = await admin.from("profiles").update({ must_change_password: true }).eq("id", bandara);
  if (flagError) throw new Error(`e2e: restore bandara flag: ${flagError.message}`);

  const ceylon = await profileId(DEMO.ownerCeylon.username);
  const { error: setupError } = await admin.from("owner_company_profiles").delete().eq("owner_id", ceylon);
  if (setupError) throw new Error(`e2e: restore ceylon setup: ${setupError.message}`);
  await admin.storage.from("branding").remove([`${ceylon}/logo.png`]);

  const unknown = ["e2e.nobody"];
  const { error: attemptsError } = await admin
    .from("login_attempts")
    .delete()
    .in("username", [...usernames, ...unknown])
    .eq("success", false);
  if (attemptsError) throw new Error(`e2e: clear failed attempts: ${attemptsError.message}`);
}

/** Business names of accounts created by the e2e tests start with this; usernames with `.e2e-`. */
export const E2E_PREFIX = "E2E";

/**
 * Deletes accounts the e2e tests created (`owner.e2e-*`, `cust.e2e-*`). Owners and
 * profiles reference each other, so this runs as one transaction over
 * SUPABASE_DB_URL (the same connection the database tests use). Audit entries stay.
 */
export async function deleteE2eAccounts(): Promise<void> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("e2e: SUPABASE_DB_URL must be set (.env.local) to clean up test accounts");
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query("begin");
    const { rows } = await db.query<{ id: string }>(
      "select id from public.profiles where username like 'owner.e2e-%' or username like 'cust.e2e-%'",
    );
    const ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await db.query("delete from public.notifications where user_id = any($1) or owner_id = any($1)", [ids]);
      await db.query("delete from public.customers where id = any($1) or owner_id = any($1)", [ids]);
      await db.query("delete from public.owner_company_profiles where owner_id = any($1)", [ids]);
      await db.query("delete from public.owner_settings where owner_id = any($1)", [ids]);
      await db.query("delete from public.invoice_counters where owner_id = any($1)", [ids]);
      // owners.id -> profiles is checked at once; profiles.owner_id -> owners is deferred to commit.
      await db.query("delete from public.owners where id = any($1)", [ids]);
      await db.query("delete from public.profiles where id = any($1)", [ids]);
      await db.query("delete from auth.users where id = any($1)", [ids]);
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    await db.end();
  }
}

/** Serial numbers of machines created by the e2e tests start with this. */
export const E2E_SERIAL_PREFIX = "E2E-";

/**
 * Deletes machines the e2e tests registered (serial `E2E-*`) with their agreements,
 * terms history and notifications. Audit entries stay.
 */
export async function deleteE2eMachines(): Promise<void> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("e2e: SUPABASE_DB_URL must be set (.env.local) to clean up test machines");
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query("begin");
    const { rows } = await db.query<{ id: string }>("select id from public.machines where serial_no like $1", [`${E2E_SERIAL_PREFIX}%`]);
    const machines = rows.map((r) => r.id);
    if (machines.length > 0) {
      const { rows: agreementRows } = await db.query<{ id: string }>(
        "select id from public.rental_agreements where machine_id = any($1)",
        [machines],
      );
      const agreements = agreementRows.map((r) => r.id);
      await db.query("delete from public.notifications where entity_id = any($1)", [agreements]);
      await db.query("delete from public.agreement_terms_history where agreement_id = any($1)", [agreements]);
      await db.query("delete from public.rental_agreements where id = any($1)", [agreements]);
      await db.query("delete from public.machines where id = any($1)", [machines]);
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    await db.end();
  }
}
