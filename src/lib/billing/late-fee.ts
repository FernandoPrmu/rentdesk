import { assertCount, sum } from "./arithmetic.ts";
import { BillingError } from "./errors.ts";
import type { InvoiceLine } from "./invoice.ts";

/**
 * Optional late fee (PAY-13, spec 8.3; rule in docs/decisions.md): a flat
 * `late_fee_cents` from the settings, added ONCE per invoice when it is still not
 * fully paid after due date + grace period. Never while a slip waits for the
 * owner's verification (spec 8.2) or while the invoice is disputed (11.4:
 * reminders pause). Dates are ISO calendar dates in Asia/Colombo.
 */

export interface LateFeeSettings {
  enabled: boolean;
  feeCents: number;
  graceDays: number;
}

export interface LateFeeInvoice {
  status: string;
  dueDate: string | null;
  subtotalCents: number;
  lateFeeCents: number;
  creditAppliedCents: number;
  totalCents: number;
  amountPaidCents: number;
  /** A payment slip is waiting for the owner (ticket PAYMENT_SUBMITTED). */
  slipAwaitingVerification: boolean;
}

const CHARGEABLE = new Set(["AWAITING_PAYMENT", "PARTIALLY_PAID", "OVERDUE"]);

function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(ms)) throw new BillingError("INVALID_INPUT", `Invalid date: ${isoDate}`);
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10);
}

/** The first day the fee may be charged: the day after due date + grace period. */
export function lateFeeFrom(dueDate: string, graceDays: number): string {
  return addDays(dueDate, assertCount(graceDays, "Grace period") + 1);
}

export function lateFeeDue(invoice: LateFeeInvoice, settings: LateFeeSettings, today: string): boolean {
  if (!settings.enabled || assertCount(settings.feeCents, "Late fee") === 0) return false;
  if (invoice.lateFeeCents > 0) return false; // once per invoice
  if (!CHARGEABLE.has(invoice.status) || invoice.slipAwaitingVerification) return false;
  if (!invoice.dueDate || invoice.amountPaidCents >= invoice.totalCents) return false;
  return today >= lateFeeFrom(invoice.dueDate, settings.graceDays);
}

/** The LATE_FEE line and the new totals (total = subtotal + late fee - credits). */
export function addLateFee(invoice: LateFeeInvoice, feeCents: number): { line: InvoiceLine; lateFeeCents: number; totalCents: number } {
  assertCount(feeCents, "Late fee");
  if (invoice.lateFeeCents > 0) throw new BillingError("INVALID_INPUT", "A late fee was already added to this invoice");
  return {
    line: { line_type: "LATE_FEE", description: "Late payment fee", quantity: 1, rate_cents: feeCents, amount_cents: feeCents },
    lateFeeCents: feeCents,
    totalCents: sum([invoice.subtotalCents, feeCents, -invoice.creditAppliedCents]),
  };
}
