import { z } from "zod";

import { addDays } from "@/lib/agreements/cycle-calendar";
import { count, isoDate, optionalIsoDate, optionalText, reasonField, requiredText, rupees, wholeNumber } from "@/lib/forms";
import type { MachineType } from "@/lib/machines/schemas";

/**
 * Agreement input (MAC-02, MAC-04, AGR-01, AGR-02). Money arrives in rupees and
 * leaves as integer cents. Colour terms and readings are required for a COLOUR
 * machine and dropped for a MONO one. The database checks all of it again.
 */

export const DEFAULT_CYCLE_LENGTH = 30;
export const DEFAULT_DUE_DAYS = 7;

/** Not shown for a mono machine: whatever is sent becomes null. */
const ignored = z.unknown().transform(() => null);

/** Colour values exist only on colour machines. Field-level, so every error shows at once. */
function colourCount(type: MachineType, label: string) {
  return type === "COLOUR" ? count(label) : ignored;
}

function pricingFields(type: MachineType) {
  return {
    monthly_commitment: rupees("Monthly commitment"),
    bw_included: count("Included B&W copies"),
    bw_rate: rupees("B&W excess rate"),
    colour_included: colourCount(type, "Included colour copies"),
    colour_rate: type === "COLOUR" ? rupees("Colour excess rate") : ignored,
    due_days: wholeNumber("Days to pay", 0, 120),
  };
}

/** Pricing terms as the database functions expect them (cents). */
export function termsPayload(value: {
  monthly_commitment: number;
  bw_included: number;
  bw_rate: number;
  colour_included: number | null;
  colour_rate: number | null;
  due_days: number;
}) {
  return {
    monthly_commitment_cents: value.monthly_commitment,
    bw_included: value.bw_included,
    bw_rate_cents: value.bw_rate,
    colour_included: value.colour_included,
    colour_rate_cents: value.colour_rate,
    due_days: value.due_days,
  };
}

/** Assign a machine to a customer (MAC-02, AGR-01). `today` is Asia/Colombo. */
export function assignmentSchema(type: MachineType, today: string) {
  return z
    .object({
      customer_id: z.uuid("Choose a customer."),
      start_date: isoDate("Start date"),
      first_billing_date: isoDate("First billing date"),
      end_date: optionalIsoDate("End date"),
      cycle_length_days: wholeNumber("Cycle length", 7, 366),
      installation_location: requiredText("Installation location", 200),
      initial_bw: count("Initial B&W reading"),
      initial_colour: colourCount(type, "Initial colour reading"),
      ...pricingFields(type),
    })
    .superRefine((value, ctx) => {
      if (value.first_billing_date < today) {
        ctx.addIssue({ code: "custom", path: ["first_billing_date"], message: "The first billing date cannot be in the past." });
      }
      if (value.first_billing_date <= value.start_date) {
        ctx.addIssue({ code: "custom", path: ["first_billing_date"], message: "The first billing date must be after the start date." });
      }
      if (value.start_date > addDays(today, 366)) {
        ctx.addIssue({ code: "custom", path: ["start_date"], message: "The start date is too far ahead." });
      }
      if (value.end_date !== null && value.end_date < value.start_date) {
        ctx.addIssue({ code: "custom", path: ["end_date"], message: "The end date cannot be before the start date." });
      }
    });
}
export type AssignmentInput = z.infer<ReturnType<typeof assignmentSchema>>;

/** p_terms for rpc_assign_machine / rpc_reassign_machine. */
export function assignmentPayload(input: AssignmentInput) {
  return {
    start_date: input.start_date,
    first_billing_date: input.first_billing_date,
    end_date: input.end_date,
    cycle_length_days: input.cycle_length_days,
    installation_location: input.installation_location,
    initial_bw_reading: input.initial_bw,
    initial_colour_reading: input.initial_colour,
    ...termsPayload(input),
  };
}

/** Edit terms (AGR-02): pricing applies from the next cycle, the rest at once. */
export function termsEditSchema(type: MachineType, startDate: string) {
  return z
    .object({
      ...pricingFields(type),
      installation_location: requiredText("Installation location", 200),
      end_date: optionalIsoDate("End date"),
      note: optionalText("Note", 500),
    })
    .superRefine((value, ctx) => {
      if (value.end_date !== null && value.end_date < startDate) {
        ctx.addIssue({ code: "custom", path: ["end_date"], message: "The end date cannot be before the start date." });
      }
    });
}
export type TermsEditInput = z.infer<ReturnType<typeof termsEditSchema>>;

/** Return (MAC-04): closing readings and a reason. */
export function returnSchema(type: MachineType) {
  return z.object({
    closing_bw: count("Closing B&W reading"),
    closing_colour: colourCount(type, "Closing colour reading"),
    reason: reasonField,
  });
}
export type ReturnInput = z.infer<ReturnType<typeof returnSchema>>;
