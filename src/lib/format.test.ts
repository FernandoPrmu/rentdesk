import { describe, expect, it } from "vitest";

import { formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("shows Asia/Colombo time", () => {
    // 18:45 UTC is 00:15 the next day in Colombo (UTC+05:30).
    expect(formatDateTime("2026-10-07T18:45:00Z")).toBe("8 Oct 2026, 00:15");
  });
});
