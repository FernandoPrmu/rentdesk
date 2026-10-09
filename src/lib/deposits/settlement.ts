import { formatRupees } from "@/lib/money";

/**
 * Security deposit settlement (DEP-03, DEP-04; client decision 2). Pure: used by
 * the forms (live totals) and the Server Actions (validation before the rpc).
 * app.settle_deposit applies the same rules again in the same transaction.
 *
 *   deduct + refund + retain = deposit held        (always balances)
 *   deduct <= unpaid balance that may be deducted   (no slip waiting, not disputed)
 *   retain needs a reason; a refund needs a date and a method
 *
 * Deductions pay the agreement's unpaid invoices oldest due first, each recorded
 * as a payment of method SECURITY_DEPOSIT.
 */

export interface DepositInvoice {
  id: string;
  invoiceNo: string | null;
  balanceCents: number;
  /** False while a payment slip waits for the owner or the invoice is disputed. */
  deductible: boolean;
}

export interface SettlementAmounts {
  deductCents: number;
  refundCents: number;
  retainCents: number;
}

export interface Allocation {
  invoiceId: string;
  invoiceNo: string | null;
  amountCents: number;
  paidInFull: boolean;
}

export type SettlementPlan =
  | { ok: true; allocations: Allocation[] }
  | { ok: false; errors: Partial<Record<"deduct" | "refund" | "retain" | "form", string>> };

/** What the deposit may pay: unpaid balances of invoices with no slip waiting and no dispute. */
export function deductibleCents(invoices: DepositInvoice[]): number {
  return invoices.filter((i) => i.deductible).reduce((sum, i) => sum + i.balanceCents, 0);
}

/** Suggested split: pay what can be paid, refund the rest, retain nothing. */
export function defaultSettlement(heldCents: number, invoices: DepositInvoice[]): SettlementAmounts {
  const deductCents = Math.min(heldCents, deductibleCents(invoices));
  return { deductCents, refundCents: heldCents - deductCents, retainCents: 0 };
}

function isCents(n: number) {
  return Number.isSafeInteger(n) && n >= 0;
}

/** Checks a split and allocates the deduction to invoices (in the order given: oldest due first). */
export function planSettlement(heldCents: number, invoices: DepositInvoice[], amounts: SettlementAmounts, retainReason: string | null): SettlementPlan {
  const { deductCents, refundCents, retainCents } = amounts;
  if (![heldCents, deductCents, refundCents, retainCents].every(isCents)) {
    return { ok: false, errors: { form: "Amounts must be whole cents of 0 or more." } };
  }
  if (heldCents === 0) return { ok: false, errors: { form: "No deposit is held for this agreement." } };

  const errors: Partial<Record<"deduct" | "refund" | "retain" | "form", string>> = {};
  const available = deductibleCents(invoices);
  if (deductCents > available) {
    errors.deduct = `At most ${formatRupees(available)} can be deducted (unpaid invoices without a slip waiting or a dispute).`;
  }
  if (retainCents > 0 && !retainReason?.trim()) errors.retain = "Give a reason for keeping part of the deposit.";
  const total = deductCents + refundCents + retainCents;
  if (total !== heldCents) {
    errors.form = `Deduct + refund + keep must equal the deposit held (${formatRupees(heldCents)}); now ${formatRupees(total)}.`;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const allocations: Allocation[] = [];
  let rest = deductCents;
  for (const invoice of invoices) {
    if (rest === 0) break;
    if (!invoice.deductible || invoice.balanceCents <= 0) continue;
    const amountCents = Math.min(rest, invoice.balanceCents);
    rest -= amountCents;
    allocations.push({ invoiceId: invoice.id, invoiceNo: invoice.invoiceNo, amountCents, paidInFull: amountCents === invoice.balanceCents });
  }
  return { ok: true, allocations };
}
