import { z } from "zod";

import { phoneField } from "@/lib/accounts/schemas";
import { englishOnly } from "@/lib/text/english";

// Everything here is printed on invoices: English letters only (decision 33).
const required = (label: string, max = 120) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .max(max, `${label} is too long.`)
    .refine(...englishOnly);

/** Company setup and Settings > Company (BRD-01, BRD-03). The logo is optional. */
export const companySchema = z.object({
  company_name: required("Company name"),
  address: required("Address", 300),
  phone: phoneField,
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, "Email is required.")
    .max(200, "Email is too long.")
    .pipe(z.email("Enter a valid email address.")),
  bank_name: required("Bank name"),
  bank_branch: z
    .string()
    .trim()
    .max(120, "Branch is too long.")
    .refine(...englishOnly)
    .transform((v) => (v === "" ? null : v)),
  bank_account_name: required("Account name"),
  bank_account_no: required("Account number", 40).regex(/^[0-9 -]+$/, "Use digits only."),
});
export type CompanyInput = z.infer<typeof companySchema>;
