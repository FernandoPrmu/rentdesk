import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { AccountStatusValue, CustomerInput, OwnerInput } from "@/lib/accounts/schemas";
import type { CurrentUser } from "@/lib/auth/current-user";
import { generateTemporaryPassword } from "@/lib/auth/temporary-password";
import { usernameCandidates, usernameToEmail } from "@/lib/auth/username";
import { dbErrorMessage } from "@/lib/db-errors";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/db";

/**
 * Account provisioning and management (AUTH-01/02/04/05, ADM-01..03, CUS-01..03).
 * Credentials go through the Auth Admin API (service role, server only); every
 * database change goes through an atomic rpc_* function that checks the hierarchy
 * (Admin -> Owner -> Customer) again and writes the audit log.
 */

/** Shown once to the creator, never stored by RentDesk. */
export interface Credentials {
  userId: string;
  username: string;
  temporaryPassword: string;
}

/** Which of these usernames are already taken. */
async function existingUsernames(candidates: string[]): Promise<Set<string>> {
  const { data, error } = await createAdminClient().from("profiles").select("username").in("username", candidates);
  if (error) throw new Error(`usernames: ${error.message}`);
  return new Set(data.map((r) => r.username));
}

/**
 * Creates the auth user (synthetic email, temporary password) and then the profile
 * rows through rpc_provision_account. If the second step fails, the auth user is
 * deleted again, so no half-created account is left behind.
 */
async function provision(input: {
  actor: CurrentUser;
  role: "OWNER" | "CUSTOMER";
  displayName: string;
  fullName: string;
  details: Record<string, string | null>;
}): Promise<ActionResult<Credentials>> {
  const admin = createAdminClient();
  const candidates = usernameCandidates(input.role === "OWNER" ? "owner" : "cust", input.displayName, 50);
  const taken = await existingUsernames(candidates);
  const free = candidates.filter((c) => !taken.has(c));

  // Retry a few times in case another request takes the same username meanwhile.
  for (const username of free.slice(0, 3)) {
    const temporaryPassword = generateTemporaryPassword();
    const { data: created, error: authError } = await admin.auth.admin.createUser({
      email: usernameToEmail(username),
      password: temporaryPassword,
      email_confirm: true,
      user_metadata: { username },
    });
    if (authError || !created.user) {
      if (authError?.code === "email_exists" || authError?.status === 422) continue;
      console.error("[accounts] create auth user:", authError?.code, authError?.message);
      return fail("The account could not be created. Please try again.");
    }

    const userId = created.user.id;
    const { error } = await admin.rpc("rpc_provision_account", {
      p_user_id: userId,
      p_role: input.role,
      p_username: username,
      p_full_name: input.fullName,
      // An owner's tenant is the owner itself; the function ignores p_owner_id for owners.
      p_owner_id: input.role === "CUSTOMER" ? input.actor.id : (null as unknown as string),
      p_created_by: input.actor.id,
      p_must_change_password: true,
      p_details: input.details as Json,
    });
    if (error) {
      await admin.auth.admin.deleteUser(userId);
      if (error.code === "23505") continue; // username taken in the meantime
      return fail(dbErrorMessage(error, "accounts"));
    }
    return ok({ userId, username, temporaryPassword });
  }
  return fail("No free username was found for this name. Try a slightly different name.");
}

export function createOwner(actor: CurrentUser, input: OwnerInput) {
  return provision({
    actor,
    role: "OWNER",
    displayName: input.business_name,
    fullName: input.contact_person,
    details: { ...input },
  });
}

export function createCustomer(actor: CurrentUser, input: CustomerInput) {
  return provision({
    actor,
    role: "CUSTOMER",
    displayName: input.business_name ?? input.name,
    fullName: input.name,
    details: { ...input },
  });
}

export async function updateOwner(actor: CurrentUser, ownerId: string, input: OwnerInput): Promise<ActionResult> {
  const { error } = await createAdminClient().rpc("rpc_update_owner", {
    p_actor_id: actor.id,
    p_owner_id: ownerId,
    p_details: input as unknown as Json,
  });
  return error ? fail(dbErrorMessage(error, "accounts")) : ok(undefined);
}

export async function updateCustomer(actor: CurrentUser, customerId: string, input: CustomerInput): Promise<ActionResult> {
  const { error } = await createAdminClient().rpc("rpc_update_customer", {
    p_actor_id: actor.id,
    p_customer_id: customerId,
    p_details: input as unknown as Json,
  });
  return error ? fail(dbErrorMessage(error, "accounts")) : ok(undefined);
}

/** Suspend, reactivate or deactivate (ADM-02, CUS-03); the database checks who may. */
export async function changeAccountStatus(
  actor: CurrentUser,
  targetId: string,
  status: AccountStatusValue,
  reason: string,
): Promise<ActionResult> {
  const { error } = await createAdminClient().rpc("rpc_set_account_status", {
    p_actor_id: actor.id,
    p_target_id: targetId,
    p_status: status,
    p_reason: reason,
  });
  return error ? fail(dbErrorMessage(error, "accounts")) : ok(undefined);
}

/**
 * New temporary password (AUTH-05, ADM-03, CUS-03). The rpc call is the permission
 * check, so it runs first; only then is the password replaced.
 */
export async function resetAccountPassword(actor: CurrentUser, targetId: string): Promise<ActionResult<Credentials>> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("rpc_reset_account_password", { p_actor_id: actor.id, p_target_id: targetId });
  if (error) return fail(dbErrorMessage(error, "accounts"));

  const { username } = data as { username: string };
  const temporaryPassword = generateTemporaryPassword();
  const { error: authError } = await admin.auth.admin.updateUserById(targetId, { password: temporaryPassword });
  if (authError) {
    console.error("[accounts] reset password:", authError.code, authError.message);
    return fail("The password could not be reset. Please try again.");
  }
  return ok({ userId: targetId, username, temporaryPassword });
}
