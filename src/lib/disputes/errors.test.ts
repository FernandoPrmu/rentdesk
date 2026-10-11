import { describe, expect, it } from "vitest";

import { BillingError } from "../billing/errors";
import { RpcError, TransitionError } from "../tickets/transitions";
import { classifyDisputeError, DISPUTE_RETRY_MESSAGE, OWNER_RETRY_MESSAGE, TransientError } from "./errors";

describe("dispute failures: refusals in plain words, everything else a safe retry (task 8 review)", () => {
  it("shows workflow refusals as they are", () => {
    expect(classifyDisputeError(new RpcError("RD409", "ALREADY_DISPUTED: This bill was already disputed once."), DISPUTE_RETRY_MESSAGE)).toEqual({
      kind: "REFUSED",
      message: "This bill was already disputed once.",
    });
    expect(classifyDisputeError(new RpcError("RD403", "This ticket belongs to another customer"))).toEqual({ kind: "REFUSED", message: "You are not allowed to do this." });
    expect(classifyDisputeError(new TransitionError("INVALID_STATE", "Dispute the invoice: not possible while the ticket is CLOSED"))).toEqual({
      kind: "REFUSED",
      message: "not possible while the ticket is CLOSED",
    });
    expect(classifyDisputeError(new BillingError("INVALID_INPUT", "Nothing is left to pay on this bill"))).toMatchObject({ kind: "REFUSED" });
  });

  it("a statement timeout when the database stalls (seen in the load run) asks the customer to tap Send again", () => {
    expect(classifyDisputeError(new RpcError("57014", "canceling statement due to statement timeout"), DISPUTE_RETRY_MESSAGE)).toEqual({
      kind: "TRANSIENT",
      message: DISPUTE_RETRY_MESSAGE,
    });
  });

  it("a failed read, a dropped connection or anything unknown is a retry too", () => {
    expect(classifyDisputeError(new TransientError("dispute replay: fetch failed"), DISPUTE_RETRY_MESSAGE).kind).toBe("TRANSIENT");
    expect(classifyDisputeError(new TypeError("fetch failed"), DISPUTE_RETRY_MESSAGE).message).toBe(DISPUTE_RETRY_MESSAGE);
    expect(classifyDisputeError(new RpcError(undefined, "upstream connect error"))).toEqual({ kind: "TRANSIENT", message: OWNER_RETRY_MESSAGE });
    expect(DISPUTE_RETRY_MESSAGE).toMatch(/never sent twice/);
  });
});
