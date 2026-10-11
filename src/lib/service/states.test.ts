import { describe, expect, it } from "vitest";

import { availableActions, SERVICE_STATUSES, serviceRefusal, targetStatus, TRANSITIONS, transitionAllowed } from "./states";

describe("service request transitions (SRV-03, decision 57)", () => {
  it("follows New → Acknowledged → Assigned → In progress → Resolved → Closed, with Cancelled from any open status", () => {
    expect(TRANSITIONS).toEqual({
      NEW: ["ACKNOWLEDGED", "CANCELLED"],
      ACKNOWLEDGED: ["ASSIGNED", "CANCELLED"],
      ASSIGNED: ["IN_PROGRESS", "CANCELLED"],
      IN_PROGRESS: ["RESOLVED", "CANCELLED"],
      RESOLVED: ["CLOSED", "IN_PROGRESS", "CANCELLED"],
      CLOSED: [],
      CANCELLED: [],
    });
  });

  it("never skips a step and never leaves Closed or Cancelled", () => {
    expect(transitionAllowed("NEW", "ASSIGNED")).toBe(false);
    expect(transitionAllowed("ACKNOWLEDGED", "IN_PROGRESS")).toBe(false);
    expect(transitionAllowed("ASSIGNED", "RESOLVED")).toBe(false);
    expect(transitionAllowed("IN_PROGRESS", "CLOSED")).toBe(false);
    for (const to of SERVICE_STATUSES) {
      expect(transitionAllowed("CLOSED", to)).toBe(false);
      expect(transitionAllowed("CANCELLED", to)).toBe(false);
    }
  });

  it("gives each role only its own steps", () => {
    expect(availableActions("OWNER", "NEW")).toEqual(["ACKNOWLEDGE", "CANCEL", "NOTE"]);
    expect(availableActions("OWNER", "ACKNOWLEDGED")).toEqual(["ASSIGN", "CANCEL", "NOTE"]);
    expect(availableActions("OWNER", "ASSIGNED")).toEqual(["ASSIGN", "START", "CANCEL", "NOTE"]);
    expect(availableActions("OWNER", "IN_PROGRESS")).toEqual(["ASSIGN", "RESOLVE", "CANCEL", "NOTE"]);
    expect(availableActions("OWNER", "RESOLVED")).toEqual(["CLOSE", "CANCEL", "NOTE"]);
    expect(availableActions("OWNER", "CLOSED")).toEqual([]);
    expect(availableActions("CUSTOMER", "NEW")).toEqual(["CANCEL"]);
    expect(availableActions("CUSTOMER", "ACKNOWLEDGED")).toEqual([]);
    expect(availableActions("CUSTOMER", "RESOLVED")).toEqual(["CONFIRM", "REOPEN"]);
    expect(availableActions("CUSTOMER", "CLOSED")).toEqual([]);
  });

  it("explains refusals in plain words", () => {
    expect(serviceRefusal("ACKNOWLEDGE", "CUSTOMER", "NEW")).toBe("Only the rental company can do this");
    expect(serviceRefusal("CONFIRM", "OWNER", "RESOLVED")).toBe("Only the customer can do this");
    expect(serviceRefusal("CANCEL", "CUSTOMER", "IN_PROGRESS")).toMatch(/already working/);
    expect(serviceRefusal("START", "OWNER", "NEW")).toMatch(/new, so it cannot/);
    expect(serviceRefusal("ACKNOWLEDGE", "ADMIN", "NEW")).not.toBeNull();
  });

  it("'still not fixed' takes a resolved request back to In progress; assigning again keeps the status", () => {
    expect(targetStatus("REOPEN", "RESOLVED")).toBe("IN_PROGRESS");
    expect(targetStatus("CONFIRM", "RESOLVED")).toBe("CLOSED");
    expect(targetStatus("ASSIGN", "ACKNOWLEDGED")).toBe("ASSIGNED");
    expect(targetStatus("ASSIGN", "IN_PROGRESS")).toBeNull();
    expect(targetStatus("NOTE", "ASSIGNED")).toBeNull();
  });
});
