import "server-only";

import { cookies, headers } from "next/headers";

import { getCurrentUser, loadSessionState } from "@/lib/auth/current-user";
import { evaluateLoginGate, gateStateFromRow, type LoginGateRow, minutesUntil } from "@/lib/auth/login-gate";
import {
  type BlockReason,
  blockReason,
  LAST_SEEN_COOKIE,
  lastSeenCookieOptions,
  PORTAL_HOME,
  routeDecision,
  SIGN_OUT_MESSAGES,
} from "@/lib/auth/session-policy";
import { isValidUsername, normalizeUsername, usernameToEmail } from "@/lib/auth/username";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/** One message for every wrong username / password combination (never reveals which). */
export const GENERIC_LOGIN_ERROR = "The username or password is not correct.";
export const LOGIN_UNAVAILABLE = "Sign-in is not available right now. Please try again in a few minutes.";

export function lockoutMessage(minutes: number): string {
  return `Too many sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export type LoginOutcome = { ok: true; redirectTo: string } | { ok: false; error: string };

/** The client IP as seen by Vercel (first x-forwarded-for entry), or null. */
async function clientIp(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || h.get("x-real-ip")?.trim() || null;
  // Only plain IPv4 / IPv6 literals reach the inet column.
  return ip && /^[0-9a-f:.]+$/i.test(ip) && ip.length <= 45 ? ip : null;
}

/** Only same-site paths are accepted as a post-login destination. */
function safeNext(next: string | undefined): string | null {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : null;
}

const BLOCKED_PREFIX = "RD_BLOCKED:";
const HOOK_REASONS: Record<string, BlockReason | "locked"> = {
  SUSPENDED: "suspended",
  DEACTIVATED: "deactivated",
  OWNER_INACTIVE: "owner_inactive",
  NO_PROFILE: "no_profile",
  LOCKED: "locked",
};

/**
 * Username + password sign-in (AUTH-08, AUTH-10, AUTH-11).
 *   1. Lockout / IP rate limit (login_attempts + profiles), same for unknown usernames.
 *   2. Supabase Auth with the synthetic email. Wrong credentials -> one generic message.
 *   3. Blocked accounts are signed out again with a clear message (the access token
 *      hook refuses them earlier once it is enabled).
 *   4. Every attempt is recorded; success writes the LOGIN audit entry.
 */
export async function signInWithUsername(input: { username: string; password: string; next?: string }): Promise<LoginOutcome> {
  const admin = createAdminClient();
  const username = normalizeUsername(input.username).slice(0, 100);
  const ip = await clientIp();
  const userAgent = (await headers()).get("user-agent") ?? undefined;

  const record = async (success: boolean, reason?: string) => {
    const { data, error } = await admin.rpc("rpc_record_login_attempt", {
      p_username: username || "(empty)",
      p_ip: ip,
      p_success: success,
      p_reason: reason,
      p_user_agent: userAgent,
    });
    if (error) console.error("[login] record attempt:", error.message);
    return (data ?? null) as { locked_until: string | null } | null;
  };

  const { data: gateRow, error: gateError } = await admin.rpc("rpc_login_gate_state", { p_username: username, p_ip: ip });
  if (gateError || !gateRow) {
    console.error("[login] gate state:", gateError?.message);
    return { ok: false, error: LOGIN_UNAVAILABLE };
  }
  const gate = gateStateFromRow(gateRow as unknown as LoginGateRow);
  const decision = evaluateLoginGate(gate);
  if (!decision.allowed) {
    await record(false, decision.reason);
    return { ok: false, error: lockoutMessage(minutesUntil(decision.retryAt, gate.now)) };
  }

  if (!isValidUsername(username) || input.password.length === 0) {
    await record(false, "invalid_credentials");
    return { ok: false, error: GENERIC_LOGIN_ERROR };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(username), password: input.password });

  if (error || !data.user) {
    const message = error?.message ?? "";
    if (message.startsWith(BLOCKED_PREFIX)) {
      // The access token hook refused a correct password (blocked or locked account).
      const reason = HOOK_REASONS[message.slice(BLOCKED_PREFIX.length)] ?? "no_profile";
      await record(false, reason);
      return { ok: false, error: reason === "locked" ? lockoutMessage(gate.policy.lockoutMinutes) : SIGN_OUT_MESSAGES[reason] };
    }
    if (error?.code === "invalid_credentials" || error?.status === 400) {
      const result = await record(false, "invalid_credentials");
      if (result?.locked_until) {
        return { ok: false, error: lockoutMessage(gate.policy.lockoutMinutes) };
      }
      return { ok: false, error: GENERIC_LOGIN_ERROR };
    }
    console.error("[login] supabase auth:", error?.status, error?.code, message);
    return { ok: false, error: LOGIN_UNAVAILABLE };
  }

  const state = await loadSessionState(data.user.id);
  const blocked = blockReason(state);
  if (blocked || !state) {
    await supabase.auth.signOut({ scope: "local" });
    await record(false, blocked ?? "no_profile");
    return { ok: false, error: SIGN_OUT_MESSAGES[blocked ?? "no_profile"] };
  }

  await record(true);
  (await cookies()).set(LAST_SEEN_COOKIE, String(Date.now()), lastSeenCookieOptions());

  const next = safeNext(input.next) ?? PORTAL_HOME[state.role];
  return { ok: true, redirectTo: routeDecision(state, next) ?? next };
}

/** Sign out the current user (AUTH-11: LOGOUT audit entry). */
export async function signOutCurrentUser(): Promise<void> {
  const supabase = await createClient();
  const user = await getCurrentUser();
  if (user) {
    const { error } = await createAdminClient().rpc("rpc_write_audit", {
      p_actor_id: user.id,
      p_action: "LOGOUT",
      p_entity: "profiles",
      p_entity_id: user.id,
      ...(user.owner_id ? { p_owner_id: user.owner_id } : {}),
    });
    if (error) console.error("[logout] audit:", error.message);
  }
  await supabase.auth.signOut({ scope: "local" });
  (await cookies()).delete(LAST_SEEN_COOKIE);
}
