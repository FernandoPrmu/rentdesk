import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DepositInvoice } from "@/lib/deposits/settlement";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/db";

/**
 * Security deposits and advance payments (DEP-01..04). Pages read as the signed-in
 * user (RLS: owner = own tenant, customer = own records); server actions pass the
 * service-role client after their own checks.
 */

type Client = SupabaseClient<Database>;

const UNPAID = ["AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "PARTIALLY_PAID", "OVERDUE", "DISPUTED"] as const;
/** Same as app.deposit_deductible_invoices: no slip waiting, not disputed. */
const DEDUCTIBLE = new Set(["AWAITING_PAYMENT", "PARTIALLY_PAID", "OVERDUE"]);

export interface DepositInvoiceRow extends DepositInvoice {
  status: string;
  dueDate: string | null;
  totalCents: number;
}

export interface DepositState {
  heldCents: number;
  receivedCents: number;
  transactions: Database["public"]["Tables"]["deposit_transactions"]["Row"][];
  /** The agreement's unpaid invoices, oldest due first (the order deductions pay them). */
  invoices: DepositInvoiceRow[];
}

export async function getDepositState(client: Client, agreementId: string): Promise<DepositState> {
  const [ledger, invoices] = await Promise.all([
    client.from("deposit_transactions").select("*").eq("agreement_id", agreementId).order("created_at"),
    client
      .from("invoices")
      .select("id, invoice_no, status, total_cents, amount_paid_cents, due_date, invoice_seq")
      .eq("agreement_id", agreementId)
      .in("status", [...UNPAID])
      .order("due_date", { nullsFirst: false })
      .order("invoice_seq", { nullsFirst: false }),
  ]);
  if (ledger.error) throw new Error(`deposit: ${ledger.error.message}`);
  if (invoices.error) throw new Error(`deposit invoices: ${invoices.error.message}`);
  const received = ledger.data.filter((t) => t.kind === "RECEIVED").reduce((s, t) => s + t.amount_cents, 0);
  const out = ledger.data.filter((t) => t.kind !== "RECEIVED").reduce((s, t) => s + t.amount_cents, 0);
  return {
    heldCents: received - out,
    receivedCents: received,
    transactions: ledger.data,
    invoices: invoices.data
      .map((i) => ({
        id: i.id,
        invoiceNo: i.invoice_no,
        status: i.status,
        dueDate: i.due_date,
        totalCents: i.total_cents,
        balanceCents: i.total_cents - i.amount_paid_cents,
        deductible: DEDUCTIBLE.has(i.status),
      }))
      .filter((i) => i.balanceCents > 0),
  };
}

/** Deposit held per agreement (agreement cards: owner profile, customer Machines tab). */
export async function getDepositsHeld(agreementIds: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (agreementIds.length === 0) return out;
  const supabase = await createClient();
  const { data, error } = await supabase.from("agreement_deposit_balances").select("agreement_id, held_cents").in("agreement_id", agreementIds);
  if (error) throw new Error(`deposits held: ${error.message}`);
  for (const row of data) if (row.agreement_id && row.held_cents) out.set(row.agreement_id, row.held_cents);
  return out;
}

export interface DepositToSettle {
  agreementId: string;
  heldCents: number;
  customer: { id: string; name: string };
  machine: { brand: string; model: string; serial_no: string };
  terminatedAt: string | null;
}

/** Returned agreements whose deposit is still held: "Deposits to settle" (client decision 2). */
export async function listDepositsToSettle(customerId?: string): Promise<DepositToSettle[]> {
  const supabase = await createClient();
  let balances = supabase.from("agreement_deposit_balances").select("agreement_id, held_cents").gt("held_cents", 0);
  if (customerId) balances = balances.eq("customer_id", customerId);
  const { data: held, error } = await balances;
  if (error) throw new Error(`deposits to settle: ${error.message}`);
  const ids = held.map((h) => h.agreement_id).filter((id): id is string => id !== null);
  if (ids.length === 0) return [];
  const { data: agreements, error: agreementsError } = await supabase
    .from("rental_agreements")
    .select(
      "id, terminated_at, customer:customers!rental_agreements_customer_fkey(id, name), machine:machines!rental_agreements_machine_fkey(brand, model, serial_no)",
    )
    .in("id", ids)
    .eq("status", "TERMINATED")
    .order("terminated_at", { ascending: false });
  if (agreementsError) throw new Error(`deposits to settle: ${agreementsError.message}`);
  return agreements.map((a) => ({
    agreementId: a.id,
    heldCents: held.find((h) => h.agreement_id === a.id)?.held_cents ?? 0,
    customer: a.customer,
    machine: a.machine,
    terminatedAt: a.terminated_at,
  }));
}

/** Advance payments received with an agreement (DEP-02) and what is left of them. */
export async function getAdvances(agreementId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("credits")
    .select("id, amount_cents, status, received_on, method, reference, reason, created_at")
    .eq("agreement_id", agreementId)
    .eq("kind", "ADVANCE")
    .order("created_at");
  if (error) throw new Error(`advances: ${error.message}`);
  return data;
}
