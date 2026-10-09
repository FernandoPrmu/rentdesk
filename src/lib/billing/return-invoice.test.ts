import { describe, expect, it } from "vitest";

import { finalCycle } from "../agreements/cycle-calendar.ts";
import type { Terms } from "./invoice.ts";
import { buildMeterSubmission, type MeterContext } from "./meter-invoice.ts";
import { buildReturnInvoice, type ReturnContext } from "./return-invoice.ts";

const RS = (rupees: number) => rupees * 100;
const MONO: Terms = { machineType: "MONO", commitmentCents: RS(5000), bwIncluded: 2000, bwRateCents: 250, colourIncluded: null, colourRateCents: null };
const counters = { BW: { known: [{ value: 10_000, at: "2026-01-01T00:00:00Z", source: "READING" as const }], counterMax: null, history: [] } };

const context = (today: string, lastConfirmedCycle = 1, credits: ReturnContext["credits"] = []): ReturnContext => ({
  terms: MONO,
  dueDays: 7,
  final: finalCycle({ startDate: "2026-01-10", firstBillingDate: "2026-01-31", today, lastConfirmedCycle }),
  counters,
  estimateCredits: [],
  credits,
});

describe("final invoice on return (RET-01)", () => {
  it("prorates the cycle in progress by its real days (February: 28)", () => {
    // Cycle 2: 31 Jan - 27 Feb. Returned 13 Feb = 14 of 28 days -> half the commitment and included copies.
    const s = buildReturnInvoice(context("2026-02-13"), { closing: { BW: 11_500 }, rule: "PRORATED" })!;
    expect(s.result.commitmentCents).toBe(RS(2500));
    expect(s.result.counters[0]).toMatchObject({ included: 1000, usage: 1500, excess: 500 });
    expect(s.invoice.total_cents).toBe(RS(2500) + 500 * 250);
    expect(s.invoice.calculation).toMatchObject({ full_cycles: 0, cycles_covered: 1, partial: { days_used: 14, days_in_cycle: 28, rule: "PRORATED" } });
    expect(s.readings).toEqual([{ counter_type: "BW", previous_value: 10_000, current_value: 11_500, rolled_over: false }]);
  });

  it("the same 14 days in a 31-day cycle cost less", () => {
    // Cycle 3: 28 Feb - 30 Mar (31 days). Returned 13 Mar = 14 days.
    const s = buildReturnInvoice(context("2026-03-13", 2), { closing: { BW: 10_000 }, rule: "PRORATED" })!;
    expect(s.result.commitmentCents).toBe(225_806); // 500,000 x 14 / 31, half up
  });

  it("FULL bills the cycle in progress as a whole cycle", () => {
    const s = buildReturnInvoice(context("2026-02-13"), { closing: { BW: 12_600 }, rule: "FULL" })!;
    expect(s.invoice.total_cents).toBe(RS(6500));
  });

  it("adds whole cycles that were never confirmed", () => {
    const s = buildReturnInvoice(context("2026-03-13", 1), { closing: { BW: 10_000 }, rule: "PRORATED" })!;
    expect(s.result.cyclesCovered).toBe(2);
    expect(s.result.commitmentCents).toBe(RS(5000) + 225_806);
  });

  it("applies the customer's credits automatically; the owner can remove one", () => {
    const credits = [
      { id: "adv", amountCents: RS(1000), label: "advance payment" },
      { id: "over", amountCents: RS(200) },
    ];
    const auto = buildReturnInvoice(context("2026-02-13", 1, credits), { closing: { BW: 10_000 }, rule: "PRORATED" })!;
    expect(auto.invoice.credit_applied_cents).toBe(RS(1200));
    expect(auto.invoice.total_cents).toBe(RS(1300));
    const removed = buildReturnInvoice(context("2026-02-13", 1, credits), { closing: { BW: 10_000 }, rule: "PRORATED", creditsExcluded: ["adv"] })!;
    expect(removed.invoice.total_cents).toBe(RS(2300));
    expect(removed.invoice.calculation).toMatchObject({ credits_excluded: ["adv"], credits: [{ id: "over", available_cents: RS(200) }] });
  });

  it("is null when nothing can be billed yet", () => {
    const ctx = { ...context("2026-01-05"), final: finalCycle({ startDate: "2026-01-10", firstBillingDate: "2026-02-10", today: "2026-01-05", lastConfirmedCycle: 0 }) };
    expect(buildReturnInvoice(ctx, { closing: { BW: 10_000 }, rule: "PRORATED" })).toBeNull();
  });
});

describe("meter invoice credits (rule 13)", () => {
  const meter = (credits: MeterContext["credits"], creditsExcluded: string[] = []): MeterContext => ({
    terms: MONO,
    cyclesCovered: 1,
    counters,
    estimateCredits: [],
    credits,
    creditsExcluded,
  });

  it("an advance becomes a CREDIT line on the next draft", () => {
    const s = buildMeterSubmission(meter([{ id: "adv", amountCents: RS(2000), label: "advance payment" }]), { BW: 12_600 });
    expect(s.invoice.lines.at(-1)).toEqual({
      line_type: "CREDIT",
      description: "Credit applied (advance payment)",
      quantity: 1,
      rate_cents: -RS(2000),
      amount_cents: -RS(2000),
      credit_id: "adv",
    });
    expect(s.invoice.total_cents).toBe(RS(4500));
  });

  it("a removed credit is left out and recorded", () => {
    const s = buildMeterSubmission(meter([{ id: "adv", amountCents: RS(2000) }], ["adv"]), { BW: 12_600 });
    expect(s.invoice.credit_applied_cents).toBe(0);
    expect(s.invoice.calculation).toMatchObject({ credits: [], credits_excluded: ["adv"] });
  });
});
