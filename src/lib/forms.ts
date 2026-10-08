import { z } from "zod";

import { isIsoDate } from "@/lib/agreements/cycle-calendar";
import { rupeesToCents } from "@/lib/money";

/**
 * Zod field helpers for form input (everything arrives as a string). Used by the
 * forms and by the Server Actions, which always parse again on the server.
 */

/** Highest meter reading or copy count accepted (a 12-digit counter). */
export const MAX_COUNT = 999_999_999_999;

export const requiredText = (label: string, max = 120) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);

/** Empty input becomes null, so optional fields can be cleared. */
export const optionalText = (label: string, max = 500) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long.`)
    .transform((v) => (v === "" ? null : v));

function parseCount(value: string): number | null {
  const cleaned = value.trim().replace(/[,\s]/g, "");
  if (!/^\d{1,12}$/.test(cleaned)) return null;
  return Number(cleaned);
}

/** A whole number of 0 or more ("12,500" is fine). Meter readings and copy counts. */
export const count = (label: string) =>
  z.string().transform((value, ctx) => {
    const n = parseCount(value);
    if (n === null || n > MAX_COUNT) {
      ctx.addIssue({ code: "custom", message: `${label} must be a whole number (0 or more).` });
      return z.NEVER;
    }
    return n;
  });

export const optionalCount = (label: string) =>
  z.string().transform((value, ctx) => {
    if (value.trim() === "") return null;
    const n = parseCount(value);
    if (n === null || n > MAX_COUNT) {
      ctx.addIssue({ code: "custom", message: `${label} must be a whole number (0 or more).` });
      return z.NEVER;
    }
    return n;
  });

/** Rupees as typed ("2,500", "2.50") -> integer cents. */
export const rupees = (label: string) =>
  z.string().transform((value, ctx) => {
    const cents = rupeesToCents(value);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: `${label}: enter an amount in rupees, like 2,500 or 2.50.` });
      return z.NEVER;
    }
    return cents;
  });

export const optionalRupees = (label: string) =>
  z.string().transform((value, ctx) => {
    if (value.trim() === "") return null;
    const cents = rupeesToCents(value);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: `${label}: enter an amount in rupees, like 2,500 or 2.50.` });
      return z.NEVER;
    }
    return cents;
  });

export const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => isIsoDate(v), `${label}: enter a valid date.`);

export const optionalIsoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || isIsoDate(v), `${label}: enter a valid date.`)
    .transform((v) => (v === "" ? null : v));

export const wholeNumber = (label: string, min: number, max: number) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, `${label} must be a whole number.`)
    .transform(Number)
    .refine((n) => n >= min && n <= max, `${label} must be between ${min} and ${max}.`);

export const reasonField = z.string().trim().min(3, "Please give a reason.").max(500, "The reason is too long.");
