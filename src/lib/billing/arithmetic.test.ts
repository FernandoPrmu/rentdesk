import { describe, expect, it } from "vitest";

import { assertCount, excessOver, mul, mulDivRoundHalfUp, sum } from "./arithmetic.ts";
import { BillingError } from "./errors.ts";

describe("integer arithmetic", () => {
  it("rounds half up, and only at the end", () => {
    expect(mulDivRoundHalfUp(5, 1, 2)).toBe(3); // 2.5 -> 3
    expect(mulDivRoundHalfUp(7, 1, 3)).toBe(2); // 2.33 -> 2
    expect(mulDivRoundHalfUp(8, 1, 3)).toBe(3); // 2.67 -> 3
    expect(mulDivRoundHalfUp(1_000_000, 12, 30)).toBe(400_000);
    // The product is exact even above 2^53 before dividing.
    expect(mulDivRoundHalfUp(9_000_000_000_000_000, 3, 9)).toBe(3_000_000_000_000_000);
  });

  it("refuses results a JavaScript number cannot hold exactly", () => {
    expect(() => mul(Number.MAX_SAFE_INTEGER, 2)).toThrow(BillingError);
    expect(() => sum([Number.MAX_SAFE_INTEGER, 1])).toThrow(BillingError);
    expect(() => mulDivRoundHalfUp(1, 1, 0)).toThrow(BillingError);
  });

  it("checks inputs and never goes below zero for excess", () => {
    expect(() => assertCount(-1, "x")).toThrow(BillingError);
    expect(() => assertCount(0.5, "x")).toThrow(BillingError);
    expect(excessOver(100, 300)).toBe(0);
    expect(excessOver(300, 100)).toBe(200);
  });
});
