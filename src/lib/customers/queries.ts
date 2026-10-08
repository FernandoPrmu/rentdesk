import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * Customer profile data for the owner portal (CUS-04, CUS-05). Runs as the
 * signed-in owner, so RLS limits everything to their own tenant.
 */

export interface Balance {
  outstandingCents: number;
  unpaidInvoices: number;
}

/**
 * Outstanding balance per customer: issued, unpaid invoices minus what was paid
 * (view customer_balances). Credits are not netted yet (PAY-12).
 */
export async function getCustomerBalances(customerId?: string): Promise<Map<string, Balance>> {
  const supabase = await createClient();
  let query = supabase.from("customer_balances").select("customer_id, outstanding_cents, unpaid_invoices");
  if (customerId) query = query.eq("customer_id", customerId);
  const { data, error } = await query;
  if (error) throw new Error(`balances: ${error.message}`);
  const out = new Map<string, Balance>();
  for (const row of data) {
    if (row.customer_id) {
      out.set(row.customer_id, { outstandingCents: row.outstanding_cents ?? 0, unpaidInvoices: row.unpaid_invoices ?? 0 });
    }
  }
  return out;
}

/** Most recent billing tickets and invoices of a customer (profile sections). */
export async function getCustomerBilling(customerId: string) {
  const supabase = await createClient();
  const [tickets, invoices] = await Promise.all([
    supabase
      .from("billing_cycle_tickets")
      .select("id, cycle_no, cycle_date, status, machine:machines!billing_cycle_tickets_machine_fkey(brand, model, serial_no)")
      .eq("customer_id", customerId)
      .order("cycle_date", { ascending: false })
      .limit(10),
    supabase
      .from("invoices")
      .select("id, invoice_no, status, total_cents, amount_paid_cents, due_date, created_at")
      .eq("customer_id", customerId)
      .neq("status", "DRAFT")
      .order("created_at", { ascending: false })
      .limit(10),
  ]);
  if (tickets.error) throw new Error(`customer tickets: ${tickets.error.message}`);
  if (invoices.error) throw new Error(`customer invoices: ${invoices.error.message}`);
  return { tickets: tickets.data, invoices: invoices.data };
}
