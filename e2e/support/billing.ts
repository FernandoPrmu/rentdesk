import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadMeterContext } from "../../src/lib/billing/context.ts";
import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";
import { previousReading } from "../../src/lib/billing/usage.ts";
import type { Database, Json } from "../../src/types/db";

/**
 * Billing steps the portal has no screen for yet (the daily cron, the meter
 * submission and the owner's review), driven through the same rpc functions and
 * billing engine as the app, with the service role. Dev project only.
 */

function service(): SupabaseClient<Database> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("e2e: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (.env.local)");
  return createClient<Database>(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function check<T>(result: { data: T; error: { message: string } | null }, what: string): T {
  if (result.error) throw new Error(`e2e ${what}: ${result.error.message}`);
  return result.data;
}

/** Registers a mono machine for an owner (serial must start with E2E- so it is cleaned up). */
export async function createMachine(ownerId: string, serial: string): Promise<string> {
  const row = check(
    await service().from("machines").insert({ owner_id: ownerId, brand: "Ricoh", model: "MP 2501", serial_no: serial, type: "MONO" }).select("id").single(),
    "machine",
  );
  return row!.id;
}

/**
 * Opens cycle 1 (as the cron would), submits `used` copies as the customer and
 * confirms the reading as the owner: an issued, unpaid invoice. Credits (an
 * advance) are applied by the engine automatically.
 */
export async function issueFirstInvoice(agreementId: string, used: number): Promise<{ invoiceNo: string; totalCents: number }> {
  const db = service();
  const agreement = check(await db.from("rental_agreements").select("owner_id, customer_id").eq("id", agreementId).single(), "agreement")!;
  const opened = check(
    await db.rpc("rpc_open_billing_cycle", { p_agreement_id: agreementId, p_cycle_no: 1, p_stage_due_at: new Date(Date.now() + 5 * 86_400_000).toISOString() }),
    "open cycle",
  ) as { ticket_id: string };
  const ticketId = opened.ticket_id;

  const context = await loadMeterContext(db, ticketId);
  const previous = previousReading(context.counters.BW!.known).value;
  const s = buildMeterSubmission(context, { BW: previous + used });
  const submitted = check(
    await db.rpc("rpc_submit_meter_reading", {
      p_ticket_id: ticketId,
      p_actor_id: agreement.customer_id,
      p_idempotency_key: randomUUID(),
      p_source: "CUSTOMER",
      p_readings: s.readings as unknown as Json,
      p_photo: { storage_path: `${agreement.owner_id}/${ticketId}/e2e-meter.jpg`, captured_at: new Date().toISOString() },
      p_invoice: s.invoice as unknown as Json,
      p_anomaly_flag: s.anomalyFlag ?? undefined,
      p_stage_due_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    }),
    "submit reading",
  ) as { submission_id: string };
  const confirmed = check(
    await db.rpc("rpc_confirm_meter_submission", {
      p_ticket_id: ticketId,
      p_submission_id: submitted.submission_id,
      p_actor_id: agreement.owner_id,
      p_due_date: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      p_stage_due_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    }),
    "confirm reading",
  ) as { invoice_no: string };
  return { invoiceNo: confirmed.invoice_no, totalCents: s.invoice.total_cents };
}
