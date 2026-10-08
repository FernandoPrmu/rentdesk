import { describe, expect, it } from "vitest";

import {
  actionRedirectTarget,
  authenticatedAtFromClaims,
  blockReason,
  isServerActionRequest,
  isSignOutReason,
  parseLastSeen,
  routeDecision,
  safeInternalPath,
  type SessionState,
  sessionTimeout,
} from "./session-policy";

function session(overrides: Partial<SessionState> = {}): SessionState {
  return {
    user_id: "u1",
    role: "CUSTOMER",
    username: "cust.perera",
    full_name: "Perera",
    status: "ACTIVE",
    owner_id: "o1",
    owner_status: "ACTIVE",
    must_change_password: false,
    onboarded: true,
    session_idle_minutes: 30,
    session_max_hours: 12,
    ...overrides,
  };
}

describe("blockReason (AUTH-10)", () => {
  it("allows active users", () => {
    expect(blockReason(session())).toBeNull();
    expect(blockReason(session({ role: "ADMIN", owner_id: null, owner_status: null }))).toBeNull();
  });

  it("blocks suspended, deactivated and missing accounts", () => {
    expect(blockReason(session({ status: "SUSPENDED" }))).toBe("suspended");
    expect(blockReason(session({ status: "DEACTIVATED" }))).toBe("deactivated");
    expect(blockReason(null)).toBe("no_profile");
  });

  it("blocks customers of a suspended or deactivated owner", () => {
    expect(blockReason(session({ owner_status: "SUSPENDED" }))).toBe("owner_inactive");
    expect(blockReason(session({ owner_status: "DEACTIVATED" }))).toBe("owner_inactive");
  });

  it("recognises sign-out reasons from the query string", () => {
    expect(isSignOutReason("idle")).toBe(true);
    expect(isSignOutReason("toString")).toBe(false);
    expect(isSignOutReason(undefined)).toBe(false);
  });
});

describe("sessionTimeout (AUTH-09)", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const base = { now, idleMinutes: 30, maxHours: 12 };

  it("keeps an active session", () => {
    expect(sessionTimeout({ ...base, authenticatedAt: ago(60), lastSeenAt: ago(29) })).toBeNull();
    expect(sessionTimeout({ ...base, authenticatedAt: null, lastSeenAt: null })).toBeNull();
  });

  it("signs out after 30 idle minutes", () => {
    expect(sessionTimeout({ ...base, authenticatedAt: ago(60), lastSeenAt: ago(31) })).toBe("idle");
  });

  it("signs out 12 hours after login, however active", () => {
    expect(sessionTimeout({ ...base, authenticatedAt: ago(12 * 60 + 1), lastSeenAt: ago(1) })).toBe("expired");
  });
});

describe("routeDecision (AUTH-03, AUTH-06, BRD-01)", () => {
  it("keeps each role inside its own portal", () => {
    const owner = session({ role: "OWNER", owner_id: "u1" });
    expect(routeDecision(owner, "/owner/customers")).toBeNull();
    expect(routeDecision(owner, "/admin")).toBe("/owner");
    expect(routeDecision(owner, "/admin/owners/1")).toBe("/owner");
    expect(routeDecision(owner, "/customer")).toBe("/owner");

    const customer = session();
    expect(routeDecision(customer, "/customer/bills")).toBeNull();
    expect(routeDecision(customer, "/owner")).toBe("/customer");

    const admin = session({ role: "ADMIN", owner_id: null, owner_status: null });
    expect(routeDecision(admin, "/admin/owners")).toBeNull();
    expect(routeDecision(admin, "/owner")).toBe("/admin");
  });

  it("does not confuse portal prefixes with similar paths", () => {
    expect(routeDecision(session(), "/ownerx")).toBeNull();
  });

  it("sends signed-in users from public pages to their portal", () => {
    expect(routeDecision(session(), "/")).toBe("/customer");
    expect(routeDecision(session({ role: "ADMIN" }), "/login")).toBe("/admin");
  });

  it("forces a password change before anything else", () => {
    const forced = session({ must_change_password: true });
    expect(routeDecision(forced, "/customer")).toBe("/change-password");
    expect(routeDecision(forced, "/owner")).toBe("/change-password");
    expect(routeDecision(forced, "/change-password")).toBeNull();

    const forcedOwner = session({ role: "OWNER", must_change_password: true, onboarded: false });
    expect(routeDecision(forcedOwner, "/setup")).toBe("/change-password");
  });

  it("sends an owner through setup before the dashboard, and never back", () => {
    const newOwner = session({ role: "OWNER", onboarded: false });
    expect(routeDecision(newOwner, "/owner")).toBe("/setup");
    expect(routeDecision(newOwner, "/owner/settings/company")).toBe("/setup");
    expect(routeDecision(newOwner, "/setup")).toBeNull();

    const done = session({ role: "OWNER" });
    expect(routeDecision(done, "/setup")).toBe("/owner");
    expect(routeDecision(done, "/change-password")).toBeNull();
  });
});

describe("session cookies and claims", () => {
  it("parses the last-seen cookie", () => {
    expect(parseLastSeen("1760000000000")).toEqual(new Date(1760000000000));
    expect(parseLastSeen(undefined)).toBeNull();
    expect(parseLastSeen("garbage")).toBeNull();
  });

  it("reads the sign-in time from amr, falling back to iat", () => {
    expect(authenticatedAtFromClaims({ iat: 2000, amr: [{ method: "password", timestamp: 1000 }] })).toEqual(new Date(1_000_000));
    expect(
      authenticatedAtFromClaims({ amr: [{ method: "otp", timestamp: 500 }, { method: "password", timestamp: 900 }] }),
    ).toEqual(new Date(900_000));
    expect(authenticatedAtFromClaims({ iat: 2000, amr: ["password"] })).toEqual(new Date(2_000_000));
    expect(authenticatedAtFromClaims({})).toBeNull();
  });
});

describe("Server Action requests in the proxy", () => {
  it("recognises a Server Action by POST + Next-Action", () => {
    expect(isServerActionRequest("POST", new Headers({ "next-action": "abc" }))).toBe(true);
    expect(isServerActionRequest("POST", new Headers())).toBe(false);
    expect(isServerActionRequest("GET", new Headers({ "next-action": "abc" }))).toBe(false);
  });

  it("only accepts same-site paths as redirect targets", () => {
    expect(safeInternalPath("/login?reason=idle")).toBe("/login?reason=idle");
    expect(safeInternalPath("/setup")).toBe("/setup");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "login", "", null, undefined]) {
      expect(safeInternalPath(bad)).toBeNull();
    }
  });
});

describe("actionRedirectTarget (action guard without a proxy hint)", () => {
  it("sends each kind of user to the right page", () => {
    expect(actionRedirectTarget(null)).toBe("/login");
    expect(actionRedirectTarget(session({ status: "SUSPENDED" }))).toBe("/login?reason=suspended");
    expect(actionRedirectTarget(session({ owner_status: "SUSPENDED" }))).toBe("/login?reason=owner_inactive");
    expect(actionRedirectTarget(session({ must_change_password: true }))).toBe("/change-password");
    expect(actionRedirectTarget(session({ role: "OWNER", owner_id: null, onboarded: false }))).toBe("/setup");
    // The action is allowed at its own gate; the user only has the wrong role.
    expect(actionRedirectTarget(session({ role: "OWNER", owner_id: null, onboarded: false }), "/setup")).toBe("/owner");
    expect(actionRedirectTarget(session())).toBe("/customer");
  });
});
