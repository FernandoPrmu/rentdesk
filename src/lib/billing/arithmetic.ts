import { BillingError } from "./errors.ts";

/**
 * Integer arithmetic for money (cents) and copy counts. No floating point is
 * ever used: products are computed as BigInt and every result must fit a safe
 * JavaScript integer (2^53 - 1, about Rs. 90 trillion), or an error is raised.
 *
 * ROUNDING RULE (docs/decisions.md): the only rounding in billing is proration.
 * divRoundHalfUp() rounds to the nearest integer, halves up (2.5 -> 3). Money is
 * rounded to the cent, prorated included copies to a whole copy.
 */

const ZERO = BigInt(0);
const TWO = BigInt(2);

/** A safe, non-negative integer (copies, cents, days), or INVALID_INPUT. */
export function assertCount(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BillingError("INVALID_INPUT", `${label} must be a whole number of 0 or more (got ${value})`);
  }
  return value;
}

/** A safe integer, any sign (adjustments, credits as negative lines). */
export function assertInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new BillingError("INVALID_INPUT", `${label} must be a whole number (got ${value})`);
  }
  return value;
}

function toSafe(value: bigint, label: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new BillingError("INVALID_INPUT", `${label} is too large to calculate safely`);
  }
  return n;
}

/** a × b, exact. */
export function mul(a: number, b: number, label = "amount"): number {
  return toSafe(BigInt(a) * BigInt(b), label);
}

/** Sum of integers, exact. */
export function sum(values: number[], label = "total"): number {
  return toSafe(values.reduce((acc, v) => acc + BigInt(v), ZERO), label);
}

/** round(a × b / d), halves up, for a, b >= 0 and d > 0. */
export function mulDivRoundHalfUp(a: number, b: number, d: number, label = "amount"): number {
  if (d <= 0) throw new BillingError("INVALID_INPUT", `${label}: divisor must be positive`);
  const n = BigInt(a) * BigInt(b);
  const den = BigInt(d);
  // floor((2n + d) / 2d) == round half up for non-negative n.
  return toSafe((TWO * n + den) / (TWO * den), label);
}

/** max(0, a - b). */
export function excessOver(a: number, b: number): number {
  return a > b ? a - b : 0;
}

