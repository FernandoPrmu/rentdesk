/**
 * Session rules for the route guard in src/proxy.ts (AUTH-03, AUTH-06, AUTH-09,
 * AUTH-10, BRD-01). Pure, so every decision is unit-tested.
 */

export type Role = "ADMIN" | "OWNER" | "CUSTOMER";
export type AccountStatus = "ACTIVE" | "SUSPENDED" | "DEACTIVATED";

/** Shape returned by `rpc_session_state`. */
export interface SessionState {
  user_id: string;
  role: Role;
  username: string;
  full_name: string;
  status: AccountStatus;
  owner_id: string | null;
  owner_status: AccountStatus | null;
  must_change_password: boolean;
  onboarded: boolean;
  session_idle_minutes: number;
  session_max_hours: number;
}

export const PORTAL_HOME: Record<Role, string> = {
  ADMIN: "/admin",
  OWNER: "/owner",
  CUSTOMER: "/customer",
};

export const CHANGE_PASSWORD_PATH = "/change-password";
export const SETUP_PATH = "/setup";
export const LOGIN_PATH = "/login";

/** Pages anyone may open. Signed-in users are sent on to their portal. */
export const PUBLIC_PATHS = ["/", LOGIN_PATH];

export type BlockReason = "suspended" | "deactivated" | "owner_inactive" | "no_profile";
export type SignOutReason = BlockReason | "idle" | "expired";

/** Why this account may not use the app right now, or null. */
export function blockReason(state: SessionState | null): BlockReason | null {
  if (!state) return "no_profile";
  if (state.status === "SUSPENDED") return "suspended";
  if (state.status === "DEACTIVATED") return "deactivated";
  if (state.role === "CUSTOMER" && state.owner_status !== "ACTIVE") return "owner_inactive";
  return null;
}

/** Messages shown on the login page after a forced sign-out (`?reason=`). */
export const SIGN_OUT_MESSAGES: Record<SignOutReason, string> = {
  suspended: "Your account is suspended. Please contact your provider.",
  deactivated: "Your account is closed. Please contact your provider.",
  owner_inactive: "Your provider's account is not active right now. Please contact them.",
  no_profile: "Your account is not set up. Please contact your provider.",
  idle: "You were signed out after a period of inactivity. Please sign in again.",
  expired: "Your session has ended. Please sign in again.",
};

export function isSignOutReason(value: unknown): value is SignOutReason {
  return typeof value === "string" && Object.hasOwn(SIGN_OUT_MESSAGES, value);
}

export interface SessionTimes {
  now: Date;
  /** When the user signed in (JWT `amr` timestamp, or `iat` as a fallback). */
  authenticatedAt: Date | null;
  /** Last request seen by the proxy (cookie); null on the first request. */
  lastSeenAt: Date | null;
  idleMinutes: number;
  maxHours: number;
}

/** AUTH-09: inactivity timeout and maximum session length. */
export function sessionTimeout(t: SessionTimes): "idle" | "expired" | null {
  const now = t.now.getTime();
  if (t.authenticatedAt && now - t.authenticatedAt.getTime() > t.maxHours * 3_600_000) {
    return "expired";
  }
  if (t.lastSeenAt && now - t.lastSeenAt.getTime() > t.idleMinutes * 60_000) {
    return "idle";
  }
  return null;
}

export function matchesPath(pathname: string, base: string): boolean {
  return base === "/" ? pathname === "/" : pathname === base || pathname.startsWith(`${base}/`);
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((p) => matchesPath(pathname, p));
}

/** Which role a portal path belongs to, if any. */
export function portalRole(pathname: string): Role | null {
  for (const role of Object.keys(PORTAL_HOME) as Role[]) {
    if (matchesPath(pathname, PORTAL_HOME[role])) return role;
  }
  return null;
}

/** The page a signed-in user must be on right now, before anything else. */
export function gatePath(state: SessionState): string | null {
  if (state.must_change_password) return CHANGE_PASSWORD_PATH;
  if (state.role === "OWNER" && !state.onboarded) return SETUP_PATH;
  return null;
}

/**
 * Where a signed-in, unblocked user may go. Returns null to allow the request,
 * or the path to redirect to.
 *   1. Forced password change, then owner company setup (BRD-01), before anything else.
 *   2. /setup only while it is needed; public pages send the user to their portal.
 *   3. Each portal only for its own role (AUTH-06).
 */
export function routeDecision(state: SessionState, pathname: string): string | null {
  const home = PORTAL_HOME[state.role];
  const gate = gatePath(state);
  if (gate) {
    return matchesPath(pathname, gate) ? null : gate;
  }
  if (matchesPath(pathname, SETUP_PATH) || isPublicPath(pathname)) {
    return home;
  }
  if (matchesPath(pathname, CHANGE_PASSWORD_PATH)) {
    return null;
  }
  const portal = portalRole(pathname);
  if (portal && portal !== state.role) {
    return home;
  }
  return null;
}
