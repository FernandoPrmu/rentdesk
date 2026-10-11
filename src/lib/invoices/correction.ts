import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { addDays, todayInColombo } from "@/lib/agreements/cycle-calendar";
import type { CurrentUser } from "@/lib/auth/current-user";
import { loadAvailableCredits } from "@/lib/billing/context";
import type { StoredCalculation } from "@/lib/billing/dispute";
import { BillingError } from "@/lib/billing/errors";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { afterDisputeCorrected } from "@/lib/disputes/service";
import { type CorrectionInput, correctionInputSchema, type CorrectionView, previewCorrection } from "@/lib/invoices/correction-form";
import { onInvoiceChanged, onInvoiceIssued } from "@/lib/invoices/issued";
import { readingErrorMessage } from "@/lib/meter/readings";
import { formatRupees } from "@/lib/money";
import { createAdminClient } from "@/lib/supabase/admin";
import { paymentDeadline, PLATFORM_DEFAULTS } from "@/lib/tickets/deadlines";
import { canPerform, type TicketStatus } from "@/lib/tickets/states";
import { correctInvoice, RpcError, TransitionError } from "@/lib/tickets/transitions";

/**
 * Correcting an issued invoice (spec 11.1, 11.3, 11.4; decision 49): a wrong
 * reading confirmed by mistake, a calculation or rate error, or the answer to a
 * dispute. Never an edit in place: the bill is cancelled (its number voided, a
 * CANCELLED PDF version) and the corrected bill gets a new number. Money already
 * paid becomes a credit taken off the corrected bill. A closed ticket is reopened
 * first (TKT-10). The billing engine builds the corrected bill from the original
 * calculation (buildCorrectedInvoice); the database checks it again.
 */

function failure(error: unknown, context: string): { ok: false; error: string } {
  if (error instanceof TransitionError) return fail(error.message.replace(/^[^:]+: /, ""));
  if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, context));
  if (error instanceof BillingError) return fail(readingErrorMessage(error).message);
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again.");
}

export type { CorrectionInput, CorrectionView };

export async function getCorrectionView(owner: CurrentUser, ticketId: string): Promise<CorrectionView | null> {
  const admin = createAdminClient();
  const { data: t } = await admin
    .from("billing_cycle_tickets")
    .select(
      `id, owner_id, customer_id, agreement_id, cycle_no, status, status_before_overdue, current_invoice_id, machine_type, due_days,
       machine:machines!billing_cycle_tickets_machine_fkey(brand, model), customer:customers!billing_cycle_tickets_customer_fkey(name)`,
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (!t || t.owner_id !== owner.id || !t.current_invoice_id) return null;
  const { data: inv } = await admin
    .from("invoices")
    .select("id, invoice_no, type, status, total_cents, amount_paid_cents, due_date, calculation, lines:invoice_lines!invoice_lines_invoice_fkey(line_type, description, amount_cents, sort_order)")
    .eq("id", t.current_invoice_id)
    .maybeSingle();
  if (!inv?.invoice_no) return null;

  const state = { status: t.status as TicketStatus, statusBeforeOverdue: t.status_before_overdue as TicketStatus | null };
  const calc = inv.calculation as StoredCalculation | null;
  const [credits, waiting, sub] = await Promise.all([
    loadAvailableCredits(admin, t.customer_id, inv.id),
    admin.from("payment_allocations").select("id", { count: "exact", head: true }).eq("invoice_id", inv.id).eq("waiting", true),
    admin.from("meter_submissions").select("id, reviewed_at, submitted_at").eq("invoice_id", inv.id).eq("status", "CONFIRMED").maybeSingle(),
  ]);

  // The reading can change only while the next bill has not started from it (the database decides; this explains it first).
  let readingsBlocked: string | null = null;
  if (inv.type !== "NORMAL" || !calc?.counters?.length) readingsBlocked = "An estimated bill has no reading: correct it with an adjustment line.";
  else if (!sub.data) readingsBlocked = "This bill has no confirmed reading to change: correct it with an adjustment line.";
  else {
    const since = sub.data.reviewed_at ?? sub.data.submitted_at;
    const [later, baseline] = await Promise.all([
      admin
        .from("meter_submissions")
        .select("id, ticket:billing_cycle_tickets!meter_submissions_ticket_fkey!inner(agreement_id, cycle_no)", { count: "exact", head: true })
        .eq("ticket.agreement_id", t.agreement_id)
        .gt("ticket.cycle_no", t.cycle_no)
        .in("status", ["PENDING_REVIEW", "CONFIRMED"]),
      admin.from("meter_baselines").select("id", { count: "exact", head: true }).eq("agreement_id", t.agreement_id).gte("recorded_at", since),
    ]);
    if ((later.count ?? 0) > 0 || (baseline.count ?? 0) > 0) {
      readingsBlocked = "A later reading or a new meter baseline exists, so this reading can no longer change: use an adjustment line.";
    }
  }

  const blocked = !calc
    ? "This bill was issued before calculations were stored. Cancel the ticket and bill again."
    : t.status === "CLOSED"
      ? "This ticket is closed. Reopen it first (with a reason), then correct the bill."
      : (waiting.count ?? 0) > 0 || t.status === "PAYMENT_SUBMITTED"
        ? "A payment slip is waiting for your check. Accept or reject it first."
        : !canPerform("correctInvoice", "OWNER", state)
          ? "This bill cannot be corrected now."
          : null;

  const today = todayInColombo();
  return {
    ticket: {
      id: t.id,
      owner_id: t.owner_id,
      customer_id: t.customer_id,
      cycle_no: t.cycle_no,
      status: state.status,
      status_before_overdue: state.statusBeforeOverdue,
      machine_name: `${t.machine.brand} ${t.machine.model}`,
      customer_name: t.customer.name,
      current_invoice_id: t.current_invoice_id,
    },
    invoice: {
      id: inv.id,
      invoiceNo: inv.invoice_no,
      type: inv.type,
      status: inv.status,
      totalCents: inv.total_cents,
      paidCents: inv.amount_paid_cents,
      dueDate: inv.due_date,
      calculation: (calc ?? { counters: [] }) as StoredCalculation,
      lines: [...inv.lines].sort((a, b) => a.sort_order - b.sort_order),
    },
    machineType: t.machine_type,
    counters: (calc?.counters ?? []).map((c) => ({ counter: c.counter_type, previous: c.previous_value, current: c.current_value })),
    credits,
    readingsAllowed: readingsBlocked === null,
    readingsBlocked,
    defaultDueDate: addDays(today, t.due_days ?? PLATFORM_DEFAULTS.payment_due_days),
    today,
    disputed: t.status === "DISPUTED",
    blocked,
  };
}

export async function submitCorrection(owner: CurrentUser, input: CorrectionInput): Promise<ActionResult<{ invoiceNo: string; invoiceId: string }>> {
  const parsed = correctionInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue.message, { [String(issue.path[0] === "adjustments" ? `adjustment${String(issue.path[1])}` : issue.path[0])]: issue.message });
  }
  const i = parsed.data;
  if (i.dueDate < todayInColombo()) return fail("Choose a due date from today.", { dueDate: "From today on." });
  try {
    const view = await getCorrectionView(owner, i.ticketId);
    if (!view || view.invoice.id !== i.invoiceId) return fail("This bill changed. Please reload the page.");
    if (view.blocked) return fail(view.blocked);
    const paidCreditId = crypto.randomUUID();
    const preview = previewCorrection(view, i, paidCreditId);
    if (!preview.ok) return fail(preview.message ?? "Please check the form.", preview.errors);
    const { built, keptCreditCents } = preview;
    const admin = createAdminClient();
    const result = await correctInvoice(supabaseRpc(admin), { kind: "USER", id: owner.id, role: "OWNER" }, view.ticket, {
      invoiceId: view.invoice.id,
      reason: i.reason,
      readings: built.readings,
      invoice: built.invoice,
      paidCreditId: view.invoice.paidCents > 0 ? paidCreditId : null,
      dueDate: i.dueDate,
      stageDueAt: paymentDeadline(i.dueDate),
      context: { totals: `${formatRupees(built.summary.oldTotalCents)} → ${formatRupees(built.summary.newTotalCents)}`, creditCents: keptCreditCents },
    });
    // PDFs: version 1 of the corrected bill, and the CANCELLED version of the old one.
    await onInvoiceIssued({ invoiceId: result.invoice_id, ticketId: view.ticket.id, ownerId: owner.id });
    await onInvoiceChanged(result.old_invoice_id);
    if (view.disputed) await afterDisputeCorrected(view.ticket.id);
    return ok({ invoiceNo: result.invoice_no, invoiceId: result.invoice_id });
  } catch (error) {
    return failure(error, "invoice correction");
  }
}
