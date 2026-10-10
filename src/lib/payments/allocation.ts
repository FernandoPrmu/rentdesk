/**
 * How one payment is split over the bills it is for (decision 39): oldest due
 * date first (no due date last, then invoice number, then id), each bill up to
 * what is left to pay on it; whatever is left over becomes a customer credit.
 * Bills the amount does not reach are left out. The same rule runs again when
 * the owner accepts another amount or moves the payment.
 * Mirrors app.plan_allocation (migration 0025; DB test). Pure, integer cents.
 * Only relative imports.
 */

export interface AllocatableInvoice {
  id: string;
  invoiceNo: string;
  dueDate: string | null;
  /** Per-owner invoice number sequence (ties on the due date). */
  seq: number | null;
  /** What is left to pay on it now. */
  balanceCents: number;
}

export interface PlannedAllocation {
  invoiceId: string;
  invoiceNo: string;
  cents: number;
  balanceAfterCents: number;
  paidInFull: boolean;
}

export interface AllocationPlan {
  allocations: PlannedAllocation[];
  /** Kept as a credit (overpayment, or an advance when there are no bills). */
  creditCents: number;
  /** Bills the amount does not reach (not part of this payment). */
  leftOut: string[];
}

/** Oldest due first; no due date last; then the invoice sequence; then the id. */
export function allocationOrder(a: AllocatableInvoice, b: AllocatableInvoice): number {
  if (a.dueDate !== b.dueDate) {
    if (a.dueDate === null) return 1;
    if (b.dueDate === null) return -1;
    return a.dueDate < b.dueDate ? -1 : 1;
  }
  if (a.seq !== b.seq) {
    if (a.seq === null) return 1;
    if (b.seq === null) return -1;
    return a.seq - b.seq;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function planAllocation(amountCents: number, invoices: AllocatableInvoice[]): AllocationPlan {
  if (!Number.isSafeInteger(amountCents) || amountCents < 0) throw new Error("amount must be whole cents, 0 or more");
  let rest = amountCents;
  const allocations: PlannedAllocation[] = [];
  const leftOut: string[] = [];
  for (const inv of [...invoices].sort(allocationOrder)) {
    const balance = Math.max(inv.balanceCents, 0);
    const cents = Math.min(rest, balance);
    rest -= cents;
    if (cents === 0) {
      leftOut.push(inv.id);
      continue;
    }
    allocations.push({ invoiceId: inv.id, invoiceNo: inv.invoiceNo, cents, balanceAfterCents: balance - cents, paidInFull: cents === balance });
  }
  return { allocations, creditCents: rest, leftOut };
}

/** What the plan means for the customer or owner, in one line. */
export function describePlan(plan: AllocationPlan, money: (cents: number) => string): string {
  const parts = plan.allocations.map((a) => (a.paidInFull ? `${a.invoiceNo} in full` : `${money(a.cents)} of ${a.invoiceNo}`));
  const pays = parts.length > 0 ? `Pays ${parts.join(", ")}.` : "Pays no bill.";
  return plan.creditCents > 0 ? `${pays} ${money(plan.creditCents)} is kept as credit for your next bills.` : pays;
}
