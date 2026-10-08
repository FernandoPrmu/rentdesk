"use server";

import { refresh } from "next/cache";

import type { CreateAccountResult } from "@/components/accounts/account-form";
import type { ShownCredentials } from "@/components/accounts/credentials-dialog";
import { type ActionResult, fail, fieldErrorsFrom, ok } from "@/lib/action-result";
import { customerSchema, formValues, statusChangeSchema, uuidSchema } from "@/lib/accounts/schemas";
import { changeAccountStatus, createCustomer, resetAccountPassword, updateCustomer } from "@/lib/accounts/service";
import { currentActor } from "@/lib/auth/current-user";

/**
 * Owner portal: customer accounts (CUS-01..03). The rpc functions allow an owner to
 * manage only their own customers, whatever id the browser sends.
 */


export async function createCustomerAction(_prev: CreateAccountResult | null, formData: FormData): Promise<CreateAccountResult> {
  const actor = await currentActor("OWNER");
  const parsed = customerSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  return createCustomer(actor, parsed.data);
}

export async function updateCustomerAction(customerId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(customerId).success) return fail("Customer not found.");
  const parsed = customerSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  const result = await updateCustomer(actor, customerId, parsed.data);
  if (result.ok) refresh();
  return result;
}

export async function setCustomerStatusAction(customerId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(customerId).success) return fail("Customer not found.");
  const parsed = statusChangeSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail(parsed.error.issues[0].message, fieldErrorsFrom(parsed.error.issues));
  const result = await changeAccountStatus(actor, customerId, parsed.data.status, parsed.data.reason);
  if (result.ok) refresh();
  return result;
}

export async function resetCustomerPasswordAction(customerId: string): Promise<ActionResult<ShownCredentials>> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(customerId).success) return fail("Customer not found.");
  const result = await resetAccountPassword(actor, customerId);
  if (!result.ok) return result;
  refresh();
  return ok({ username: result.data.username, temporaryPassword: result.data.temporaryPassword });
}
