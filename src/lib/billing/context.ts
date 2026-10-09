import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "../../types/db.ts";
import { BillingError } from "./errors.ts";
import type { EstimateCredit } from "./invoice.ts";
import type { CounterContext, MeterContext } from "./meter-invoice.ts";
import type { CounterType, KnownReading } from "./usage.ts";

/**
 * Loads everything the billing engine needs for one ticket. Takes the client as a
 * parameter so server code (service-role client, after its own actor checks) and
 * scripts/seed.ts use the same loader. Only relative imports: the seed runs it
 * under plain Node.
 *
 * Same facts the database re-checks in app.verify_meter_invoice:
 *   - terms: the ticket's snapshot (AGR-02);
 *   - cycles: since the ticket of the last confirmed reading (11.6);
 *   - previous reading: newest of initial / confirmed / baseline, ties in that
 *     order of priority (app.last_known_reading).
 */

type Client = SupabaseClient<Database>;

const HISTORY_CYCLES = 6;

function fail(what: string, message?: string): never {
  throw new Error(`billing context: ${what}${message ? `: ${message}` : ""}`);
}

export async function loadMeterContext(client: Client, ticketId: string): Promise<MeterContext> {
  const { data: ticket, error: ticketError } = await client
    .from("billing_cycle_tickets")
    .select(
      "id, agreement_id, machine_id, cycle_no, machine_type, cycle_length_days, commitment_cents, bw_included, bw_rate_cents, colour_included, colour_rate_cents",
    )
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketError) fail("ticket", ticketError.message);
  if (!ticket) throw new BillingError("INVALID_INPUT", "Ticket not found");

  const [agreement, machine, confirmed, baselines] = await Promise.all([
    client.from("rental_agreements").select("initial_bw_reading, initial_colour_reading, created_at").eq("id", ticket.agreement_id).single(),
    client.from("machines").select("bw_counter_max, colour_counter_max").eq("id", ticket.machine_id).single(),
    client
      .from("meter_submissions")
      .select(
        `submitted_at, reviewed_at,
         ticket:billing_cycle_tickets!meter_submissions_ticket_fkey!inner(cycle_no, agreement_id),
         readings:meter_readings!meter_readings_submission_fkey(counter_type, previous_value, current_value, rolled_over),
         invoice:invoices!meter_submissions_invoice_fkey(cycles_covered, calculation)`,
      )
      .eq("status", "CONFIRMED")
      .eq("ticket.agreement_id", ticket.agreement_id),
    client.from("meter_baselines").select("counter_type, value, recorded_at").eq("agreement_id", ticket.agreement_id),
  ]);
  if (agreement.error) fail("agreement", agreement.error.message);
  if (machine.error) fail("machine", machine.error.message);
  if (confirmed.error) fail("confirmed readings", confirmed.error.message);
  if (baselines.error) fail("baselines", baselines.error.message);

  // Newest confirmed cycle first.
  const submissions = [...confirmed.data].sort((a, b) => b.ticket.cycle_no - a.ticket.cycle_no);
  const lastConfirmedCycle = submissions[0]?.ticket.cycle_no ?? 0;

  const counterTypes: CounterType[] = ticket.machine_type === "COLOUR" ? ["BW", "COLOUR"] : ["BW"];
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

  // 11.6: issued estimated invoices between the last confirmed reading and this ticket.
  const { data: estimates, error: estimateError } = await client
    .from("invoices")
    .select("invoice_no, subtotal_cents, ticket:billing_cycle_tickets!invoices_ticket_fkey!inner(cycle_no)")
    .eq("agreement_id", ticket.agreement_id)
    .eq("type", "ESTIMATED")
    .not("status", "in", "(DRAFT,REJECTED,CANCELLED)")
    .gt("ticket.cycle_no", lastConfirmedCycle)
    .lt("ticket.cycle_no", ticket.cycle_no);
  if (estimateError) fail("estimated invoices", estimateError.message);
  const estimateCredits: EstimateCredit[] = estimates
    .map((e) => ({ invoiceNo: e.invoice_no, cycleNo: e.ticket.cycle_no, amountCents: e.subtotal_cents }))
    .sort((a, b) => a.cycleNo - b.cycleNo);

  return {
    terms: {
      machineType: ticket.machine_type,
      commitmentCents: ticket.commitment_cents,
      bwIncluded: ticket.bw_included,
      bwRateCents: ticket.bw_rate_cents,
      colourIncluded: ticket.colour_included,
      colourRateCents: ticket.colour_rate_cents,
      cycleLengthDays: ticket.cycle_length_days,
    },
    cyclesCovered: ticket.cycle_no - lastConfirmedCycle,
    counters,
    estimateCredits,
  };
}

/** Usage per cycle of a confirmed submission (from its calculation record when there is one). */
function perCycleUsage(
  s: {
    readings: { counter_type: CounterType; previous_value: number; current_value: number; rolled_over: boolean }[];
    invoice: { cycles_covered: number; calculation: unknown } | null;
  },
  counter: CounterType,
): number | null {
  const cycles = s.invoice?.cycles_covered ?? 1;
  const calc = s.invoice?.calculation as { counters?: { counter_type: string; usage: number }[] } | null | undefined;
  const fromCalc = calc?.counters?.find((c) => c.counter_type === counter)?.usage;
  if (typeof fromCalc === "number") return Math.floor(fromCalc / cycles);
  const r = s.readings.find((x) => x.counter_type === counter);
  // Older rows without a calculation: a rollover cannot be recomputed without the maximum.
  if (!r || r.rolled_over) return null;
  return Math.floor((r.current_value - r.previous_value) / cycles);
}
