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
  const { data: ceylonLogos } = await admin.storage.from("branding").list(`${ceylon}/logos`, { limit: 100 });
  if (ceylonLogos?.length) await admin.storage.from("branding").remove(ceylonLogos.map((o) => `${ceylon}/logos/${o.name}`));

  await restoreInvoiceTemplate();

  const unknown = ["e2e.nobody"];
  const { error: attemptsError } = await admin
    .from("login_attempts")
    .delete()
    .in("username", [...usernames, ...unknown])
    .eq("success", false);
  if (attemptsError) throw new Error(`e2e: clear failed attempts: ${attemptsError.message}`);
}

/**
 * Owner A's invoice template back to the built-in one (BRD-06), and the letterheads the
 * tests uploaded removed unless an invoice still uses one (decision 35).
 */
export async function restoreInvoiceTemplate(): Promise<void> {
  const admin = serviceClient();
  const lanka = await profileId(DEMO.ownerLanka.username);
  const { error: templateError } = await admin
    .from("owner_company_profiles")
    .update({ letterhead_path: null, letterhead_layout: {}, payment_instructions: null })
    .eq("owner_id", lanka);
  if (templateError) throw new Error(`e2e: restore lanka template: ${templateError.message}`);
  const { data: letterheads } = await admin.storage.from("branding").list(`${lanka}/letterheads`, { limit: 100 });
  for (const file of letterheads ?? []) {
    const path = `${lanka}/letterheads/${file.name}`;
    const { count } = await admin.from("invoices").select("id", { count: "exact", head: true }).eq("branding_snapshot->>letterhead_path", path);
    if (!count) await admin.storage.from("branding").remove([path]);
  }
  await admin.storage.from("invoices").remove([`${lanka}/preview/sample.pdf`]);
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
 * Deletes machines the e2e tests registered (serial `E2E-*`) with everything their
 * agreements produced: tickets, readings, invoices (final invoices on return),
 * payments, deposit entries, advance credits, terms history and notifications.
 * Credits of seed customers that an e2e invoice used become available again.
 * Audit entries stay.
 */
export async function deleteE2eMachines(serial?: string): Promise<void> {
  const url = process.env.SUPABASE_DB_URL;
  if (!url) throw new Error("e2e: SUPABASE_DB_URL must be set (.env.local) to clean up test machines");
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    await db.query("begin");
    // One spec cleans up only its own machine: spec files run in parallel.
    const { rows } = serial
      ? await db.query<{ id: string }>("select id from public.machines where serial_no = $1", [serial])
      : await db.query<{ id: string }>("select id from public.machines where serial_no like $1", [`${E2E_SERIAL_PREFIX}%`]);
    const machines = rows.map((r) => r.id);
    if (machines.length > 0) {
      // Meter photos the tests uploaded (also ones never submitted) live in Storage, not only in rows.
      const { rows: folders } = await db.query<{ folder: string }>(
        `select t.owner_id || '/' || t.id as folder from public.billing_cycle_tickets t
         join public.rental_agreements a on a.id = t.agreement_id where a.machine_id = any($1)`,
        [machines],
      );
      await removePhotoFolders(folders.map((r) => r.folder));
      const { rows: agreementRows } = await db.query<{ id: string }>(
        "select id from public.rental_agreements where machine_id = any($1)",
        [machines],
      );
      const agreements = agreementRows.map((r) => r.id);
      const tickets = (await db.query<{ id: string }>("select id from public.billing_cycle_tickets where agreement_id = any($1)", [agreements])).rows.map((r) => r.id);
      const invoices = (await db.query<{ id: string }>("select id from public.invoices where agreement_id = any($1)", [agreements])).rows.map((r) => r.id);
      await db.query("delete from public.notifications where entity_id = any($1) or entity_id = any($2)", [agreements, tickets]);
      await db.query("delete from public.deposit_transactions where agreement_id = any($1)", [agreements]);
      await db.query("delete from public.payment_slips where payment_id in (select id from public.payments where invoice_id = any($1))", [invoices]);
      await db.query("update public.credits set source_payment_id = null where source_payment_id in (select id from public.payments where invoice_id = any($1))", [invoices]);
      await db.query("delete from public.payments where invoice_id = any($1)", [invoices]);
      // Invoice PDFs: the files in the invoices bucket and their version rows.
      const { rows: pdfFolders } = await db.query<{ folder: string }>(
        "select owner_id || '/' || id as folder from public.invoices where id = any($1)",
        [invoices],
      );
      await removeFolders("invoices", pdfFolders.map((r) => r.folder));
      await db.query("delete from public.invoice_pdf_versions where invoice_id = any($1)", [invoices]);
      await db.query("delete from public.invoice_lines where invoice_id = any($1)", [invoices]);
      await db.query(
        "update public.credits set status = 'AVAILABLE', applied_to_invoice_id = null, applied_at = null where applied_to_invoice_id = any($1)",
        [invoices],
      );
      await db.query("delete from public.credits where agreement_id = any($1) or source_invoice_id = any($2)", [agreements, invoices]);
      await db.query("update public.billing_cycle_tickets set current_invoice_id = null where id = any($1)", [tickets]);
      await db.query("update public.meter_submissions set invoice_id = null where ticket_id = any($1)", [tickets]);
      await db.query("delete from public.disputes where ticket_id = any($1)", [tickets]);
      await db.query("delete from public.invoices where id = any($1)", [invoices]);
      await db.query("delete from public.meter_photos where submission_id in (select id from public.meter_submissions where ticket_id = any($1))", [tickets]);
      await db.query("delete from public.meter_readings where submission_id in (select id from public.meter_submissions where ticket_id = any($1))", [tickets]);
      await db.query("delete from public.meter_submissions where ticket_id = any($1)", [tickets]);
      await db.query("delete from public.ticket_comments where ticket_id = any($1)", [tickets]);
      await db.query("delete from public.ticket_events where ticket_id = any($1)", [tickets]);
      await db.query("delete from public.billing_cycle_tickets where id = any($1)", [tickets]);
      await db.query("delete from public.meter_baselines where agreement_id = any($1)", [agreements]);
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

/** Deletes every meter photo under the given `{owner}/{ticket}` folders (Storage API: direct deletes are not allowed). */
async function removePhotoFolders(folders: string[]): Promise<void> {
  await removeFolders("meter-photos", folders);
}

async function removeFolders(bucket: string, folders: string[]): Promise<void> {
  const storage = serviceClient().storage.from(bucket);
  for (const folder of folders) {
    const { data } = await storage.list(folder, { limit: 100 });
    const paths = (data ?? []).map((o) => `${folder}/${o.name}`);
    if (paths.length > 0) await storage.remove(paths);
  }
}
