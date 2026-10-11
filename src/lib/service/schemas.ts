import { z } from "zod";

import { rupeesToCents } from "../money.ts";
import { englishOnly } from "../text/english.ts";
import { SERVICE_TYPES, TONER_COLOURS, URGENCIES } from "./states.ts";

/**
 * Inputs of the service request forms (SRV-01, SRV-02, SRV-04, SRV-07, SRV-09),
 * checked on the server. English only (rule 33). The database checks again.
 * Only relative imports.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31");
const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, `${label}: at most ${max.toLocaleString("en-US")} characters.`)
    .refine(...englishOnly)
    .optional()
    .transform((v) => (v ? v : undefined));
const requiredText = (max: number, missing: string) =>
  z.string().trim().min(1, missing).max(max, `At most ${max.toLocaleString("en-US")} characters.`).refine(...englishOnly);

/** "" or rupees → cents; null when empty. */
const rupees = (label: string) =>
  z
    .string()
    .trim()
    .max(20)
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const cents = rupeesToCents(v);
      if (cents === null) {
        ctx.addIssue({ code: "custom", message: `${label}: enter rupees, for example 1500` });
        return z.NEVER;
      }
      return cents;
    });

export const raiseSchema = z.object({
  idempotencyKey: z.uuid(),
  machineId: z.uuid("Choose the machine"),
  type: z.enum(SERVICE_TYPES, "Choose what you need"),
  urgency: z.enum(URGENCIES, "Choose how urgent it is").default("NORMAL"),
  description: requiredText(1000, "Tell your rental company what is wrong or what you need."),
  tonerColours: z.array(z.enum(TONER_COLOURS)).max(4).default([]),
  partName: optionalText(100, "Part"),
  preferredDate: isoDate.optional().or(z.literal("").transform(() => undefined)),
  photoPath: z.string().max(300).nullable().default(null),
});
export type RaiseInput = z.input<typeof raiseSchema>;

export const noteSchema = optionalText(1000, "Note");

export const assignSchema = z.object({
  technician: requiredText(100, "Name the technician or staff member."),
  plannedDate: isoDate.optional().or(z.literal("").transform(() => undefined)),
  note: noteSchema,
});

export const resolveSchema = z
  .object({
    workDone: requiredText(1000, "Describe the work done."),
    partsUsed: optionalText(500, "Parts used"),
    cost: rupees("Cost"),
    chargeAmount: rupees("Charge"),
    chargeDescription: optionalText(200, "Charge description"),
    discountAmount: rupees("Discount"),
    discountDescription: optionalText(200, "Discount reason"),
    note: noteSchema,
  })
  .superRefine((v, ctx) => {
    if (v.chargeAmount !== null && v.chargeAmount < 1) ctx.addIssue({ code: "custom", path: ["chargeAmount"], message: "The charge must be more than zero." });
    if (v.chargeAmount !== null && !v.chargeDescription) {
      ctx.addIssue({ code: "custom", path: ["chargeDescription"], message: "Say what the charge is for (shown on the bill)." });
    }
    if (v.chargeAmount === null && v.chargeDescription) ctx.addIssue({ code: "custom", path: ["chargeAmount"], message: "Enter the amount to charge." });
    if (v.discountAmount !== null && v.discountAmount < 1) ctx.addIssue({ code: "custom", path: ["discountAmount"], message: "The discount must be more than zero." });
    if (v.discountAmount !== null && !v.discountDescription) {
      ctx.addIssue({ code: "custom", path: ["discountDescription"], message: "Give a reason for the discount." });
    }
    if (v.discountAmount === null && v.discountDescription) ctx.addIssue({ code: "custom", path: ["discountAmount"], message: "Enter the discount amount." });
  });

export const reasonSchema = requiredText(1000, "A reason is required.");

export const rateSchema = z.object({
  rating: z.number().int().min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars"),
  comment: optionalText(500, "Comment"),
});
