import { createHash } from "node:crypto";

import { brandingFromSnapshot } from "../../invoices/pdf/document.ts";
import { PAYMENT_METHOD_LABEL } from "../../status-labels.ts";
import { colomboDate } from "../../tickets/deadlines.ts";

/**
 * What a receipt PDF shows (decision 44): built only from the receipt's content
 * snapshot (fixed when the payment was accepted, replaced when it is moved) and
 * the owner's branding snapshot, so later edits never change it. Pure apart from
 * hashing. Only relative imports.
 */

/** Bump when the drawing changes, so a re-render makes a new version. */
export const RECEIPT_RENDERER_VERSION = 1;

export interface ReceiptLine {
  invoiceNo: string;
  machine: string;
  period: { start: string; end: string };
  appliedCents: number;
  balanceAfterCents: number;
}

export interface ReceiptDocument {
  receiptNo: string;
  issueDate: string;
  reversed: { date: string | null; reason: string | null } | null;
  reallocated: { date: string | null; reason: string } | null;
  customer: { name: string; businessName: string | null; address: string | null };
  payment: { receivedCents: number; slipCents: number; method: string; paidOn: string; reference: string | null; bySlip: boolean };
  lines: ReceiptLine[];
  creditCents: number;
  outstandingAfterCents: number;
  company: { name: string; address: string | null; phone: string | null; email: string | null };
  logoPath: string | null;
  letterhead: ReturnType<typeof brandingFromSnapshot>["letterhead"];
}

/** rpc_claim_receipt_pdf's result (migration 0025). */
export interface ReceiptPdfClaim {
  receipt: {
    id: string;
    owner_id: string;
    customer_id: string;
    receipt_no: string;
    status: "ISSUED" | "REVERSED";
    issued_at: string;
    reversed_at: string | null;
    reverse_reason: string | null;
    content: ReceiptContent;
    branding_snapshot: Record<string, unknown> | null;
    pdf_revision: number;
  };
  latest: { version: number; content_hash: string } | null;
}

/** receipts.content (app.receipt_content). */
export interface ReceiptContent {
  payment: { amount_cents: number; accepted_cents: number | null; method: string; paid_on: string; reference: string | null; source: string };
  allocations: {
    invoice_no: string;
    invoice_total_cents: number;
    applied_cents: number;
    balance_after_cents: number | null;
    machine: string;
    period_start: string;
    period_end: string;
  }[];
  credit_cents: number;
  outstanding_after_cents: number;
  customer: { name: string; business_name: string | null; address: string | null } | null;
  reallocated?: { reason: string; at: string };
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0));
const day = (at: string | null | undefined) => (at ? colomboDate(new Date(at)) : null);

export function buildReceiptDocument(claim: ReceiptPdfClaim): ReceiptDocument {
  const r = claim.receipt;
  const c = r.content;
  const branding = brandingFromSnapshot(r.branding_snapshot);
  return {
    receiptNo: r.receipt_no,
    issueDate: day(r.issued_at) ?? colomboDate(new Date()),
    reversed: r.status === "REVERSED" ? { date: day(r.reversed_at), reason: text(r.reverse_reason) } : null,
    reallocated: c.reallocated ? { date: day(c.reallocated.at), reason: c.reallocated.reason } : null,
    customer: { name: c.customer?.name ?? "", businessName: text(c.customer?.business_name), address: text(c.customer?.address) },
    payment: {
      receivedCents: num(c.payment.accepted_cents ?? c.payment.amount_cents),
      slipCents: num(c.payment.amount_cents),
      method: PAYMENT_METHOD_LABEL[c.payment.method] ?? c.payment.method,
      paidOn: c.payment.paid_on,
      reference: text(c.payment.reference),
      bySlip: c.payment.source === "CUSTOMER_SLIP",
    },
    lines: c.allocations.map((a) => ({
      invoiceNo: a.invoice_no,
      machine: a.machine,
      period: { start: a.period_start, end: a.period_end },
      appliedCents: num(a.applied_cents),
      balanceAfterCents: num(a.balance_after_cents),
    })),
    creditCents: num(c.credit_cents),
    outstandingAfterCents: num(c.outstanding_after_cents),
    company: branding.company,
    logoPath: branding.logoPath,
    letterhead: branding.letterhead,
  };
}

/** Same content → same hash: no new version is stored. */
export function receiptHash(doc: ReceiptDocument): string {
  return createHash("sha256").update(JSON.stringify({ renderer: RECEIPT_RENDERER_VERSION, doc })).digest("hex");
}
