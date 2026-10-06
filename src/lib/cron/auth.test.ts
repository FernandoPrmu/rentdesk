import { describe, expect, it } from "vitest";

import { isAuthorizedCronRequest } from "@/lib/cron/auth";

const SECRET = "a-long-enough-test-secret";

describe("isAuthorizedCronRequest", () => {
  it("accepts the exact bearer token", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a wrong or missing header", () => {
    expect(isAuthorizedCronRequest(`Bearer nope`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(SECRET, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(null, SECRET)).toBe(false);
  });

  it("rejects everything when CRON_SECRET is not configured", () => {
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest("Bearer undefined", undefined)).toBe(false);
  });
});
