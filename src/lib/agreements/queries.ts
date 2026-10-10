import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Agreements, their terms history and what blocks a return (AGR-01..03, MAC-04).
 * Run as the signed-in user: RLS limits owners to their tenant and customers to
 * their own agreements.
 */

const MACHINE = "machine:machines!rental_agreements_machine_fkey(id, brand, model, serial_no, type, status, bw_counter_max, colour_counter_max)";
const CUSTOMER = "customer:customers!rental_agreements_customer_fkey(id, name, business_name)";

export async function getAgreement(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rental_agreements")
    .select(`*, ${MACHINE}, ${CUSTOMER}`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`agreement: ${error.message}`);
  return data;
}

export type AgreementDetail = NonNullable<Awaited<ReturnType<typeof getAgreement>>>;

/** Every terms version, newest first, with who changed it (owner and admin only). */
export async function getTermsHistory(agreementId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("agreement_terms_history")
    .select("*, changer:profiles!agreement_terms_history_changed_by_fkey(full_name, username)")
    .eq("agreement_id", agreementId)
    .order("version", { ascending: false });
  if (error) throw new Error(`terms history: ${error.message}`);
  return data;
}

export type TermsVersion = Awaited<ReturnType<typeof getTermsHistory>>[number];

export const UNPAID_INVOICE_STATUSES = ["AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "PARTIALLY_PAID", "OVERDUE", "DISPUTED"] as const;

export interface ReturnBlocker {
  kind: "ticket";
  id: string;
  label: string;
  status: string;
}

/**
 * RET-01 / rule 4: only a meter reading waiting for the owner's review blocks a
 * return (the final bill must start from confirmed numbers). Unpaid invoices do
 * not. Same rule as app.agreement_return_blockers.
 */
export async function getReturnBlockers(agreementId: string): Promise<ReturnBlocker[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("billing_cycle_tickets")
    .select("id, cycle_no, status, status_before_overdue")
    .eq("agreement_id", agreementId)
    .in("status", ["PENDING_OWNER_REVIEW", "OVERDUE"])
    .order("cycle_no");
  if (error) throw new Error(`blockers: ${error.message}`);
  return data
    .filter((t) => t.status === "PENDING_OWNER_REVIEW" || t.status_before_overdue === "PENDING_OWNER_REVIEW")
    .map((t) => ({ kind: "ticket" as const, id: t.id, label: `Meter reading for cycle ${t.cycle_no}`, status: "PENDING_OWNER_REVIEW" }));
}

/** A customer's agreements, live first (owner portal profile, customer portal). */
export async function listCustomerAgreements(customerId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("rental_agreements")
    .select(
      `id, status, start_date, end_date, first_billing_date, next_cycle_no, next_cycle_date, billing_day,
       installation_location, monthly_commitment_cents, bw_included, bw_rate_cents, colour_included, colour_rate_cents,
       due_days, late_fee_mode, late_fee_cents, terminated_at, ${MACHINE}`,
    )
    .eq("customer_id", customerId)
    .order("status")
    .order("start_date", { ascending: false });
  if (error) throw new Error(`customer agreements: ${error.message}`);
  return data;
}

export type CustomerAgreement = Awaited<ReturnType<typeof listCustomerAgreements>>[number];

/**
 * Latest known counter values (hint on the return form): the initial reading, a
 * confirmed reading or a new baseline, whichever is newest. Same rule as
 * app.last_known_reading, which enforces it.
 */
export async function getLastKnownReadings(agreement: {
  id: string;
  created_at: string;
  initial_bw_reading: number;
  initial_colour_reading: number | null;
}): Promise<{ bw: number; colour: number | null }> {
  const supabase = await createClient();
  const [readings, baselines] = await Promise.all([
    supabase
      .from("meter_readings")
      .select("counter_type, current_value, submission:meter_submissions!inner(status, submitted_at, reviewed_at, ticket:billing_cycle_tickets!inner(agreement_id))")
      .eq("submission.status", "CONFIRMED")
      .eq("submission.ticket.agreement_id", agreement.id),
    supabase.from("meter_baselines").select("counter_type, value, recorded_at").eq("agreement_id", agreement.id),
  ]);
  if (readings.error) throw new Error(`last readings: ${readings.error.message}`);
  if (baselines.error) throw new Error(`last readings: ${baselines.error.message}`);

  const known = [
    { counter: "BW", value: agreement.initial_bw_reading, at: agreement.created_at },
    ...(agreement.initial_colour_reading !== null ? [{ counter: "COLOUR", value: agreement.initial_colour_reading, at: agreement.created_at }] : []),
    ...readings.data.map((r) => ({
      counter: r.counter_type,
      value: r.current_value,
      at: r.submission.reviewed_at ?? r.submission.submitted_at,
    })),
    ...baselines.data.map((b) => ({ counter: b.counter_type, value: b.value, at: b.recorded_at })),
  ];
  const latest = (counter: string) =>
    known
      .filter((k) => k.counter === counter)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]?.value ?? null;
  return { bw: latest("BW") ?? 0, colour: latest("COLOUR") };
}
