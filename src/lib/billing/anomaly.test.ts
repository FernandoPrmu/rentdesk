import { describe, expect, it } from "vitest";

import { counterAnomaly, invoiceAnomaly, median, usageBaseline } from "./anomaly.ts";

describe("usage baseline", () => {
  it("is the median of up to the 6 most recent cycles, rounded down", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2); // (2 + 3) / 2 = 2.5 -> 2
    expect(usageBaseline([100, 200, 300, 400, 500, 600, 9_999])).toBe(350); // 7th (oldest) ignored
  });

  it("needs at least 3 cycles of history", () => {
    expect(usageBaseline([2500, 2600])).toBeNull();
    expect(counterAnomaly(50_000, 1, [2500, 2600])).toBeNull();
  });
});

describe("counterAnomaly (thresholds in docs/decisions.md)", () => {
  const history = [2500, 2500, 2500];

  it("HIGH above 2x the median and at least 200 copies above it", () => {
    expect(counterAnomaly(5000, 1, history)).toBeNull(); // exactly 2x
    expect(counterAnomaly(5001, 1, history)).toBe("HIGH");
    // Tiny volumes: 3x the median but only 100 copies more is not flagged.
    expect(counterAnomaly(150, 1, [50, 50, 50])).toBeNull();
  });

  it("LOW below 50% of the median and at least 200 copies below it", () => {
    expect(counterAnomaly(1250, 1, history)).toBeNull(); // exactly 50%
    expect(counterAnomaly(1249, 1, history)).toBe("LOW");
    expect(counterAnomaly(0, 1, history)).toBe("LOW");
    expect(counterAnomaly(20, 1, [100, 100, 100])).toBeNull(); // only 80 copies below
  });

  it("compares per cycle when a reading covers several cycles", () => {
    expect(counterAnomaly(10_000, 2, history)).toBeNull();
    expect(counterAnomaly(10_001, 2, history)).toBe("HIGH");
  });

  it("ZERO when the counter printed nothing and that is not unusual", () => {
    expect(counterAnomaly(0, 1, [])).toBe("ZERO");
    expect(counterAnomaly(0, 1, [0, 0, 0])).toBe("ZERO");
  });
});

describe("invoiceAnomaly", () => {
  it("ZERO only when no counter printed anything", () => {
    expect(invoiceAnomaly([{ usage: 0, anomaly: "ZERO" }, { usage: 0, anomaly: "ZERO" }])).toBe("ZERO");
    // An unused colour counter on its own is normal.
    expect(invoiceAnomaly([{ usage: 2500, anomaly: null }, { usage: 0, anomaly: "ZERO" }])).toBeNull();
  });

  it("HIGH beats LOW", () => {
    expect(invoiceAnomaly([{ usage: 9000, anomaly: "HIGH" }, { usage: 0, anomaly: "LOW" }])).toBe("HIGH");
    expect(invoiceAnomaly([{ usage: 2500, anomaly: null }, { usage: 0, anomaly: "LOW" }])).toBe("LOW");
  });
});
