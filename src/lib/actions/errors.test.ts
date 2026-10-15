import { describe, expect, it } from "vitest";

import { BillingError } from "../billing/errors.ts";
import { dbErrorMessage } from "../db-errors.ts";
import { RpcError, TransitionError } from "../tickets/transitions.ts";
import { UNREACHABLE_CHECK, UNREACHABLE_SAFE, unreachable } from "./client-errors.ts";
import { actionFailure, CHECK_FIRST_MESSAGE, classifyActionError, isTransientDbError, must, SAFE_RETRY_MESSAGE, TransientError } from "./errors.ts";

describe("action failures (decision 47, every action since task 12)", () => {
  it("refusals are shown in plain words, never as a retry", () => {
    expect(classifyActionError(new RpcError("RD409", "ALREADY_DONE: This was already confirmed."))).toEqual({ kind: "REFUSED", message: "This was already confirmed." });
    expect(classifyActionError(new RpcError("RD403", "nope"))).toEqual({ kind: "REFUSED", message: "You are not allowed to do this." });
    expect(classifyActionError(new TransitionError("INVALID_STATE", "Confirm: not possible while the ticket is CLOSED"))).toMatchObject({ kind: "REFUSED" });
    expect(classifyActionError(new BillingError("INVALID_INPUT", "Nothing is left to pay"))).toEqual({ kind: "REFUSED", message: "Nothing is left to pay" });
  });

  it("a timeout, a dropped connection or a failed read is transient: check first by default", () => {
    for (const e of [new RpcError("57014", "canceling statement due to statement timeout"), new TypeError("fetch failed"), new TransientError("ticket: fetch failed"), new RpcError(undefined, "upstream connect error")]) {
      expect(classifyActionError(e)).toEqual({ kind: "TRANSIENT", message: CHECK_FIRST_MESSAGE });
    }
  });

  it("actions with a key or a state re-check say it is safe to tap again", () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(actionFailure(new RpcError("57014", "timeout"), "test", SAFE_RETRY_MESSAGE)).toEqual({ ok: false, error: SAFE_RETRY_MESSAGE });
      expect(SAFE_RETRY_MESSAGE).toContain("never done twice");
      expect(CHECK_FIRST_MESSAGE).toContain("Reload the page");
    } finally {
      console.error = original;
    }
  });

  it("must(): a failed read throws instead of returning nothing", () => {
    expect(must({ data: null, error: null }, "x")).toBeNull();
    expect(must({ data: { id: 1 }, error: null }, "x")).toEqual({ id: 1 });
    expect(() => must({ data: null, error: { message: "canceling statement due to statement timeout" } }, "ticket")).toThrow(TransientError);
  });

  it("recognises failures to answer, not refusals", () => {
    expect(isTransientDbError({ code: "57014", message: "canceling statement" })).toBe(true);
    expect(isTransientDbError({ code: "08006", message: "connection failure" })).toBe(true);
    expect(isTransientDbError({ code: "40001", message: "could not serialize" })).toBe(true);
    expect(isTransientDbError({ message: "TypeError: fetch failed" })).toBe(true);
    expect(isTransientDbError({ code: "RD409", message: "timeout in the text" })).toBe(false);
    expect(isTransientDbError({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });

  it("the shared database message no longer says just 'try again' after a timeout", () => {
    const original = console.error;
    console.error = () => {};
    try {
      expect(dbErrorMessage({ code: "57014", message: "canceling statement due to statement timeout" })).toBe(CHECK_FIRST_MESSAGE);
      expect(dbErrorMessage({ code: "23505", message: "duplicate key" })).toBe("Something went wrong. Please try again.");
    } finally {
      console.error = original;
    }
  });

  it("client: a thrown call names what is safe", () => {
    expect(unreachable("safe")).toBe(UNREACHABLE_SAFE);
    expect(unreachable("check")).toBe(UNREACHABLE_CHECK);
  });
});
