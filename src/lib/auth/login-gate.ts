/**
 * Login rate limiting and lockout (AUTH-08). Pure: the server action reads the
 * state with `rpc_login_gate_state` and records the outcome with
 * `rpc_record_login_attempt`, which applies the same thresholds atomically.
 *
 * Rules (thresholds from platform_settings):
 *   - An account is locked for `lockoutMinutes` after `maxFailures` wrong passwords
 *     (counted since its last success, within the lockout window).
 *   - Unknown usernames are treated exactly the same, so a lockout message never
 *     reveals whether a username exists.
 *   - One IP address may fail at most `ipMaxFailures` times per `ipWindowMinutes`.
 */

export interface LoginPolicy {
  maxFailures: number;
  lockoutMinutes: number;
  ipMaxFailures: number;
  ipWindowMinutes: number;
}

export const DEFAULT_LOGIN_POLICY: LoginPolicy = {
  maxFailures: 5,
  lockoutMinutes: 15,
  ipMaxFailures: 30,
  ipWindowMinutes: 15,
};

export interface LoginGateState {
  now: Date;
  /** profiles.locked_until; null for unknown usernames or unlocked accounts. */
  lockedUntil: Date | null;
  /** Wrong-password failures for this username in the current window. */
  usernameFailures: number;
  lastUsernameFailureAt: Date | null;
  /** Wrong-password failures from this IP in the IP window. */
  ipFailures: number;
  policy: LoginPolicy;
}

export type LoginGateDecision =
  | { allowed: true }
  | { allowed: false; reason: "locked" | "ip_limited"; retryAt: Date };

const MINUTE = 60_000;

export function evaluateLoginGate(state: LoginGateState): LoginGateDecision {
  const { now, policy } = state;

  if (state.lockedUntil && state.lockedUntil > now) {
    return { allowed: false, reason: "locked", retryAt: state.lockedUntil };
  }
  if (state.usernameFailures >= policy.maxFailures && state.lastUsernameFailureAt) {
    const until = new Date(state.lastUsernameFailureAt.getTime() + policy.lockoutMinutes * MINUTE);
    if (until > now) {
      return { allowed: false, reason: "locked", retryAt: until };
    }
  }
  if (state.ipFailures >= policy.ipMaxFailures) {
    return { allowed: false, reason: "ip_limited", retryAt: new Date(now.getTime() + policy.ipWindowMinutes * MINUTE) };
  }
  return { allowed: true };
}

/** Whole minutes until `retryAt`, at least 1. */
export function minutesUntil(retryAt: Date, now: Date): number {
  return Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / MINUTE));
}

/** Shape returned by `rpc_login_gate_state`. */
export interface LoginGateRow {
  now: string;
  locked_until: string | null;
  username_failures: number;
  last_username_failure_at: string | null;
  ip_failures: number;
  policy: { max_failures: number; lockout_minutes: number; ip_max_failures: number; ip_window_minutes: number };
}

export function gateStateFromRow(row: LoginGateRow): LoginGateState {
  return {
    now: new Date(row.now),
    lockedUntil: row.locked_until ? new Date(row.locked_until) : null,
    usernameFailures: row.username_failures,
    lastUsernameFailureAt: row.last_username_failure_at ? new Date(row.last_username_failure_at) : null,
    ipFailures: row.ip_failures,
    policy: {
      maxFailures: row.policy.max_failures,
      lockoutMinutes: row.policy.lockout_minutes,
      ipMaxFailures: row.policy.ip_max_failures,
      ipWindowMinutes: row.policy.ip_window_minutes,
    },
  };
}
