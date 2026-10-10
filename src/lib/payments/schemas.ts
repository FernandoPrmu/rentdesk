import { z } from "zod";

import { isoDate, optionalText, reasonField, rupees } from "@/lib/forms";
import { REFERENCE_LABEL } from "@/lib/status-labels";
import { englishOnly } from "@/lib/text/english";
import { MANUAL_METHODS, SLIP_METHODS } from "@/lib/tickets/transitions";

/**
 * Payment forms (PAY-02, PAY-05, PAY-07, PAY-12, TKT-10): amounts typed in rupees
 * become integer cents; every text is English only (decision 33: references and
 * notes are printed on receipts). The server parses again; the rpc checks again.
 */

const uuid = z.uuid("Please reload the page and try again.");
const englishOptional = (label: string, max: number) => optionalText(label, max).refine((v) => v === null || englishOnly[0](v), englishOnly[1]);
const notFuture = (today: string) => (v: string) => v <= today;

/** Methods where the bank or cheque number is asked for. */
const NEEDS_REFERENCE = new Set<string>(["BANK_TRANSFER", "DEPOSIT", "CHEQUE"]);

/** The customer's slip form (CP-04). `today` is the Colombo date. */
export const customerPaymentSchema = (today: string) =>
  z
    .object({
      idempotencyKey: uuid,
      invoiceIds: z.array(uuid).min(1, "Choose at least one bill.").max(50),
      amount: rupees("Amount paid").refine((c) => c > 0, "Amount paid must be more than 0."),
      paidOn: isoDate("Date paid").refine(notFuture(today), "Date paid cannot be in the future."),
      method: z.enum(SLIP_METHODS, "Choose how you paid."),
      reference: englishOptional("Reference", 100),
      note: englishOptional("Note", 500),
      slipPath: z.string().min(1, "Add a photo or file of the payment slip.").max(300),
      originalSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
      confirmDuplicate: z.boolean().default(false),
    })
    .superRefine((v, ctx) => {
      if (NEEDS_REFERENCE.has(v.method) && !v.reference) {
        ctx.addIssue({ code: "custom", path: ["reference"], message: `${REFERENCE_LABEL[v.method]} is required.` });
      }
    });
export type CustomerPaymentInput = z.input<ReturnType<typeof customerPaymentSchema>>;

/** The owner records money received without a slip (PAY-07); no bills = an advance. */
export const manualPaymentSchema = (today: string) =>
  z
    .object({
      customerId: uuid,
      idempotencyKey: uuid,
      invoiceIds: z.array(uuid).max(50).default([]),
      amount: rupees("Amount received").refine((c) => c > 0, "Amount received must be more than 0."),
      paidOn: isoDate("Date received").refine(notFuture(today), "Date received cannot be in the future."),
      method: z.enum(MANUAL_METHODS, "Choose how it was paid."),
      reference: englishOptional("Reference", 100),
      note: englishOptional("Note", 500),
    })
    .superRefine((v, ctx) => {
      if (v.method === "CHEQUE" && !v.reference) ctx.addIssue({ code: "custom", path: ["reference"], message: "Cheque number is required." });
    });
export type ManualPaymentInput = z.input<ReturnType<typeof manualPaymentSchema>>;

/** The owner checks a slip (PAY-05): accept it, accept the amount really received, or reject with a reason. */
export const verifySchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("ACCEPT"), paymentId: uuid, amount: z.string().default("") }),
  z.object({ decision: z.literal("REJECT"), paymentId: uuid, reason: reasonField.refine(...englishOnly) }),
]);
export type VerifyInput = z.input<typeof verifySchema>;

export const reverseSchema = z.object({ paymentId: uuid, reason: reasonField.refine(...englishOnly) });
export const reallocateSchema = z.object({ paymentId: uuid, invoiceIds: z.array(uuid).max(50), reason: reasonField.refine(...englishOnly) });

/** PAY-12: a credit paid back to the customer. */
export const refundSchema = (today: string) =>
  z.object({
    creditId: uuid,
    amount: rupees("Amount refunded").refine((c) => c > 0, "Amount refunded must be more than 0."),
    refundedOn: isoDate("Date refunded").refine(notFuture(today), "Date refunded cannot be in the future."),
    method: z.enum(MANUAL_METHODS, "Choose how it was refunded."),
    reference: englishOptional("Reference", 100),
    note: englishOptional("Note", 500),
  });
export type RefundInput = z.input<ReturnType<typeof refundSchema>>;
