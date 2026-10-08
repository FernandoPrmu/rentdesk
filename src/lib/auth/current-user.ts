import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import {
  blockReason,
  gatePath,
  LOGIN_PATH,
  PORTAL_HOME,
  type Role,
  type SessionState,
} from "@/lib/auth/session-policy";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Data Access Layer for the signed-in user. The proxy (src/proxy.ts) is the first
 * guard; every page and Server Action checks again here, close to the data.
 */

export type CurrentUser = SessionState & { id: string };

/** Account state of a user id (service role; the user may be blocked from RLS reads). */
export async function loadSessionState(userId: string): Promise<SessionState | null> {
  const { data, error } = await createAdminClient().rpc("rpc_session_state", { p_user_id: userId });
  if (error) throw new Error(`session state: ${error.message}`);
  return (data as SessionState | null) ?? null;
}

/** The verified signed-in user and their account state, or null. Once per request. */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims?.sub;
  if (!userId) return null;
  const state = await loadSessionState(userId);
  return state ? { ...state, id: userId } : null;
});

/**
 * The signed-in, active user with one of `roles`, or a redirect:
 * signed out or blocked -> /login; a pending password change or setup -> that page
 * (unless `allowGate` names it); another role -> that role's portal.
 */
export async function requireUser(
  roles?: Role | Role[],
  options: { allowGate?: "/change-password" | "/setup" } = {},
): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(LOGIN_PATH);

  const blocked = blockReason(user);
  if (blocked) redirect(`${LOGIN_PATH}?reason=${blocked}`);

  const gate = gatePath(user);
  if (gate && gate !== options.allowGate) redirect(gate);

  const allowed = roles === undefined ? null : Array.isArray(roles) ? roles : [roles];
  if (allowed && !allowed.includes(user.role)) redirect(PORTAL_HOME[user.role]);
  return user;
}

/**
 * For Server Actions: like requireUser, but returns null instead of redirecting,
 * so the action can answer with a typed error.
 */
export async function currentActor(roles: Role | Role[], options: { allowGate?: "/change-password" | "/setup" } = {}) {
  const user = await getCurrentUser();
  if (!user || blockReason(user)) return null;
  const gate = gatePath(user);
  if (gate && gate !== options.allowGate) return null;
  const allowed = Array.isArray(roles) ? roles : [roles];
  return allowed.includes(user.role) ? user : null;
}
