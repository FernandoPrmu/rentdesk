import { daysBetween, type IsoDate } from "../agreements/cycle-calendar.ts";

/**
 * Outstanding and ageing (PAY-09, RPT-04; decision 45). Every issued bill with
 * something left to pay is put in a bucket by the days past its due date, on the
 * Colombo calendar: Current (not due yet, or due today), 1-30, 31-60, 60+ days
 * overdue. A bill whose payment slip waits for the owner's check is not overdue
 * (spec 8.2): it stays in Current, tagged "slip waiting". Disputed bills age
 * normally. Pure. Only relative imports.
 */

export const AGE_BUCKETS = ["CURRENT", "D1_30", "D31_60", "D60_PLUS"] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number];

export const AGE_BUCKET_LABEL: Record<AgeBucket, string> = {
  CURRENT: "Current",
  D1_30: "1-30 days",
  D31_60: "31-60 days",
  D60_PLUS: "60+ days",
};

export interface AgeingInvoice {
  id: string;
  invoiceNo: string;
  customerId: string;
  customerName: string;
  status: string;
  dueDate: IsoDate | null;
  balanceCents: number;
}

/** Days past the due date (0 or less = not overdue). No due date = due on receipt, never aged. */
export function daysOverdue(dueDate: IsoDate | null, today: IsoDate): number {
  return dueDate === null ? 0 : daysBetween(dueDate, today);
}

export function ageBucket(invoice: Pick<AgeingInvoice, "status" | "dueDate">, today: IsoDate): AgeBucket {
  if (invoice.status === "PAYMENT_SUBMITTED") return "CURRENT";
  const days = daysOverdue(invoice.dueDate, today);
  if (days <= 0) return "CURRENT";
  if (days <= 30) return "D1_30";
  if (days <= 60) return "D31_60";
  return "D60_PLUS";
}

export type BucketTotals = Record<AgeBucket, number>;

export interface CustomerAgeing {
  customerId: string;
  customerName: string;
  buckets: BucketTotals;
  totalCents: number;
  /** Part of Current that waits for a slip check. */
  slipWaitingCents: number;
  invoices: number;
  /** Days past due of the oldest unpaid bill (0 if none is overdue). */
  oldestDays: number;
}

export interface AgeingReport {
  customers: CustomerAgeing[];
  totals: BucketTotals & { total: number; slipWaiting: number };
}

const emptyBuckets = (): BucketTotals => ({ CURRENT: 0, D1_30: 0, D31_60: 0, D60_PLUS: 0 });

/** Per customer, most overdue money first (60+, then 31-60, ...), then by name. */
export function ageingReport(invoices: AgeingInvoice[], today: IsoDate): AgeingReport {
  const byCustomer = new Map<string, CustomerAgeing>();
  const totals = { ...emptyBuckets(), total: 0, slipWaiting: 0 };
  for (const inv of invoices) {
    if (inv.balanceCents <= 0) continue;
    const bucket = ageBucket(inv, today);
    const row =
      byCustomer.get(inv.customerId) ??
      ({ customerId: inv.customerId, customerName: inv.customerName, buckets: emptyBuckets(), totalCents: 0, slipWaitingCents: 0, invoices: 0, oldestDays: 0 } satisfies CustomerAgeing);
    row.buckets[bucket] += inv.balanceCents;
    row.totalCents += inv.balanceCents;
    row.invoices += 1;
    if (inv.status === "PAYMENT_SUBMITTED") {
      row.slipWaitingCents += inv.balanceCents;
      totals.slipWaiting += inv.balanceCents;
    } else {
      row.oldestDays = Math.max(row.oldestDays, daysOverdue(inv.dueDate, today));
    }
    byCustomer.set(inv.customerId, row);
    totals[bucket] += inv.balanceCents;
    totals.total += inv.balanceCents;
  }
  const customers = [...byCustomer.values()].sort(
    (a, b) =>
      b.buckets.D60_PLUS - a.buckets.D60_PLUS ||
      b.buckets.D31_60 - a.buckets.D31_60 ||
      b.buckets.D1_30 - a.buckets.D1_30 ||
      a.customerName.localeCompare(b.customerName),
  );
  return { customers, totals };
}
