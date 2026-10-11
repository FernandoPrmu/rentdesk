import { assertCount, assertInteger } from "./arithmetic.ts";
import { BillingError } from "./errors.ts";
import {
  type Adjustment,
  type AvailableCredit,
  calculateInvoice,
  type CounterReadingInput,
  type EstimateCredit,
  type InvoiceLine,
  type InvoiceResult,
  type PartialCycle,
  type Terms,
} from "./invoice.ts";
import { applicableCredits, type InvoicePayload, type MeterReadingRow } from "./meter-invoice.ts";
import type { CounterType, ReadingSource } from "./usage.ts";

/**
 * Answers to a dispute and corrections after confirmation (spec 11.1, 11.3, 11.4;
 * decisions 48-49). Pure; integer cents. The database re-checks both
 * (app.credit_dispute, app.verify_corrected_invoice).
 *
 * Give a credit: a credit of the given amount goes on the disputed bill as a CREDIT
 * line, up to what is left to pay; the rest stays a credit for the next bills.
 *
 * Correct the invoice: never an edit in place. The bill is cancelled and a corrected
 * one is built from the original calculation with the corrected reading(s) and/or
 * adjustment lines. Money already paid on the old bill becomes a credit, taken off
 * the corrected bill with the customer's other credits (rule 13).
 * Only relative imports.
 */

// -----------------------------------------------------------------------------
// Give a credit
// -----------------------------------------------------------------------------

export interface IssuedAmounts {
  totalCents: number;
  amountPaidCents: number;
  creditAppliedCents: number;
}

export interface DisputeCredit {
  line: InvoiceLine;
  /** Taken off this bill. */
  appliedCents: number;
  /** Kept as a credit for the next bills. */
  leftOverCents: number;
  totalCents: number;
  creditAppliedCents: number;
  /** Still to pay on this bill. */
  balanceCents: number;
  /** Fully paid now: the ticket closes. */
  settled: boolean;
}

export function creditOnIssuedInvoice(invoice: IssuedAmounts, creditId: string, amountCents: number): DisputeCredit {
  assertCount(invoice.totalCents, "Total");
  assertCount(invoice.amountPaidCents, "Paid");
  assertCount(invoice.creditAppliedCents, "Credit applied");
  assertCount(amountCents, "Credit");
  if (amountCents < 1) throw new BillingError("INVALID_INPUT", "The credit must be more than zero");
  const left = invoice.totalCents - invoice.amountPaidCents;
  if (left <= 0) throw new BillingError("INVALID_INPUT", "Nothing is left to pay on this bill");
  const applied = Math.min(amountCents, left);
  const totalCents = invoice.totalCents - applied;
  return {
    line: { line_type: "CREDIT", description: "Credit given (dispute)", quantity: 1, rate_cents: -applied, amount_cents: -applied, credit_id: creditId },
    appliedCents: applied,
    leftOverCents: amountCents - applied,
    totalCents,
    creditAppliedCents: invoice.creditAppliedCents + applied,
    balanceCents: totalCents - invoice.amountPaidCents,
    settled: totalCents <= invoice.amountPaidCents,
  };
}

// -----------------------------------------------------------------------------
// Correct the invoice (cancel and reissue)
// -----------------------------------------------------------------------------

/** invoices.calculation as the engine stored it (the fields a correction needs). */
export interface StoredCalculation {
  type: "NORMAL" | "ESTIMATED";
  cycles_covered: number;
  full_cycles: number;
  partial: { days_used: number; days_in_cycle: number; rule: "PRORATED" | "FULL" } | null;
  terms: { commitment_cents: number; bw_included: number; bw_rate_cents: number; colour_included: number | null; colour_rate_cents: number | null };
  counters: {
    counter_type: CounterType;
    previous_value: number;
    previous_source?: ReadingSource;
    current_value: number;
    counter_max?: number | null;
    carried_copies?: number;
  }[];
  estimate_credits?: { invoice_no: string | null; cycle_no: number; amount_cents: number }[];
  /** Decision 59: service charges billed on it; a corrected bill carries them. */
  service_charges?: { id: string; description: string; amount_cents: number }[];
  credits_excluded?: string[];
}

export interface OriginalInvoice {
  invoiceNo: string;
  type: "NORMAL" | "ESTIMATED";
  totalCents: number;
  amountPaidCents: number;
  calculation: StoredCalculation | null;
}

export interface CorrectionInput {
  /** Corrected readings; null keeps the original ones. */
  readings: Partial<Record<CounterType, number>> | null;
  adjustments: Adjustment[];
  /** The customer's available credits with the old bill's own credit lines freed (oldest first). */
  credits: AvailableCredit[];
  /** Id for the credit that keeps the money already paid (null when nothing was paid). */
  paidCreditId: string | null;
}

export interface CorrectedInvoice {
  /** null when the readings are unchanged. */
  readings: MeterReadingRow[] | null;
  invoice: InvoicePayload | (Omit<InvoicePayload, "type"> & { type: "ESTIMATED" });
  anomalyFlag: InvoiceResult["anomaly"];
  result: InvoiceResult;
  /** Before and after, for the owner's preview and the customer's notice. */
  summary: {
    oldTotalCents: number;
    paidCents: number;
    newTotalCents: number;
    /** What the customer owes on the corrected bill. */
    toPayCents: number;
    changes: { counter: CounterType; from: number; to: number }[];
  };
}

function termsOf(c: StoredCalculation): Terms {
  return {
    machineType: c.terms.colour_included !== null && c.terms.colour_rate_cents !== null ? "COLOUR" : "MONO",
    commitmentCents: c.terms.commitment_cents,
    bwIncluded: c.terms.bw_included,
    bwRateCents: c.terms.bw_rate_cents,
    colourIncluded: c.terms.colour_included,
    colourRateCents: c.terms.colour_rate_cents,
  };
}

function partialOf(c: StoredCalculation): PartialCycle | null {
  return c.partial ? { daysUsed: c.partial.days_used, daysInCycle: c.partial.days_in_cycle, rule: c.partial.rule } : null;
}

export function buildCorrectedInvoice(original: OriginalInvoice, input: CorrectionInput): CorrectedInvoice {
  const calc = original.calculation;
  if (!calc) throw new BillingError("INVALID_INPUT", "This invoice has no stored calculation; cancel the ticket and bill again");
  if (input.readings && original.type !== "NORMAL") {
    throw new BillingError("INVALID_INPUT", "An estimated invoice has no reading; correct it with an adjustment line");
  }
  for (const a of input.adjustments) {
    assertInteger(a.amountCents, "Adjustment");
    if (a.amountCents === 0) throw new BillingError("INVALID_INPUT", "An adjustment cannot be zero");
  }
  if (!input.readings && input.adjustments.length === 0) {
    throw new BillingError("INVALID_INPUT", "Change a reading or add an adjustment line");
  }
  if ((original.amountPaidCents > 0) !== (input.paidCreditId !== null)) {
    throw new BillingError("INVALID_INPUT", "The credit for the money already paid is missing");
  }

  const changes: CorrectedInvoice["summary"]["changes"] = [];
  const readings: Partial<Record<CounterType, CounterReadingInput>> = {};
  for (const c of calc.counters) {
    const current = input.readings?.[c.counter_type] ?? c.current_value;
    if (input.readings && input.readings[c.counter_type] === undefined) {
      throw new BillingError("MISSING_READING", `The ${c.counter_type === "BW" ? "B&W" : "colour"} reading is required`, c.counter_type);
    }
    if (current !== c.current_value) changes.push({ counter: c.counter_type, from: c.current_value, to: current });
    readings[c.counter_type] = {
      previous: c.previous_value,
      previousSource: c.previous_source ?? "READING",
      current,
      counterMax: c.counter_max ?? null,
      history: [],
      carried: c.carried_copies ?? 0,
    };
  }
  if (input.readings && changes.length === 0 && input.adjustments.length === 0) {
    throw new BillingError("INVALID_INPUT", "The reading is the same as before");
  }

  const excluded = calc.credits_excluded ?? [];
  const credits = applicableCredits(input.credits, excluded);
  if (input.paidCreditId) {
    credits.push({ id: input.paidCreditId, amountCents: original.amountPaidCents, label: `paid on ${original.invoiceNo}` });
  }
  const estimateCredits: EstimateCredit[] = (calc.estimate_credits ?? []).map((e) => ({ invoiceNo: e.invoice_no, cycleNo: e.cycle_no, amountCents: e.amount_cents }));
  const result = calculateInvoice({
    terms: termsOf(calc),
    kind: original.type,
    fullCycles: calc.full_cycles,
    partialCycle: partialOf(calc),
    readings: original.type === "NORMAL" ? readings : undefined,
    estimateCredits,
    adjustments: input.adjustments,
    serviceCharges: (calc.service_charges ?? []).map((c) => ({ id: c.id, description: c.description, amountCents: c.amount_cents })),
    credits,
    creditsExcluded: excluded,
  });

  // Readings typed again but unchanged count as unchanged (the reading stays on record as it is).
  const changed = changes.length > 0;
  return {
    readings: changed
      ? result.counters.map((c) => ({ counter_type: c.counter, previous_value: c.previous, current_value: c.current, rolled_over: c.rolledOver }))
      : null,
    invoice: {
      type: original.type,
      cycles_covered: result.cyclesCovered,
      subtotal_cents: result.subtotalCents,
      credit_applied_cents: result.creditAppliedCents,
      total_cents: result.totalCents,
      lines: result.lines,
      calculation: result.calculation,
    } as CorrectedInvoice["invoice"],
    anomalyFlag: result.anomaly,
    result,
    summary: {
      oldTotalCents: original.totalCents,
      paidCents: original.amountPaidCents,
      newTotalCents: result.totalCents,
      toPayCents: result.totalCents,
      changes,
    },
  };
}
