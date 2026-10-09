import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../types/db.ts";
import { finalCycle } from "../agreements/cycle-calendar.ts";
import { versionForCycle } from "../agreements/terms.ts";
import { BillingError } from "./errors.ts";
import type { AvailableCredit, EstimateCredit, MachineType } from "./invoice.ts";
import type { CounterContext, MeterContext } from "./meter-invoice.ts";
import type { ReturnContext } from "./return-invoice.ts";
import type { CounterType, KnownReading } from "./usage.ts";

/**
 * Loads everything the billing engine needs for one ticket, or for the final
 * invoice of a return. Takes the client as a parameter so server code
 * (service-role client, after its own actor checks), pages (the owner's own
 * client, RLS) and scripts/seed.ts use the same loader. Only relative imports:
 * the seed runs it under plain Node.
 *
 * Same facts the database re-checks (app.verify_meter_invoice,
 * app.verify_final_invoice):
 *   - terms: the ticket's snapshot (AGR-02), or the version in force for the
 *     final cycle;
 *   - cycles: since the ticket of the last confirmed reading (11.6);
 *   - previous reading: newest of initial / confirmed / baseline, ties in that
 *     order of priority (app.last_known_reading);
 *   - credits: the customer's available credits, oldest first (app.available_credits).
 */

type Client = SupabaseClient<Database>;

const HISTORY_CYCLES = 6;

const CREDIT_LABEL: Record<string, string> = {
  ADVANCE: "advance payment",
  OVERPAYMENT: "overpayment",
  CANCELLED_INVOICE: "paid on a cancelled invoice",
  ESTIMATE_RECONCILIATION: "estimate",
  MANUAL: "credit",
};

function fail(what: string, message?: string): never {
  throw new Error(`billing context: ${what}${message ? `: ${message}` : ""}`);
}

interface ConfirmedSubmission {
  submitted_at: string;
  reviewed_at: string | null;
  ticket: { cycle_no: number; agreement_id: string };
  readings: { counter_type: CounterType; previous_value: number; current_value: number; rolled_over: boolean }[];
  invoice: { cycles_covered: number; calculation: unknown } | null;
}

/** Counters, confirmed history and the last confirmed cycle of an agreement. */
async function loadCounters(
  client: Client,
  agreementId: string,
  machineId: string,
  machineType: MachineType,
): Promise<{ counters: Partial<Record<CounterType, CounterContext>>; lastConfirmedCycle: number }> {
  const [agreement, machine, confirmed, baselines] = await Promise.all([
    client.from("rental_agreements").select("initial_bw_reading, initial_colour_reading, created_at").eq("id", agreementId).single(),
    client.from("machines").select("bw_counter_max, colour_counter_max").eq("id", machineId).single(),
    client
      .from("meter_submissions")
      .select(
        `submitted_at, reviewed_at,
         ticket:billing_cycle_tickets!meter_submissions_ticket_fkey!inner(cycle_no, agreement_id),
         readings:meter_readings!meter_readings_submission_fkey(counter_type, previous_value, current_value, rolled_over),
         invoice:invoices!meter_submissions_invoice_fkey(cycles_covered, calculation)`,
      )
      .eq("status", "CONFIRMED")
      .eq("ticket.agreement_id", agreementId),
    client.from("meter_baselines").select("counter_type, value, recorded_at").eq("agreement_id", agreementId),
  ]);
  if (agreement.error) fail("agreement", agreement.error.message);
  if (machine.error) fail("machine", machine.error.message);
  if (confirmed.error) fail("confirmed readings", confirmed.error.message);
  if (baselines.error) fail("baselines", baselines.error.message);

  // Newest confirmed cycle first.
  const submissions = [...(confirmed.data as ConfirmedSubmission[])].sort((a, b) => b.ticket.cycle_no - a.ticket.cycle_no);

  const counterTypes: CounterType[] = machineType === "COLOUR" ? ["BW", "COLOUR"] : ["BW"];
  const counters: Partial<Record<CounterType, CounterContext>> = {};
  for (const counter of counterTypes) {
    const initial = counter === "BW" ? agreement.data.initial_bw_reading : agreement.data.initial_colour_reading;
    // Order = tie priority: initial, then confirmed readings, then baselines (later wins).
    const known: KnownReading[] = [];
    if (initial !== null) known.push({ value: initial, at: agreement.data.created_at, source: "INITIAL" });
    for (const s of [...submissions].reverse()) {
      const r = s.readings.find((x) => x.counter_type === counter);
      if (r) known.push({ value: r.current_value, at: s.reviewed_at ?? s.submitted_at, source: "READING" });
    }
    for (const b of baselines.data.filter((x) => x.counter_type === counter)) {
      known.push({ value: b.value, at: b.recorded_at, source: "BASELINE" });
    }

    counters[counter] = {
      known,
      counterMax: counter === "BW" ? machine.data.bw_counter_max : machine.data.colour_counter_max,
      history: submissions
        .slice(0, HISTORY_CYCLES)
        .map((s) => perCycleUsage(s, counter))
        .filter((u): u is number => u !== null),
    };
  }
  return { counters, lastConfirmedCycle: submissions[0]?.ticket.cycle_no ?? 0 };
}

/** 11.6: issued estimated invoices for cycles after the last confirmed one and before `beforeCycle`. */
async function loadEstimateCredits(client: Client, agreementId: string, lastConfirmedCycle: number, beforeCycle: number): Promise<EstimateCredit[]> {
  const { data: estimates, error } = await client
    .from("invoices")
    .select("invoice_no, subtotal_cents, ticket:billing_cycle_tickets!invoices_ticket_fkey!inner(cycle_no)")
    .eq("agreement_id", agreementId)
    .eq("type", "ESTIMATED")
    .not("status", "in", "(DRAFT,REJECTED,CANCELLED)")
    .gt("ticket.cycle_no", lastConfirmedCycle)
    .lt("ticket.cycle_no", beforeCycle);
  if (error) fail("estimated invoices", error.message);
  return estimates
    .map((e) => ({ invoiceNo: e.invoice_no, cycleNo: e.ticket.cycle_no, amountCents: e.subtotal_cents }))
    .sort((a, b) => a.cycleNo - b.cycleNo);
}

/**
 * Rule 13: the customer's credits with something left, oldest first. What is left
 * = amount minus the CREDIT lines that use it on live invoices (drafts included:
 * a draft reserves its credits). `excludeInvoiceId`: recalculating that draft, so
 * its own lines do not count. Same as app.available_credits.
 */
export async function loadAvailableCredits(client: Client, customerId: string, excludeInvoiceId: string | null = null): Promise<AvailableCredit[]> {
  const { data: credits, error } = await client
    .from("credits")
    .select("id, kind, amount_cents, created_at")
    .eq("customer_id", customerId)
    .eq("status", "AVAILABLE")
    .order("created_at")
    .order("id");
  if (error) fail("credits", error.message);
  if (credits.length === 0) return [];

  const { data: used, error: usedError } = await client
    .from("invoice_lines")
    .select("credit_id, amount_cents, invoice:invoices!invoice_lines_invoice_fkey!inner(id, status)")
    .in(
      "credit_id",
      credits.map((c) => c.id),
    )
    .not("invoice.status", "in", "(REJECTED,CANCELLED)");
  if (usedError) fail("credit use", usedError.message);

  const usedBy = new Map<string, number>();
  for (const line of used) {
    if (!line.credit_id || line.invoice.id === excludeInvoiceId) continue;
    usedBy.set(line.credit_id, (usedBy.get(line.credit_id) ?? 0) - line.amount_cents);
  }
  return credits
    .map((c) => ({ id: c.id, amountCents: c.amount_cents - (usedBy.get(c.id) ?? 0), label: CREDIT_LABEL[c.kind] }))
    .filter((c) => c.amountCents > 0);
}

export async function loadMeterContext(
  client: Client,
  ticketId: string,
  options: { excludeInvoiceId?: string | null; creditsExcluded?: string[] } = {},
): Promise<MeterContext> {
  const { data: ticket, error: ticketError } = await client
    .from("billing_cycle_tickets")
    .select(
      "id, agreement_id, machine_id, customer_id, cycle_no, machine_type, commitment_cents, bw_included, bw_rate_cents, colour_included, colour_rate_cents",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketError) fail("ticket", ticketError.message);
  if (!ticket) throw new BillingError("INVALID_INPUT", "Ticket not found");

  const { counters, lastConfirmedCycle } = await loadCounters(client, ticket.agreement_id, ticket.machine_id, ticket.machine_type);
  const [estimateCredits, credits] = await Promise.all([
    loadEstimateCredits(client, ticket.agreement_id, lastConfirmedCycle, ticket.cycle_no),
    loadAvailableCredits(client, ticket.customer_id, options.excludeInvoiceId ?? null),
  ]);

  return {
    terms: {
      machineType: ticket.machine_type,
      commitmentCents: ticket.commitment_cents,
      bwIncluded: ticket.bw_included,
      bwRateCents: ticket.bw_rate_cents,
      colourIncluded: ticket.colour_included,
      colourRateCents: ticket.colour_rate_cents,
    },
    cyclesCovered: ticket.cycle_no - lastConfirmedCycle,
    counters,
    estimateCredits,
    credits,
    creditsExcluded: options.creditsExcluded ?? [],
  };
}

/** The final invoice of a return on `today` (Asia/Colombo). */
export async function loadReturnContext(client: Client, agreementId: string, today: string): Promise<ReturnContext> {
  const { data: agreement, error } = await client
    .from("rental_agreements")
    .select(
      "id, customer_id, machine_id, start_date, first_billing_date, machine:machines!rental_agreements_machine_fkey(type), history:agreement_terms_history!agreement_terms_history_agreement_fkey(version, effective_from_cycle_no, monthly_commitment_cents, bw_included, bw_rate_cents, colour_included, colour_rate_cents, due_days)",
    )
    .eq("id", agreementId)
    .maybeSingle();
  if (error) fail("agreement", error.message);
  if (!agreement) throw new BillingError("INVALID_INPUT", "Agreement not found");

  const machineType = agreement.machine.type;
  const { counters, lastConfirmedCycle } = await loadCounters(client, agreement.id, agreement.machine_id, machineType);
  const final = finalCycle({ startDate: agreement.start_date, firstBillingDate: agreement.first_billing_date, today, lastConfirmedCycle });
  const terms = versionForCycle(agreement.history, final.cycleNo);
  if (!terms) fail("terms", "no version in force");
  const [estimateCredits, credits] = await Promise.all([
    loadEstimateCredits(client, agreement.id, lastConfirmedCycle, final.cycleNo),
    loadAvailableCredits(client, agreement.customer_id),
  ]);

  return {
    terms: {
      machineType,
      commitmentCents: terms.monthly_commitment_cents,
      bwIncluded: terms.bw_included,
      bwRateCents: terms.bw_rate_cents,
      colourIncluded: terms.colour_included,
      colourRateCents: terms.colour_rate_cents,
    },
    dueDays: terms.due_days,
    final,
    counters,
    estimateCredits,
    credits,
  };
}

/** Usage per cycle of a confirmed submission (from its calculation record when there is one). */
function perCycleUsage(s: ConfirmedSubmission, counter: CounterType): number | null {
  const cycles = s.invoice?.cycles_covered ?? 1;
  const calc = s.invoice?.calculation as { counters?: { counter_type: string; usage: number }[] } | null | undefined;
  const fromCalc = calc?.counters?.find((c) => c.counter_type === counter)?.usage;
  if (typeof fromCalc === "number") return Math.floor(fromCalc / cycles);
  const r = s.readings.find((x) => x.counter_type === counter);
  // Older rows without a calculation: a rollover cannot be recomputed without the maximum.
  if (!r || r.rolled_over) return null;
  return Math.floor((r.current_value - r.previous_value) / cycles);
}
