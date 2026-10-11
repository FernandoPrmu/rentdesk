import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { customer, notificationsFor } from "@/lib/notifications/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { RpcError } from "@/lib/tickets/transitions";

/**
 * Spec 11.4 "Invoice notification not delivered: the invoice stays in the portal;
 * owner can resend". Sends the bill's notice to the customer again (in-app today;
 * the email with the PDF joins it with NOT-02). A ticket event and an audit entry
 * record it; not twice within 10 minutes.
 */
export async function resendInvoiceNotification(owner: CurrentUser, invoiceId: string): Promise<ActionResult> {
  const admin = createAdminClient();
  try {
    const { data: inv } = await admin
      .from("invoices")
      .select("id, owner_id, customer_id, invoice_no, due_date, total_cents, amount_paid_cents, machine:machines!invoices_machine_fkey(brand, model)")
      .eq("id", invoiceId)
      .maybeSingle();
    if (!inv || inv.owner_id !== owner.id) return fail("This invoice was not found.");
    await supabaseRpc(admin)("rpc_resend_invoice_notification", {
      p_invoice_id: inv.id,
      p_actor_id: owner.id,
      p_notifications: notificationsFor(
        "invoice.resent",
        [customer(inv.customer_id)],
        { machine: `${inv.machine.brand} ${inv.machine.model}`, invoiceNo: inv.invoice_no, dueDate: inv.due_date ?? undefined, amountCents: inv.total_cents - inv.amount_paid_cents },
        { link: `/customer/bills/${inv.id}` },
      ),
    });
    return ok(undefined);
  } catch (error) {
    if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, "invoice resend"));
    console.error("[invoice resend]", error);
    return fail("Something went wrong. Please try again.");
  }
}
