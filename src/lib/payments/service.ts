import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { type ActionResult, fail, fieldErrorsFrom, ok } from "@/lib/action-result";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import type { CurrentUser } from "@/lib/auth/current-user";
import { loadAvailableCredits } from "@/lib/billing/context";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { formatRupees, rupeesToCents } from "@/lib/money";
import { customer as customerRecipient, notificationsFor } from "@/lib/notifications/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { PLATFORM_DEFAULTS, slipReviewDeadline, type StageSettings } from "@/lib/tickets/deadlines";
import { canPerform, type TicketStatus } from "@/lib/tickets/states";
import {
  acceptPayment,
  type Actor,
  recordPayment,
  reallocatePayment,
  rejectPayment,
  reversePayment,
  RpcError,
  submitSlip,
  type TicketSnapshot,
  TransitionError,
} from "@/lib/tickets/transitions";
import type { Database } from "@/types/db";

import { type AgeingReport, ageingReport } from "./ageing";
import { type AllocatableInvoice, planAllocation } from "./allocation";
import { renderReceiptPdfNow } from "./receipt-pdf/server";
import {
  customerPaymentSchema,
  type CustomerPaymentInput,
  manualPaymentSchema,
  type ManualPaymentInput,
  reallocateSchema,
  refundSchema,
  type RefundInput,
  reverseSchema,
  verifySchema,
  type VerifyInput,
} from "./schemas";
import { checkSlipFile, SLIP_EXTENSION } from "./slip-check";

/**
 * Payments (PAY-02..12, TKT-10, CP-04; decisions 39-46): the customer's slip for
 * one or more bills, the owner's check, payments recorded by the owner, reversal,
 * moving a payment to other bills, credit refunds. Every change goes through a
 * transition function and its atomic rpc (which checks it all again); this module
 * loads what they need with the service role and checks ownership first, so
 * another tenant's payment looks exactly like a missing one.
 */

type Admin = SupabaseClient<Database>;

export const SLIP_BUCKET = "payment-slips";

const UNPAID = ["AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "PARTIALLY_PAID", "OVERDUE", "DISPUTED"] as const;

function failure(error: unknown, context: string): { ok: false; error: string } {
  if (error instanceof TransitionError) return fail(error.message.replace(/^[^:]+: /, ""));
  if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, context));
  console.error(`[${context}]`, error);
  return fail("Something went wrong. Please try again.");
}

const actorOf = (user: CurrentUser): Actor => ({ kind: "USER", id: user.id, role: user.role });

async function settingsFor(admin: Admin, ownerId: string): Promise<StageSettings> {
  const { data, error } = await admin.from("owner_settings_effective").select("*").eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error(`settings: ${error.message}`);
  return data ? ({ ...PLATFORM_DEFAULTS, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null)) } as StageSettings) : PLATFORM_DEFAULTS;
}

// -----------------------------------------------------------------------------
// Bills and their tickets
// -----------------------------------------------------------------------------

export interface Bill {
  id: string;
  invoiceNo: string;
  ownerId: string;
  customerId: string;
  customerName: string;
  status: string;
  dueDate: string | null;
  seq: number | null;
  totalCents: number;
  paidCents: number;
  balanceCents: number;
  machine: string;
  periodStart: string;
  periodEnd: string;
  ticket: TicketSnapshot & { current_invoice_id: string | null };
}

const BILL_COLUMNS =
  "id, invoice_no, owner_id, customer_id, status, due_date, invoice_seq, total_cents, amount_paid_cents, period_start, period_end, " +
  "machine:machines!invoices_machine_fkey(brand, model), customer:customers!invoices_customer_fkey(name), " +
  "ticket:billing_cycle_tickets!invoices_ticket_fkey(id, owner_id, customer_id, cycle_no, status, status_before_overdue, current_invoice_id)";

interface BillRow {
  id: string;
  invoice_no: string | null;
  owner_id: string;
  customer_id: string;
  status: string;
  due_date: string | null;
  invoice_seq: number | null;
  total_cents: number;
  amount_paid_cents: number;
  period_start: string;
  period_end: string;
  machine: { brand: string; model: string };
  customer: { name: string };
  ticket: { id: string; owner_id: string; customer_id: string; cycle_no: number; status: string; status_before_overdue: string | null; current_invoice_id: string | null };
}

function toBill(r: BillRow): Bill {
  const machine = `${r.machine.brand} ${r.machine.model}`;
  return {
    id: r.id,
    invoiceNo: r.invoice_no ?? "",
    ownerId: r.owner_id,
    customerId: r.customer_id,
    customerName: r.customer.name,
    status: r.status,
    dueDate: r.due_date,
    seq: r.invoice_seq,
    totalCents: r.total_cents,
    paidCents: r.amount_paid_cents,
    balanceCents: r.total_cents - r.amount_paid_cents,
    machine,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    ticket: {
      id: r.ticket.id,
      owner_id: r.ticket.owner_id,
      customer_id: r.ticket.customer_id,
      cycle_no: r.ticket.cycle_no,
      status: r.ticket.status as TicketStatus,
      status_before_overdue: r.ticket.status_before_overdue as TicketStatus | null,
      current_invoice_id: r.ticket.current_invoice_id,
      machine_name: machine,
      customer_name: r.customer.name,
    },
  };
}

async function loadBills(admin: Admin, filter: { ids?: string[]; customerId?: string; unpaidOnly?: boolean }): Promise<Bill[]> {
  let query = admin.from("invoices").select(BILL_COLUMNS).not("invoice_no", "is", null);
  if (filter.ids) query = query.in("id", filter.ids.length > 0 ? filter.ids : ["00000000-0000-0000-0000-000000000000"]);
  if (filter.customerId) query = query.eq("customer_id", filter.customerId);
  if (filter.unpaidOnly) query = query.in("status", [...UNPAID]);
  const { data, error } = await query.order("due_date", { nullsFirst: false }).order("invoice_seq");
  if (error) throw new Error(`bills: ${error.message}`);
  return (data as unknown as BillRow[]).map(toBill);
}

/** A bill the customer can pay now (same rule as app.assert_payable). */
export function isPayable(b: Bill): boolean {
  return (
    ["AWAITING_PAYMENT", "PARTIALLY_PAID", "OVERDUE"].includes(b.status) &&
    b.balanceCents > 0 &&
    b.ticket.current_invoice_id === b.id &&
    canPerform("submitSlip", "CUSTOMER", { status: b.ticket.status, statusBeforeOverdue: b.ticket.status_before_overdue })
  );
}

const allocatable = (b: Bill): AllocatableInvoice => ({ id: b.id, invoiceNo: b.invoiceNo, dueDate: b.dueDate, seq: b.seq, balanceCents: b.balanceCents });

export interface PayableBill {
  id: string;
  invoiceNo: string;
  machine: string;
  dueDate: string | null;
  seq: number | null;
  balanceCents: number;
  totalCents: number;
  overdue: boolean;
}

const payableView = (b: Bill, today: string): PayableBill => ({
  id: b.id,
  invoiceNo: b.invoiceNo,
  machine: b.machine,
  dueDate: b.dueDate,
  seq: b.seq,
  balanceCents: b.balanceCents,
  totalCents: b.totalCents,
  overdue: b.dueDate !== null && b.dueDate < today,
});

// -----------------------------------------------------------------------------
// Customer: pay (CP-04, PAY-02..04, PAY-11)
// -----------------------------------------------------------------------------

export interface PayView {
  ownerId: string;
  customerId: string;
  today: string;
  bills: PayableBill[];
  /** Bills whose slip is waiting for the owner's check. */
  waiting: { invoiceNo: string; balanceCents: number }[];
  /** Bills that cannot be paid now (disputed). */
  blocked: { invoiceNo: string; reason: string }[];
  preselected: string[];
  bank: { name: string; branch: string | null; accountName: string | null; accountNo: string | null } | null;
  instructions: string | null;
  companyName: string;
}

export async function getPayView(user: CurrentUser, preselect: string[]): Promise<PayView> {
  const admin = createAdminClient();
  const ownerId = user.owner_id!;
  const today = todayInColombo();
  const [bills, profile] = await Promise.all([
    loadBills(admin, { customerId: user.id, unpaidOnly: true }),
    admin.from("owner_company_profiles").select("company_name, bank_name, bank_branch, bank_account_name, bank_account_no, payment_instructions").eq("owner_id", ownerId).maybeSingle(),
  ]);
  const payable = bills.filter(isPayable);
  const p = profile.data;
  return {
    ownerId,
    customerId: user.id,
    today,
    bills: payable.map((b) => payableView(b, today)),
    waiting: bills.filter((b) => b.status === "PAYMENT_SUBMITTED").map((b) => ({ invoiceNo: b.invoiceNo, balanceCents: b.balanceCents })),
    blocked: bills.filter((b) => b.status === "DISPUTED").map((b) => ({ invoiceNo: b.invoiceNo, reason: "Disputed: it can be paid once your rental company answers." })),
    preselected: preselect.filter((id) => payable.some((b) => b.id === id)),
    bank: p?.bank_name ? { name: p.bank_name, branch: p.bank_branch, accountName: p.bank_account_name, accountNo: p.bank_account_no } : null,
    instructions: p?.payment_instructions ?? null,
    companyName: p?.company_name ?? "your rental company",
  };
}

export interface DuplicateWarning {
  reasons: string[];
  /** The earlier payment was the same customer's (then we can say when). */
  own: boolean;
  date: string | null;
  status: string;
}

export type SubmitResult = { paymentId: string; replayed: boolean } | { needsConfirm: true; duplicate: DuplicateWarning };

export async function submitCustomerPayment(user: CurrentUser, input: CustomerPaymentInput): Promise<ActionResult<SubmitResult>> {
  const today = todayInColombo();
  const parsed = customerPaymentSchema(today).safeParse(input);
  if (!parsed.success) return fail("Please check the form.", fieldErrorsFrom(parsed.error.issues));
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    // A retry of a payment that already went through returns it (idempotency key).
    const { data: earlier } = await admin.from("payments").select("id, customer_id").eq("idempotency_key", i.idempotencyKey).maybeSingle();
    if (earlier) return earlier.customer_id === user.id ? ok({ paymentId: earlier.id, replayed: true }) : fail("Please reload the page and try again.");

    const bills = await loadBills(admin, { ids: i.invoiceIds });
    if (bills.length !== i.invoiceIds.length || bills.some((b) => b.customerId !== user.id)) return fail("A bill was not found. Please reload the page.");
    const notPayable = bills.find((b) => !isPayable(b));
    if (notPayable) {
      return fail(notPayable.status === "PAYMENT_SUBMITTED" ? `A slip for ${notPayable.invoiceNo} is already waiting for a check.` : `${notPayable.invoiceNo} cannot be paid right now.`);
    }
    const ownerId = bills[0].ownerId;

    // The slip: in the customer's folder, then checked on the bytes that arrived (decision 41).
    const folder = new RegExp(`^${ownerId}/${user.id}/[0-9a-f-]{36}\\.(jpg|png|pdf)$`);
    if (!folder.test(i.slipPath)) return fail("The slip upload did not work. Please add it again.", { slip: "Please add the slip again." });
    const { data: file, error: downloadError } = await admin.storage.from(SLIP_BUCKET).download(i.slipPath);
    if (downloadError || !file) return fail("The slip did not arrive. Please add it again.", { slip: "Please add the slip again." });
    const checked = await checkSlipFile(new Uint8Array(await file.arrayBuffer()));
    if (!checked.ok || !i.slipPath.endsWith(`.${SLIP_EXTENSION[checked.mimeType]}`)) {
      await admin.storage.from(SLIP_BUCKET).remove([i.slipPath]);
      const message = checked.ok ? "The file type does not match its name. Please add it again." : checked.error;
      return fail(message, { slip: message });
    }

    // PAY-11: warn first; the customer may still send it (the owner sees the flag).
    if (!i.confirmDuplicate) {
      const { data: dup, error: dupError } = await admin.rpc("rpc_payment_duplicates", {
        p_owner_id: ownerId,
        p_sha256: checked.sha256,
        p_original_sha256: i.originalSha256 ?? undefined,
        p_reference: i.reference ?? undefined,
        p_amount_cents: i.amount,
      } as never);
      if (dupError) throw new Error(`duplicates: ${dupError.message}`);
      const d = dup as { customer_id: string; submitted_at: string; status: string; reasons: string[] } | null;
      if (d) {
        const own = d.customer_id === user.id;
        return ok({ needsConfirm: true, duplicate: { reasons: d.reasons, own, date: own ? d.submitted_at : null, status: own ? d.status : "" } });
      }
    }

    const settings = await settingsFor(admin, ownerId);
    const result = await submitSlip(supabaseRpc(admin), actorOf(user), bills.map((b) => b.ticket), {
      idempotencyKey: i.idempotencyKey,
      invoiceIds: i.invoiceIds,
      payment: { amountCents: i.amount, paidOn: i.paidOn, method: i.method, reference: i.reference ?? undefined, note: i.note ?? undefined },
      slip: { storagePath: i.slipPath, sha256: checked.sha256, originalSha256: i.originalSha256, mimeType: checked.mimeType, sizeBytes: checked.sizeBytes },
      stageDueAt: slipReviewDeadline(new Date(), settings),
      context: { customerName: bills[0].customerName, invoiceNos: bills.map((b) => b.invoiceNo) },
    });
    return ok({ paymentId: result.payment_id, replayed: result.replayed });
  } catch (error) {
    return failure(error, "payment submit");
  }
}

// -----------------------------------------------------------------------------
// Lists and details (PAY-08, CP-05): the signed-in user's client, so RLS decides
// -----------------------------------------------------------------------------

export type PaymentStatus = "SUBMITTED" | "ACCEPTED" | "PARTIAL" | "REJECTED" | "REVERSED";

export interface PaymentRow {
  id: string;
  status: PaymentStatus;
  source: "CUSTOMER_SLIP" | "OWNER_MANUAL";
  method: string;
  amount_cents: number;
  accepted_amount_cents: number | null;
  credit_cents: number;
  paid_on: string;
  reference: string | null;
  submitted_at: string;
  verified_at: string | null;
  duplicate_of_payment_id: string | null;
  duplicate_reasons: string[];
  customer: { id: string; name: string; business_name: string | null };
  allocations: { invoice_id: string; planned_cents: number; applied_cents: number; balance_after_cents: number | null; released_at: string | null; invoice: { invoice_no: string | null } }[];
  receipts: { id: string; receipt_no: string; status: string; pdf_path: string | null; pdf_status: string }[];
}

const PAYMENT_COLUMNS =
  "id, status, source, method, amount_cents, accepted_amount_cents, credit_cents, paid_on, reference, submitted_at, verified_at, duplicate_of_payment_id, duplicate_reasons, " +
  "customer:customers!payments_customer_fkey(id, name, business_name), " +
  "allocations:payment_allocations!payment_allocations_payment_fkey(invoice_id, planned_cents, applied_cents, balance_after_cents, released_at, invoice:invoices!payment_allocations_invoice_fkey(invoice_no)), " +
  "receipts:receipts!receipts_payment_fkey(id, receipt_no, status, pdf_path, pdf_status)";

export const PAYMENT_FILTERS = ["TO_VERIFY", "ALL", "ACCEPTED", "PARTIAL", "REJECTED", "REVERSED"] as const;
export type PaymentFilter = (typeof PAYMENT_FILTERS)[number];

/** Payments the signed-in user may see (owner: tenant; customer: own), newest first. */
export async function listPayments(client: Admin, filter: { status?: PaymentFilter; customerId?: string; invoiceId?: string; limit?: number } = {}) {
  let query = client.from("payments").select(PAYMENT_COLUMNS);
  if (filter.status === "TO_VERIFY") query = query.eq("status", "SUBMITTED");
  else if (filter.status && filter.status !== "ALL") query = query.eq("status", filter.status);
  if (filter.customerId) query = query.eq("customer_id", filter.customerId);
  if (filter.invoiceId) {
    const { data: ids, error } = await client.from("payment_allocations").select("payment_id").eq("invoice_id", filter.invoiceId);
    if (error) throw new Error(`invoice payments: ${error.message}`);
    query = query.in("id", ids.length > 0 ? [...new Set(ids.map((r) => r.payment_id))] : ["00000000-0000-0000-0000-000000000000"]);
  }
  const ascending = filter.status === "TO_VERIFY";
  const { data, error } = await query.order("submitted_at", { ascending }).limit(filter.limit ?? 200);
  if (error) throw new Error(`payments: ${error.message}`);
  return data as unknown as PaymentRow[];
}

export async function countPaymentsToVerify(client: Admin): Promise<number> {
  const { count, error } = await client.from("payments").select("id", { count: "exact", head: true }).eq("status", "SUBMITTED");
  if (error) throw new Error(`payments to verify: ${error.message}`);
  return count ?? 0;
}

/** Bills a payment is on now (not the released ones of an earlier allocation). */
export const activeAllocations = (p: Pick<PaymentRow, "allocations">) => p.allocations.filter((a) => a.released_at === null);

export interface PaymentDetail extends PaymentRow {
  note: string | null;
  reject_reason: string | null;
  reverse_reason: string | null;
  reversed_at: string | null;
  slips: { storage_path: string; mime_type: string; size_bytes: number }[];
  /** A 5-minute link to the slip (signed with the viewer's own client: storage RLS decides). */
  slipUrl: string | null;
  slipMime: string | null;
  duplicateOf: { id: string; submitted_at: string; status: string; amount_cents: number; reference: string | null; customer: string } | null;
  receiptVersions: { version: number; reason: string; created_at: string }[];
  credits: { id: string; kind: string; status: string; amount_cents: number }[];
}

export async function getPaymentDetail(client: Admin, id: string): Promise<PaymentDetail | null> {
  const { data, error } = await client
    .from("payments")
    .select(
      `${PAYMENT_COLUMNS}, note, reject_reason, reverse_reason, reversed_at, slips:payment_slips!payment_slips_payment_fkey(storage_path, mime_type, size_bytes)`,
    )
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`payment: ${error.message}`);
  if (!data) return null;
  const p = data as unknown as PaymentDetail;
  const slip = p.slips[0] ?? null;
  const [signed, dup, versions, credits] = await Promise.all([
    slip ? client.storage.from(SLIP_BUCKET).createSignedUrl(slip.storage_path, 5 * 60) : null,
    p.duplicate_of_payment_id
      ? client.from("payments").select("id, submitted_at, status, amount_cents, reference, customer:customers!payments_customer_fkey(name)").eq("id", p.duplicate_of_payment_id).maybeSingle()
      : null,
    p.receipts[0] ? client.from("receipt_pdf_versions").select("version, reason, created_at").eq("receipt_id", p.receipts[0].id).order("version", { ascending: false }) : null,
    client.from("credits").select("id, kind, status, amount_cents").eq("source_payment_id", id),
  ]);
  const d = dup?.data as { id: string; submitted_at: string; status: string; amount_cents: number; reference: string | null; customer: { name: string } } | null | undefined;
  return {
    ...p,
    slipUrl: signed?.data?.signedUrl ?? null,
    slipMime: slip?.mime_type ?? null,
    duplicateOf: d ? { id: d.id, submitted_at: d.submitted_at, status: d.status, amount_cents: d.amount_cents, reference: d.reference, customer: d.customer.name } : null,
    receiptVersions: versions?.data ?? [],
    credits: credits.data ?? [],
  };
}

// -----------------------------------------------------------------------------
// Owner: check a slip (PAY-05, PAY-06)
// -----------------------------------------------------------------------------

/** The owner's view of a payment's bills: what each owes now and what is left after the split. */
export async function getVerifyContext(owner: CurrentUser, paymentId: string) {
  const admin = createAdminClient();
  const { data: payment } = await admin.from("payments").select("id, owner_id, customer_id, amount_cents, status").eq("id", paymentId).maybeSingle();
  if (!payment || payment.owner_id !== owner.id) return null;
  const { data: allocs } = await admin.from("payment_allocations").select("invoice_id").eq("payment_id", paymentId).is("released_at", null);
  const bills = await loadBills(admin, { ids: (allocs ?? []).map((a) => a.invoice_id) });
  return { payment, bills };
}

export async function verifySlip(owner: CurrentUser, input: VerifyInput): Promise<ActionResult<{ status: string; receiptNo: string | null }>> {
  const parsed = verifySchema.safeParse(input);
  if (!parsed.success) return fail("Please check the form.", fieldErrorsFrom(parsed.error.issues));
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const ctx = await getVerifyContext(owner, i.paymentId);
    if (!ctx) return fail("This payment was not found.");
    if (ctx.payment.status !== "SUBMITTED") return fail("This payment has already been checked.");
    const rpc = supabaseRpc(admin);
    const actor = actorOf(owner);
    const tickets = ctx.bills.map((b) => b.ticket);
    const invoiceNos = ctx.bills.map((b) => b.invoiceNo);
    if (i.decision === "REJECT") {
      await rejectPayment(rpc, actor, tickets, { paymentId: i.paymentId, reason: i.reason, amountCents: ctx.payment.amount_cents });
      return ok({ status: "REJECTED", receiptNo: null });
    }
    let accepted = ctx.payment.amount_cents;
    if (i.amount.trim() !== "") {
      const cents = rupeesToCents(i.amount);
      if (cents === null || cents <= 0) return fail("Enter the amount received in rupees.", { amount: "Enter an amount in rupees, like 2,500." });
      if (cents > ctx.payment.amount_cents) {
        return fail(`The amount received cannot be more than the slip (${formatRupees(ctx.payment.amount_cents)}).`, { amount: "Not more than the slip amount." });
      }
      accepted = cents;
    }
    const plan = planAllocation(accepted, ctx.bills.map(allocatable));
    const balanceCents = plan.allocations.reduce((sum, a) => sum + a.balanceAfterCents, 0) + plan.leftOut.reduce((sum, id) => sum + (ctx.bills.find((b) => b.id === id)?.balanceCents ?? 0), 0);
    const result = await acceptPayment(rpc, actor, tickets, {
      paymentId: i.paymentId,
      acceptedAmountCents: accepted,
      outcome: { balanceCents, creditCents: plan.creditCents },
      context: { invoiceNos },
    });
    await renderReceiptPdfNow(result.receipt_id);
    return ok({ status: result.status, receiptNo: result.receipt_no });
  } catch (error) {
    return failure(error, "payment verify");
  }
}

// -----------------------------------------------------------------------------
// Owner: record a payment without a slip (PAY-07; 11.5 advance)
// -----------------------------------------------------------------------------

export interface RecordView {
  customers: { id: string; name: string; business_name: string | null }[];
  customer: { id: string; name: string } | null;
  bills: PayableBill[];
  today: string;
}

export async function getRecordView(owner: CurrentUser, customerId: string | null): Promise<RecordView> {
  const admin = createAdminClient();
  const today = todayInColombo();
  const { data: customers, error } = await admin.from("customers").select("id, name, business_name").eq("owner_id", owner.id).order("name");
  if (error) throw new Error(`customers: ${error.message}`);
  const chosen = customers.find((c) => c.id === customerId) ?? null;
  const bills = chosen ? (await loadBills(admin, { customerId: chosen.id, unpaidOnly: true })).filter(isPayable) : [];
  return { customers, customer: chosen ? { id: chosen.id, name: chosen.name } : null, bills: bills.map((b) => payableView(b, today)), today };
}

export async function recordManualPayment(owner: CurrentUser, input: ManualPaymentInput): Promise<ActionResult<{ paymentId: string; receiptNo: string; replayed: boolean }>> {
  const parsed = manualPaymentSchema(todayInColombo()).safeParse(input);
  if (!parsed.success) return fail("Please check the form.", fieldErrorsFrom(parsed.error.issues));
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const { data: cu } = await admin.from("customers").select("id, owner_id, name").eq("id", i.customerId).maybeSingle();
    if (!cu || cu.owner_id !== owner.id) return fail("This customer was not found.");
    const bills = await loadBills(admin, { ids: i.invoiceIds });
    if (bills.length !== i.invoiceIds.length || bills.some((b) => b.customerId !== cu.id)) return fail("A bill was not found. Please reload the page.");
    const plan = planAllocation(i.amount, bills.map(allocatable));
    const result = await recordPayment(supabaseRpc(admin), actorOf(owner), bills.map((b) => b.ticket), {
      customerId: cu.id,
      idempotencyKey: i.idempotencyKey,
      invoiceIds: i.invoiceIds,
      payment: { amountCents: i.amount, paidOn: i.paidOn, method: i.method, reference: i.reference ?? undefined, note: i.note ?? undefined },
      outcome: { creditCents: plan.creditCents },
      context: { invoiceNos: plan.allocations.map((a) => a.invoiceNo) },
    });
    await renderReceiptPdfNow(result.receipt_id);
    return ok({ paymentId: result.payment_id, receiptNo: result.receipt_no, replayed: result.replayed });
  } catch (error) {
    return failure(error, "payment record");
  }
}

// -----------------------------------------------------------------------------
// Owner: reverse or move an accepted payment (TKT-10, 11.5)
// -----------------------------------------------------------------------------

async function ownedAccepted(admin: Admin, owner: CurrentUser, paymentId: string) {
  const { data: p } = await admin
    .from("payments")
    .select("id, owner_id, customer_id, status, method, accepted_amount_cents, amount_cents")
    .eq("id", paymentId)
    .maybeSingle();
  if (!p || p.owner_id !== owner.id) return null;
  const { data: allocs } = await admin.from("payment_allocations").select("invoice_id, applied_cents").eq("payment_id", paymentId).is("released_at", null);
  return { payment: p, current: (allocs ?? []).filter((a) => a.applied_cents > 0).map((a) => a.invoice_id) };
}

export async function reverseOwnerPayment(owner: CurrentUser, input: { paymentId: string; reason: string }): Promise<ActionResult> {
  const parsed = reverseSchema.safeParse(input);
  if (!parsed.success) return fail("Please give a reason.", fieldErrorsFrom(parsed.error.issues));
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const found = await ownedAccepted(admin, owner, i.paymentId);
    if (!found) return fail("This payment was not found.");
    const bills = await loadBills(admin, { ids: found.current });
    await reversePayment(supabaseRpc(admin), actorOf(owner), bills.map((b) => b.ticket), {
      paymentId: i.paymentId,
      customerId: found.payment.customer_id,
      reason: i.reason,
      amountCents: found.payment.accepted_amount_cents ?? found.payment.amount_cents,
      context: { invoiceNos: bills.map((b) => b.invoiceNo) },
    });
    const { data: receipt } = await admin.from("receipts").select("id").eq("payment_id", i.paymentId).maybeSingle();
    await renderReceiptPdfNow(receipt?.id);
    return ok(undefined);
  } catch (error) {
    return failure(error, "payment reverse");
  }
}

/** Bills a payment can be moved to: the customer's payable bills and the ones it is on now. */
export async function getReallocateOptions(owner: CurrentUser, paymentId: string): Promise<{ bills: PayableBill[]; current: string[] } | null> {
  const admin = createAdminClient();
  const found = await ownedAccepted(admin, owner, paymentId);
  if (!found) return null;
  const today = todayInColombo();
  const [open, current] = await Promise.all([
    loadBills(admin, { customerId: found.payment.customer_id, unpaidOnly: true }),
    loadBills(admin, { ids: found.current }),
  ]);
  const byId = new Map<string, Bill>();
  for (const b of [...current, ...open.filter(isPayable)]) byId.set(b.id, b);
  return { bills: [...byId.values()].map((b) => payableView(b, today)), current: found.current };
}

export async function reallocateOwnerPayment(owner: CurrentUser, input: { paymentId: string; invoiceIds: string[]; reason: string }): Promise<ActionResult> {
  const parsed = reallocateSchema.safeParse(input);
  if (!parsed.success) return fail("Please check the form.", fieldErrorsFrom(parsed.error.issues));
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const found = await ownedAccepted(admin, owner, i.paymentId);
    if (!found) return fail("This payment was not found.");
    const bills = await loadBills(admin, { ids: [...new Set([...found.current, ...i.invoiceIds])] });
    if (bills.some((b) => b.customerId !== found.payment.customer_id)) return fail("A bill was not found. Please reload the page.");
    await reallocatePayment(supabaseRpc(admin), actorOf(owner), bills.map((b) => b.ticket), {
      paymentId: i.paymentId,
      customerId: found.payment.customer_id,
      invoiceIds: i.invoiceIds,
      reason: i.reason,
      amountCents: found.payment.accepted_amount_cents ?? found.payment.amount_cents,
      context: { invoiceNos: bills.filter((b) => i.invoiceIds.includes(b.id)).map((b) => b.invoiceNo) },
    });
    const { data: receipt } = await admin.from("receipts").select("id").eq("payment_id", i.paymentId).maybeSingle();
    await renderReceiptPdfNow(receipt?.id);
    return ok(undefined);
  } catch (error) {
    return failure(error, "payment reallocate");
  }
}

// -----------------------------------------------------------------------------
// Credits and refunds (PAY-12)
// -----------------------------------------------------------------------------

export interface CreditView {
  id: string;
  kind: string;
  status: string;
  reason: string;
  amountCents: number;
  refundedCents: number;
  /** Free to refund or use now (not used by an invoice, not reserved by a draft). */
  availableCents: number;
  createdAt: string;
  refunds: { amount_cents: number; refunded_on: string; method: string; reference: string | null }[];
}

export async function listCustomerCredits(owner: CurrentUser, customerId: string): Promise<CreditView[]> {
  const admin = createAdminClient();
  const { data: cu } = await admin.from("customers").select("owner_id").eq("id", customerId).maybeSingle();
  if (!cu || cu.owner_id !== owner.id) return [];
  const [{ data, error }, available] = await Promise.all([
    admin
      .from("credits")
      .select("id, kind, status, reason, amount_cents, refunded_cents, created_at, refunds:credit_refunds!credit_refunds_credit_fkey(amount_cents, refunded_on, method, reference)")
      .eq("customer_id", customerId)
      .neq("status", "VOID")
      .order("created_at", { ascending: false }),
    loadAvailableCredits(admin, customerId),
  ]);
  if (error) throw new Error(`credits: ${error.message}`);
  const free = new Map(available.map((c) => [c.id, c.amountCents]));
  return data.map((c) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    reason: c.reason,
    amountCents: c.amount_cents,
    refundedCents: c.refunded_cents,
    availableCents: free.get(c.id) ?? 0,
    createdAt: c.created_at,
    refunds: c.refunds,
  }));
}

export async function refundCredit(owner: CurrentUser, input: RefundInput): Promise<ActionResult<{ leftCents: number }>> {
  const parsed = refundSchema(todayInColombo()).safeParse(input);
  if (!parsed.success) return fail("Please check the form.", fieldErrorsFrom(parsed.error.issues));
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const { data: c } = await admin.from("credits").select("id, owner_id, customer_id").eq("id", i.creditId).maybeSingle();
    if (!c || c.owner_id !== owner.id) return fail("This credit was not found.");
    const result = (await supabaseRpc(admin)("rpc_refund_credit", {
      p_credit_id: i.creditId,
      p_actor_id: owner.id,
      p_refund: { amount_cents: i.amount, refunded_on: i.refundedOn, method: i.method, reference: i.reference, note: i.note },
      p_notifications: notificationsFor("credit.refunded", [customerRecipient(c.customer_id)], { amountCents: i.amount, reason: i.note ?? undefined }, { link: "/customer/payments" }),
    })) as { left_cents: number };
    return ok({ leftCents: result.left_cents });
  } catch (error) {
    return failure(error, "credit refund");
  }
}

// -----------------------------------------------------------------------------
// Customer balance (CP-01, CP-05) and the bills a payment can be for
// -----------------------------------------------------------------------------

/** What the customer still owes on issued bills and the credit waiting for the next bill. */
export async function customerMoney(user: CurrentUser): Promise<{ outstandingCents: number; creditCents: number }> {
  const admin = createAdminClient();
  const [bills, credits] = await Promise.all([loadBills(admin, { customerId: user.id, unpaidOnly: true }), loadAvailableCredits(admin, user.id)]);
  return { outstandingCents: bills.reduce((sum, b) => sum + Math.max(b.balanceCents, 0), 0), creditCents: credits.reduce((sum, c) => sum + c.amountCents, 0) };
}

// -----------------------------------------------------------------------------
// Outstanding and ageing (PAY-09, RPT-04; decision 45)
// -----------------------------------------------------------------------------

/** Every unpaid issued bill the signed-in owner may see, by customer and age. */
export async function getOutstanding(client: Admin): Promise<AgeingReport & { today: string }> {
  const { data, error } = await client
    .from("invoices")
    .select("id, invoice_no, customer_id, status, due_date, total_cents, amount_paid_cents, customer:customers!invoices_customer_fkey(name)")
    .not("invoice_no", "is", null)
    .in("status", [...UNPAID])
    .limit(5000);
  if (error) throw new Error(`outstanding: ${error.message}`);
  const today = todayInColombo();
  const report = ageingReport(
    data.map((i) => ({
      id: i.id,
      invoiceNo: i.invoice_no ?? "",
      customerId: i.customer_id,
      customerName: i.customer.name,
      status: i.status,
      dueDate: i.due_date,
      balanceCents: i.total_cents - i.amount_paid_cents,
    })),
    today,
  );
  return { ...report, today };
}
