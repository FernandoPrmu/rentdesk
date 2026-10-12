import { addDays, daysBetween, type IsoDate } from "../agreements/cycle-calendar.ts";
import type { CustomerRow, IncomeMonthRow, MachineRow, UsageRow } from "./types.ts";

/**
 * Report maths (RPT-01..06; decisions 77-80). The database sums the rows; these
 * pure functions derive the figures shown and exported, in integer cents.
 */

// ---------------------------------------------------------------------------
// Income (RPT-02, decision 77)
// ---------------------------------------------------------------------------

export interface IncomeMonth extends IncomeMonthRow {
  /** Bill charges less discount-type credits. */
  invoiced_cents: number;
  /** Payments + advances + deposits kept - refunds. */
  collected_cents: number;
}

export function incomeMonth(row: IncomeMonthRow): IncomeMonth {
  return {
    ...row,
    invoiced_cents: row.commitment_cents + row.excess_cents + row.other_cents + row.discount_cents,
    collected_cents: row.payments_cents + row.advances_cents + row.deposits_kept_cents + row.refunds_cents,
  };
}

const INCOME_SUM_KEYS = [
  "commitment_cents",
  "excess_cents",
  "other_cents",
  "discount_cents",
  "invoices",
  "payments_cents",
  "advances_cents",
  "deposits_kept_cents",
  "refunds_cents",
  "invoiced_cents",
  "collected_cents",
] as const;

export type IncomeTotals = Record<(typeof INCOME_SUM_KEYS)[number], number>;

export function incomeTotals(months: IncomeMonth[]): IncomeTotals {
  const totals = Object.fromEntries(INCOME_SUM_KEYS.map((k) => [k, 0])) as IncomeTotals;
  for (const m of months) for (const k of INCOME_SUM_KEYS) totals[k] += m[k];
  return totals;
}

/**
 * Change from `previous` to `current` in whole percent (rounded half away from zero),
 * or null when there is nothing to compare with.
 */
export function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  const tenths = Math.round((Math.abs(current - previous) * 1000) / Math.abs(previous));
  return (current >= previous ? 1 : -1) * Math.round(tenths / 10);
}

// ---------------------------------------------------------------------------
// Machine profitability (RPT-03, decision 79)
// ---------------------------------------------------------------------------

export interface MachineProfit extends MachineRow {
  name: string;
  profit_cents: number;
  /** Profit as a percent of revenue, one decimal; null without revenue. */
  margin_percent: number | null;
}

export function marginPercent(profitCents: number, revenueCents: number): number | null {
  if (revenueCents <= 0) return null;
  return Math.round((profitCents * 1000) / revenueCents) / 10;
}

export function machineProfit(row: MachineRow): MachineProfit {
  const profit = row.revenue_cents - row.service_cost_cents;
  return {
    ...row,
    name: `${row.brand} ${row.model} (${row.serial_no})`,
    profit_cents: profit,
    margin_percent: marginPercent(profit, row.revenue_cents),
  };
}

export function machineTotals(rows: MachineProfit[]) {
  const sum = (k: keyof MachineRow | "profit_cents") => rows.reduce((t, r) => t + (r[k] as number), 0);
  const revenue = sum("revenue_cents");
  const profit = sum("profit_cents");
  return {
    revenue_cents: revenue,
    commitment_cents: sum("commitment_cents"),
    bw_excess_cents: sum("bw_excess_cents"),
    colour_excess_cents: sum("colour_excess_cents"),
    bw_copies: sum("bw_copies"),
    colour_copies: sum("colour_copies"),
    service_cost_cents: sum("service_cost_cents"),
    toner_cost_cents: sum("toner_cost_cents"),
    profit_cents: profit,
    margin_percent: marginPercent(profit, revenue),
  };
}

// ---------------------------------------------------------------------------
// Customer payment behaviour (RPT-05)
// ---------------------------------------------------------------------------

/** Paid on time as a whole percent of the bills paid; null when none. */
export function onTimePercent(row: Pick<CustomerRow, "paid_bills" | "paid_on_time">): number | null {
  return row.paid_bills > 0 ? Math.round((row.paid_on_time * 100) / row.paid_bills) : null;
}

export type PaymentBehaviour = "GOOD" | "LATE" | "OVERDUE" | "NONE";

/** A short label: anything overdue now wins; then mostly late; then good. */
export function paymentBehaviour(row: Pick<CustomerRow, "paid_bills" | "paid_on_time" | "overdue_cents">): PaymentBehaviour {
  if (row.overdue_cents > 0) return "OVERDUE";
  const pct = onTimePercent(row);
  if (pct === null) return "NONE";
  return pct >= 80 ? "GOOD" : "LATE";
}

export const BEHAVIOUR_LABEL: Record<PaymentBehaviour, string> = {
  GOOD: "Pays on time",
  LATE: "Often late",
  OVERDUE: "Has overdue bills",
  NONE: "No paid bills yet",
};

// ---------------------------------------------------------------------------
// Toner forecast (RPT-06, decision 80)
// ---------------------------------------------------------------------------

export interface TonerForecast {
  /** Average days between toner requests. */
  everyDays: number;
  /** Last request + the average interval. */
  nextDate: IsoDate;
  /** Days from today (negative = expected already). */
  inDays: number;
}

/**
 * From a machine's toner request dates (any order): needs two or more; the next
 * request is expected one average interval after the last one.
 */
export function tonerForecast(dates: IsoDate[] | null, today: IsoDate): TonerForecast | null {
  if (!dates || dates.length < 2) return null;
  const sorted = [...dates].sort();
  const span = daysBetween(sorted[0], sorted[sorted.length - 1]);
  if (span <= 0) return null;
  const everyDays = Math.round(span / (sorted.length - 1));
  const nextDate = addDays(sorted[sorted.length - 1], everyDays);
  return { everyDays, nextDate, inDays: daysBetween(today, nextDate) };
}

// ---------------------------------------------------------------------------
// Usage trends
// ---------------------------------------------------------------------------

export type UsageBy = "machine" | "customer";

export interface UsageSeries {
  id: string;
  label: string;
  /** month -> copies */
  bw: Record<string, number>;
  colour: Record<string, number>;
  totalBw: number;
  totalColour: number;
}

/** Copies per month for each machine (or customer), biggest total first. */
export function usageSeries(rows: UsageRow[], by: UsageBy): UsageSeries[] {
  const map = new Map<string, UsageSeries>();
  for (const r of rows) {
    const id = by === "machine" ? r.machine_id : r.customer_id;
    const label = by === "machine" ? r.machine : r.customer;
    const s = map.get(id) ?? { id, label, bw: {}, colour: {}, totalBw: 0, totalColour: 0 };
    s.bw[r.month] = (s.bw[r.month] ?? 0) + r.bw;
    s.colour[r.month] = (s.colour[r.month] ?? 0) + r.colour;
    s.totalBw += r.bw;
    s.totalColour += r.colour;
    map.set(id, s);
  }
  return [...map.values()].sort((a, b) => b.totalBw + b.totalColour - (a.totalBw + a.totalColour) || a.label.localeCompare(b.label));
}

/** Bar lengths for a simple chart: each value as a percent of the largest (0-100). */
export function barPercents(values: number[]): number[] {
  const max = Math.max(0, ...values.map((v) => Math.abs(v)));
  return values.map((v) => (max === 0 ? 0 : Math.round((Math.abs(v) * 100) / max)));
}
