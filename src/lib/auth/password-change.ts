import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { type CurrentUser, loadSessionState } from "@/lib/auth/current-user";
import { checkPassword } from "@/lib/auth/password";
import { PORTAL_HOME, routeDecision } from "@/lib/auth/session-policy";
import { usernameToEmail } from "@/lib/auth/username";
import { publicEnv } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** Checks a password without touching the caller's session; revokes the check's own session. */
async function verifyPassword(username: string, password: string): Promise<boolean> {
  const env = publicEnv();
  const probe = createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data, error } = await probe.auth.signInWithPassword({ email: usernameToEmail(username), password });
  if (error || !data.session) return false;
  await createAdminClient().auth.admin.signOut(data.session.access_token, "local");
  return true;
}

/**
 * AUTH-03: the signed-in user sets a new password. During a forced change the
 * current password is not asked again (the user has just signed in with it);
 * a voluntary change must confirm it. Clears must_change_password and returns
 * where to go next (owner setup, or the portal).
 */
export async function changeOwnPassword(
  user: CurrentUser,
  input: { currentPassword?: string; newPassword: string; confirmPassword: string },
): Promise<ActionResult<{ redirectTo: string }>> {
  if (input.newPassword !== input.confirmPassword) {
    return fail("The two new passwords do not match.", { confirmPassword: "The passwords do not match." });
  }
  if (!checkPassword(input.newPassword, { username: user.username }).ok) {
    return fail("The new password does not meet all the rules.", { newPassword: "Follow all the rules below." });
  }
  if (!user.must_change_password) {
    if (!input.currentPassword || !(await verifyPassword(user.username, input.currentPassword))) {
      return fail("Your current password is not correct.", { currentPassword: "Not correct." });
    }
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: input.newPassword });
  if (error) {
    if (error.code === "same_password") {
      return fail("Choose a password that is different from your current one.", { newPassword: "Must be different from your current password." });
    }
    if (error.code === "weak_password") {
      return fail("This password is too weak. Choose a longer one.", { newPassword: "Too weak." });
    }
    console.error("[password] update:", error.code, error.message);
    return fail("Your password could not be changed. Please try again.");
  }

  const { error: rpcError } = await createAdminClient().rpc("rpc_complete_password_change", { p_user_id: user.id });
  if (rpcError) {
    console.error("[password] complete:", rpcError.message);
    return fail("Your password was changed, but something else went wrong. Please sign in again.");
  }

  const state = await loadSessionState(user.id);
  const home = PORTAL_HOME[user.role];
  return ok({ redirectTo: state ? (routeDecision(state, home) ?? home) : home });
}
