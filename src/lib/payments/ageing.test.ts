import { describe, expect, it } from "vitest";

import { ageBucket, type AgeingInvoice, ageingReport, daysOverdue } from "./ageing";

const TODAY = "2026-10-11";

describe("ageing buckets (PAY-09, decision 45)", () => {
  it("counts days past the due date on the calendar", () => {
    expect(daysOverdue("2026-10-11", TODAY)).toBe(0);
    expect(daysOverdue("2026-10-10", TODAY)).toBe(1);
    expect(daysOverdue("2026-10-20", TODAY)).toBe(-9);
    expect(daysOverdue(null, TODAY)).toBe(0);
  });

  it("current, 1-30, 31-60, 60+ at their edges", () => {
    const at = (dueDate: string | null) => ageBucket({ status: "OVERDUE", dueDate }, TODAY);
    expect(at("2026-10-12")).toBe("CURRENT");
    expect(at(TODAY)).toBe("CURRENT"); // due today is not overdue yet
    expect(at("2026-10-10")).toBe("D1_30"); // 1 day
    expect(at("2026-09-11")).toBe("D1_30"); // 30 days
    expect(at("2026-09-10")).toBe("D31_60"); // 31 days
    expect(at("2026-08-12")).toBe("D31_60"); // 60 days
    expect(at("2026-08-11")).toBe("D60_PLUS"); // 61 days
    expect(at(null)).toBe("CURRENT");
  });

  it("a bill with a slip waiting is current (spec 8.2); a disputed one ages", () => {
    expect(ageBucket({ status: "PAYMENT_SUBMITTED", dueDate: "2026-01-01" }, TODAY)).toBe("CURRENT");
    expect(ageBucket({ status: "DISPUTED", dueDate: "2026-09-01" }, TODAY)).toBe("D31_60");
  });
});

describe("ageingReport", () => {
  const bill = (id: string, customerId: string, dueDate: string, balanceCents: number, status = "AWAITING_PAYMENT"): AgeingInvoice => ({
    id,
    invoiceNo: `INV-${id}`,
    customerId,
    customerName: customerId === "c1" ? "Silva Traders" : "Abeysekara",
    status,
    dueDate,
    balanceCents,
  });

  it("totals per customer and overall, the most overdue first", () => {
    const report = ageingReport(
      [
        bill("1", "c1", "2026-10-20", 100_000),
        bill("2", "c1", "2026-10-01", 50_000, "OVERDUE"),
        bill("3", "c2", "2026-07-01", 75_000, "OVERDUE"),
        bill("4", "c2", "2026-09-01", 20_000, "PAYMENT_SUBMITTED"),
        bill("5", "c2", "2026-09-01", 0, "PARTIALLY_PAID"),
      ],
      TODAY,
    );
    expect(report.customers.map((c) => c.customerId)).toEqual(["c2", "c1"]);
    expect(report.customers[0]).toEqual({
      customerId: "c2",
      customerName: "Abeysekara",
      buckets: { CURRENT: 20_000, D1_30: 0, D31_60: 0, D60_PLUS: 75_000 },
      totalCents: 95_000,
      slipWaitingCents: 20_000,
      invoices: 2,
      oldestDays: 102,
    });
    expect(report.customers[1].buckets).toEqual({ CURRENT: 100_000, D1_30: 50_000, D31_60: 0, D60_PLUS: 0 });
    expect(report.totals).toEqual({ CURRENT: 120_000, D1_30: 50_000, D31_60: 0, D60_PLUS: 75_000, total: 245_000, slipWaiting: 20_000 });
  });

  it("nothing outstanding: an empty report", () => {
    expect(ageingReport([], TODAY)).toEqual({ customers: [], totals: { CURRENT: 0, D1_30: 0, D31_60: 0, D60_PLUS: 0, total: 0, slipWaiting: 0 } });
  });
});
