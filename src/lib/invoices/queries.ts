import "server-only";

import { z } from "zod";

import { isIsoDate } from "@/lib/agreements/cycle-calendar";
import { createClient } from "@/lib/supabase/server";

/**
 * Invoice lists and details (CP-04, CP-05; owner and admin views). Always the
 * signed-in user's client: RLS decides what is visible (an owner their tenant,
 * a customer their own issued invoices, admin all). Drafts and rejected drafts
 * are not invoices yet: they appear only on the review screen.
 */

export const LISTED_STATUSES = ["AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "PARTIALLY_PAID", "OVERDUE", "DISPUTED", "PAID", "CANCELLED"] as const;
export const UNPAID_STATUSES = ["AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "PARTIALLY_PAID", "OVERDUE", "DISPUTED"] as const;

const optionalDate = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v && isIsoDate(v) ? v : undefined));

/** ?status=&customer=&from=&to= (issue date, Colombo days); bad values are ignored. */
export const invoiceFilterSchema = z.object({
  status: z.enum(LISTED_STATUSES).optional().catch(undefined),
  customer: z.uuid().optional().catch(undefined),
  owner: z.uuid().optional().catch(undefined),
  from: optionalDate.catch(undefined),
  to: optionalDate.catch(undefined),
});
export type InvoiceFilter = z.infer<typeof invoiceFilterSchema>;

const LIST_COLUMNS =
  "id, owner_id, invoice_no, type, status, total_cents, amount_paid_cents, due_date, issued_at, period_start, period_end, pdf_status, " +
  "customer:customers!invoices_customer_fkey(id, name, business_name), machine:machines!invoices_machine_fkey(brand, model, serial_no)";

const LIST_LIMIT = 200;

export async function listInvoices(filter: Partial<InvoiceFilter>) {
  const supabase = await createClient();
  let query = supabase.from("invoices").select(LIST_COLUMNS).not("invoice_no", "is", null).in("status", [...LISTED_STATUSES]);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.customer) query = query.eq("customer_id", filter.customer);
  if (filter.owner) query = query.eq("owner_id", filter.owner);
  if (filter.from) query = query.gte("issued_at", `${filter.from}T00:00:00+05:30`);
  if (filter.to) query = query.lte("issued_at", `${filter.to}T23:59:59.999+05:30`);
  const { data, error } = await query.order("issued_at", { ascending: false }).order("invoice_seq", { ascending: false }).limit(LIST_LIMIT);
  if (error) throw new Error(`invoices: ${error.message}`);
  return data as unknown as InvoiceRow[];
}

export interface InvoiceRow {
  id: string;
  owner_id: string;
  invoice_no: string;
  type: "NORMAL" | "ESTIMATED";
  status: string;
  total_cents: number;
  amount_paid_cents: number;
  due_date: string | null;
  issued_at: string | null;
  period_start: string;
  period_end: string;
  pdf_status: "NONE" | "PENDING" | "READY";
  customer: { id: string; name: string; business_name: string | null };
  machine: { brand: string; model: string; serial_no: string };
}

/** Customer Bills: unpaid first (soonest due), then paid and cancelled (newest first). */
export function unpaidFirst(rows: InvoiceRow[]): InvoiceRow[] {
  const unpaid = (r: InvoiceRow) => (UNPAID_STATUSES as readonly string[]).includes(r.status);
  return [...rows].sort((a, b) => {
    if (unpaid(a) !== unpaid(b)) return unpaid(a) ? -1 : 1;
    if (unpaid(a)) return (a.due_date ?? "9999").localeCompare(b.due_date ?? "9999") || a.invoice_no.localeCompare(b.invoice_no);
    return (b.issued_at ?? "").localeCompare(a.issued_at ?? "");
  });
}

export async function getInvoiceDetail(id: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoices")
    .select(
      `${LIST_COLUMNS}, ticket_id, cycles_covered, subtotal_cents, late_fee_cents, credit_applied_cents, cancel_reason, cancelled_at, calculation, pdf_path, ` +
        "ticket:billing_cycle_tickets!invoices_ticket_fkey(cycle_no), lines:invoice_lines(line_type, description, quantity, rate_cents, amount_cents, sort_order)",
    )
    .eq("id", id)
    .not("invoice_no", "is", null)
    .maybeSingle();
  if (error) throw new Error(`invoice: ${error.message}`);
  if (!data) return null;
  const row = data as unknown as InvoiceRow & {
    ticket_id: string;
    cycles_covered: number;
    cancel_reason: string | null;
    cancelled_at: string | null;
    calculation: { partial?: unknown } | null;
    pdf_path: string | null;
    ticket: { cycle_no: number } | null;
    lines: { line_type: string; description: string; quantity: number; rate_cents: number; amount_cents: number; sort_order: number }[];
  };
  return { ...row, lines: [...row.lines].sort((a, b) => a.sort_order - b.sort_order), final: Boolean(row.calculation?.partial) };
}
export type InvoiceDetail = NonNullable<Awaited<ReturnType<typeof getInvoiceDetail>>>;

/** PDF version history (owner and admin; RLS). */
export async function listPdfVersions(invoiceId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("invoice_pdf_versions")
    .select("version, reason, template, byte_size, created_at")
    .eq("invoice_id", invoiceId)
    .order("version", { ascending: false });
  if (error) throw new Error(`pdf versions: ${error.message}`);
  return data;
}

/** Owner filter: the tenant's customers (RLS). */
export async function listInvoiceCustomers() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("customers").select("id, name").order("name").limit(500);
  if (error) throw new Error(`customers: ${error.message}`);
  return data;
}
