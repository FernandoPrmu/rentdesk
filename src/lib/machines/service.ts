import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { dbErrorMessage } from "@/lib/db-errors";
import type { MachineCreateInput, MachineUpdateInput } from "@/lib/machines/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Machine details are written as the signed-in owner: RLS and column grants allow
 * only their own machines and never the status. Status changes go through
 * rpc_set_machine_status (reason + audit, MAC-03).
 */

const DUPLICATE_SERIAL = "You already have a machine with this serial number.";

export async function createMachine(actor: CurrentUser, input: MachineCreateInput): Promise<ActionResult<{ id: string }>> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("machines")
    .insert({ ...input, owner_id: actor.id })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return fail(DUPLICATE_SERIAL, { serial_no: DUPLICATE_SERIAL });
    return fail(dbErrorMessage(error, "machines"));
  }
  return ok({ id: data.id });
}

export async function updateMachine(machineId: string, input: MachineUpdateInput): Promise<ActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("machines").update(input).eq("id", machineId).select("id");
  if (error) {
    if (error.code === "23505") return fail(DUPLICATE_SERIAL, { serial_no: DUPLICATE_SERIAL });
    return fail(dbErrorMessage(error, "machines"));
  }
  return data.length === 1 ? ok(undefined) : fail("This machine was not found.");
}

export async function setMachineStatus(
  actor: CurrentUser,
  machineId: string,
  status: "AVAILABLE" | "UNDER_REPAIR" | "RETIRED",
  reason: string,
): Promise<ActionResult> {
  const { error } = await createAdminClient().rpc("rpc_set_machine_status", {
    p_actor_id: actor.id,
    p_machine_id: machineId,
    p_status: status,
    p_reason: reason,
  });
  return error ? fail(dbErrorMessage(error, "machines")) : ok(undefined);
}
