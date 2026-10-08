import { describe, expect, it } from "vitest";

import { hookBlockReason, lockoutMessage } from "./login";

describe("hookBlockReason", () => {
  it("reads the access token hook's refusal, even when wrapped", () => {
    expect(hookBlockReason("RD_BLOCKED:SUSPENDED")).toBe("suspended");
    expect(hookBlockReason("Error running hook URI: RD_BLOCKED:OWNER_INACTIVE")).toBe("owner_inactive");
    expect(hookBlockReason("RD_BLOCKED:LOCKED")).toBe("locked");
    expect(hookBlockReason("RD_BLOCKED:SOMETHING_NEW")).toBe("no_profile");
  });

  it("ignores other errors", () => {
    expect(hookBlockReason("Invalid login credentials")).toBeNull();
    expect(hookBlockReason(undefined)).toBeNull();
  });
});

describe("lockoutMessage", () => {
  it("says how long to wait", () => {
    expect(lockoutMessage(15)).toBe("Too many sign-in attempts. Please try again in 15 minutes.");
    expect(lockoutMessage(1)).toBe("Too many sign-in attempts. Please try again in 1 minute.");
  });
});
