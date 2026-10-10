/**
 * Demo seed for the linked Supabase project: `npm run db:seed`.
 *
 * Creates 1 admin, 2 owners (one onboarded with branding, one not), 3 customers each,
 * mono and colour machines, agreements, and billing cycle tickets in several stages.
 * Tickets are driven through the real workflow functions (public.rpc_* wrappers around
 * the private app.* functions, service role only), exactly as the server will do it.
 *
 * Safe to re-run: auth users are looked up by email, rows use fixed ids derived from
 * names, and each ticket is only advanced from its current status toward its target.
 *
 * Node runs this file with built-in TypeScript support, which cannot resolve the
 * app's "@/" path alias. It shares only the billing engine (src/lib/billing, which
 * uses relative ".ts" imports for this reason) and the database types.
 * Never run it against production: the demo passwords below are public.
 */
import { createHash } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { addMonths } from "../src/lib/agreements/cycle-calendar.ts";
import { logoFilePath } from "../src/lib/branding/files.ts";
import { loadMeterContext } from "../src/lib/billing/context.ts";
import { buildMeterSubmission } from "../src/lib/billing/meter-invoice.ts";
import { previousReading } from "../src/lib/billing/usage.ts";
import { BRANDING_SNAPSHOT_COLUMNS, brandingSnapshot } from "../src/lib/invoices/branding-snapshot.ts";
import { generateInvoicePdf, INVOICE_BUCKET, type InvoiceFiles } from "../src/lib/invoices/pdf-job.ts";
import { loadInvoiceFonts } from "../src/lib/invoices/pdf/fonts.ts";
import { generateReceiptPdf, RECEIPT_BUCKET, type ReceiptFiles } from "../src/lib/payments/receipt-pdf/job.ts";
import type { Rpc } from "../src/lib/tickets/transitions.ts";
import type { Database, Json } from "../src/types/db";

import { demoLogo, demoMeterPhoto } from "./demo-meter-photo.ts";

type Admin = SupabaseClient<Database>;
type Ticket = Database["public"]["Tables"]["billing_cycle_tickets"]["Row"];
type TicketStatus = Database["public"]["Enums"]["ticket_status"];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EMAIL_DOMAIN = "users.rentdesk.invalid";
// The system (cron) acts with a null actor; generated RPC types do not model that.
const SYSTEM_ACTOR = null as unknown as string;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in .env.local");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic UUID (v4 layout) from a name, so re-runs hit the same rows. */
function stableId(name: string): string {
  const h = createHash("sha256").update(`rentdesk-seed:${name}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function colomboToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Colombo" }).format(new Date());
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type Result<T> = { data: T; error: { message: string; code?: string } | null };

/** Throws on error; returns data that may legitimately be null (maybeSingle). */
function checkMaybe<T>(result: Result<T>, what: string): T {
  if (result.error) {
    throw new Error(`${what}: ${result.error.message}${result.error.code ? ` (${result.error.code})` : ""}`);
  }
  return result.data;
}

/** Throws on error. For reads that always return data, and writes whose data is unused. */
function check<T>(result: Result<T>, what: string): NonNullable<T> {
  return checkMaybe(result, what) as NonNullable<T>;
}

// Tiny valid files for storage.
const slipPdf = (label: string) => Buffer.from(`%PDF-1.4\n% RentDesk demo payment slip ${label}\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n`);

// ---------------------------------------------------------------------------
// Demo data definition
// ---------------------------------------------------------------------------

const PASSWORDS = {
  ADMIN: "RentDesk-Admin-2026!",
  OWNER: "RentDesk-Owner-2026!",
  CUSTOMER: "RentDesk-Customer-2026!",
} as const;

interface Account {
  key: string;
  role: "ADMIN" | "OWNER" | "CUSTOMER";
  username: string;
  fullName: string;
  owner?: string; // owner account key for customers
  mustChangePassword?: boolean;
  details?: Record<string, string>;
}

const ACCOUNTS: Account[] = [
  { key: "admin", role: "ADMIN", username: "admin", fullName: "Ciigus Admin" },
  {
    key: "ownerA", role: "OWNER", username: "owner.lanka", fullName: "Nimal Perera",
    details: { business_name: "Lanka Copy Solutions", contact_person: "Nimal Perera", phone: "0112345678",
               email: "accounts@lankacopy.example", address: "12 Galle Road, Colombo 03" },
  },
  {
    key: "ownerB", role: "OWNER", username: "owner.ceylon", fullName: "Kumari Silva",
    details: { business_name: "Ceylon Office Machines", contact_person: "Kumari Silva", phone: "0812233445",
               email: "hello@ceylonoffice.example", address: "45 Peradeniya Road, Kandy" },
  },
  { key: "custA1", role: "CUSTOMER", owner: "ownerA", username: "cust.perera", fullName: "Perera Printers",
    details: { name: "Perera Printers", business_name: "Perera Printers (Pvt) Ltd", phone: "0771234567", address: "Nugegoda" } },
  { key: "custA2", role: "CUSTOMER", owner: "ownerA", username: "cust.silva", fullName: "Silva Stationers",
    details: { name: "Silva Stationers", phone: "0772345678", address: "Maharagama" } },
  { key: "custA3", role: "CUSTOMER", owner: "ownerA", username: "cust.fernando", fullName: "Fernando Book Shop",
    details: { name: "Fernando Book Shop", phone: "0773456789", address: "Moratuwa" } },
  { key: "custB1", role: "CUSTOMER", owner: "ownerB", username: "cust.jayasuriya", fullName: "Jayasuriya Traders",
    details: { name: "Jayasuriya Traders", phone: "0714567890", address: "Kandy" } },
  { key: "custB2", role: "CUSTOMER", owner: "ownerB", username: "cust.wickrama", fullName: "Wickrama Copy Centre",
    details: { name: "Wickrama Copy Centre", phone: "0715678901", address: "Katugastota" } },
  { key: "custB3", role: "CUSTOMER", owner: "ownerB", username: "cust.bandara", fullName: "Bandara Enterprises",
    mustChangePassword: true, details: { name: "Bandara Enterprises", phone: "0716789012", address: "Peradeniya" } },
];

interface MachineDef { key: string; owner: string; brand: string; model: string; serial: string; type: "MONO" | "COLOUR" }

const MACHINES: MachineDef[] = [
  { key: "mA1", owner: "ownerA", brand: "Canon", model: "imageRUNNER ADVANCE C3226", serial: "LCS-C-001", type: "COLOUR" },
  { key: "mA2", owner: "ownerA", brand: "Ricoh", model: "MP 2014", serial: "LCS-M-002", type: "MONO" },
  { key: "mA3", owner: "ownerA", brand: "Kyocera", model: "ECOSYS M2040dn", serial: "LCS-M-003", type: "MONO" },
  { key: "mA4", owner: "ownerA", brand: "Konica Minolta", model: "bizhub C250i", serial: "LCS-C-004", type: "COLOUR" },
  { key: "mA5", owner: "ownerA", brand: "Sharp", model: "AR-6020", serial: "LCS-M-005", type: "MONO" },
  { key: "mA6", owner: "ownerA", brand: "Ricoh", model: "MP 2014", serial: "LCS-M-006", type: "MONO" }, // stays AVAILABLE
  { key: "mB1", owner: "ownerB", brand: "Sharp", model: "AR-6023", serial: "COM-M-101", type: "MONO" },
  { key: "mB2", owner: "ownerB", brand: "Canon", model: "imageRUNNER C3020", serial: "COM-C-102", type: "COLOUR" },
  { key: "mB3", owner: "ownerB", brand: "Kyocera", model: "TASKalfa 2020", serial: "COM-M-103", type: "MONO" },
];

/** Target ticket status per cycle number. Start dates are relative to today (Asia/Colombo). */
interface AgreementDef {
  key: string;
  owner: string;
  customer: string;
  machine: string;
  startDaysAgo: number;
  targets: Record<number, TicketStatus | "PARTIALLY_PAID">;
}

const AGREEMENTS: AgreementDef[] = [
  { key: "agA1", owner: "ownerA", customer: "custA1", machine: "mA1", startDaysAgo: 40, targets: { 1: "METER_REQUESTED" } },
  { key: "agA2", owner: "ownerA", customer: "custA1", machine: "mA2", startDaysAgo: 40, targets: { 1: "PENDING_OWNER_REVIEW" } },
  { key: "agA3", owner: "ownerA", customer: "custA2", machine: "mA3", startDaysAgo: 70, targets: { 1: "CLOSED", 2: "AWAITING_PAYMENT" } },
  { key: "agA4", owner: "ownerA", customer: "custA3", machine: "mA4", startDaysAgo: 70, targets: { 1: "OVERDUE", 2: "PAYMENT_SUBMITTED" } },
  { key: "agA5", owner: "ownerA", customer: "custA3", machine: "mA5", startDaysAgo: 40, targets: { 1: "PARTIALLY_PAID" } },
  { key: "agB1", owner: "ownerB", customer: "custB1", machine: "mB1", startDaysAgo: 40, targets: { 1: "METER_REQUESTED" } },
  { key: "agB2", owner: "ownerB", customer: "custB2", machine: "mB2", startDaysAgo: 40, targets: { 1: "PENDING_OWNER_REVIEW" } },
  { key: "agB3", owner: "ownerB", customer: "custB3", machine: "mB3", startDaysAgo: 20, targets: {} }, // first cycle not due yet
];

// Commercial terms (spec 6.3 worked examples).
const COLOUR_TERMS = { monthly_commitment_cents: 1_000_000, bw_included: 3000, bw_rate_cents: 200, colour_included: 500, colour_rate_cents: 1000 };
const MONO_TERMS = { monthly_commitment_cents: 500_000, bw_included: 2000, bw_rate_cents: 250, colour_included: null, colour_rate_cents: null };
// Copies used per cycle (spec 6.3: colour case 2, mono case 2).
const USAGE = { BW_COLOUR: 3400, COLOUR: 700, BW_MONO: 2600 };

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const admin: Admin = createClient<Database>(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Service-role client that attributes direct table writes to `actorId` in audit_logs. */
function actingAs(actorId: string): Admin {
  return createClient<Database>(SUPABASE_URL!, SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { "x-actor-id": actorId } },
  });
}

async function ensureUsers(): Promise<Record<string, string>> {
  const existing = new Map<string, string>();
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`listUsers: ${error.message}`);
    for (const u of data.users) if (u.email) existing.set(u.email, u.id);
    if (data.users.length < 1000) break;
  }

  const ids: Record<string, string> = {};
  for (const account of ACCOUNTS) {
    const email = `${account.username}@${EMAIL_DOMAIN}`;
    const password = PASSWORDS[account.role];
    let id = existing.get(email);
    if (id) {
      // Keep demo logins working on re-runs.
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw new Error(`reset password ${account.username}: ${error.message}`);
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { username: account.username },
      });
      if (error) {
        if (/email/i.test(error.message)) {
          console.error(
            `\nSupabase Auth rejected the login email "${email}": ${error.message}\n` +
              `The synthetic {username}@${EMAIL_DOMAIN} format was not accepted. Stopping without changing the format.\n`,
          );
          process.exit(1);
        }
        throw new Error(`createUser ${account.username}: ${error.message}`);
      }
      id = data.user.id;
    }
    ids[account.key] = id;
  }

  for (const account of ACCOUNTS) {
    const result = check(
      await admin.rpc("rpc_provision_account", {
        p_user_id: ids[account.key],
        p_role: account.role,
        p_username: account.username,
        p_full_name: account.fullName,
        p_owner_id: account.owner ? ids[account.owner] : SYSTEM_ACTOR,
        p_created_by: account.role === "ADMIN" ? SYSTEM_ACTOR : account.role === "OWNER" ? ids.admin : ids[account.owner!],
        p_must_change_password: account.mustChangePassword ?? false,
        p_details: (account.details ?? {}) as Json,
      }),
      `provision ${account.username}`,
    ) as { created: boolean };
    console.log(`  ${result.created ? "created " : "exists  "} ${account.role.padEnd(8)} ${account.username}`);

    // Re-runs restore the demo login state (e2e tests and manual testing change it):
    // active, not locked, and the forced password change exactly as defined above.
    check(
      await admin
        .from("profiles")
        .update({ status: "ACTIVE", failed_login_count: 0, locked_until: null, must_change_password: account.mustChangePassword ?? false })
        .eq("id", ids[account.key]),
      `restore login state ${account.username}`,
    );
  }
  return ids;
}

async function seedPlansTemplatesAndBranding(ids: Record<string, string>) {
  const planId = stableId("plan:starter");
  check(
    await admin.from("subscription_plans").upsert(
      [{ id: planId, name: "Starter (free)", price_cents: 0, max_customers: 50, max_machines: 50 }],
      { onConflict: "id", ignoreDuplicates: true },
    ),
    "plans",
  );
  check(await admin.from("owners").update({ plan_id: planId }).in("id", [ids.ownerA, ids.ownerB]), "assign plan");

  const templates = [
    { event: "ticket.created", channel: "EMAIL" as const, subject: "Meter reading needed for {{machine}}", body: "Please submit your meter reading and photo by {{due_date}}." },
    { event: "invoice.issued", channel: "EMAIL" as const, subject: "Invoice {{invoice_no}}", body: "Your invoice for {{period}} is {{amount}}. Due {{due_date}}." },
    { event: "payment.closed", channel: "EMAIL" as const, subject: "Payment received", body: "Thank you. Your payment for invoice {{invoice_no}} is confirmed." },
  ];
  check(
    await admin.from("notification_templates").upsert(
      templates.map((t) => ({ ...t, owner_id: null, locale: "en" })),
      { onConflict: "owner_id,event,channel,locale", ignoreDuplicates: true },
    ),
    "templates",
  );

  // Owner A is onboarded with branding; owner B has not completed setup yet (a re-run
  // undoes a setup done while testing, so the onboarding gate can be shown again).
  check(await admin.from("owner_company_profiles").delete().eq("owner_id", ids.ownerB), "reset owner B setup");
  check(await admin.storage.from("branding").remove([`${ids.ownerB}/logo.png`]), "reset owner B logo");
  // Logos are immutable files at content-hash paths (decision 35).
  const logo = await demoLogo("LCS");
  const logoPath = logoFilePath(ids.ownerA, logo);
  check(
    await admin.storage.from("branding").upload(logoPath, logo, { contentType: "image/png", upsert: true }),
    "upload logo",
  );
  check(
    await actingAs(ids.ownerA).from("owner_company_profiles").upsert(
      [{
        owner_id: ids.ownerA,
        company_name: "Lanka Copy Solutions",
        logo_path: logoPath,
        address: "12 Galle Road, Colombo 03",
        phone: "011 234 5678",
        email: "accounts@lankacopy.example",
        bank_name: "Bank of Ceylon",
        bank_branch: "Kollupitiya",
        bank_account_name: "Lanka Copy Solutions (Pvt) Ltd",
        bank_account_no: "0001234567",
        onboarding_completed_at: new Date().toISOString(),
      }],
      { onConflict: "owner_id", ignoreDuplicates: true },
    ),
    "company profile",
  );
  // A re-run moves owner A from the old 1-pixel logo to the generated one (new invoices only).
  check(await actingAs(ids.ownerA).from("owner_company_profiles").update({ logo_path: logoPath }).eq("owner_id", ids.ownerA), "logo path");
}

async function seedMachinesAndAgreements(ids: Record<string, string>) {
  check(
    await admin.from("machines").upsert(
      MACHINES.map((m) => ({
        id: stableId(`machine:${m.key}`),
        owner_id: ids[m.owner],
        brand: m.brand,
        model: m.model,
        serial_no: m.serial,
        type: m.type,
        bw_counter_max: 999_999,
        colour_counter_max: m.type === "COLOUR" ? 999_999 : null,
      })),
      { onConflict: "id", ignoreDuplicates: true },
    ),
    "machines",
  );

  const today = colomboToday();
  const rows = AGREEMENTS.map((a) => {
    const machine = MACHINES.find((m) => m.key === a.machine)!;
    const terms = machine.type === "COLOUR" ? COLOUR_TERMS : MONO_TERMS;
    return {
      id: stableId(`agreement:${a.key}`),
      owner_id: ids[a.owner],
      customer_id: ids[a.customer],
      machine_id: stableId(`machine:${a.machine}`),
      start_date: addDays(today, -a.startDaysAgo),
      // The seed backdates rentals to create tickets in several stages, so the first
      // billing date is in the past here; the app only allows today or later.
      // Monthly cycles (rule 1): one month after the start, then monthly on that day.
      first_billing_date: addMonths(addDays(today, -a.startDaysAgo), 1),
      due_days: 7,
      installation_location: "Front office",
      initial_bw_reading: 10_000,
      initial_colour_reading: machine.type === "COLOUR" ? 2_000 : null,
      ...terms,
    };
  });
  // Agreements are created by each owner (audited as that owner). The service role
  // writes them directly to keep stable ids; the same triggers apply as for
  // rpc_assign_machine (terms version 1, machine RENTED, cycle calendar).
  // Only missing ones are inserted: the insert trigger refuses an already rented
  // machine before ON CONFLICT could skip the row, so an upsert breaks re-runs.
  const existing = new Set(
    check(await admin.from("rental_agreements").select("id").in("id", rows.map((r) => r.id)), "existing agreements").map((r) => r.id),
  );
  for (const owner of ["ownerA", "ownerB"]) {
    const missing = rows.filter((r) => r.owner_id === ids[owner] && !existing.has(r.id));
    if (missing.length === 0) continue;
    check(await actingAs(ids[owner]).from("rental_agreements").insert(missing), `agreements ${owner}`);
  }
}

/**
 * Money received upfront (DEP-01/02): a security deposit held for Fernando Book
 * Shop's mono machine (agA5) and an advance payment from Bandara Enterprises (agB3),
 * which the first invoice of agB3 takes off automatically (rule 13). Stable ids:
 * re-runs add nothing.
 */
async function seedUpfrontMoney(ids: Record<string, string>) {
  const today = colomboToday();
  check(
    await actingAs(ids.ownerA).from("deposit_transactions").upsert(
      [
        {
          id: stableId("deposit:agA5"),
          owner_id: ids.ownerA,
          customer_id: ids.custA3,
          agreement_id: stableId("agreement:agA5"),
          kind: "RECEIVED" as const,
          amount_cents: 1_000_000,
          occurred_on: addDays(today, -40),
          method: "BANK_TRANSFER" as const,
          reference: "DEP-FERNANDO",
          note: "Security deposit with the contract",
          created_by: ids.ownerA,
        },
      ],
      { onConflict: "id", ignoreDuplicates: true },
    ),
    "deposit",
  );
  check(
    await actingAs(ids.ownerB).from("credits").upsert(
      [
        {
          id: stableId("advance:agB3"),
          owner_id: ids.ownerB,
          customer_id: ids.custB3,
          agreement_id: stableId("agreement:agB3"),
          kind: "ADVANCE" as const,
          amount_cents: 300_000,
          reason: "Advance payment with the contract",
          received_on: addDays(today, -20),
          method: "CASH" as const,
          reference: "ADV-BANDARA",
          created_by: ids.ownerB,
        },
      ],
      { onConflict: "id", ignoreDuplicates: true },
    ),
    "advance",
  );
}

/** Opens every cycle that is due today or earlier, like the daily cron (catch-up). */
async function openDueCycles(ids: Record<string, string>) {
  const today = colomboToday();
  for (const a of AGREEMENTS) {
    const agreementId = stableId(`agreement:${a.key}`);
    for (;;) {
      const agreement = check(
        await admin.from("rental_agreements").select("next_cycle_no, next_cycle_date, status").eq("id", agreementId).single(),
        "load agreement",
      );
      if (agreement.status !== "ACTIVE" || agreement.next_cycle_date > today) break;
      check(
        await admin.rpc("rpc_open_billing_cycle", {
          p_agreement_id: agreementId,
          p_cycle_no: agreement.next_cycle_no,
          p_stage_due_at: inDays(5),
          p_notifications: [
            { user_id: ids[a.customer], event: "ticket.created", title: "Meter reading needed", link: "/tickets/{entity_id}" },
            { user_id: ids[a.customer], event: "ticket.created", channel: "EMAIL", title: "Meter reading needed" },
          ],
        }),
        `open cycle ${a.key}#${agreement.next_cycle_no}`,
      );
    }
  }
}

async function submitMeter(ticket: Ticket, agreement: AgreementDef, ids: Record<string, string>) {
  // The billing engine is the only place amounts are calculated (migration 0015
  // refuses anything else); the seed uses the same loader and engine as the app.
  const context = await loadMeterContext(admin, ticket.id);
  const previous = (counter: "BW" | "COLOUR") => previousReading(context.counters[counter]!.known).value;
  const colour = ticket.machine_type === "COLOUR";
  // Copies per cycle from spec 6.3 (colour case 2, mono case 2), times the cycles covered.
  const perCycle = { BW: colour ? USAGE.BW_COLOUR : USAGE.BW_MONO, COLOUR: USAGE.COLOUR };
  const submission = buildMeterSubmission(context, {
    BW: previous("BW") + perCycle.BW * context.cyclesCovered,
    COLOUR: colour ? previous("COLOUR") + perCycle.COLOUR * context.cyclesCovered : null,
  });

  // One photo per attempt (a rejected attempt keeps its row).
  const photoPath = `${ticket.owner_id}/${ticket.id}/seed-meter${ticket.rejection_count ? `-${ticket.rejection_count}` : ""}.jpg`;
  const photo = await demoPhotoFor(ticket.machine_id, submission.readings);
  check(await admin.storage.from("meter-photos").upload(photoPath, photo, { contentType: "image/jpeg", upsert: true }), "upload meter photo");

  check(
    await admin.rpc("rpc_submit_meter_reading", {
      p_ticket_id: ticket.id,
      p_actor_id: ticket.customer_id,
      // A new key after each rejection, so a re-run sends a fresh reading instead of replaying the rejected one.
      p_idempotency_key: stableId(`meter:${ticket.id}:${ticket.rejection_count}`),
      p_source: "CUSTOMER",
      p_readings: submission.readings as unknown as Json,
      p_photo: { storage_path: photoPath, captured_at: new Date().toISOString() },
      p_invoice: submission.invoice as unknown as Json,
      p_anomaly_flag: submission.anomalyFlag ?? undefined,
      p_stage_due_at: inDays(2),
      p_notifications: [{ user_id: ids[agreement.owner], event: "meter.submitted", title: "Meter reading submitted" }],
    }),
    `submit meter ${agreement.key}#${ticket.cycle_no}`,
  );
}

async function confirmMeter(ticket: Ticket, agreement: AgreementDef) {
  const submission = check(
    await admin.from("meter_submissions").select("id").eq("ticket_id", ticket.id).eq("status", "PENDING_REVIEW").single(),
    "pending submission",
  );
  const branding = brandingSnapshot(
    checkMaybe(await admin.from("owner_company_profiles").select(BRANDING_SNAPSHOT_COLUMNS).eq("owner_id", ticket.owner_id).maybeSingle(), "branding"),
    new Date(),
  );
  const result = check(
    await admin.rpc("rpc_confirm_meter_submission", {
      p_ticket_id: ticket.id,
      p_submission_id: submission.id,
      p_actor_id: ticket.owner_id,
      p_due_date: addDays(colomboToday(), 7),
      p_stage_due_at: inDays(7),
      p_branding_snapshot: (branding ?? undefined) as Json | undefined,
      p_notifications: [{ user_id: ticket.customer_id, event: "invoice.issued", title: "Your invoice is ready" }],
    }),
    `confirm ${agreement.key}#${ticket.cycle_no}`,
  ) as { photo_paths: string[] };

  // INV-09: delete the photo after the confirmation committed, then record it.
  if (result.photo_paths.length > 0) {
    check(await admin.storage.from("meter-photos").remove(result.photo_paths), "delete meter photo");
    check(
      await admin.from("meter_photos").update({ deleted_at: new Date().toISOString() }).in("storage_path", result.photo_paths),
      "mark photo deleted",
    );
  }
}

async function submitPayment(ticket: Ticket, agreement: AgreementDef, partial: boolean) {
  const invoice = check(
    await admin.from("invoices").select("total_cents, amount_paid_cents").eq("id", ticket.current_invoice_id!).single(),
    "invoice",
  );
  const balance = invoice.total_cents - invoice.amount_paid_cents;
  const amount = partial ? Math.round(balance * 0.6) : balance;
  const bytes = slipPdf(ticket.id);
  // Slips live in the customer's folder (decision 41).
  const slipPath = `${ticket.owner_id}/${ticket.customer_id}/${stableId(`slip:${ticket.id}`)}.pdf`;
  check(await admin.storage.from("payment-slips").upload(slipPath, bytes, { contentType: "application/pdf", upsert: true }), "upload slip");

  check(
    await admin.rpc("rpc_submit_payment", {
      p_actor_id: ticket.customer_id,
      p_customer_id: ticket.customer_id,
      p_idempotency_key: stableId(`payment:${ticket.id}`),
      p_invoice_ids: [ticket.current_invoice_id!],
      p_payment: { amount_cents: amount, paid_on: colomboToday(), method: "BANK_TRANSFER", reference: `SEED-${ticket.id.slice(0, 8).toUpperCase()}` },
      p_slip: { storage_path: slipPath, sha256: sha256(bytes), mime_type: "application/pdf", size_bytes: bytes.length },
      p_stage_due_at: inDays(2),
      p_notifications: [{ user_id: ticket.owner_id, event: "payment.submitted", title: "Payment slip received", link: "/owner/payments/{entity_id}" }],
    }),
    `submit payment ${agreement.key}#${ticket.cycle_no}`,
  );
}

async function verifyPayment(ticket: Ticket, agreement: AgreementDef) {
  const waiting = check(
    await admin.from("payment_allocations").select("payment_id").eq("ticket_id", ticket.id).eq("waiting", true).single(),
    "pending payment",
  );
  check(
    await admin.rpc("rpc_verify_payment", {
      p_payment_id: waiting.payment_id,
      p_actor_id: ticket.owner_id,
      p_accept: true,
      p_notifications: [{ user_id: ticket.customer_id, event: "payment.receipt", title: "Payment received", link: "/customer/payments/{entity_id}" }],
    }),
    `verify payment ${agreement.key}#${ticket.cycle_no}`,
  );
}

/** A meter photo showing these readings (demo data; decision 37 asks for a real-looking frame). */
async function demoPhotoFor(machineId: string, readings: { counter_type: string; current_value: number }[]): Promise<Buffer> {
  const machine = check(await admin.from("machines").select("brand, model, serial_no").eq("id", machineId).single(), "photo machine");
  const value = (c: string) => readings.find((r) => r.counter_type === c)?.current_value ?? null;
  return demoMeterPhoto({ machine: `${machine.brand} ${machine.model}`, serialNo: machine.serial_no, bw: value("BW") ?? 0, colour: value("COLOUR") });
}

/** A re-run replaces every demo photo still waiting for review with the generated one. */
async function refreshDemoPhotos(ids: Record<string, string>) {
  const photos = check(
    await admin
      .from("meter_photos")
      .select("storage_path, submission:meter_submissions!meter_photos_submission_fkey(ticket:billing_cycle_tickets!meter_submissions_ticket_fkey(machine_id), readings:meter_readings!meter_readings_submission_fkey(counter_type, current_value))")
      .in("owner_id", [ids.ownerA, ids.ownerB])
      .is("deleted_at", null)
      .like("storage_path", "%/seed-meter%.jpg"),
    "demo photos",
  ) as unknown as { storage_path: string; submission: { ticket: { machine_id: string }; readings: { counter_type: string; current_value: number }[] } }[];
  for (const p of photos) {
    const photo = await demoPhotoFor(p.submission.ticket.machine_id, p.submission.readings);
    check(await admin.storage.from("meter-photos").upload(p.storage_path, photo, { contentType: "image/jpeg", upsert: true }), "refresh meter photo");
  }
  return photos.length;
}

/** INV-09: PDFs of the demo invoices, through the same job as the app and the daily job. */
async function makeInvoicePdfs(ids: Record<string, string>) {
  const rpc: Rpc = async (fn, args) => {
    const { data, error } = await admin.rpc(fn as never, args as never);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const files: InvoiceFiles = {
    async readBranding(path) {
      const { data, error } = await admin.storage.from("branding").download(path);
      if (error) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async writeInvoicePdf(path, bytes) {
      check(await admin.storage.from(INVOICE_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true }), "upload invoice pdf");
    },
  };
  const pending = check(
    await admin.from("invoices").select("id").in("owner_id", [ids.ownerA, ids.ownerB]).eq("pdf_status", "PENDING"),
    "pending pdfs",
  );
  for (const inv of pending) await generateInvoicePdf(rpc, files, () => loadInvoiceFonts(), inv.id);
  return pending.length;
}

/** Decision 44: PDFs of the demo receipts, through the same job as the app. */
async function makeReceiptPdfs(ids: Record<string, string>) {
  const rpc: Rpc = async (fn, args) => {
    const { data, error } = await admin.rpc(fn as never, args as never);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const files: ReceiptFiles = {
    async readBranding(path) {
      const { data, error } = await admin.storage.from("branding").download(path);
      if (error) return null;
      return new Uint8Array(await data.arrayBuffer());
    },
    async writeReceiptPdf(path, bytes) {
      check(await admin.storage.from(RECEIPT_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true }), "upload receipt pdf");
    },
  };
  const pending = check(
    await admin.from("receipts").select("id").in("owner_id", [ids.ownerA, ids.ownerB]).eq("pdf_status", "PENDING"),
    "pending receipt pdfs",
  );
  for (const r of pending) await generateReceiptPdf(rpc, files, () => loadInvoiceFonts(), r.id);
  return pending.length;
}

/** Moves a ticket from wherever it is toward its target, one workflow step at a time. */
async function advance(agreement: AgreementDef, cycleNo: number, target: TicketStatus, ids: Record<string, string>) {
  const agreementId = stableId(`agreement:${agreement.key}`);
  for (let step = 0; step < 8; step++) {
    const ticket = checkMaybe(
      await admin.from("billing_cycle_tickets").select("*").eq("agreement_id", agreementId).eq("cycle_no", cycleNo).maybeSingle(),
      "load ticket",
    );
    if (!ticket) {
      console.warn(`  ! ${agreement.key} cycle ${cycleNo} is not open yet; skipped`);
      return;
    }
    if (ticket.status === target) return;

    switch (ticket.status) {
      case "METER_REQUESTED":
        if (target === "OVERDUE") {
          check(
            await admin.rpc("rpc_transition_ticket", {
              p_ticket_id: ticket.id,
              p_from: "METER_REQUESTED",
              p_to: "OVERDUE",
              p_actor_id: SYSTEM_ACTOR,
              p_reason: "Meter reading deadline missed",
              p_notifications: [{ user_id: ticket.owner_id, event: "ticket.overdue", title: "Meter reading overdue" }],
            }),
            `overdue ${agreement.key}#${cycleNo}`,
          );
        } else {
          await submitMeter(ticket, agreement, ids);
        }
        break;
      case "PENDING_OWNER_REVIEW":
        await confirmMeter(ticket, agreement);
        break;
      case "AWAITING_PAYMENT":
        await submitPayment(ticket, agreement, target === "PARTIALLY_PAID");
        break;
      case "PAYMENT_SUBMITTED":
        await verifyPayment(ticket, agreement);
        break;
      default:
        console.warn(`  ! ${agreement.key} cycle ${cycleNo} is ${ticket.status}; cannot reach ${target}`);
        return;
    }
  }
}

async function seedServiceRequests(ids: Record<string, string>) {
  check(
    await admin.from("service_requests").upsert(
      [
        {
          id: stableId("sr:toner"),
          owner_id: ids.ownerA,
          customer_id: ids.custA1,
          machine_id: stableId("machine:mA1"),
          agreement_id: stableId("agreement:agA1"),
          type: "TONER",
          toner_colours: ["CYAN", "MAGENTA"],
          description: "Cyan and magenta toner almost empty",
          urgency: "NORMAL",
          created_by: ids.custA1,
        },
        {
          id: stableId("sr:breakdown"),
          owner_id: ids.ownerB,
          customer_id: ids.custB2,
          machine_id: stableId("machine:mB2"),
          agreement_id: stableId("agreement:agB2"),
          type: "BREAKDOWN",
          description: "Paper jam error E-201 keeps coming back",
          urgency: "URGENT",
          created_by: ids.custB2,
        },
      ],
      { onConflict: "id", ignoreDuplicates: true, defaultToNull: false },
    ),
    "service requests",
  );
}

async function main() {
  console.log(`Seeding ${SUPABASE_URL}`);

  console.log("Accounts");
  const ids = await ensureUsers();
  await seedPlansTemplatesAndBranding(ids);
  await seedMachinesAndAgreements(ids);
  await seedUpfrontMoney(ids);
  await openDueCycles(ids);

  console.log("Tickets");
  for (const agreement of AGREEMENTS) {
    for (const [cycle, target] of Object.entries(agreement.targets)) {
      await advance(agreement, Number(cycle), target, ids);
    }
  }
  await seedServiceRequests(ids);
  console.log(`  demo meter photos refreshed: ${await refreshDemoPhotos(ids)}`);
  console.log(`  invoice PDFs made: ${await makeInvoicePdfs(ids)}`);
  console.log(`  receipt PDFs made: ${await makeReceiptPdfs(ids)}`);

  const tickets = check(
    await admin
      .from("billing_cycle_tickets")
      .select("cycle_no, status, agreement_id")
      .in("agreement_id", AGREEMENTS.map((a) => stableId(`agreement:${a.key}`)))
      .order("agreement_id"),
    "summary",
  );
  for (const a of AGREEMENTS) {
    const own = tickets.filter((t) => t.agreement_id === stableId(`agreement:${a.key}`));
    const summary = own.map((t) => `#${t.cycle_no} ${t.status}`).join(", ") || "no ticket yet";
    console.log(`  ${a.key.padEnd(5)} ${summary}`);
  }

  console.log("\nDemo logins (sign in with the username; demo data only, never use in production)");
  console.table(
    ACCOUNTS.map((a) => ({
      role: a.role,
      username: a.username,
      password: PASSWORDS[a.role],
      tenant: a.role === "OWNER" ? a.details?.business_name : a.owner ? ACCOUNTS.find((o) => o.key === a.owner)?.details?.business_name : "-",
      note: a.key === "ownerA" ? "onboarded, branded" : a.key === "ownerB" ? "not onboarded" : a.mustChangePassword ? "must change password" : "",
    })),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
