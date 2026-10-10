"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";

import { type ActionResult, fail, fieldErrorsFrom } from "@/lib/action-result";
import { formValues, uuidSchema } from "@/lib/accounts/schemas";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { assignmentSchema, returnSchema } from "@/lib/agreements/schemas";
import { assignMachine, reassignMachine } from "@/lib/agreements/service";
import { currentActor } from "@/lib/auth/current-user";
import { getMachineType } from "@/lib/machines/queries";
import { machineCreateSchema, machineStatusSchema, machineUpdateSchema } from "@/lib/machines/schemas";
import { createMachine, setMachineStatus, updateMachine } from "@/lib/machines/service";

/**
 * Owner portal: machines (MAC-01..04). Every action parses its input with Zod on
 * the server; the database checks the owner and tenant again (RLS or rpc).
 */

const NOT_FOUND = "This machine was not found.";
const CHECK_FIELDS = "Please check the highlighted fields.";

export async function createMachineAction(_prev: ActionResult<{ id: string }> | null, formData: FormData): Promise<ActionResult<{ id: string }>> {
  const actor = await currentActor("OWNER");
  const parsed = machineCreateSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail(CHECK_FIELDS, fieldErrorsFrom(parsed.error.issues));
  return createMachine(actor, parsed.data);
}

export async function updateMachineAction(machineId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  await currentActor("OWNER"); // guard only: the update runs as the user (RLS)
  if (!uuidSchema.safeParse(machineId).success) return fail(NOT_FOUND);
  const type = await getMachineType(machineId);
  if (!type) return fail(NOT_FOUND);
  const parsed = machineUpdateSchema(type).safeParse(formValues(formData));
  if (!parsed.success) return fail(CHECK_FIELDS, fieldErrorsFrom(parsed.error.issues));
  const result = await updateMachine(machineId, parsed.data);
  if (result.ok) refresh();
  return result;
}

export async function setMachineStatusAction(machineId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(machineId).success) return fail(NOT_FOUND);
  const parsed = machineStatusSchema.safeParse(formValues(formData));
  if (!parsed.success) return fail(parsed.error.issues[0].message, fieldErrorsFrom(parsed.error.issues));
  const result = await setMachineStatus(actor, machineId, parsed.data.status, parsed.data.reason);
  if (result.ok) refresh();
  return result;
}

/** MAC-02 / AGR-01. On success the browser goes to the new agreement. */
export async function assignMachineAction(machineId: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(machineId).success) return fail(NOT_FOUND);
  const type = await getMachineType(machineId);
  if (!type) return fail(NOT_FOUND);
  const parsed = assignmentSchema(type, todayInColombo()).safeParse(formValues(formData));
  if (!parsed.success) return fail(CHECK_FIELDS, fieldErrorsFrom(parsed.error.issues));
  const result = await assignMachine(actor, machineId, parsed.data);
  if (!result.ok) return result;
  redirect(`/owner/agreements/${result.data.agreementId}?assigned=1`);
}

/**
 * MAC-04 reassign: closing readings for the current agreement and the new
 * customer's terms in one form, saved in one transaction.
 */
export async function reassignMachineAction(
  machineId: string,
  agreementId: string,
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  if (!uuidSchema.safeParse(machineId).success || !uuidSchema.safeParse(agreementId).success) return fail(NOT_FOUND);
  const type = await getMachineType(machineId);
  if (!type) return fail(NOT_FOUND);
  const values = formValues(formData);
  const closing = returnSchema(type, todayInColombo()).safeParse(values);
  const assignment = assignmentSchema(type, todayInColombo()).safeParse(values);
  if (!closing.success || !assignment.success) {
    return fail(CHECK_FIELDS, {
      ...(assignment.success ? {} : fieldErrorsFrom(assignment.error.issues)),
      ...(closing.success ? {} : fieldErrorsFrom(closing.error.issues)),
    });
  }
  const result = await reassignMachine(actor, agreementId, closing.data, assignment.data);
  if (!result.ok) return result;
  redirect(`/owner/agreements/${result.data.agreementId}?assigned=1`);
}

