import { z } from "zod";

import { englishOnly } from "../text/english.ts";

import { clampArea, LAYOUT_PRESETS, type LetterheadLayout } from "./pdf/layout.ts";

/**
 * Settings › Invoice template (BRD-04..07): the letterhead file chosen (already
 * uploaded and checked), where the invoice data goes on it, and the payment
 * instructions printed under the bank details. Used by Save and by Preview.
 */

const percent = (label: string) =>
  z
    .string()
    .trim()
    .transform((v, ctx) => {
      const n = Number(v);
      if (v === "" || !Number.isFinite(n) || n < 0 || n > 100) {
        ctx.addIssue({ code: "custom", message: `${label} must be between 0 and 100.` });
        return z.NEVER;
      }
      return n;
    });

export const invoiceTemplateSchema = z
  .object({
    letterhead_path: z
      .string()
      .trim()
      .default("")
      .transform((v) => (v === "" ? null : v)),
    preset: z.enum([...LAYOUT_PRESETS, "CUSTOM"], "Choose a layout.").default("HEADER_ONLY"),
    area_x: percent("Left").default(0),
    area_y: percent("Top").default(0),
    area_w: percent("Width").default(100),
    area_h: percent("Height").default(100),
    // Printed on every invoice: English letters only (decision 33).
    payment_instructions: z
      .string()
      .default("")
      .pipe(z.string().trim().max(300, "Payment instructions are too long (300 characters at most)."))
      .refine(...englishOnly)
      .transform((v) => (v === "" ? null : v)),
  })
  .transform((v) => ({
    letterheadPath: v.letterhead_path,
    layout: { preset: v.preset, area: clampArea({ x: v.area_x, y: v.area_y, w: v.area_w, h: v.area_h }) } satisfies LetterheadLayout,
    paymentInstructions: v.payment_instructions,
  }));
export type InvoiceTemplateInput = z.output<typeof invoiceTemplateSchema>;
