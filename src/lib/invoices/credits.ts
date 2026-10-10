import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { loadMeterContext } from "@/lib/billing/context";
import { buildMeterSubmission } from "@/lib/billing/meter-invoice";
import { dbErrorMessage } from "@/lib/db-errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/db";

/**
 * Rule 13 (client decision C): available credits are added to every new draft
 * automatically. Before confirming, the owner may remove one (e.g. to refund it
 * instead) or add it back. The draft is recalculated by the billing engine with
 * the same readings; app.set_invoice_credit checks that only the credit lines
 * changed, swaps them and writes the audit log. A removed credit stays available.
 *
 * Used by the owner's review screen (INV-07, built with the ticket flow).
 */
export async function setInvoiceCredit(
  actor: CurrentUser,
  invoiceId: string,
  creditId: string,
  include: boolean,
  note: string | null,
): Promise<ActionResult<{ totalCents: number }>> {
  const admin = createAdminClient();
  const { data: invoice, error } = await admin
    .from("invoices")
    .select("id, owner_id, status, ticket_id, calculation")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) return fail(dbErrorMessage(error, "invoice credits"));
  // Another tenant's invoice looks exactly like a missing one.
  if (!invoice || invoice.owner_id !== actor.id) return fail("This invoice was not found.");
  if (invoice.status !== "DRAFT") return fail("Credits can only be changed before the invoice is confirmed.");

  const { data: submission, error: readingsError } = await admin
    .from("meter_submissions")
    .select("readings:meter_readings!meter_readings_submission_fkey(counter_type, current_value)")
    .eq("invoice_id", invoice.id)
    .maybeSingle();
  if (readingsError || !submission) return fail("The reading for this invoice was not found.");

  const excluded = ((invoice.calculation as { credits_excluded?: string[] } | null)?.credits_excluded ?? []).filter((id) => id !== creditId);
  if (!include) excluded.push(creditId);

  const context = await loadMeterContext(admin, invoice.ticket_id, { excludeInvoiceId: invoice.id, creditsExcluded: excluded });
  const reading = (counter: "BW" | "COLOUR") => submission.readings.find((r) => r.counter_type === counter)?.current_value ?? null;
  const rebuilt = buildMeterSubmission(context, { BW: reading("BW") ?? 0, COLOUR: reading("COLOUR") });

  const { error: rpcError } = await admin.rpc("rpc_set_invoice_credit", {
    p_actor_id: actor.id,
    p_invoice_id: invoice.id,
    p_credit_id: creditId,
    p_include: include,
    p_note: note as string,
    p_invoice: rebuilt.invoice as unknown as Json,
  });
  if (rpcError) return fail(dbErrorMessage(rpcError, "invoice credits"));
  return ok({ totalCents: rebuilt.invoice.total_cents });
}
