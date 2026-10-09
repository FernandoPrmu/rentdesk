import { describe, expect, it } from "vitest";

import { deductibleCents, defaultSettlement, type DepositInvoice, planSettlement } from "./settlement";

const RS = (rupees: number) => rupees * 100;

const invoices: DepositInvoice[] = [
  { id: "i1", invoiceNo: "INV-1", balanceCents: RS(3000), deductible: true },
  { id: "i2", invoiceNo: "INV-2", balanceCents: RS(4000), deductible: false }, // slip waiting
  { id: "i3", invoiceNo: "INV-3", balanceCents: RS(2500), deductible: true },
];

describe("deposit settlement (DEP-03/04)", () => {
  it("only deducts invoices without a slip waiting or a dispute", () => {
    expect(deductibleCents(invoices)).toBe(RS(5500));
  });

  it("suggests paying what it can and refunding the rest", () => {
    expect(defaultSettlement(RS(10_000), invoices)).toEqual({ deductCents: RS(5500), refundCents: RS(4500), retainCents: 0 });
    // A small deposit goes entirely to the bills.
    expect(defaultSettlement(RS(1000), invoices)).toEqual({ deductCents: RS(1000), refundCents: 0, retainCents: 0 });
    expect(defaultSettlement(RS(1000), [])).toEqual({ deductCents: 0, refundCents: RS(1000), retainCents: 0 });
  });

  it("allocates the deduction oldest due first, skipping invoices that cannot be deducted", () => {
    const plan = planSettlement(RS(10_000), invoices, { deductCents: RS(4000), refundCents: RS(5000), retainCents: RS(1000) }, "Scratched cover");
    expect(plan).toEqual({
      ok: true,
      allocations: [
        { invoiceId: "i1", invoiceNo: "INV-1", amountCents: RS(3000), paidInFull: true },
        { invoiceId: "i3", invoiceNo: "INV-3", amountCents: RS(1000), paidInFull: false },
      ],
    });
  });

  it("always balances: deduct + refund + retain = held", () => {
    const plan = planSettlement(RS(10_000), invoices, { deductCents: RS(5000), refundCents: RS(4000), retainCents: 0 }, null);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.form).toMatch(/must equal the deposit held \(Rs\. 10,000\); now Rs\. 9,000/);
    // Exactly balanced, everything refunded.
    expect(planSettlement(RS(10_000), invoices, { deductCents: 0, refundCents: RS(10_000), retainCents: 0 }, null)).toEqual({ ok: true, allocations: [] });
    // Everything kept (with a reason).
    expect(planSettlement(RS(10_000), [], { deductCents: 0, refundCents: 0, retainCents: RS(10_000) }, "Machine damaged").ok).toBe(true);
  });

  it("refuses deducting more than the deductible balance", () => {
    const plan = planSettlement(RS(10_000), invoices, { deductCents: RS(6000), refundCents: RS(4000), retainCents: 0 }, null);
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.deduct).toMatch(/At most Rs\. 5,500/);
  });

  it("needs a reason to retain, and a deposit to settle", () => {
    const plan = planSettlement(RS(1000), [], { deductCents: 0, refundCents: RS(500), retainCents: RS(500) }, "  ");
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.errors.retain).toBeDefined();
    const none = planSettlement(0, [], { deductCents: 0, refundCents: 0, retainCents: 0 }, null);
    expect(none.ok).toBe(false);
  });

  it("refuses negative or fractional amounts", () => {
    expect(planSettlement(RS(1000), [], { deductCents: -1, refundCents: RS(1000) + 1, retainCents: 0 }, null).ok).toBe(false);
    expect(planSettlement(RS(1000), [], { deductCents: 0.5, refundCents: RS(1000) - 0.5, retainCents: 0 }, null).ok).toBe(false);
  });
});
