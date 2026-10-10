import { counterAnomaly, type CounterAnomaly, invoiceAnomaly, type InvoiceAnomaly } from "./anomaly.ts";
import { assertCount, assertInteger, excessOver, mul, mulDivRoundHalfUp, sum } from "./arithmetic.ts";
import { BillingError } from "./errors.ts";
import { counterUsage, type CounterType, type ReadingSource } from "./usage.ts";

/**
 * Invoice calculation (spec 6.2, 6.3, 6.6, 11.4, 11.6; INV-05). Pure; integer
 * cents only. THE single source of truth: the database stores the result and
 * re-checks its inputs and arithmetic, but never calculates an amount itself.
 *
 *   commitment       commitment x full cycles (+ a final partial cycle, prorated
 *                    by the real calendar days of that cycle)
 *   included copies  included x full cycles (+ the partial cycle's share), per counter
 *   excess           max(0, usage - included) x rate, B&W and colour separately:
 *                    unused copies on one counter never offset the other
 *   subtotal         commitment + excess + adjustments
 *   credits          estimated charges credited back (11.6), then customer credits
 *                    oldest first, never below zero (rule 13: added automatically;
 *                    the owner may exclude one, recorded in the calculation)
 *   total            subtotal - credits (+ a late fee later, see late-fee.ts)
 */

export const ENGINE_VERSION = "rentdesk-billing-2";

export type MachineType = "MONO" | "COLOUR";
export type LineType = "COMMITMENT" | "BW_EXCESS" | "COLOUR_EXCESS" | "LATE_FEE" | "CREDIT" | "ADJUSTMENT";

export interface Terms {
  machineType: MachineType;
  commitmentCents: number;
  bwIncluded: number;
  bwRateCents: number;
  colourIncluded: number | null;
  colourRateCents: number | null;
}

export interface CounterReadingInput {
  previous: number;
  previousSource: ReadingSource;
  current: number;
  counterMax: number | null;
  /** Confirmed usage per cycle of this counter, newest first (anomaly + rollover guard). */
  history: number[];
}

/** Final invoice when a machine is returned mid-cycle (spec 11.4, owner's choice). */
export interface PartialCycle {
  daysUsed: number;
  /** Calendar days of that cycle (28 to 31 with monthly cycles). */
  daysInCycle: number;
  rule: "PRORATED" | "FULL";
}

/** An earlier ESTIMATED invoice whose charge is credited at the real reading (11.6). */
export interface EstimateCredit {
  invoiceNo: string | null;
  cycleNo: number;
  amountCents: number;
}

/** Customer credit (overpayment, advance, ...), applied oldest first (PAY-12, rule 13). */
export interface AvailableCredit {
  id: string;
  /** What is still available (not used by another live invoice). */
  amountCents: number;
  /** Shown on the line, e.g. "advance payment". */
  label?: string;
}

export interface Adjustment {
  description: string;
  amountCents: number;
}

export interface InvoiceInput {
  terms: Terms;
  /** ESTIMATED: commitment only, no readings (11.6). */
  kind: "NORMAL" | "ESTIMATED";
  /** Whole cycles billed (several when cycles were skipped, 11.6). */
  fullCycles: number;
  partialCycle?: PartialCycle | null;
  readings?: Partial<Record<CounterType, CounterReadingInput>>;
  estimateCredits?: EstimateCredit[];
  adjustments?: Adjustment[];
  /** Available customer credits, oldest first, without the excluded ones. */
  credits?: AvailableCredit[];
  /** Credits the owner removed from this invoice (they stay available). */
  creditsExcluded?: string[];
}

export interface InvoiceLine {
  line_type: LineType;
  description: string;
  quantity: number;
  rate_cents: number;
  amount_cents: number;
  /** The customer credit a CREDIT line uses (null for estimated-charge credits). */
  credit_id?: string | null;
}

export interface CounterResult {
  counter: CounterType;
  previous: number;
  previousSource: ReadingSource;
  current: number;
  counterMax: number | null;
  usage: number;
  rolledOver: boolean;
  included: number;
  excess: number;
  rateCents: number;
  excessCents: number;
  anomaly: CounterAnomaly;
}

export interface InvoiceResult {
  type: "NORMAL" | "ESTIMATED";
  cyclesCovered: number;
  lines: InvoiceLine[];
  commitmentCents: number;
  excessCents: number;
  subtotalCents: number;
  creditAppliedCents: number;
  lateFeeCents: number;
  totalCents: number;
  counters: CounterResult[];
  creditsApplied: { id: string; amountCents: number; remainingCents: number }[];
  /** Estimated charges that did not fit (terms changed); hold them as customer credit. */
  estimateCreditUnappliedCents: number;
  anomaly: InvoiceAnomaly;
  /** A counter rolled over: the owner must confirm it before the invoice is issued. */
  rolloverToConfirm: boolean;
  /** Stored on the invoice (invoices.calculation) and re-checked by the database. */
  calculation: Record<string, unknown>;
}

const COUNTER_LABEL: Record<CounterType, string> = { BW: "B&W", COLOUR: "Colour" };

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function validateTerms(t: Terms) {
  assertCount(t.commitmentCents, "Commitment");
  assertCount(t.bwIncluded, "Included B&W copies");
  assertCount(t.bwRateCents, "B&W rate");
  if (t.machineType === "COLOUR") {
    if (t.colourIncluded === null || t.colourRateCents === null) {
      throw new BillingError("INVALID_INPUT", "A colour machine needs colour terms");
    }
    assertCount(t.colourIncluded, "Included colour copies");
    assertCount(t.colourRateCents, "Colour rate");
  }
}

export function calculateInvoice(input: InvoiceInput): InvoiceResult {
  const { terms } = input;
  validateTerms(terms);
  const fullCycles = assertCount(input.fullCycles, "Cycles");
  const partial = input.partialCycle ?? null;
  if (partial) {
    assertCount(partial.daysInCycle, "Days in cycle");
    assertCount(partial.daysUsed, "Days used");
    if (partial.daysInCycle < 1) throw new BillingError("INVALID_INPUT", "A cycle has at least 1 day");
    if (partial.daysUsed < 1 || partial.daysUsed > partial.daysInCycle) {
      throw new BillingError("INVALID_INPUT", `Days used must be between 1 and ${partial.daysInCycle}`);
    }
  }
  const cyclesCovered = fullCycles + (partial ? 1 : 0);
  if (cyclesCovered < 1) throw new BillingError("INVALID_INPUT", "An invoice covers at least one cycle");
  // A FULL final cycle is billed like any other whole cycle.
  const billedFull = fullCycles + (partial?.rule === "FULL" ? 1 : 0);
  const prorated = partial?.rule === "PRORATED" ? partial.daysUsed : null;
  const cycleDays = partial?.daysInCycle ?? 1;

  const lines: InvoiceLine[] = [];

  // Commitment (spec 6.2), multiplied for skipped cycles (11.6), prorated on return (11.4).
  if (billedFull > 0) {
    lines.push({
      line_type: "COMMITMENT",
      description: billedFull === 1 ? "Monthly commitment" : `Monthly commitment × ${plural(billedFull, "cycle")}`,
      quantity: billedFull,
      rate_cents: terms.commitmentCents,
      amount_cents: mul(terms.commitmentCents, billedFull),
    });
  }
  if (prorated !== null) {
    const amount = mulDivRoundHalfUp(terms.commitmentCents, prorated, cycleDays, "Prorated commitment");
    lines.push({
      line_type: "COMMITMENT",
      description: `Commitment for ${prorated} of ${cycleDays} days (final cycle)`,
      quantity: 1,
      rate_cents: amount,
      amount_cents: amount,
    });
  }

  // Excess per counter.
  const counters: CounterResult[] = [];
  if (input.kind === "ESTIMATED") {
    if (input.readings && Object.keys(input.readings).length > 0) {
      throw new BillingError("INVALID_INPUT", "An estimated invoice has no readings");
    }
    if (partial) throw new BillingError("INVALID_INPUT", "An estimated invoice covers whole cycles only");
  } else {
    const readings = input.readings ?? {};
    const wanted: CounterType[] = terms.machineType === "COLOUR" ? ["BW", "COLOUR"] : ["BW"];
    if (terms.machineType === "MONO" && readings.COLOUR) {
      throw new BillingError("UNEXPECTED_READING", "A mono machine has only a B&W counter", "COLOUR");
    }
    for (const counter of wanted) {
      const r = readings[counter];
      if (!r) throw new BillingError("MISSING_READING", `The ${COUNTER_LABEL[counter]} reading is required`, counter);
      const perCycle = counter === "BW" ? terms.bwIncluded : (terms.colourIncluded as number);
      const rate = counter === "BW" ? terms.bwRateCents : (terms.colourRateCents as number);
      const included = sum([
        mul(perCycle, billedFull, "Included copies"),
        prorated === null ? 0 : mulDivRoundHalfUp(perCycle, prorated, cycleDays, "Prorated included copies"),
      ]);
      const { usage, rolledOver } = counterUsage({
        counter,
        previous: r.previous,
        current: r.current,
        counterMax: r.counterMax,
        cycles: cyclesCovered,
        history: r.history,
      });
      const excess = excessOver(usage, included);
      const excessCents = mul(excess, rate, `${COUNTER_LABEL[counter]} excess`);
      counters.push({
        counter,
        previous: r.previous,
        previousSource: r.previousSource,
        current: r.current,
        counterMax: r.counterMax,
        usage,
        rolledOver,
        included,
        excess,
        rateCents: rate,
        excessCents,
        anomaly: counterAnomaly(usage, cyclesCovered, r.history),
      });
      // Spec 6.6: excess lines are hidden when zero.
      if (excess > 0) {
        lines.push({
          line_type: counter === "BW" ? "BW_EXCESS" : "COLOUR_EXCESS",
          description: `${COUNTER_LABEL[counter]} copies above ${included.toLocaleString("en-US")} included`,
          quantity: excess,
          rate_cents: rate,
          amount_cents: excessCents,
        });
      }
    }
  }

  for (const a of input.adjustments ?? []) {
    assertInteger(a.amountCents, "Adjustment");
    if (!a.description.trim()) throw new BillingError("INVALID_INPUT", "An adjustment needs a description");
    lines.push({ line_type: "ADJUSTMENT", description: a.description.trim(), quantity: 1, rate_cents: a.amountCents, amount_cents: a.amountCents });
  }

  const subtotalCents = sum(lines.map((l) => l.amount_cents), "Subtotal");
  if (subtotalCents < 0) throw new BillingError("INVALID_INPUT", "Adjustments cannot make the invoice negative; use a credit");
  const commitmentCents = sum(lines.filter((l) => l.line_type === "COMMITMENT").map((l) => l.amount_cents));
  const excessCents = sum(counters.map((c) => c.excessCents));

  // Credits: estimated charges first (11.6), then customer credits oldest first.
  let remaining = subtotalCents;
  let estimateCreditUnappliedCents = 0;
  for (const e of input.estimateCredits ?? []) {
    assertCount(e.amountCents, "Estimated charge");
    const applied = Math.min(e.amountCents, remaining);
    estimateCreditUnappliedCents += e.amountCents - applied;
    if (applied > 0) {
      remaining -= applied;
      lines.push({
        line_type: "CREDIT",
        description: `Estimated charge credited (${e.invoiceNo ?? `cycle ${e.cycleNo}`})`,
        quantity: 1,
        rate_cents: -applied,
        amount_cents: -applied,
      });
    }
  }
  const creditsApplied: InvoiceResult["creditsApplied"] = [];
  const excluded = new Set(input.creditsExcluded ?? []);
  const credits = input.credits ?? [];
  if (new Set(credits.map((c) => c.id)).size !== credits.length) throw new BillingError("INVALID_INPUT", "A credit is listed twice");
  for (const c of credits) {
    assertCount(c.amountCents, "Credit");
    if (excluded.has(c.id)) throw new BillingError("INVALID_INPUT", "An excluded credit cannot be applied");
    const applied = Math.min(c.amountCents, remaining);
    if (applied === 0) continue;
    remaining -= applied;
    creditsApplied.push({ id: c.id, amountCents: applied, remainingCents: c.amountCents - applied });
    lines.push({
      line_type: "CREDIT",
      description: c.label ? `Credit applied (${c.label})` : "Credit applied",
      quantity: 1,
      rate_cents: -applied,
      amount_cents: -applied,
      credit_id: c.id,
    });
  }
  const creditAppliedCents = subtotalCents - remaining;
  const totalCents = remaining;

  const anomaly = input.kind === "ESTIMATED" ? null : invoiceAnomaly(counters);
  const rolloverToConfirm = counters.some((c) => c.rolledOver);
  const type = input.kind;

  return {
    type,
    cyclesCovered,
    lines,
    commitmentCents,
    excessCents,
    subtotalCents,
    creditAppliedCents,
    lateFeeCents: 0,
    totalCents,
    counters,
    creditsApplied,
    estimateCreditUnappliedCents,
    anomaly,
    rolloverToConfirm,
    calculation: {
      engine: ENGINE_VERSION,
      type,
      cycles_covered: cyclesCovered,
      full_cycles: fullCycles,
      partial: partial ? { days_used: partial.daysUsed, days_in_cycle: partial.daysInCycle, rule: partial.rule } : null,
      terms: {
        commitment_cents: terms.commitmentCents,
        bw_included: terms.bwIncluded,
        bw_rate_cents: terms.bwRateCents,
        colour_included: terms.colourIncluded,
        colour_rate_cents: terms.colourRateCents,
      },
      counters: counters.map((c) => ({
        counter_type: c.counter,
        previous_value: c.previous,
        previous_source: c.previousSource,
        current_value: c.current,
        counter_max: c.counterMax,
        usage: c.usage,
        rolled_over: c.rolledOver,
        included: c.included,
        excess: c.excess,
        rate_cents: c.rateCents,
        excess_cents: c.excessCents,
        anomaly: c.anomaly,
      })),
      estimate_credits: (input.estimateCredits ?? []).map((e) => ({ invoice_no: e.invoiceNo, cycle_no: e.cycleNo, amount_cents: e.amountCents })),
      // Rule 13: the credits that were available (the database checks this list) and
      // the ones the owner removed; what was applied is on the CREDIT lines.
      credits: credits.map((c) => ({ id: c.id, available_cents: c.amountCents })),
      credits_excluded: [...excluded].sort(),
      credits_applied: creditsApplied.map((c) => ({ id: c.id, amount_cents: c.amountCents })),
      anomaly,
    },
  };
}
