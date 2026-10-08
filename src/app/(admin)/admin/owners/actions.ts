"use server";

import { refresh } from "next/cache";

import type { CreateAccountResult } from "@/components/accounts/account-form";
import type { ShownCredentials } from "@/components/accounts/credentials-dialog";
import { type ActionResult, fail, fieldErrorsFrom, ok } from "@/lib/action-result";
import { formValues, ownerSchema, statusChangeSchema, uuidSchema } from "@/lib/accounts/schemas";
import { changeAccountStatus, createOwner, resetAccountPassword, updateOwner } from "@/lib/accounts/service";
import { currentActor } from "@/lib/auth/current-user";

/** Admin portal: owner accounts (ADM-01..03). The rpc functions re-check the role. */

const SIGNED_OUT = "Your session has ended. Please sign in again.";

export async function createOwnerAction(_prev: CreateAccountResult | null, formData: FormData): Promise<CreateAccountResult> {
  const actor = await currentActor("ADMIN");
  if (!actor) return fail(SIGNED_OUT);
  const parsed = ownerSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  return createOwner(actor, parsed.data);
}

export async function updateOwnerAction(ownerId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("ADMIN");
  if (!actor) return fail(SIGNED_OUT);
  if (!uuidSchema.safeParse(ownerId).success) return fail("Owner not found.");
  const parsed = ownerSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  const result = await updateOwner(actor, ownerId, parsed.data);
  if (result.ok) refresh();
  return result;
}

export async function setOwnerStatusAction(ownerId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("ADMIN");
  if (!actor) return fail(SIGNED_OUT);
  if (!uuidSchema.safeParse(ownerId).success) return fail("Owner not found.");
  const parsed = statusChangeSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail(parsed.error.issues[0].message, fieldErrorsFrom(parsed.error.issues));
  const result = await changeAccountStatus(actor, ownerId, parsed.data.status, parsed.data.reason);
  if (result.ok) refresh();
  return result;
}

export async function resetOwnerPasswordAction(ownerId: string): Promise<ActionResult<ShownCredentials>> {
  const actor = await currentActor("ADMIN");
  if (!actor) return fail(SIGNED_OUT);
  if (!uuidSchema.safeParse(ownerId).success) return fail("Owner not found.");
  const result = await resetAccountPassword(actor, ownerId);
  if (!result.ok) return result;
  refresh();
  return ok({ username: result.data.username, temporaryPassword: result.data.temporaryPassword });
}
