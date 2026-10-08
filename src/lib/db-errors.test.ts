import { describe, expect, it, vi } from "vitest";

import { dbErrorMessage } from "./db-errors";

describe("dbErrorMessage", () => {
  it("passes through input and conflict messages from the workflow functions", () => {
    expect(dbErrorMessage({ code: "RD400", message: "A reason is required" })).toBe("A reason is required");
    expect(dbErrorMessage({ code: "RD409", message: "The account already has this status" })).toBe("The account already has this status");
  });

  it("hides permission and unexpected errors", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(dbErrorMessage({ code: "RD403", message: "Only the owner can create their customers" })).toBe("You are not allowed to do this.");
    expect(dbErrorMessage({ code: "23505", message: "duplicate key value violates unique constraint" })).toBe("Something went wrong. Please try again.");
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
