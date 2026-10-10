import { z } from "zod";

import { englishOnly } from "@/lib/text/english";

/**
 * Form input for owners, customers and status changes (ADM-01/02, CUS-01/03).
 * Shared by the forms and the Server Actions; the server always parses again.
 */

const required = (label: string, max = 120) =>
  z.string().trim().min(1, `${label} is required.`).max(max, `${label} is too long.`);

/** Empty input becomes null, so optional fields can be cleared. */
const optional = (label: string, max = 200) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long.`)
    .transform((v) => (v === "" ? null : v));

/** Customer details are printed on invoices: English letters only (decision 33). */
const requiredEnglish = (label: string, max = 120) => required(label, max).refine(...englishOnly);
const optionalEnglish = (label: string, max = 200) =>
  z
    .string()
    .trim()
    .max(max, `${label} is too long.`)
    .refine(...englishOnly)
    .transform((v) => (v === "" ? null : v));

export const phoneField = required("Phone", 30).regex(/^\+?[0-9][0-9 ()-]{6,24}$/, "Enter a valid phone number.");
const optionalEmail = z
  .string()
  .trim()
  .max(200, "Email is too long.")
  .transform((v) => (v === "" ? null : v.toLowerCase()))
  .pipe(z.email("Enter a valid email address.").nullable());

export const ownerSchema = z.object({
  business_name: required("Business name"),
  contact_person: required("Contact person"),
  phone: phoneField,
  email: optionalEmail,
  address: optional("Address", 300),
});
export type OwnerInput = z.infer<typeof ownerSchema>;

export const customerSchema = z.object({
  name: requiredEnglish("Name"),
  business_name: optionalEnglish("Business name", 120),
  phone: phoneField,
  email: optionalEmail,
  address: optionalEnglish("Address", 300),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const ACCOUNT_STATUSES = ["ACTIVE", "SUSPENDED", "DEACTIVATED"] as const;
export type AccountStatusValue = (typeof ACCOUNT_STATUSES)[number];

export const statusChangeSchema = z.object({
  status: z.enum(ACCOUNT_STATUSES),
  reason: z.string().trim().min(3, "Please give a reason.").max(500, "The reason is too long."),
});

export const uuidSchema = z.uuid();

/** List filters from the URL (?q=&status=). */
export const accountListFilterSchema = z.object({
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .catch(undefined),
  status: z.enum(ACCOUNT_STATUSES).optional().catch(undefined),
});

export const BALANCE_FILTERS = ["due", "clear"] as const;

/** Owner's customer list: adds the outstanding balance filter (CUS-05). */
export const customerListFilterSchema = accountListFilterSchema.extend({
  balance: z.enum(BALANCE_FILTERS).optional().catch(undefined),
});

/** Reads a FormData into a plain object of strings (files are ignored). */
export function formValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}
