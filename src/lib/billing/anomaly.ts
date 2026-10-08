import { assertCount, mul } from "./arithmetic.ts";

/**
 * Usage anomaly check (spec 6.4 "warn the owner when usage is unusually high or
 * low", 11.4 "zero usage ... flagged as low usage"). Thresholds are decisions,
 * not spec (docs/decisions.md). Integer comparisons only.
 *
 * Usage is compared per cycle with the MEDIAN usage per cycle of the most recent
 * confirmed cycles of the same counter:
 *   HIGH  per-cycle usage > 200 % of the median AND at least 200 copies above it;
 *   LOW   per-cycle usage <  50 % of the median AND at least 200 copies below it;
 *   ZERO  no copies at all.
 * HIGH and LOW need at least 3 cycles of history; up to 6 are used.
 */
export const ANOMALY = {
  historyCycles: 6,
  minHistoryCycles: 3,
  highPercent: 200,
  lowPercent: 50,
  minDifference: 200,
} as const;

export type CounterAnomaly = "HIGH" | "LOW" | "ZERO" | null;
export type InvoiceAnomaly = "HIGH" | "LOW" | "ZERO" | null;

/** Median of whole numbers, rounded down (no fractions). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * The comparison baseline: median per-cycle usage of the most recent cycles
 * (`history` newest first), or null with less than 3 cycles of history.
 */
export function usageBaseline(history: number[]): number | null {
  const recent = history.slice(0, ANOMALY.historyCycles).map((v, i) => assertCount(v, `history[${i}]`));
  return recent.length >= ANOMALY.minHistoryCycles ? median(recent) : null;
}

/** `usage` copies over `cycles` cycles: above the HIGH threshold for this baseline? */
export function isHighUsage(usage: number, cycles: number, baseline: number): boolean {
  const expected = mul(baseline, cycles);
  return mul(usage, 100) > mul(expected, ANOMALY.highPercent) && usage - expected >= mul(ANOMALY.minDifference, cycles);
}

export function isLowUsage(usage: number, cycles: number, baseline: number): boolean {
  const expected = mul(baseline, cycles);
  return mul(usage, 100) < mul(expected, ANOMALY.lowPercent) && expected - usage >= mul(ANOMALY.minDifference, cycles);
}

/**
 * Per counter: HIGH or LOW against its history (zero copies can be LOW too), else
 * ZERO when it printed nothing (e.g. an unused colour counter), else null.
 */
export function counterAnomaly(usage: number, cycles: number, history: number[]): CounterAnomaly {
  const baseline = usageBaseline(history);
  if (baseline !== null) {
    if (isHighUsage(usage, cycles, baseline)) return "HIGH";
    if (isLowUsage(usage, cycles, baseline)) return "LOW";
  }
  return usage === 0 ? "ZERO" : null;
}

/**
 * One flag for the submission (meter_submissions.anomaly_flag): ZERO when no
 * counter printed anything (spec 11.4); otherwise HIGH beats LOW. One idle counter
 * on its own (colour unused, as usual) is not flagged.
 */
export function invoiceAnomaly(counters: { usage: number; anomaly: CounterAnomaly }[]): InvoiceAnomaly {
  if (counters.length > 0 && counters.every((c) => c.usage === 0)) return "ZERO";
  if (counters.some((c) => c.anomaly === "HIGH")) return "HIGH";
  if (counters.some((c) => c.anomaly === "LOW")) return "LOW";
  return null;
}
