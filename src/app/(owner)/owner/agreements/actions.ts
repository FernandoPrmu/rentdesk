"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { type ActionResult, fail, fieldErrorsFrom } from "@/lib/action-result";
import { formValues, uuidSchema } from "@/lib/accounts/schemas";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { getAgreement } from "@/lib/agreements/queries";
import { returnSchema, settlementSchema, termsEditSchema } from "@/lib/agreements/schemas";
import { returnMachine, settleDeposit, type TermsChange, updateAgreementTerms } from "@/lib/agreements/service";
import { currentActor } from "@/lib/auth/current-user";

/** Owner portal: agreement terms (AGR-02, LATE-01), machine return (MAC-04, RET-01), deposit settlement (DEP-03/04). */

const NOT_FOUND = "This agreement was not found.";
const CHECK_FIELDS = "Please check the highlighted fields.";

/** RLS: only the owner's own agreements load. */
async function loadAgreement(agreementId: string) {
  if (!uuidSchema.safeParse(agreementId).success) return null;
  return getAgreement(agreementId);
}

export async function updateTermsAction(
  agreementId: string,
  _prev: ActionResult<TermsChange> | null,
  formData: FormData,
): Promise<ActionResult<TermsChange>> {
  const actor = await currentActor("OWNER");
  const agreement = await loadAgreement(agreementId);
  if (!agreement) return fail(NOT_FOUND);
  const parsed = termsEditSchema(agreement.machine.type, agreement.start_date).safeParse(formValues(formData));
  if (!parsed.success) return fail(CHECK_FIELDS, fieldErrorsFrom(parsed.error.issues));
  const result = await updateAgreementTerms(actor, agreementId, parsed.data);
  if (result.ok) refresh();
  return result;
}

export async function returnMachineAction(agreementId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  const agreement = await loadAgreement(agreementId);
  if (!agreement) return fail(NOT_FOUND);
  const parsed = returnSchema(agreement.machine.type, todayInColombo()).safeParse(formValues(formData));
  if (!parsed.success) return fail(CHECK_FIELDS, fieldErrorsFrom(parsed.error.issues));
  const result = await returnMachine(actor, agreementId, parsed.data);
  if (!result.ok) return result;
  redirect(`/owner/machines/${agreement.machine.id}?returned=1`);
}

/** Settle later: the agreement was returned while its deposit was kept. */
export async function settleDepositAction(agreementId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  const agreement = await loadAgreement(agreementId);
  if (!agreement) return fail(NOT_FOUND);
  const parsed = settlementSchema(todayInColombo()).safeParse(formValues(formData));
  if (!parsed.success) return fail(CHECK_FIELDS, fieldErrorsFrom(parsed.error.issues));
  const result = await settleDeposit(actor, agreementId, parsed.data);
  if (result.ok) refresh();
  return result;
}
