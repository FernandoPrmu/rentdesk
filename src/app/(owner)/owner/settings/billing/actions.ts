"use server";

import { refresh } from "next/cache";

import { type ActionResult, fail, fieldErrorsFrom } from "@/lib/action-result";
import { formValues } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { saveBillingSettings } from "@/lib/settings/billing";
import { billingSettingsSchema } from "@/lib/settings/billing-schema";

/** Settings › Billing (PAY-13): the owner's late fee default. */
export async function updateBillingSettingsAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  const parsed = billingSettingsSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  const result = await saveBillingSettings(actor, parsed.data);
  if (result.ok) refresh();
  return result;
}
