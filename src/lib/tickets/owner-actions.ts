import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { isIsoDate, todayInColombo } from "@/lib/agreements/cycle-calendar";
import type { CurrentUser } from "@/lib/auth/current-user";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { onInvoiceChanged } from "@/lib/invoices/issued";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { paymentDeadline } from "@/lib/tickets/deadlines";
import type { TicketStatus } from "@/lib/tickets/states";
import {
  type Actor,
  cancelTicket,
  clearOverdue,
  reopenTicket,
  requestPaymentAgain,
  RpcError,
  type TicketSnapshot,
  TransitionError,
} from "@/lib/tickets/transitions";

/**
 * The owner's own ticket actions on the ticket page (TKT-10, spec 5.3, 11.1, 11.7):
 * cancel, reopen a closed ticket, ask for the payment again, and give an overdue
 * payment a new due date. A reason is required for each (checked here, in the
 * transition function and in the rpc). Reversing a payment is on the payment.
 */

function failure(error: unknown, context: string): { ok: false; error: string } {
  if (error instanceof TransitionError) return fail(error.message.replace(/^[^:]+: /, ""));
  if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, context));
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again.");
}

async function ownedTicket(owner: CurrentUser, ticketId: string) {
  const admin = createAdminClient();
  const { data } = await admin
    .from("billing_cycle_tickets")
    .select(
      `id, owner_id, customer_id, cycle_no, status, status_before_overdue, current_invoice_id,
       machine:machines!billing_cycle_tickets_machine_fkey(brand, model), customer:customers!billing_cycle_tickets_customer_fkey(name),
       invoice:invoices!billing_cycle_tickets_current_invoice_fkey(id, due_date, total_cents, amount_paid_cents)`,
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (!data || data.owner_id !== owner.id) return null;
  const ticket: TicketSnapshot = {
    id: data.id,
    owner_id: data.owner_id,
    customer_id: data.customer_id,
    cycle_no: data.cycle_no,
    status: data.status as TicketStatus,
    status_before_overdue: data.status_before_overdue as TicketStatus | null,
    machine_name: `${data.machine.brand} ${data.machine.model}`,
    customer_name: data.customer.name,
  };
  return { admin, ticket, invoice: data.invoice };
}

const actorOf = (owner: CurrentUser): Actor => ({ kind: "USER", id: owner.id, role: "OWNER" });

export type OwnerTicketAction =
  | { action: "cancel"; reason: string }
  | { action: "reopen"; reason: string }
  | { action: "requestPayment" }
  | { action: "newDueDate"; reason: string; dueDate: string };

export async function ownerTicketAction(owner: CurrentUser, ticketId: string, input: OwnerTicketAction): Promise<ActionResult> {
  const found = await ownedTicket(owner, ticketId);
  if (!found) return fail("This ticket was not found.");
  const { admin, ticket, invoice } = found;
  const rpc = supabaseRpc(admin);
  const actor = actorOf(owner);
  try {
    switch (input.action) {
      case "cancel":
        await cancelTicket(rpc, actor, ticket, { reason: input.reason });
        await onInvoiceChanged(invoice?.id);
        break;
      case "reopen":
        await reopenTicket(rpc, actor, ticket, { reason: input.reason });
        break;
      case "requestPayment": {
        if (!invoice?.due_date) return fail("This ticket has no bill to pay.");
        await requestPaymentAgain(rpc, actor, ticket, {
          stageDueAt: paymentDeadline(invoice.due_date),
          amountCents: invoice.total_cents - invoice.amount_paid_cents,
          dueDate: invoice.due_date,
        });
        break;
      }
      case "newDueDate": {
        if (!isIsoDate(input.dueDate) || input.dueDate < todayInColombo()) return fail("Choose a new due date from today.", { dueDate: "From today on." });
        await clearOverdue(rpc, actor, ticket, { reason: input.reason, dueDate: input.dueDate, stageDueAt: paymentDeadline(input.dueDate) });
        await onInvoiceChanged(invoice?.id);
        break;
      }
    }
    return ok(undefined);
  } catch (error) {
    return failure(error, `ticket ${input.action}`);
  }
}

/** The payment whose slip waits on this ticket (the signed-in user's client: RLS decides). */
export async function waitingPaymentId(ticketId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("payment_allocations").select("payment_id").eq("ticket_id", ticketId).eq("waiting", true).maybeSingle();
  return data?.payment_id ?? null;
}
