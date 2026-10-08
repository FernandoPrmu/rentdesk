"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { type ActionResult, fail, fieldErrorsFrom } from "@/lib/action-result";
import { formValues } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { saveCompanyProfile } from "@/lib/branding/company";
import { companySchema } from "@/lib/branding/schemas";

async function save(formData: FormData, allowGate?: "/setup"): Promise<ActionResult> {
  const owner = await currentActor("OWNER", { allowGate });
  const parsed = companySchema.safeParse(formValues(formData));
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  const logo = formData.get("logo");
  return saveCompanyProfile(owner, parsed.data, {
    file: logo instanceof File && logo.size > 0 ? logo : null,
    remove: formData.get("remove_logo") === "on",
  });
}

/** BRD-01: first company setup; completes onboarding and opens the dashboard. */
export async function completeSetupAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const result = await save(formData, "/setup");
  if (!result.ok) return result;
  redirect("/owner");
}

/** BRD-03: Settings > Company. Issued invoices keep their own branding snapshot. */
export async function updateCompanyAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const result = await save(formData);
  if (result.ok) refresh();
  return result;
}
