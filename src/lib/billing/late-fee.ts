import { assertCount, sum } from "./arithmetic.ts";
import { BillingError } from "./errors.ts";
import type { InvoiceLine } from "./invoice.ts";

/**
 * Optional late fee (PAY-13, LATE-01, spec 8.3; rule 7 in docs/decisions.md): a
 * flat amount, added ONCE per invoice when it is still not fully paid after due
 * date + grace period. Never while a slip waits for the owner's verification
 * (spec 8.2) or while the invoice is disputed (11.4: reminders pause). Dates are
 * ISO calendar dates in Asia/Colombo.
 *
 * Which amount: the agreement's setting (kept in its terms history, snapshot on
 * each ticket), then the owner's settings, then the platform default.
 */

export interface LateFeeSettings {
  enabled: boolean;
  feeCents: number;
  graceDays: number;
}

/** Agreement setting: follow the owner, a custom amount, or never. */
export type LateFeeMode = "OWNER_DEFAULT" | "CUSTOM" | "NONE";

export interface LateFeeSources {
  agreement: { mode: LateFeeMode; feeCents: number | null };
  /** owner_settings: null = not set, use the platform default. */
  owner: { enabled: boolean | null; feeCents: number | null; graceDays: number | null };
  platform: { enabled: boolean; feeCents: number; graceDays: number };
}

export interface ResolvedLateFee extends LateFeeSettings {
  /** Where the amount comes from. */
  source: "AGREEMENT" | "OWNER" | "PLATFORM";
}

/**
 * Effective late fee for an agreement (LATE-01). CUSTOM charges its amount even
 * when the owner's late fee is off (client decision); NONE never charges. The
 * grace period always comes from the owner's settings, else the platform's.
 */
export function resolveLateFee(s: LateFeeSources): ResolvedLateFee {
  const graceDays = assertCount(s.owner.graceDays ?? s.platform.graceDays, "Grace period");
  switch (s.agreement.mode) {
    case "NONE":
      return { enabled: false, feeCents: 0, graceDays, source: "AGREEMENT" };
    case "CUSTOM":
      if (s.agreement.feeCents === null) throw new BillingError("INVALID_INPUT", "A custom late fee needs an amount");
      return { enabled: true, feeCents: assertCount(s.agreement.feeCents, "Late fee"), graceDays, source: "AGREEMENT" };
    case "OWNER_DEFAULT": {
      const ownerSet = s.owner.enabled !== null || s.owner.feeCents !== null;
      return {
        enabled: s.owner.enabled ?? s.platform.enabled,
        feeCents: assertCount(s.owner.feeCents ?? s.platform.feeCents, "Late fee"),
        graceDays,
        source: ownerSet ? "OWNER" : "PLATFORM",
      };
    }
    default:
      throw new BillingError("INVALID_INPUT", "Unknown late fee setting");
  }
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
