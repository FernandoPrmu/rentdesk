import type { FinalCycle } from "../agreements/cycle-calendar.ts";
import { type AvailableCredit, calculateInvoice, type EstimateCredit, type PartialCycle, type Terms } from "./invoice.ts";
import { applicableCredits, type CounterContext, type MeterSubmission, readingInputs, toSubmission, type TypedReadings } from "./meter-invoice.ts";
import type { CounterType } from "./usage.ts";

/**
 * The final invoice when a machine is returned (RET-01, spec 11.4; rules 4 and 5
 * in docs/decisions.md). The owner types the closing readings; the invoice covers
 * every whole cycle since the last confirmed reading plus the cycle in progress,
 * prorated by its real calendar days or billed in full (owner's choice). Customer
 * credits are added automatically (rule 13) unless the owner removes them.
 * Pure: the context is loaded by context.ts (loadReturnContext).
 */

export interface ReturnContext {
  /** Terms in force for the final cycle. */
  terms: Terms;
  /** Days to pay from the same terms version: the final invoice is due today + dueDays. */
  dueDays: number;
  final: FinalCycle;
  counters: Partial<Record<CounterType, CounterContext>>;
  estimateCredits: EstimateCredit[];
  credits: AvailableCredit[];
}

export interface ReturnChoices {
  closing: TypedReadings;
  rule: PartialCycle["rule"];
  creditsExcluded?: string[];
}

/** null when nothing can be billed (returned before the first billing period began). */
export function buildReturnInvoice(context: ReturnContext, choices: ReturnChoices): MeterSubmission | null {
  if (!context.final.billable) return null;
  const result = calculateInvoice({
    terms: context.terms,
    kind: "NORMAL",
    fullCycles: context.final.fullCycles,
    partialCycle: { daysUsed: context.final.daysUsed, daysInCycle: context.final.daysInCycle, rule: choices.rule },
    readings: readingInputs(context.terms.machineType, context.counters, choices.closing),
    estimateCredits: context.estimateCredits,
    credits: applicableCredits(context.credits, choices.creditsExcluded),
    creditsExcluded: choices.creditsExcluded,
  });
  return toSubmission(result);
}
