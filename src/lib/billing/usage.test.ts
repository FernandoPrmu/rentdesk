import { describe, expect, it } from "vitest";

import { BillingError } from "./errors.ts";
import { counterUsage, previousReading } from "./usage.ts";

const base = { counter: "BW" as const, counterMax: null, cycles: 1, history: [] as number[] };

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    return e as BillingError;
  }
  throw new Error("expected an error");
}

describe("counterUsage", () => {
  it("is current minus previous", () => {
    expect(counterUsage({ ...base, previous: 12_500, current: 15_100 })).toEqual({ usage: 2600, rolledOver: false });
  });

  it("is zero when the counter did not move", () => {
    expect(counterUsage({ ...base, previous: 12_500, current: 12_500 })).toEqual({ usage: 0, rolledOver: false });
  });

  it("rejects a reading lower than the previous one when the counter has no maximum", () => {
    const e = errorOf(() => counterUsage({ ...base, previous: 12_500, current: 12_400 }));
    expect(e).toBeInstanceOf(BillingError);
    expect(e.code).toBe("READING_BELOW_PREVIOUS");
    expect(e.counter).toBe("BW");
  });

  it("rejects a reading above the counter maximum", () => {
    expect(errorOf(() => counterUsage({ ...base, counterMax: 999_999, previous: 5, current: 1_000_000 })).code).toBe(
      "READING_ABOVE_COUNTER_MAX",
    );
  });

  it("rejects negative, fractional or unsafe numbers", () => {
    for (const current of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(errorOf(() => counterUsage({ ...base, previous: 0, current })).code).toBe("INVALID_INPUT");
    }
  });
});

describe("rollover (spec 11.2; guard in docs/decisions.md)", () => {
  const max = 999_999;

  it("counts 999,999 -> 0 as one copy: (max - previous) + 1 + current", () => {
    expect(counterUsage({ ...base, counterMax: max, previous: 999_990, current: 10 })).toEqual({ usage: 20, rolledOver: true });
    expect(counterUsage({ ...base, counterMax: max, previous: 999_999, current: 0 })).toEqual({ usage: 1, rolledOver: true });
  });

  it("accepts a plausible rollover with history: not above the HIGH threshold", () => {
    // Median of the last cycles is 2,500; HIGH starts above 5,000 (2x) for one cycle.
    const history = [2400, 2500, 2600];
    // (999,999 - 998,000) + 1 + 3,000 = 5,000: exactly 2x the median is not HIGH.
    expect(counterUsage({ ...base, counterMax: max, history, previous: 998_000, current: 3_000 })).toEqual({
      usage: 5000,
      rolledOver: true,
    });
  });

  it("rejects a typo that would be a rollover above the HIGH threshold", () => {
    // 12,500 -> 12,050 typed for 12,950: as a rollover that is 987,550 copies.
    const history = [2400, 2500, 2600];
    const e = errorOf(() => counterUsage({ ...base, counterMax: max, history, previous: 12_500, current: 12_050 }));
    expect(e.code).toBe("READING_BELOW_PREVIOUS");
    // One copy above the threshold (5,001) is rejected too.
    expect(errorOf(() => counterUsage({ ...base, counterMax: max, history, previous: 998_000, current: 3_001 })).code).toBe(
      "READING_BELOW_PREVIOUS",
    );
  });

  it("allows proportionally more for a reading that covers several cycles", () => {
    const history = [2500, 2500, 2500];
    expect(counterUsage({ ...base, counterMax: max, history, cycles: 2, previous: 995_000, current: 5_000 }).usage).toBe(10_000);
    expect(() => counterUsage({ ...base, counterMax: max, history, cycles: 2, previous: 995_000, current: 5_001 })).toThrow(
      BillingError,
    );
  });

  it("without 3 cycles of history: at most half the counter maximum", () => {
    expect(counterUsage({ ...base, counterMax: 9999, history: [100], previous: 9000, current: 3999 }).usage).toBe(4999);
    expect(errorOf(() => counterUsage({ ...base, counterMax: 9999, history: [100], previous: 9000, current: 4000 })).code).toBe(
      "READING_BELOW_PREVIOUS",
    );
  });

  it("never treats a previous value above the maximum as a rollover", () => {
    expect(errorOf(() => counterUsage({ ...base, counterMax: 99, previous: 150, current: 10 })).code).toBe("READING_BELOW_PREVIOUS");
  });
});

describe("previousReading (baselines, spec 6.4 / 11.8)", () => {
  it("takes the newest of initial reading, confirmed readings and baselines", () => {
    const known = [
      { value: 1000, at: "2026-01-01T00:00:00Z", source: "INITIAL" as const },
      { value: 4400, at: "2026-02-01T00:00:00Z", source: "READING" as const },
      // Meter replaced after the February reading: usage continues from the new baseline.
      { value: 0, at: "2026-02-10T09:00:00Z", source: "BASELINE" as const },
    ];
    expect(previousReading(known)).toEqual(known[2]);
    expect(counterUsage({ ...base, previous: previousReading(known).value, current: 1800 })).toEqual({ usage: 1800, rolledOver: false });
  });

  it("uses a confirmed reading taken after an older baseline", () => {
    const known = [
      { value: 0, at: "2026-02-10T09:00:00Z", source: "BASELINE" as const },
      { value: 1800, at: "2026-03-01T00:00:00Z", source: "READING" as const },
    ];
    expect(previousReading(known).value).toBe(1800);
  });
});
