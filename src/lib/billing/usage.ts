import { isHighUsage, usageBaseline } from "./anomaly.ts";
import { assertCount, mul } from "./arithmetic.ts";
import { BillingError } from "./errors.ts";

/**
 * Copies used per counter (spec 6.2, 6.4, 11.2, 11.8; INV-04).
 *
 * The previous reading is the newest known value of the counter: the initial
 * reading at assignment, a confirmed reading, or a baseline the owner recorded
 * after a meter reset or replacement (meter_baselines). Same rule as
 * app.last_known_reading in the database.
 */

export type CounterType = "BW" | "COLOUR";
export type ReadingSource = "INITIAL" | "READING" | "BASELINE";

export interface KnownReading {
  value: number;
  /** ISO timestamp (agreement created, submission reviewed, baseline recorded). */
  at: string;
  source: ReadingSource;
}

/** The newest known reading (later entries win a tie). */
export function previousReading(known: KnownReading[]): KnownReading {
  if (known.length === 0) throw new BillingError("INVALID_INPUT", "No previous reading is known");
  let latest = known[0];
  for (const k of known) {
    if (Date.parse(k.at) >= Date.parse(latest.at)) latest = k;
  }
  return latest;
}

export interface CounterUsageInput {
  counter: CounterType;
  previous: number;
  current: number;
  /** Highest value the counter shows before it rolls over to 0; null = no rollover. */
  counterMax: number | null;
  /** Cycles this reading covers (the rollover guard compares per cycle). */
  cycles: number;
  /** Confirmed usage per cycle of this counter, newest first. */
  history: number[];
}

export interface CounterUsage {
  usage: number;
  rolledOver: boolean;
}

const LABEL: Record<CounterType, string> = { BW: "B&W", COLOUR: "Colour" };

/**
 * usage = current - previous. A lower reading counts as a rollover
 * ((max - previous) + 1 + current, e.g. 999,999 -> 0 is one copy) only when the
 * counter has a maximum AND the result is plausible (docs/decisions.md):
 *   - with 3+ cycles of history: not above the HIGH anomaly threshold;
 *   - otherwise: at most half the counter maximum.
 * Anything else is READING_BELOW_PREVIOUS, so a typo is re-entered, never billed.
 * An accepted rollover is always flagged; the owner must confirm it on review.
 */
export function counterUsage(input: CounterUsageInput): CounterUsage {
  const label = LABEL[input.counter];
  const previous = assertCount(input.previous, `${label} previous reading`);
  const current = assertCount(input.current, `${label} reading`);
  const cycles = assertCount(input.cycles, "Cycles");
  if (cycles < 1) throw new BillingError("INVALID_INPUT", "A reading covers at least one cycle");
  const max = input.counterMax === null ? null : assertCount(input.counterMax, `${label} counter maximum`);

  if (max !== null && current > max) {
    throw new BillingError(
      "READING_ABOVE_COUNTER_MAX",
      `${label} reading ${current} is above the counter maximum ${max}. Please check the number.`,
      input.counter,
    );
  }
  if (current >= previous) return { usage: current - previous, rolledOver: false };

  const below = new BillingError(
    "READING_BELOW_PREVIOUS",
    `${label} reading ${current} is lower than the previous reading ${previous}. Please check the number.`,
    input.counter,
  );
  if (max === null || previous > max) throw below;

  const usage = max - previous + 1 + current;
  const baseline = usageBaseline(input.history);
  const plausible = baseline !== null ? !isHighUsage(usage, cycles, baseline) : mul(usage, 2) <= max;
  if (!plausible) throw below;
  return { usage, rolledOver: true };
}
