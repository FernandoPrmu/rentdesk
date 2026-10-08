import { describe, expect, it } from "vitest";

import { DEFAULT_LOGIN_POLICY, evaluateLoginGate, gateStateFromRow, type LoginGateState, minutesUntil } from "./login-gate";

const NOW = new Date("2026-10-08T10:00:00Z");
const minutes = (m: number) => new Date(NOW.getTime() + m * 60_000);

function state(overrides: Partial<LoginGateState> = {}): LoginGateState {
  return {
    now: NOW,
    lockedUntil: null,
    usernameFailures: 0,
    lastUsernameFailureAt: null,
    ipFailures: 0,
    policy: DEFAULT_LOGIN_POLICY,
    ...overrides,
  };
}

describe("evaluateLoginGate", () => {
  it("allows a clean attempt", () => {
    expect(evaluateLoginGate(state())).toEqual({ allowed: true });
  });

  it("allows up to 4 recent failures", () => {
    expect(evaluateLoginGate(state({ usernameFailures: 4, lastUsernameFailureAt: minutes(-1) }))).toEqual({ allowed: true });
  });

  it("blocks a locked account until locked_until", () => {
    expect(evaluateLoginGate(state({ lockedUntil: minutes(10) }))).toEqual({ allowed: false, reason: "locked", retryAt: minutes(10) });
    expect(evaluateLoginGate(state({ lockedUntil: minutes(-1) }))).toEqual({ allowed: true });
  });

  it("locks unknown usernames after 5 failures for 15 minutes from the last one", () => {
    const s = state({ usernameFailures: 5, lastUsernameFailureAt: minutes(-5) });
    expect(evaluateLoginGate(s)).toEqual({ allowed: false, reason: "locked", retryAt: minutes(10) });
    expect(evaluateLoginGate({ ...s, lastUsernameFailureAt: minutes(-16) })).toEqual({ allowed: true });
  });

  it("limits an IP after 30 failures in its window", () => {
    expect(evaluateLoginGate(state({ ipFailures: 29 }))).toEqual({ allowed: true });
    expect(evaluateLoginGate(state({ ipFailures: 30 }))).toEqual({ allowed: false, reason: "ip_limited", retryAt: minutes(15) });
  });

  it("reports the account lock before the IP limit", () => {
    const d = evaluateLoginGate(state({ lockedUntil: minutes(3), ipFailures: 100 }));
    expect(d).toMatchObject({ reason: "locked" });
  });

  it("uses the policy from settings", () => {
    const policy = { maxFailures: 3, lockoutMinutes: 60, ipMaxFailures: 5, ipWindowMinutes: 10 };
    expect(evaluateLoginGate(state({ policy, usernameFailures: 3, lastUsernameFailureAt: minutes(-30) }))).toMatchObject({
      allowed: false,
      retryAt: minutes(30),
    });
    expect(evaluateLoginGate(state({ policy, ipFailures: 5 }))).toMatchObject({ reason: "ip_limited", retryAt: minutes(10) });
  });
});

describe("helpers", () => {
  it("rounds the wait up to whole minutes", () => {
    expect(minutesUntil(minutes(14.2), NOW)).toBe(15);
    expect(minutesUntil(minutes(-1), NOW)).toBe(1);
  });

  it("reads the database row", () => {
    const s = gateStateFromRow({
      now: NOW.toISOString(),
      locked_until: null,
      username_failures: 2,
      last_username_failure_at: minutes(-1).toISOString(),
      ip_failures: 3,
      policy: { max_failures: 5, lockout_minutes: 15, ip_max_failures: 30, ip_window_minutes: 15 },
    });
    expect(s).toEqual(state({ usernameFailures: 2, lastUsernameFailureAt: minutes(-1), ipFailures: 3 }));
  });
});
