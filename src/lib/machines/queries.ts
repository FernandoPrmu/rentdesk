import "server-only";

import { searchTerm } from "@/lib/accounts/queries";
import type { MachineListFilter } from "@/lib/machines/schemas";
import { createClient } from "@/lib/supabase/server";

/**
 * Machine lists and details (MAC-01, MAC-03, MAC-05). They run as the signed-in
 * user, so RLS decides: an owner sees their own machines, a customer only the
 * machines they rent.
 */

const AGREEMENT_SUMMARY =
  "id, status, start_date, end_date, installation_location, customer:customers!rental_agreements_customer_fkey(id, name)";

export async function listMachines(filter: MachineListFilter) {
  const supabase = await createClient();
  let query = supabase
    .from("machines")
    .select(`id, brand, model, serial_no, type, status, agreements:rental_agreements!rental_agreements_machine_fkey(${AGREEMENT_SUMMARY})`)
    .order("brand")
    .order("model")
    .order("serial_no");
  if (filter.type) query = query.eq("type", filter.type);
  if (filter.status) query = query.eq("status", filter.status);
  const term = searchTerm(filter.q);
  if (term) {
    // Quoted, so dots and spaces in the term cannot break the or=(...) syntax.
    const quoted = `"%${term}%"`;
    query = query.or(`brand.ilike.${quoted},model.ilike.${quoted},serial_no.ilike.${quoted}`);
  }
  const { data, error } = await query.limit(500);
  if (error) throw new Error(`machines: ${error.message}`);
  return data.map((m) => ({ ...m, current: m.agreements.find((a) => a.status !== "TERMINATED") ?? null }));
}

export type MachineListRow = Awaited<ReturnType<typeof listMachines>>[number];

export async function getMachine(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("machines")
    .select(
      `id, brand, model, serial_no, type, status, purchase_date, bw_counter_max, colour_counter_max, notes, created_at,
       agreements:rental_agreements!rental_agreements_machine_fkey(${AGREEMENT_SUMMARY}, first_billing_date, terminated_at,
         termination_reason, initial_bw_reading, initial_colour_reading, closing_bw_reading, closing_colour_reading)`,
    )
    .eq("id", id)
    .order("start_date", { referencedTable: "rental_agreements", ascending: false })
    .maybeSingle();
  if (error) throw new Error(`machine: ${error.message}`);
  if (!data) return null;
  return { ...data, current: data.agreements.find((a) => a.status !== "TERMINATED") ?? null };
}

export type MachineDetail = NonNullable<Awaited<ReturnType<typeof getMachine>>>;

/** Machines that can be assigned now (for the assign flow started from a customer). */
export async function listAvailableMachines() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("machines")
    .select("id, brand, model, serial_no, type")
    .eq("status", "AVAILABLE")
    .order("brand")
    .order("serial_no")
    .limit(500);
  if (error) throw new Error(`available machines: ${error.message}`);
  return data;
}

/** Type of a machine the signed-in owner can see (schemas depend on it), or null. */
export async function getMachineType(id: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("machines").select("type").eq("id", id).maybeSingle();
  if (error) throw new Error(`machine type: ${error.message}`);
  return data?.type ?? null;
}
