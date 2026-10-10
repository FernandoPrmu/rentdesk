import { describe, expect, it } from "vitest";

import { formatInvoiceCount, formatInvoiceDate, formatInvoiceMoney } from "./format";

describe("invoice money format", () => {
  it("always shows rupees with two decimals and thousands separators", () => {
    expect(formatInvoiceMoney(1_280_000)).toBe("Rs. 12,800.00"); // spec 6.3 colour case 2
    expect(formatInvoiceMoney(650_000)).toBe("Rs. 6,500.00"); // mono case 2
    expect(formatInvoiceMoney(250)).toBe("Rs. 2.50");
    expect(formatInvoiceMoney(5)).toBe("Rs. 0.05");
    expect(formatInvoiceMoney(0)).toBe("Rs. 0.00");
    expect(formatInvoiceMoney(123_456_789)).toBe("Rs. 1,234,567.89");
  });

  it("shows credits as negative amounts", () => {
    expect(formatInvoiceMoney(-200_000)).toBe("-Rs. 2,000.00");
    expect(formatInvoiceMoney(-1)).toBe("-Rs. 0.01");
  });

  it("refuses fractions of a cent (money is integer cents)", () => {
    expect(() => formatInvoiceMoney(12.5)).toThrow(/whole cents/);
    expect(() => formatInvoiceMoney(Number.NaN)).toThrow();
  });

  it("formats dates and counts", () => {
    expect(formatInvoiceDate("2026-10-08")).toBe("8 Oct 2026");
    expect(formatInvoiceDate("2026-12-31T23:00:00Z")).toBe("31 Dec 2026");
    expect(formatInvoiceCount(12_500)).toBe("12,500");
    expect(formatInvoiceCount(0)).toBe("0");
  });
});
