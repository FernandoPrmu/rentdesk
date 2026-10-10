import { BillingError } from "./errors.ts";
import {
  type AvailableCredit,
  calculateInvoice,
  type CounterReadingInput,
  type EstimateCredit,
  type InvoiceResult,
  type MachineType,
  type Terms,
} from "./invoice.ts";
import { type CounterType, type KnownReading, previousReading } from "./usage.ts";

/**
 * Builds the rpc_submit_meter_reading payload (readings + draft invoice) for a
 * ticket from its billing context and the readings the customer (or the owner,
 * INV-12) typed. Pure: the context is loaded by context.ts.
 */

export interface CounterContext {
  /** Everything known about the counter: initial reading, confirmed readings, baselines. */
  known: KnownReading[];
  counterMax: number | null;
  /** Confirmed usage per cycle, newest first. */
  history: number[];
}

export interface MeterContext {
  /** Terms snapshot on the ticket (AGR-02: never the agreement's newer terms). */
  terms: Terms;
  /** Cycles since the last confirmed reading (11.6: skipped cycles are billed together). */
  cyclesCovered: number;
  counters: Partial<Record<CounterType, CounterContext>>;
  /** Issued estimated invoices since the last confirmed reading (11.6). */
  estimateCredits: EstimateCredit[];
  /** Rule 13: the customer's available credits, oldest first, added automatically. */
  credits: AvailableCredit[];
  /** Credits the owner removed from this draft; they stay available. */
  creditsExcluded?: string[];
}

export interface MeterReadingRow {
  counter_type: CounterType;
  previous_value: number;
  current_value: number;
  rolled_over: boolean;
}

export interface InvoicePayload {
  type: "NORMAL";
  cycles_covered: number;
  subtotal_cents: number;
  credit_applied_cents: number;
  total_cents: number;
  lines: InvoiceResult["lines"];
  calculation: Record<string, unknown>;
}

export interface MeterSubmission {
  readings: MeterReadingRow[];
  invoice: InvoicePayload;
  anomalyFlag: InvoiceResult["anomaly"];
  result: InvoiceResult;
}

export interface TypedReadings {
  BW: number;
  COLOUR?: number | null;
}

/** Engine inputs per counter: previous reading (newest known), typed current reading. */
export function readingInputs(
  machineType: MachineType,
  counters: Partial<Record<CounterType, CounterContext>>,
  typed: TypedReadings,
): Partial<Record<CounterType, CounterReadingInput>> {
  const wanted: CounterType[] = machineType === "COLOUR" ? ["BW", "COLOUR"] : ["BW"];
  const readings: Partial<Record<CounterType, CounterReadingInput>> = {};
  for (const counter of wanted) {
    const c = counters[counter];
    if (!c) throw new BillingError("INVALID_INPUT", `No history for the ${counter} counter`, counter);
    const current = counter === "BW" ? typed.BW : typed.COLOUR;
    if (current === undefined || current === null) {
      throw new BillingError("MISSING_READING", `The ${counter === "BW" ? "B&W" : "colour"} reading is required`, counter);
    }
    const previous = previousReading(c.known);
    readings[counter] = {
      previous: previous.value,
      previousSource: previous.source,
      current,
      counterMax: c.counterMax,
      history: c.history,
    };
  }
  if (machineType === "MONO" && typed.COLOUR !== undefined && typed.COLOUR !== null) {
    throw new BillingError("UNEXPECTED_READING", "A mono machine has only a B&W counter", "COLOUR");
  }
  return readings;
}

/** Credits that may be applied: available ones minus those the owner removed. */
export function applicableCredits(credits: AvailableCredit[], excluded: string[] = []): AvailableCredit[] {
  const out = new Set(excluded);
  return credits.filter((c) => !out.has(c.id));
}

export function toSubmission(result: InvoiceResult): MeterSubmission {
  return {
    readings: result.counters.map((c) => ({
      counter_type: c.counter,
      previous_value: c.previous,
      current_value: c.current,
      rolled_over: c.rolledOver,
    })),
    invoice: {
      type: "NORMAL",
      cycles_covered: result.cyclesCovered,
      subtotal_cents: result.subtotalCents,
      credit_applied_cents: result.creditAppliedCents,
      total_cents: result.totalCents,
      lines: result.lines,
      calculation: result.calculation,
    },
    anomalyFlag: result.anomaly,
    result,
  };
}

export function buildMeterSubmission(context: MeterContext, typed: TypedReadings): MeterSubmission {
  const result = calculateInvoice({
    terms: context.terms,
    kind: "NORMAL",
    fullCycles: context.cyclesCovered,
    readings: readingInputs(context.terms.machineType, context.counters, typed),
    estimateCredits: context.estimateCredits,
    credits: applicableCredits(context.credits, context.creditsExcluded),
    creditsExcluded: context.creditsExcluded,
  });
  return toSubmission(result);
}
