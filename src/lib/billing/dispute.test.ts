import { describe, expect, it } from "vitest";

import { buildCorrectedInvoice, creditOnIssuedInvoice, type OriginalInvoice, type StoredCalculation } from "./dispute.ts";
import { BillingError } from "./errors.ts";
import { calculateInvoice, type Terms } from "./invoice.ts";
import { buildMeterSubmission } from "./meter-invoice.ts";
import { carriedCopies, type KnownReading } from "./usage.ts";

const RS = (rupees: number) => rupees * 100;

const COLOUR: Terms = {
  machineType: "COLOUR",
  commitmentCents: RS(10_000),
  bwIncluded: 3000,
  bwRateCents: RS(2),
  colourIncluded: 500,
  colourRateCents: RS(10),
};
const MONO: Terms = { ...COLOUR, machineType: "MONO", commitmentCents: RS(5000), bwIncluded: 2000, bwRateCents: 250, colourIncluded: null, colourRateCents: null };
const at = (h: number) => `2026-10-01T0${h}:00:00Z`;

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    return e as BillingError;
  }
  throw new Error("expected an error");
}

/** Spec 6.3 colour case 2 (Rs. 12,800) as it was issued, from its stored calculation. */
function issuedColour(paidCents = 0): OriginalInvoice {
  const s = buildMeterSubmission(
    {
      terms: COLOUR,
      cyclesCovered: 1,
      counters: {
        BW: { known: [{ value: 1000, at: at(1), source: "INITIAL" }], counterMax: null, history: [] },
        COLOUR: { known: [{ value: 200, at: at(1), source: "INITIAL" }], counterMax: null, history: [] },
      },
      estimateCredits: [],
      credits: [],
    },
    { BW: 4400, COLOUR: 900 },
  );
  expect(s.invoice.total_cents).toBe(RS(12_800));
  return { invoiceNo: "INV-000041", type: "NORMAL", totalCents: s.invoice.total_cents, amountPaidCents: paidCents, calculation: s.invoice.calculation as unknown as StoredCalculation };
}

describe("give a credit on a disputed bill (rule 48)", () => {
  const bill = { totalCents: RS(12_800), amountPaidCents: 0, creditAppliedCents: 0 };

  it("takes the credit off the bill as a CREDIT line linked to the credit", () => {
    const r = creditOnIssuedInvoice(bill, "c1", RS(2000));
    expect(r.line).toEqual({ line_type: "CREDIT", description: "Credit given (dispute)", quantity: 1, rate_cents: -RS(2000), amount_cents: -RS(2000), credit_id: "c1" });
    expect(r).toMatchObject({ appliedCents: RS(2000), leftOverCents: 0, totalCents: RS(10_800), creditAppliedCents: RS(2000), balanceCents: RS(10_800), settled: false });
  });

  it("never takes more than is left to pay; the rest stays a credit for the next bills", () => {
    const partly = { ...bill, amountPaidCents: RS(10_000), creditAppliedCents: RS(500) };
    const r = creditOnIssuedInvoice(partly, "c1", RS(5000));
    expect(r).toMatchObject({ appliedCents: RS(2800), leftOverCents: RS(2200), totalCents: RS(10_000), creditAppliedCents: RS(3300), balanceCents: 0, settled: true });
  });

  it("a credit equal to what is left settles the bill", () => {
    expect(creditOnIssuedInvoice(bill, "c1", RS(12_800))).toMatchObject({ totalCents: 0, balanceCents: 0, leftOverCents: 0, settled: true });
  });

  it("refuses a zero, negative or fractional credit, and a bill with nothing left", () => {
    expect(errorOf(() => creditOnIssuedInvoice(bill, "c1", 0)).message).toMatch(/more than zero/);
    expect(() => creditOnIssuedInvoice(bill, "c1", -5)).toThrow(BillingError);
    expect(() => creditOnIssuedInvoice(bill, "c1", 1.5)).toThrow(BillingError);
    expect(errorOf(() => creditOnIssuedInvoice({ ...bill, amountPaidCents: RS(12_800) }, "c1", 100)).message).toMatch(/Nothing is left/);
  });
});

describe("a corrected invoice carries the service charges of the bill it replaces (decision 59)", () => {
  it("keeps the charge line; the correction's own adjustments come first", () => {
    const original = issuedColour();
    const withCharge: OriginalInvoice = {
      ...original,
      totalCents: original.totalCents + RS(1500),
      calculation: { ...original.calculation!, service_charges: [{ id: "sr-1", description: "Drum unit", amount_cents: RS(1500) }] },
    };
    const r = buildCorrectedInvoice(withCharge, { readings: null, adjustments: [{ description: "Goodwill", amountCents: -RS(300) }], credits: [], paidCreditId: null });
    expect(r.invoice.lines.filter((l) => l.line_type === "ADJUSTMENT").map((l) => [l.description, l.amount_cents])).toEqual([
      ["Goodwill", -RS(300)],
      ["Drum unit", RS(1500)],
    ]);
    expect(r.invoice.total_cents).toBe(RS(12_800 + 1500 - 300));
    expect((r.invoice.calculation as { service_charges: unknown[] }).service_charges).toEqual([{ id: "sr-1", description: "Drum unit", amount_cents: RS(1500) }]);
  });
});

describe("correct an issued invoice: cancel and reissue (rule 49)", () => {
  it("recalculates from the original's facts with the corrected reading (B&W 4,400 → 4,000)", () => {
    const r = buildCorrectedInvoice(issuedColour(), { readings: { BW: 4000, COLOUR: 900 }, adjustments: [], credits: [], paidCreditId: null });
    // B&W 3,000 used: within 3,000 included; colour 700: 200 × Rs. 10.
    expect(r.invoice.total_cents).toBe(RS(12_000));
    expect(r.readings).toEqual([
      { counter_type: "BW", previous_value: 1000, current_value: 4000, rolled_over: false },
      { counter_type: "COLOUR", previous_value: 200, current_value: 900, rolled_over: false },
    ]);
    expect(r.summary).toEqual({ oldTotalCents: RS(12_800), paidCents: 0, newTotalCents: RS(12_000), toPayCents: RS(12_000), changes: [{ counter: "BW", from: 4400, to: 4000 }] });
    expect(r.invoice.calculation).toMatchObject({ terms: (issuedColour().calculation as StoredCalculation).terms, cycles_covered: 1, full_cycles: 1, partial: null });
  });

  it("money already paid becomes a credit taken off the corrected bill (spec 11.4)", () => {
    const r = buildCorrectedInvoice(issuedColour(RS(5000)), { readings: { BW: 4000, COLOUR: 900 }, adjustments: [], credits: [], paidCreditId: "paid" });
    expect(r.invoice.subtotal_cents).toBe(RS(12_000));
    expect(r.invoice.credit_applied_cents).toBe(RS(5000));
    expect(r.summary).toMatchObject({ paidCents: RS(5000), newTotalCents: RS(7000), toPayCents: RS(7000) });
    expect(r.invoice.lines.at(-1)).toMatchObject({ line_type: "CREDIT", amount_cents: -RS(5000), credit_id: "paid", description: "Credit applied (paid on INV-000041)" });
  });

  it("older customer credits come first; the paid money is the newest credit; a surplus stays credit", () => {
    const r = buildCorrectedInvoice(issuedColour(RS(12_800)), {
      readings: null,
      adjustments: [{ description: "Rate error: colour charged twice", amountCents: -RS(2000) }],
      credits: [{ id: "old", amountCents: RS(1000), label: "advance payment" }],
      paidCreditId: "paid",
    });
    expect(r.readings).toBeNull();
    expect(r.invoice.subtotal_cents).toBe(RS(10_800));
    expect(r.result.creditsApplied).toEqual([
      { id: "old", amountCents: RS(1000), remainingCents: 0 },
      { id: "paid", amountCents: RS(9800), remainingCents: RS(3000) },
    ]);
    expect(r.invoice.total_cents).toBe(0);
  });

  it("an adjustment line adds or takes off money; it cannot make the bill negative", () => {
    const up = buildCorrectedInvoice(issuedColour(), { readings: null, adjustments: [{ description: "Missed toner charge", amountCents: RS(1500) }], credits: [], paidCreditId: null });
    expect(up.invoice.total_cents).toBe(RS(14_300));
    expect(up.invoice.lines.find((l) => l.line_type === "ADJUSTMENT")).toEqual({ line_type: "ADJUSTMENT", description: "Missed toner charge", quantity: 1, rate_cents: RS(1500), amount_cents: RS(1500) });
    expect(() => buildCorrectedInvoice(issuedColour(), { readings: null, adjustments: [{ description: "x", amountCents: -RS(20_000) }], credits: [], paidCreditId: null })).toThrow(/negative/);
  });

  it("keeps the owner's removed credits removed", () => {
    const original = issuedColour();
    original.calculation = { ...(original.calculation as StoredCalculation), credits_excluded: ["kept-for-refund"] };
    const r = buildCorrectedInvoice(original, {
      readings: null,
      adjustments: [{ description: "Fix", amountCents: -100 }],
      credits: [{ id: "kept-for-refund", amountCents: RS(500) }],
      paidCreditId: null,
    });
    expect(r.invoice.credit_applied_cents).toBe(0);
    expect(r.invoice.calculation).toMatchObject({ credits: [], credits_excluded: ["kept-for-refund"] });
  });

  it("an estimated invoice is corrected with adjustments only", () => {
    const est = calculateInvoice({ terms: MONO, kind: "ESTIMATED", fullCycles: 1 });
    const original: OriginalInvoice = { invoiceNo: "INV-7", type: "ESTIMATED", totalCents: est.totalCents, amountPaidCents: 0, calculation: est.calculation as unknown as StoredCalculation };
    expect(errorOf(() => buildCorrectedInvoice(original, { readings: { BW: 5 }, adjustments: [], credits: [], paidCreditId: null })).message).toMatch(/adjustment line/);
    const r = buildCorrectedInvoice(original, { readings: null, adjustments: [{ description: "Half month only", amountCents: -RS(2500) }], credits: [], paidCreditId: null });
    expect(r.invoice).toMatchObject({ type: "ESTIMATED", total_cents: RS(2500) });
  });

  it("refuses nothing to change, the same reading, a missing counter, and a paid amount without its credit", () => {
    expect(errorOf(() => buildCorrectedInvoice(issuedColour(), { readings: null, adjustments: [], credits: [], paidCreditId: null })).message).toMatch(/Change a reading/);
    expect(errorOf(() => buildCorrectedInvoice(issuedColour(), { readings: { BW: 4400, COLOUR: 900 }, adjustments: [], credits: [], paidCreditId: null })).message).toMatch(/same as before/);
    expect(errorOf(() => buildCorrectedInvoice(issuedColour(), { readings: { BW: 4000 }, adjustments: [], credits: [], paidCreditId: null })).code).toBe("MISSING_READING");
    expect(errorOf(() => buildCorrectedInvoice(issuedColour(RS(100)), { readings: { BW: 4000, COLOUR: 900 }, adjustments: [], credits: [], paidCreditId: null })).message).toMatch(/already paid/);
    expect(errorOf(() => buildCorrectedInvoice(issuedColour(), { readings: { BW: 900, COLOUR: 900 }, adjustments: [], credits: [], paidCreditId: null })).code).toBe("READING_BELOW_PREVIOUS");
    expect(errorOf(() => buildCorrectedInvoice({ ...issuedColour(), calculation: null }, { readings: null, adjustments: [{ description: "x", amountCents: 1 }], credits: [], paidCreditId: null })).message).toMatch(/no stored calculation/);
  });
});

describe("meter replaced: copies on the old meter are carried into the next bill (rule 51)", () => {
  const known = (extra: KnownReading[]): KnownReading[] => [{ value: 50_000, at: at(1), source: "READING" }, ...extra];

  it("counts the baselines recorded since the last reading (a baseline wins a tie)", () => {
    expect(carriedCopies(known([]))).toBe(0);
    expect(carriedCopies(known([{ value: 0, at: at(2), source: "BASELINE", carried: 1200 }]))).toBe(1200);
    expect(carriedCopies(known([{ value: 0, at: at(1), source: "BASELINE", carried: 300 }]))).toBe(300);
    // Two replacements before a reading: both carried.
    expect(carriedCopies(known([{ value: 0, at: at(2), source: "BASELINE", carried: 100 }, { value: 0, at: at(3), source: "BASELINE", carried: 50 }]))).toBe(150);
    // A baseline before the last reading was billed already.
    expect(carriedCopies([{ value: 0, at: at(1), source: "BASELINE", carried: 999 }, { value: 2000, at: at(2), source: "READING" }])).toBe(0);
  });

  it("bills new-meter usage plus the carried copies, with the included copies applied once", () => {
    const s = buildMeterSubmission(
      {
        terms: MONO,
        cyclesCovered: 1,
        counters: { BW: { known: known([{ value: 0, at: at(2), source: "BASELINE", carried: 1200 }]), counterMax: null, history: [] } },
        estimateCredits: [],
        credits: [],
      },
      { BW: 1400 },
    );
    // From the baseline 0 to 1,400 plus 1,200 on the old meter = 2,600: 600 above 2,000 × Rs. 2.50.
    expect(s.readings).toEqual([{ counter_type: "BW", previous_value: 0, current_value: 1400, rolled_over: false }]);
    expect(s.result.counters[0]).toMatchObject({ usage: 2600, carried: 1200, excess: 600 });
    expect(s.invoice.total_cents).toBe(RS(6500));
    expect(s.invoice.calculation).toMatchObject({ counters: [{ previous_value: 0, carried_copies: 1200, usage: 2600 }] });
    expect(s.invoice.lines[1].description).toBe("B&W copies above 2,000 included (incl. 1,200 on the replaced meter)");
  });
});
