import { z } from "zod";

import { isIsoDate } from "../agreements/cycle-calendar.ts";
import { buildCorrectedInvoice, type CorrectedInvoice, type StoredCalculation } from "../billing/dispute.ts";
import type { AvailableCredit } from "../billing/invoice.ts";
import type { CounterType } from "../billing/usage.ts";
import { parseReading, readingErrorMessage } from "../meter/readings.ts";
import { rupeesToCents } from "../money.ts";
import { englishOnly } from "../text/english.ts";
import type { TicketSnapshot } from "../tickets/transitions.ts";

/**
 * The owner's correction form (decision 49): corrected reading(s) and/or adjustment
 * lines, the reason the customer sees and the new due date. Pure, so the page shows
 * the corrected bill as it is typed with the same engine the server uses.
 * Only relative imports.
 */

export interface CorrectionView {
  ticket: TicketSnapshot & { current_invoice_id: string };
  invoice: {
    id: string;
    invoiceNo: string;
    type: "NORMAL" | "ESTIMATED";
    status: string;
    totalCents: number;
    paidCents: number;
    dueDate: string | null;
    calculation: StoredCalculation;
    lines: { line_type: string; description: string; amount_cents: number }[];
  };
  machineType: "MONO" | "COLOUR";
  counters: { counter: CounterType; previous: number; current: number }[];
  /** The customer's credits with this bill's own credit lines freed (oldest first). */
  credits: AvailableCredit[];
  /** A corrected reading is possible: a normal bill whose reading is still the latest (else adjustment lines only). */
  readingsAllowed: boolean;
  readingsBlocked: string | null;
  defaultDueDate: string;
  today: string;
  disputed: boolean;
  /** Why the invoice cannot be corrected now, or null. */
  blocked: string | null;
}

export const adjustmentSchema = z.object({
  description: z.string().trim().min(3, "Describe the adjustment.").max(120, "At most 120 characters.").refine(...englishOnly),
  direction: z.enum(["ADD", "TAKE_OFF"]),
  amount: z.string().trim().max(20),
});
export type AdjustmentInput = z.infer<typeof adjustmentSchema>;

export const correctionInputSchema = z.object({
  ticketId: z.uuid(),
  invoiceId: z.uuid(),
  reason: z.string().trim().min(3, "Write why the bill is corrected (the customer sees it).").max(1000).refine(...englishOnly),
  bw: z.string().max(20).default(""),
  colour: z.string().max(20).default(""),
  adjustments: z.array(adjustmentSchema).max(5, "At most 5 adjustment lines.").default([]),
  dueDate: z.string().refine(isIsoDate, "Choose the due date."),
});
export type CorrectionInput = z.input<typeof correctionInputSchema>;

/** Typed readings (empty = unchanged) and adjustment lines in cents, with field errors. */
export function parseCorrection(
  view: Pick<CorrectionView, "counters" | "readingsAllowed">,
  input: { bw: string; colour: string; adjustments: AdjustmentInput[] },
) {
  const errors: Record<string, string> = {};
  let readings: Partial<Record<CounterType, number>> | null = null;
  if (view.readingsAllowed && view.counters.length > 0) {
    const typed: Partial<Record<CounterType, number>> = {};
    let changed = false;
    for (const c of view.counters) {
      const text = (c.counter === "BW" ? input.bw : input.colour).trim();
      if (text === "") {
        typed[c.counter] = c.current;
        continue;
      }
      const parsed = parseReading(text, c.counter === "BW" ? "B&W" : "colour");
      if (!parsed.ok) errors[c.counter === "BW" ? "bw" : "colour"] = parsed.error;
      else {
        typed[c.counter] = parsed.value;
        if (parsed.value !== c.current) changed = true;
      }
    }
    if (changed) readings = typed;
  }
  const adjustments = input.adjustments.map((a, n) => {
    const cents = rupeesToCents(a.amount);
    if (!cents) errors[`adjustment${n}`] = "Enter the amount in rupees.";
    else if (a.description.trim().length < 3) errors[`adjustment${n}`] = "Describe the adjustment.";
    return { description: a.description.trim(), amountCents: (cents ?? 0) * (a.direction === "TAKE_OFF" ? -1 : 1) };
  });
  return { readings, adjustments, errors };
}

export type CorrectionPreview = { ok: true; built: CorrectedInvoice; keptCreditCents: number } | { ok: false; errors: Record<string, string>; message?: string };

/**
 * The corrected bill for the form. `paidCreditId` is the id of the credit that keeps
 * the money already paid (the server makes a fresh one when it saves).
 */
export function previewCorrection(
  view: CorrectionView,
  input: { bw: string; colour: string; adjustments: AdjustmentInput[] },
  paidCreditId = "00000000-0000-4000-8000-000000000000",
): CorrectionPreview {
  const { readings, adjustments, errors } = parseCorrection(view, input);
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  try {
    const creditId = view.invoice.paidCents > 0 ? paidCreditId : null;
    const built = buildCorrectedInvoice(
      { invoiceNo: view.invoice.invoiceNo, type: view.invoice.type, totalCents: view.invoice.totalCents, amountPaidCents: view.invoice.paidCents, calculation: view.invoice.calculation },
      { readings, adjustments, credits: view.credits, paidCreditId: creditId },
    );
    const applied = built.result.creditsApplied.find((c) => c.id === creditId)?.amountCents ?? 0;
    return { ok: true, built, keptCreditCents: creditId ? view.invoice.paidCents - applied : 0 };
  } catch (error) {
    const { field, message } = readingErrorMessage(error);
    return field ? { ok: false, errors: { [field]: message } } : { ok: false, errors: {}, message };
  }
}
