import { describe, expect, it } from "vitest";

import { returnBlockedMessage } from "./blockers";

describe("returnBlockedMessage (RET-01)", () => {
  it("says which meter reading to review first", () => {
    const message = `RETURN_BLOCKED:${JSON.stringify([{ kind: "ticket", id: "t", cycle_no: 3, status: "PENDING_OWNER_REVIEW" }])}`;
    expect(returnBlockedMessage(message)).toBe(
      "This machine cannot be returned yet. First review the meter reading waiting for cycle 3, so the final bill uses confirmed numbers.",
    );
  });

  it("ignores other errors and survives a broken payload", () => {
    expect(returnBlockedMessage("Closing B&W reading 5 is lower than the last reading 9")).toBeNull();
    expect(returnBlockedMessage("RETURN_BLOCKED:{oops")).toMatch(/review the meter reading/);
  });
});
