import { describe, expect, it } from "vitest";

import { formatReceiptNo, receiptSeq } from "./receipt-number";

describe("receipt numbers (decision 44)", () => {
  it("prefix and a 6-digit sequence, like invoice numbers", () => {
    expect(formatReceiptNo(1)).toBe("RCT-000001");
    expect(formatReceiptNo(123_456)).toBe("RCT-123456");
    expect(formatReceiptNo(1_234_567)).toBe("RCT-1234567");
    expect(formatReceiptNo(42, "R/")).toBe("R/000042");
  });

  it("refuses a sequence below 1 and an unsafe prefix", () => {
    expect(() => formatReceiptNo(0)).toThrow();
    expect(() => formatReceiptNo(1.5)).toThrow();
    expect(() => formatReceiptNo(1, "RCT 2026 long!")).toThrow();
  });

  it("reads the sequence back", () => {
    expect(receiptSeq("RCT-000017")).toBe(17);
    expect(receiptSeq("INV-000017")).toBeNull();
    expect(receiptSeq("RCT-17")).toBeNull();
  });
});
