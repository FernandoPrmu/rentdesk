import { describe, expect, it } from "vitest";

import { type AllocatableInvoice, describePlan, planAllocation } from "./allocation";
import { formatRupees } from "../money";

const inv = (id: string, dueDate: string | null, balanceCents: number, seq: number | null = null): AllocatableInvoice => ({
  id,
  invoiceNo: `INV-${id}`,
  dueDate,
  seq,
  balanceCents,
});

describe("planAllocation (decision 39)", () => {
  const bills = [inv("b", "2026-10-20", 650_000, 2), inv("a", "2026-10-05", 1_280_000, 1), inv("c", null, 100_000, 3)];

  it("pays the oldest due first, each up to its balance", () => {
    expect(planAllocation(1_500_000, bills)).toEqual({
      allocations: [
        { invoiceId: "a", invoiceNo: "INV-a", cents: 1_280_000, balanceAfterCents: 0, paidInFull: true },
        { invoiceId: "b", invoiceNo: "INV-b", cents: 220_000, balanceAfterCents: 430_000, paidInFull: false },
      ],
      creditCents: 0,
      leftOut: ["c"],
    });
  });

  it("an exact total pays every bill; bills without a due date come last", () => {
    const plan = planAllocation(2_030_000, bills);
    expect(plan.allocations.map((a) => [a.invoiceId, a.paidInFull])).toEqual([
      ["a", true],
      ["b", true],
      ["c", true],
    ]);
    expect(plan.creditCents).toBe(0);
  });

  it("an overpayment becomes credit", () => {
    expect(planAllocation(2_100_000, bills).creditCents).toBe(70_000);
  });

  it("no bills: everything is credit (an advance)", () => {
    expect(planAllocation(50_000, [])).toEqual({ allocations: [], creditCents: 50_000, leftOut: [] });
  });

  it("ties on the due date go by invoice number, then id", () => {
    const tied = [inv("y", "2026-10-05", 100, 9), inv("x", "2026-10-05", 100, 4), inv("w", "2026-10-05", 100, null)];
    expect(planAllocation(150, tied).allocations.map((a) => [a.invoiceId, a.cents])).toEqual([
      ["x", 100],
      ["y", 50],
    ]);
  });

  it("a bill with nothing left takes nothing", () => {
    expect(planAllocation(100, [inv("z", "2026-01-01", 0), inv("q", "2026-02-01", 500)]).allocations.map((a) => a.invoiceId)).toEqual(["q"]);
  });

  it("refuses fractions of a cent and negative amounts", () => {
    expect(() => planAllocation(1.5, bills)).toThrow();
    expect(() => planAllocation(-1, bills)).toThrow();
  });

  it("describes the plan in one line", () => {
    expect(describePlan(planAllocation(1_500_000, bills), formatRupees)).toBe("Pays INV-a in full, Rs. 2,200 of INV-b.");
    expect(describePlan(planAllocation(2_100_000, bills), formatRupees)).toBe(
      "Pays INV-a in full, INV-b in full, INV-c in full. Rs. 700 is kept as credit for your next bills.",
    );
  });
});
