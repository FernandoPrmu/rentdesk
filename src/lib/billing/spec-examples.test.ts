import { describe, expect, it } from "vitest";

import { calculateInvoice, type Terms } from "./invoice.ts";

/**
 * Spec section 6.3, every worked example with the spec's exact amounts.
 * Amounts in the spec are rupees; the engine works in cents (Rs. 1 = 100).
 */

const RS = (rupees: number) => rupees * 100;

// Colour: commitment Rs. 10,000; 3,000 B&W and 500 colour included; Rs. 2 / B&W, Rs. 10 / colour.
const COLOUR: Terms = {
  machineType: "COLOUR",
  commitmentCents: RS(10_000),
  bwIncluded: 3000,
  bwRateCents: RS(2),
  colourIncluded: 500,
  colourRateCents: RS(10),
};

// Mono: commitment Rs. 5,000; 2,000 copies included; Rs. 2.50 per copy.
const MONO: Terms = {
  machineType: "MONO",
  commitmentCents: RS(5000),
  bwIncluded: 2000,
  bwRateCents: 250,
  colourIncluded: null,
  colourRateCents: null,
};

function colour(bwUsed: number, colourUsed: number) {
  return calculateInvoice({
    terms: COLOUR,
    kind: "NORMAL",
    fullCycles: 1,
    readings: {
      BW: { previous: 10_000, previousSource: "READING", current: 10_000 + bwUsed, counterMax: null, history: [] },
      COLOUR: { previous: 2000, previousSource: "READING", current: 2000 + colourUsed, counterMax: null, history: [] },
    },
  });
}

function mono(used: number) {
  return calculateInvoice({
    terms: MONO,
    kind: "NORMAL",
    fullCycles: 1,
    readings: { BW: { previous: 10_000, previousSource: "READING", current: 10_000 + used, counterMax: null, history: [] } },
  });
}

const amountOf = (r: ReturnType<typeof colour>, type: string) =>
  r.lines.filter((l) => l.line_type === type).reduce((s, l) => s + l.amount_cents, 0);

describe("spec 6.3 colour machine (Rs. 10,000; 3,000 B&W + 500 colour included; Rs. 2 / Rs. 10)", () => {
  it("case 1, within limits: 2,500 B&W, 300 colour -> B&W extra 0, colour extra 0, invoice Rs. 10,000", () => {
    const r = colour(2500, 300);
    expect(amountOf(r, "BW_EXCESS")).toBe(0);
    expect(amountOf(r, "COLOUR_EXCESS")).toBe(0);
    expect(r.totalCents).toBe(RS(10_000));
    // Spec 6.6: excess lines are hidden when zero.
    expect(r.lines.map((l) => l.line_type)).toEqual(["COMMITMENT"]);
  });

  it("case 2, both exceed: 3,400 B&W, 700 colour -> 400 x 2 = 800, 200 x 10 = 2,000, invoice Rs. 12,800", () => {
    const r = colour(3400, 700);
    expect(r.lines).toEqual([
      expect.objectContaining({ line_type: "COMMITMENT", amount_cents: RS(10_000) }),
      expect.objectContaining({ line_type: "BW_EXCESS", quantity: 400, rate_cents: RS(2), amount_cents: RS(800) }),
      expect.objectContaining({ line_type: "COLOUR_EXCESS", quantity: 200, rate_cents: RS(10), amount_cents: RS(2000) }),
    ]);
    expect(r.totalCents).toBe(RS(12_800));
  });

  it("case 3, only colour exceeds: 2,000 B&W, 800 colour -> B&W 0 (no credit), 300 x 10 = 3,000, invoice Rs. 13,000", () => {
    const r = colour(2000, 800);
    expect(amountOf(r, "BW_EXCESS")).toBe(0);
    expect(r.lines.some((l) => l.line_type === "CREDIT")).toBe(false); // 1,000 unused B&W copies give no credit
    expect(amountOf(r, "COLOUR_EXCESS")).toBe(RS(3000));
    expect(r.totalCents).toBe(RS(13_000));
  });
});

describe("spec 6.3 mono machine (Rs. 5,000; 2,000 included; Rs. 2.50)", () => {
  it("case 1, within limit: 1,800 copies -> excess 0, invoice Rs. 5,000", () => {
    const r = mono(1800);
    expect(r.excessCents).toBe(0);
    expect(r.totalCents).toBe(RS(5000));
  });

  it("case 2, above limit: 2,600 copies -> 600 x 2.50 = 1,500, invoice Rs. 6,500", () => {
    const r = mono(2600);
    expect(r.lines[1]).toMatchObject({ line_type: "BW_EXCESS", quantity: 600, rate_cents: 250, amount_cents: RS(1500) });
    expect(r.totalCents).toBe(RS(6500));
  });
});
