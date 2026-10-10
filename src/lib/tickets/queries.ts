import "server-only";

import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

import { TICKET_STATUSES, type TicketStatus } from "./states";
import type { CustomerTicketRow, TicketViewInvoice } from "./view";

/**
 * Ticket screens (TKT-06, CP-02): they run as the signed-in user, so RLS decides
 * what is visible (an owner sees their own tenant, a customer their own tickets,
 * an admin everything). Read-only for now; actions come with the next tasks.
 */

export const TICKET_FILTERS = ["OPEN", "ALL", "ESCALATED", ...TICKET_STATUSES] as const;
export type TicketFilter = (typeof TICKET_FILTERS)[number];
export const ticketFilterSchema = z.object({
  status: z.enum(TICKET_FILTERS).catch("OPEN").default("OPEN"),
});

const INVOICE = "invoice:invoices!billing_cycle_tickets_current_invoice_fkey(id, invoice_no, type, status, due_date, total_cents, amount_paid_cents)";
const MACHINE = "machine:machines!billing_cycle_tickets_machine_fkey(id, brand, model, serial_no)";
const LIST_COLUMNS = `id, cycle_no, cycle_date, period_start, period_end, status, status_before_overdue, stage_due_at,
  escalation_level, paused_at, is_late, agreement_id,
  customer:customers!billing_cycle_tickets_customer_fkey(id, name), ${MACHINE}, ${INVOICE}`;

export async function listOwnerTickets(filter: TicketFilter) {
  const supabase = await createClient();
  let query = supabase.from("billing_cycle_tickets").select(LIST_COLUMNS);
  if (filter === "OPEN") query = query.not("status", "in", "(CLOSED,CANCELLED)");
  else if (filter === "ESCALATED") query = query.gt("escalation_level", 0).not("status", "in", "(CLOSED,CANCELLED)");
  else if (filter !== "ALL") query = query.eq("status", filter);
  const { data, error } = await query
    .order("stage_due_at", { ascending: true, nullsFirst: false })
    .order("cycle_date", { ascending: false })
    .limit(300);
  if (error) throw new Error(`tickets: ${error.message}`);
  return data.map((t) => ({ ...t, invoice: t.invoice as TicketViewInvoice | null }));
}

export type OwnerTicketRow = Awaited<ReturnType<typeof listOwnerTickets>>[number];

export async function getTicket(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("billing_cycle_tickets")
    .select(
      `${LIST_COLUMNS}, cycle_length_days, stage_entered_at, reminder_count, rejection_count, created_at, closed_at,
       events:ticket_events!ticket_events_ticket_fkey(id, event_type, from_status, to_status, reason, metadata, created_at,
         actor:profiles!ticket_events_actor_id_fkey(full_name, username, role))`,
    )
    .eq("id", id)
    .order("created_at", { referencedTable: "ticket_events", ascending: true })
    .maybeSingle();
  if (error) throw new Error(`ticket: ${error.message}`);
  if (!data) return null;
  return { ...data, invoice: data.invoice as TicketViewInvoice | null };
}

export type TicketDetail = NonNullable<Awaited<ReturnType<typeof getTicket>>>;

/** The customer's open tickets with the last confirmed cycle per agreement (months a reading covers). */
export async function listCustomerTicketRows(customerId: string): Promise<CustomerTicketRow[]> {
  const supabase = await createClient();
  const [open, confirmed] = await Promise.all([
    supabase
      .from("billing_cycle_tickets")
      .select(`id, agreement_id, cycle_no, cycle_date, status, status_before_overdue, stage_due_at, escalation_level, paused_at, ${MACHINE}, ${INVOICE}`)
      .eq("customer_id", customerId)
      .not("status", "in", "(CLOSED,CANCELLED)")
      .order("cycle_no"),
    supabase
      .from("meter_submissions")
      .select("ticket:billing_cycle_tickets!meter_submissions_ticket_fkey!inner(agreement_id, cycle_no)")
      .eq("customer_id", customerId)
      .eq("status", "CONFIRMED"),
  ]);
  if (open.error) throw new Error(`customer tickets: ${open.error.message}`);
  if (confirmed.error) throw new Error(`confirmed readings: ${confirmed.error.message}`);

  const lastConfirmed = new Map<string, number>();
  for (const s of confirmed.data) {
    lastConfirmed.set(s.ticket.agreement_id, Math.max(lastConfirmed.get(s.ticket.agreement_id) ?? 0, s.ticket.cycle_no));
  }
  return open.data.map((t) => ({
    id: t.id,
    agreement_id: t.agreement_id,
    cycle_no: t.cycle_no,
    cycle_date: t.cycle_date,
    status: t.status as TicketStatus,
    status_before_overdue: t.status_before_overdue as TicketStatus | null,
    stage_due_at: t.stage_due_at,
    escalation_level: t.escalation_level,
    paused_at: t.paused_at,
    invoice: t.invoice as TicketViewInvoice | null,
    machine: `${t.machine.brand} ${t.machine.model}`,
    last_confirmed_cycle: lastConfirmed.get(t.agreement_id) ?? 0,
  }));
}

/**
 * A customer's own ticket (CP-02): stage, timeline, and the readings sent with how
 * they were reviewed (rejection reason, corrections as old → new). RLS: own tickets
 * only, and a draft invoice is never visible to the customer.
 */
export async function getCustomerTicket(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("billing_cycle_tickets")
    .select(
      `id, cycle_no, cycle_date, period_start, period_end, status, status_before_overdue, stage_due_at, escalation_level, paused_at,
       rejection_count, ${MACHINE}, ${INVOICE},
       events:ticket_events!ticket_events_ticket_fkey(id, event_type, from_status, to_status, reason, metadata, created_at, actor_id),
       submissions:meter_submissions!meter_submissions_ticket_fkey(id, attempt_no, source, status, submitted_at, reviewed_at, reject_reason, note,
         readings:meter_readings!meter_readings_submission_fkey(counter_type, current_value, corrected_from_value, correction_note))`,
    )
    .eq("id", id)
    .order("created_at", { referencedTable: "ticket_events", ascending: true })
    .order("attempt_no", { referencedTable: "meter_submissions", ascending: false })
    .maybeSingle();
  if (error) throw new Error(`ticket: ${error.message}`);
  return data ? { ...data, invoice: data.invoice as TicketViewInvoice | null } : null;
}

export type CustomerTicketDetail = NonNullable<Awaited<ReturnType<typeof getCustomerTicket>>>;

/** Owner: how many readings and estimates wait for review (Home card, Tickets header). */
export async function countApprovals(): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase.from("billing_cycle_tickets").select("id", { count: "exact", head: true }).eq("status", "PENDING_OWNER_REVIEW");
  if (error) throw new Error(`approvals: ${error.message}`);
  return count ?? 0;
}

/** Admin: tickets escalated to the platform (the owner did not act in time). */
export async function listEscalations() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("billing_cycle_tickets")
    .select(
      `id, cycle_no, cycle_date, status, status_before_overdue, stage_due_at, stage_entered_at, escalation_level, paused_at,
       owner:owners!billing_cycle_tickets_owner_id_fkey(id, business_name),
       customer:customers!billing_cycle_tickets_customer_fkey(name), ${MACHINE}, ${INVOICE}`,
    )
    .gte("escalation_level", 2)
    .not("status", "in", "(CLOSED,CANCELLED)")
    .order("stage_entered_at")
    .limit(300);
  if (error) throw new Error(`escalations: ${error.message}`);
  return data.map((t) => ({ ...t, invoice: t.invoice as TicketViewInvoice | null }));
}

/** Admin: the latest runs of the daily job. */
export async function listCronRuns(limit = 30) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("cron_runs")
    .select("id, trigger, run_now, simulated, run_date, status, started_at, finished_at, counts, errors, remaining, triggered_by")
    .order("started_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(`cron runs: ${error.message}`);
  return data.map((r) => ({
    ...r,
    counts: (r.counts ?? {}) as Record<string, number>,
    errors: (r.errors ?? []) as { step: string; id?: string; code?: string; message: string }[],
  }));
}
