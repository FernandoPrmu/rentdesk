import { describe, expect, it } from "vitest";

import { addLateFee, lateFeeDue, lateFeeFrom, type LateFeeInvoice } from "./late-fee.ts";

const settings = { enabled: true, feeCents: 50_000, graceDays: 7 };
const invoice: LateFeeInvoice = {
  status: "OVERDUE",
  dueDate: "2026-10-10",
  subtotalCents: 650_000,
  lateFeeCents: 0,
  creditAppliedCents: 0,
  totalCents: 650_000,
  amountPaidCents: 0,
  slipAwaitingVerification: false,
};

describe("late fee (PAY-13; rule in docs/decisions.md)", () => {
  it("applies from the day after due date + grace period", () => {
    expect(lateFeeFrom("2026-10-10", 7)).toBe("2026-10-18");
    expect(lateFeeDue(invoice, settings, "2026-10-17")).toBe(false);
    expect(lateFeeDue(invoice, settings, "2026-10-18")).toBe(true);
    expect(lateFeeFrom("2028-02-25", 3)).toBe("2028-02-29");
  });

  it("is added once, as a LATE_FEE line, on top of the total after credits", () => {
    const withCredit = { ...invoice, creditAppliedCents: 100_000, totalCents: 550_000 };
    expect(addLateFee(withCredit, 50_000)).toEqual({
      line: { line_type: "LATE_FEE", description: "Late payment fee", quantity: 1, rate_cents: 50_000, amount_cents: 50_000 },
      lateFeeCents: 50_000,
      totalCents: 600_000,
    });
    expect(lateFeeDue({ ...invoice, lateFeeCents: 50_000 }, settings, "2026-12-01")).toBe(false);
    expect(() => addLateFee({ ...invoice, lateFeeCents: 50_000 }, 50_000)).toThrow();
  });

  it("is not charged while a slip waits, while disputed, when paid, or when disabled", () => {
    const late = "2026-11-30";
    expect(lateFeeDue({ ...invoice, slipAwaitingVerification: true }, settings, late)).toBe(false);
    expect(lateFeeDue({ ...invoice, status: "PAYMENT_SUBMITTED" }, settings, late)).toBe(false);
    expect(lateFeeDue({ ...invoice, status: "DISPUTED" }, settings, late)).toBe(false);
    expect(lateFeeDue({ ...invoice, status: "PAID", amountPaidCents: 650_000 }, settings, late)).toBe(false);
    expect(lateFeeDue({ ...invoice, amountPaidCents: 650_000 }, settings, late)).toBe(false);
    expect(lateFeeDue(invoice, { ...settings, enabled: false }, late)).toBe(false);
    expect(lateFeeDue(invoice, { ...settings, feeCents: 0 }, late)).toBe(false);
    // Partly paid invoices still get it.
    expect(lateFeeDue({ ...invoice, status: "PARTIALLY_PAID", amountPaidCents: 100_000 }, settings, late)).toBe(true);
  });
});
