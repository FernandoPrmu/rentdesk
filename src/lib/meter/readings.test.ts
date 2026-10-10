import { describe, expect, it } from "vitest";

import type { MeterContext } from "../billing/meter-invoice";
import { describeChange, parseReading, parseTyped, previewReading } from "./readings";

const at = "2026-01-01T00:00:00Z";
const MONO: MeterContext = {
  terms: { machineType: "MONO", commitmentCents: 500_000, bwIncluded: 2000, bwRateCents: 250, colourIncluded: null, colourRateCents: null },
  cyclesCovered: 1,
  counters: { BW: { known: [{ value: 5000, at, source: "INITIAL" }], counterMax: null, history: [] } },
  estimateCredits: [],
  credits: [],
};
const COLOUR: MeterContext = {
  terms: { machineType: "COLOUR", commitmentCents: 1_000_000, bwIncluded: 3000, bwRateCents: 200, colourIncluded: 500, colourRateCents: 1000 },
  cyclesCovered: 1,
  counters: {
    BW: { known: [{ value: 1000, at, source: "INITIAL" }], counterMax: null, history: [] },
    COLOUR: { known: [{ value: 200, at, source: "INITIAL" }], counterMax: null, history: [] },
  },
  estimateCredits: [],
  credits: [],
};

describe("typed readings (INV-02, spec 6.4)", () => {
  it("accepts digits with commas or spaces", () => {
    expect(parseReading("12,500", "B&W")).toEqual({ ok: true, value: 12500 });
    expect(parseReading(" 12 500 ", "B&W")).toEqual({ ok: true, value: 12500 });
    expect(parseReading("0", "B&W")).toEqual({ ok: true, value: 0 });
  });

  it("refuses empty, decimals, negatives, letters and absurd lengths", () => {
    expect(parseReading("", "B&W")).toEqual({ ok: false, error: "Type the B&W reading" });
    for (const bad of ["12.5", "-3", "12a", "1e5"]) expect(parseReading(bad, "B&W").ok, bad).toBe(false);
    expect(parseReading("1234567890", "B&W")).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
  });

  it("a colour machine needs both counters, a mono machine only B&W", () => {
    expect(parseTyped("COLOUR", { bw: "4400", colour: "" })).toEqual({ ok: false, errors: { colour: "Type the colour reading" } });
    expect(parseTyped("MONO", { bw: "7600", colour: "ignored" })).toEqual({ ok: true, readings: { BW: 7600, COLOUR: null } });
  });
});

describe("preview before sending (INV-04, INV-05)", () => {
  it("spec 6.3 mono case 2: 2,600 copies → Rs. 6,500", () => {
    const p = previewReading(MONO, { bw: "7600", colour: "" });
    expect(p.ok && p.result.totalCents).toBe(650_000);
    expect(p.ok && p.counters).toEqual([expect.objectContaining({ counter: "BW", previous: 5000, current: 7600, usage: 2600, excess: 600, warning: null })]);
  });

  it("spec 6.3 colour case 2: Rs. 12,800", () => {
    const p = previewReading(COLOUR, { bw: "4400", colour: "900" });
    expect(p.ok && p.result.totalCents).toBe(1_280_000);
  });

  it("a reading lower than the previous one blocks, on its own field", () => {
    expect(previewReading(MONO, { bw: "4999", colour: "" })).toEqual({
      ok: false,
      errors: { bw: "The B&W reading is lower than last time. Please check the number on the meter." },
    });
    expect(previewReading(COLOUR, { bw: "4400", colour: "100" })).toMatchObject({ ok: false, errors: { colour: expect.stringMatching(/lower than last time/) } });
  });

  it("unusual usage warns but does not block", () => {
    const history = { ...MONO, counters: { BW: { ...MONO.counters.BW!, history: [1000, 1100, 900, 1000] } } };
    const high = previewReading(history, { bw: String(5000 + 6000), colour: "" });
    expect(high.ok && high.counters[0].warning).toBe("Much higher than usual. Please check the number.");
    const zero = previewReading(MONO, { bw: "5000", colour: "" });
    expect(zero.ok && zero.counters[0].warning).toMatch(/No copies since last time/);
  });

  it("describes a correction as old → new", () => {
    expect(describeChange("BW", 12500, 12050)).toBe("B&W 12,500 → 12,050");
  });
});
