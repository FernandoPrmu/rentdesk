import { createClient } from "@supabase/supabase-js";

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
  custBandara: { username: "cust.bandara", password: "RentDesk-Customer-2026!" },
} as const;

function serviceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local)");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function profileId(username: string): Promise<string> {
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
