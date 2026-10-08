import { describe, expect, it } from "vitest";

import { returnBlockedMessage } from "./blockers";

describe("returnBlockedMessage", () => {
  it("lists what to resolve first", () => {
    const message = `RETURN_BLOCKED:${JSON.stringify([
      { kind: "invoice", id: "i", invoice_no: "INV-0004", status: "OVERDUE", balance_cents: 100 },
      { kind: "ticket", id: "t", cycle_no: 3, status: "AWAITING_PAYMENT" },
    ])}`;
    expect(returnBlockedMessage(message)).toBe(
      "This machine cannot be returned yet. Resolve first: invoice INV-0004 (Overdue); billing ticket for cycle 3 (Awaiting payment).",
    );
  });

  it("ignores other errors and survives a broken payload", () => {
    expect(returnBlockedMessage("Closing B&W reading 5 is lower than the last reading 9")).toBeNull();
    expect(returnBlockedMessage("RETURN_BLOCKED:{oops")).toMatch(/cannot be returned yet/);
  });
});
