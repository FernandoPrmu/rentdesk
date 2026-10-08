import { BillingError } from "./errors.ts";
import { calculateInvoice, type CounterReadingInput, type EstimateCredit, type InvoiceResult, type Terms } from "./invoice.ts";
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
}

export interface MeterReadingRow {
  counter_type: CounterType;
  previous_value: number;
  current_value: number;
  rolled_over: boolean;
}

export interface MeterSubmission {
  readings: MeterReadingRow[];
  invoice: {
    type: "NORMAL";
    cycles_covered: number;
    subtotal_cents: number;
    credit_applied_cents: number;
    total_cents: number;
    lines: InvoiceResult["lines"];
    calculation: Record<string, unknown>;
  };
  anomalyFlag: InvoiceResult["anomaly"];
  result: InvoiceResult;
}

export function buildMeterSubmission(context: MeterContext, typed: { BW: number; COLOUR?: number | null }): MeterSubmission {
  const counters: CounterType[] = context.terms.machineType === "COLOUR" ? ["BW", "COLOUR"] : ["BW"];
  const readings: Partial<Record<CounterType, CounterReadingInput>> = {};
  for (const counter of counters) {
    const c = context.counters[counter];
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
  if (context.terms.machineType === "MONO" && typed.COLOUR !== undefined && typed.COLOUR !== null) {
    throw new BillingError("UNEXPECTED_READING", "A mono machine has only a B&W counter", "COLOUR");
  }

  const result = calculateInvoice({
    terms: context.terms,
    kind: "NORMAL",
    fullCycles: context.cyclesCovered,
    readings,
    estimateCredits: context.estimateCredits,
  });

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
