import { BillingError } from "../billing/errors.ts";
import type { InvoiceResult } from "../billing/invoice.ts";
import { buildMeterSubmission, type MeterContext, type MeterSubmission } from "../billing/meter-invoice.ts";
import type { CounterType } from "../billing/usage.ts";
import { formatCount } from "../format.ts";

/**
 * Typed meter readings (INV-02, INV-04, spec 6.4): parsing what was typed, the
 * engine preview shown before submitting, and plain-language messages. Used by the
 * customer form, the owner's manual entry and correction, and on the server.
 * Only relative imports.
 */

/** Meter counters never need more than 9 digits (999,999,999). */
export const MAX_READING = 999_999_999;

export type ReadingParse = { ok: true; value: number } | { ok: false; error: string };

/** "12,500", "12 500" or "12500" -> 12500. Digits only: no decimals, no minus. */
export function parseReading(text: string, label: string): ReadingParse {
  const cleaned = text.replace(/[\s,]/g, "");
  if (cleaned === "") return { ok: false, error: `Type the ${label} reading` };
  if (!/^\d+$/.test(cleaned)) return { ok: false, error: `The ${label} reading must be a whole number (digits only)` };
  const value = Number(cleaned);
  if (!Number.isSafeInteger(value) || value > MAX_READING) return { ok: false, error: `The ${label} reading is too long` };
  return { ok: true, value };
}

export const COUNTER_LABEL: Record<CounterType, string> = { BW: "B&W", COLOUR: "colour" };

export interface TypedText {
  bw: string;
  colour: string;
}

export type ReadingErrors = Partial<Record<"bw" | "colour", string>>;

/** Parses the typed text for the machine's counters. */
export function parseTyped(machineType: "MONO" | "COLOUR", typed: TypedText): { ok: true; readings: { BW: number; COLOUR: number | null } } | { ok: false; errors: ReadingErrors } {
  const errors: ReadingErrors = {};
  const bw = parseReading(typed.bw, "B&W");
  if (!bw.ok) errors.bw = bw.error;
  let colour: number | null = null;
  if (machineType === "COLOUR") {
    const c = parseReading(typed.colour, "colour");
    if (!c.ok) errors.colour = c.error;
    else colour = c.value;
  }
  if (Object.keys(errors).length > 0 || !bw.ok) return { ok: false, errors };
  return { ok: true, readings: { BW: bw.value, COLOUR: colour } };
}

/** A billing engine error, in plain words, and the field it belongs to. */
export function readingErrorMessage(error: unknown): { field: "bw" | "colour" | null; message: string } {
  if (!(error instanceof BillingError)) return { field: null, message: "The reading could not be checked. Please try again." };
  const field = error.counter === "COLOUR" ? "colour" : error.counter === "BW" ? "bw" : null;
  const label = error.counter ? COUNTER_LABEL[error.counter] : "meter";
  switch (error.code) {
    case "READING_BELOW_PREVIOUS":
      return { field, message: `The ${label} reading is lower than last time. Please check the number on the meter.` };
    case "READING_ABOVE_COUNTER_MAX":
      return { field, message: `The ${label} reading is higher than this meter can show. Please check the number.` };
    case "MISSING_READING":
      return { field, message: `Type the ${label} reading` };
    default:
      return { field, message: error.message };
  }
}

export const ANOMALY_WARNING = {
  HIGH: "Much higher than usual. Please check the number.",
  LOW: "Much lower than usual. Please check the number.",
  ZERO: "No copies since last time. Please check the number.",
} as const;

export interface CounterPreview {
  counter: CounterType;
  previous: number;
  current: number;
  usage: number;
  included: number;
  excess: number;
  rolledOver: boolean;
  warning: string | null;
}

export type Preview =
  | { ok: true; submission: MeterSubmission; counters: CounterPreview[]; result: InvoiceResult }
  | { ok: false; errors: ReadingErrors; message?: string };

/**
 * What the reading means before it is sent: usage per counter and the invoice the
 * billing engine will create. Anomalies warn (they never block); a reading lower
 * than the previous one or above the counter maximum blocks.
 */
export function previewReading(context: MeterContext, typed: TypedText): Preview {
  const parsed = parseTyped(context.terms.machineType, typed);
  if (!parsed.ok) return parsed;
  try {
    const submission = buildMeterSubmission(context, parsed.readings);
    const counters = submission.result.counters.map((c) => ({
      counter: c.counter,
      previous: c.previous,
      current: c.current,
      usage: c.usage,
      included: c.included,
      excess: c.excess,
      rolledOver: c.rolledOver,
      warning: c.anomaly ? ANOMALY_WARNING[c.anomaly] : null,
    }));
    return { ok: true, submission, counters, result: submission.result };
  } catch (error) {
    const { field, message } = readingErrorMessage(error);
    return field ? { ok: false, errors: { [field]: message } } : { ok: false, errors: {}, message };
  }
}

/** "B&W 12,500 → 12,050" for correction notices. */
export function describeChange(counter: CounterType, from: number, to: number): string {
  return `${counter === "BW" ? "B&W" : "Colour"} ${formatCount(from)} → ${formatCount(to)}`;
}
