import { describe, expect, it } from "vitest";

import { BillingError } from "./errors.ts";
import { calculateInvoice, type CounterReadingInput, type InvoiceInput, type Terms } from "./invoice.ts";

const RS = (rupees: number) => rupees * 100;

const COLOUR: Terms = {
  machineType: "COLOUR",
  commitmentCents: RS(10_000),
  bwIncluded: 3000,
  bwRateCents: RS(2),
  colourIncluded: 500,
  colourRateCents: RS(10),
  cycleLengthDays: 30,
};
const MONO: Terms = { ...COLOUR, machineType: "MONO", commitmentCents: RS(5000), bwIncluded: 2000, bwRateCents: 250, colourIncluded: null, colourRateCents: null };

const reading = (previous: number, used: number, extra: Partial<CounterReadingInput> = {}): CounterReadingInput => ({
  previous,
  previousSource: "READING",
  current: previous + used,
  counterMax: null,
  history: [],
  ...extra,
});

const mono = (used: number, extra: Partial<InvoiceInput> = {}) =>
  calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 1, readings: { BW: reading(10_000, used) }, ...extra });

function errorOf(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    return e as BillingError;
  }
  throw new Error("expected an error");
}

/** Every invoice keeps the database invariants: amount = quantity x rate, lines add up. */
function expectConsistent(r: ReturnType<typeof calculateInvoice>) {
  for (const l of r.lines) expect(l.amount_cents).toBe(l.quantity * l.rate_cents);
  const nonCredit = r.lines.filter((l) => l.line_type !== "CREDIT").reduce((s, l) => s + l.amount_cents, 0);
  const credit = 0 - r.lines.filter((l) => l.line_type === "CREDIT").reduce((s, l) => s + l.amount_cents, 0);
  expect(nonCredit).toBe(r.subtotalCents);
  expect(credit).toBe(r.creditAppliedCents);
  expect(r.totalCents).toBe(r.subtotalCents + r.lateFeeCents - r.creditAppliedCents);
  expect(r.totalCents).toBeGreaterThanOrEqual(0);
}

describe("calculateInvoice: basics", () => {
  it("zero usage: commitment only, flagged ZERO (spec 11.4)", () => {
    const r = mono(0);
    expectConsistent(r);
    expect(r.totalCents).toBe(RS(5000));
    expect(r.anomaly).toBe("ZERO");
  });

  it("usage exactly at the included amount: no excess line", () => {
    const r = mono(2000);
    expect(r.lines.map((l) => l.line_type)).toEqual(["COMMITMENT"]);
    expect(r.counters[0]).toMatchObject({ usage: 2000, included: 2000, excess: 0 });
    expect(mono(2001).totalCents).toBe(RS(5000) + 250);
  });

  it("mono needs exactly a B&W reading; colour needs both", () => {
    expect(errorOf(() => calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 1, readings: { BW: reading(0, 1), COLOUR: reading(0, 1) } })).code).toBe(
      "UNEXPECTED_READING",
    );
    expect(errorOf(() => calculateInvoice({ terms: COLOUR, kind: "NORMAL", fullCycles: 1, readings: { BW: reading(0, 1) } })).code).toBe("MISSING_READING");
    expect(errorOf(() => calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 1, readings: {} })).code).toBe("MISSING_READING");
  });

  it("a reading going backwards is an error, not a negative invoice", () => {
    const e = errorOf(() => calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 1, readings: { BW: { ...reading(10_000, 0), current: 9_999 } } }));
    expect(e.code).toBe("READING_BELOW_PREVIOUS");
  });

  it("handles large numbers exactly (no floating point)", () => {
    const terms = { ...MONO, commitmentCents: 999_999_999_99, bwIncluded: 0, bwRateCents: 1_000_00 };
    const r = calculateInvoice({ terms, kind: "NORMAL", fullCycles: 1, readings: { BW: reading(0, 999_999_999) } });
    expect(r.totalCents).toBe(999_999_999_99 + 999_999_999 * 1_000_00);
    expectConsistent(r);
    // Beyond 2^53 cents the engine refuses rather than lose precision.
    expect(errorOf(() => calculateInvoice({ terms: { ...terms, bwRateCents: 100_000_000_00 }, kind: "NORMAL", fullCycles: 1, readings: { BW: reading(0, 999_999_999_999) } })).code).toBe(
      "INVALID_INPUT",
    );
  });

  it("records a rollover and asks the owner to confirm it", () => {
    const r = calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 1, readings: { BW: reading(999_000, 0, { current: 1_500, counterMax: 999_999 }) } });
    // (999,999 - 999,000) + 1 + 1,500 = 2,500 copies
    expect(r.counters[0]).toMatchObject({ usage: 2500, rolledOver: true });
    expect(r.rolloverToConfirm).toBe(true);
    expect(r.totalCents).toBe(RS(5000) + 500 * 250);
    expect(mono(100).rolloverToConfirm).toBe(false);
  });

  it("puts every input and result in the calculation record", () => {
    const r = mono(2600);
    expect(r.calculation).toMatchObject({
      engine: "rentdesk-billing-1",
      type: "NORMAL",
      cycles_covered: 1,
      terms: { commitment_cents: RS(5000), bw_included: 2000, bw_rate_cents: 250, colour_included: null, colour_rate_cents: null },
      counters: [{ counter_type: "BW", previous_value: 10_000, current_value: 12_600, usage: 2600, rolled_over: false, excess: 600 }],
    });
  });
});

describe("multiple or skipped cycles billed together (spec 6.4 / 11.6)", () => {
  it("multiplies commitment and included copies by the cycles covered", () => {
    // Two cycles: 2 x Rs. 10,000; 6,000 B&W and 1,000 colour included.
    const r = calculateInvoice({ terms: COLOUR, kind: "NORMAL", fullCycles: 2, readings: { BW: reading(0, 6500), COLOUR: reading(0, 900) } });
    expectConsistent(r);
    expect(r.cyclesCovered).toBe(2);
    expect(r.lines).toEqual([
      expect.objectContaining({ line_type: "COMMITMENT", quantity: 2, rate_cents: RS(10_000), amount_cents: RS(20_000) }),
      expect.objectContaining({ line_type: "BW_EXCESS", quantity: 500, amount_cents: RS(1000) }),
    ]);
    expect(r.totalCents).toBe(RS(21_000));
  });
});

describe("estimated billing and reconciliation (spec 11.6)", () => {
  it("an estimated invoice is the commitment only, marked ESTIMATED", () => {
    const r = calculateInvoice({ terms: COLOUR, kind: "ESTIMATED", fullCycles: 1 });
    expect(r.type).toBe("ESTIMATED");
    expect(r.lines).toEqual([expect.objectContaining({ line_type: "COMMITMENT", amount_cents: RS(10_000) })]);
    expect(r.totalCents).toBe(RS(10_000));
    expect(r.anomaly).toBeNull();
    expect(errorOf(() => calculateInvoice({ terms: COLOUR, kind: "ESTIMATED", fullCycles: 1, readings: { BW: reading(0, 1) } })).code).toBe("INVALID_INPUT");
  });

  it("the real reading covers both cycles and credits the estimated charge", () => {
    const estimate = calculateInvoice({ terms: COLOUR, kind: "ESTIMATED", fullCycles: 1 });
    // Measured from the last verified reading over 2 cycles: 7,000 B&W (6,000 included), 1,200 colour (1,000 included).
    const actual = calculateInvoice({
      terms: COLOUR,
      kind: "NORMAL",
      fullCycles: 2,
      readings: { BW: reading(10_000, 7000), COLOUR: reading(2000, 1200) },
      estimateCredits: [{ invoiceNo: "LCS-0007", cycleNo: 3, amountCents: estimate.totalCents }],
    });
    expectConsistent(actual);
    expect(actual.subtotalCents).toBe(RS(20_000) + RS(2000) + RS(2000));
    expect(actual.lines.at(-1)).toEqual({
      line_type: "CREDIT",
      description: "Estimated charge credited (LCS-0007)",
      quantity: 1,
      rate_cents: -RS(10_000),
      amount_cents: -RS(10_000),
    });
    expect(actual.totalCents).toBe(RS(14_000));
    // Over both invoices the customer pays exactly what two normal cycles cost.
    expect(estimate.totalCents + actual.totalCents).toBe(RS(24_000));
  });
});

describe("final invoice when a machine is returned mid-cycle (spec 11.4)", () => {
  it("PRORATED: commitment and included copies by days used, half up", () => {
    // 12 of 30 days: Rs. 10,000 x 12/30 = Rs. 4,000; 3,000 x 12/30 = 1,200 B&W; 500 x 12/30 = 200 colour.
    const r = calculateInvoice({
      terms: COLOUR,
      kind: "NORMAL",
      fullCycles: 0,
      partialCycle: { daysUsed: 12, rule: "PRORATED" },
      readings: { BW: reading(0, 1500), COLOUR: reading(0, 150) },
    });
    expectConsistent(r);
    expect(r.lines[0]).toMatchObject({ line_type: "COMMITMENT", description: "Commitment for 12 of 30 days (final cycle)", amount_cents: RS(4000) });
    expect(r.counters.map((c) => [c.counter, c.included, c.excess])).toEqual([
      ["BW", 1200, 300],
      ["COLOUR", 200, 0],
    ]);
    expect(r.totalCents).toBe(RS(4000) + RS(600));
  });

  it("PRORATED rounding: money half up to the cent, included copies half up to a copy", () => {
    // Rs. 5,000.01 x 1/2 = 250,000.5 cents -> 250,001; 2,001 copies x 1/2 = 1,000.5 -> 1,001.
    const terms = { ...MONO, commitmentCents: 500_001, bwIncluded: 2001, cycleLengthDays: 2 };
    const r = calculateInvoice({ terms, kind: "NORMAL", fullCycles: 0, partialCycle: { daysUsed: 1, rule: "PRORATED" }, readings: { BW: reading(0, 1001) } });
    expect(r.commitmentCents).toBe(250_001);
    expect(r.counters[0]).toMatchObject({ included: 1001, excess: 0 });
    // 1/3 of Rs. 100.00 = 3,333.33... cents -> 3,333 (rounds down below a half).
    const third = calculateInvoice({ terms: { ...MONO, commitmentCents: 10_000, cycleLengthDays: 3 }, kind: "NORMAL", fullCycles: 0, partialCycle: { daysUsed: 1, rule: "PRORATED" }, readings: { BW: reading(0, 0) } });
    expect(third.commitmentCents).toBe(3333);
  });

  it("FULL: the partial cycle is billed as a whole cycle", () => {
    const r = calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 0, partialCycle: { daysUsed: 5, rule: "FULL" }, readings: { BW: reading(0, 2600) } });
    expect(r.totalCents).toBe(RS(6500));
    expect(r.cyclesCovered).toBe(1);
  });

  it("whole missed cycles plus the final partial one", () => {
    const r = calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 1, partialCycle: { daysUsed: 15, rule: "PRORATED" }, readings: { BW: reading(0, 3000) } });
    expect(r.cyclesCovered).toBe(2);
    expect(r.commitmentCents).toBe(RS(5000) + RS(2500));
    expect(r.counters[0]).toMatchObject({ included: 3000, excess: 0 });
  });

  it("checks the days used", () => {
    for (const daysUsed of [0, 31]) {
      expect(errorOf(() => calculateInvoice({ terms: MONO, kind: "NORMAL", fullCycles: 0, partialCycle: { daysUsed, rule: "PRORATED" }, readings: { BW: reading(0, 1) } })).code).toBe(
        "INVALID_INPUT",
      );
    }
  });
});

describe("credits and adjustments (PAY-12, spec 11.4)", () => {
  it("applies credits oldest first, never below zero; a larger credit keeps its remainder", () => {
    const r = mono(2600, {
      credits: [
        { id: "c1", amountCents: RS(1000) },
        { id: "c2", amountCents: RS(9000) },
        { id: "c3", amountCents: RS(500) },
      ],
    });
    expectConsistent(r);
    expect(r.totalCents).toBe(0);
    expect(r.creditAppliedCents).toBe(RS(6500));
    expect(r.creditsApplied).toEqual([
      { id: "c1", amountCents: RS(1000), remainingCents: 0 },
      { id: "c2", amountCents: RS(5500), remainingCents: RS(3500) },
    ]);
  });

  it("adds adjustments (credit notes may be negative) but never a negative subtotal", () => {
    const r = mono(0, { adjustments: [{ description: "Toner not delivered", amountCents: -RS(500) }] });
    expectConsistent(r);
    expect(r.subtotalCents).toBe(RS(4500));
    expect(errorOf(() => mono(0, { adjustments: [{ description: "Too much", amountCents: -RS(6000) }] })).code).toBe("INVALID_INPUT");
  });
});
