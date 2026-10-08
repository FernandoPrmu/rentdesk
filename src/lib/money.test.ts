import { describe, expect, it } from "vitest";

import { centsToRupeesInput, formatRupees, MAX_CENTS, rupeesToCents } from "./money";

describe("rupeesToCents", () => {
  it.each([
    ["10000", 1_000_000],
    ["10,000", 1_000_000],
    ["Rs. 10,000", 1_000_000],
    ["rs 12,800.00", 1_280_000],
    ["LKR 5000", 500_000],
    ["2.50", 250],
    ["2.5", 250],
    ["0.05", 5],
    [".5", 50],
    ["0", 0],
    ["  7 ", 700],
  ])("%s -> %i cents", (input, cents) => {
    expect(rupeesToCents(input)).toBe(cents);
  });

  it("is exact where floats are not (0.1 + 0.2, 1.15 * 100)", () => {
    expect(rupeesToCents("0.30")).toBe(30);
    expect(rupeesToCents("1.15")).toBe(115);
    expect(rupeesToCents("4.35")).toBe(435);
    expect(rupeesToCents("999999.99")).toBe(99_999_999);
  });

  it.each(["", "-5", "2.505", "1e3", "abc", "10.", "Rs.", "1.2.3", "NaN", "Infinity"])("rejects %j", (input) => {
    expect(rupeesToCents(input)).toBeNull();
  });

  it("rejects amounts above the limit", () => {
    expect(rupeesToCents(String(MAX_CENTS / 100))).toBe(MAX_CENTS);
    expect(rupeesToCents(String(MAX_CENTS / 100 + 1))).toBeNull();
  });
});

describe("cents to rupees", () => {
  it("round-trips through the input format", () => {
    for (const cents of [0, 5, 250, 1_000_000, 1_280_050]) {
      expect(rupeesToCents(centsToRupeesInput(cents))).toBe(cents);
    }
    expect(centsToRupeesInput(250)).toBe("2.50");
    expect(centsToRupeesInput(1_000_000)).toBe("10000");
  });

  it("formats for display", () => {
    expect(formatRupees(1_000_000)).toBe("Rs. 10,000");
    expect(formatRupees(250)).toBe("Rs. 2.50");
    expect(formatRupees(1_280_005)).toBe("Rs. 12,800.05");
    expect(formatRupees(0)).toBe("Rs. 0");
    expect(formatRupees(-1500)).toBe("-Rs. 15");
  });
});
