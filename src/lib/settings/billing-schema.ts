import { z } from "zod";

import { type LateFeeSources, type ResolvedLateFee, resolveLateFee } from "@/lib/billing/late-fee";
import { rupees, wholeNumber } from "@/lib/forms";
import { formatRupees } from "@/lib/money";

/** Settings › Billing (PAY-13): the owner's default late fee. */
export const billingSettingsSchema = z
  .object({
    late_fee_enabled: z
      .string()
      .default("")
      .transform((v) => v === "on"),
    late_fee: rupees("Late fee"),
    grace_period_days: wholeNumber("Grace period", 0, 90),
  })
  .superRefine((v, ctx) => {
    if (v.late_fee_enabled && v.late_fee <= 0) {
      ctx.addIssue({ code: "custom", path: ["late_fee"], message: "Enter the late fee, or switch it off." });
    }
  });
export type BillingSettingsInput = z.infer<typeof billingSettingsSchema>;

/** "Rs. 500, 7 days after the due date" or "No late fee (7 days' grace)". */
export function describeLateFee(r: Pick<ResolvedLateFee, "enabled" | "feeCents" | "graceDays">): string {
  const grace = `${r.graceDays} day${r.graceDays === 1 ? "" : "s"}`;
  return r.enabled && r.feeCents > 0 ? `${formatRupees(r.feeCents)}, charged ${grace} after the due date` : "no late fee";
}

/** The owner's default, as the "Use my default" option explains it. */
export function describeOwnerDefault(sources: Pick<LateFeeSources, "owner" | "platform">): string {
  return describeLateFee(resolveLateFee({ agreement: { mode: "OWNER_DEFAULT", feeCents: null }, ...sources }));
}
