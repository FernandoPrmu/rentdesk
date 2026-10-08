import { describe, expect, it } from "vitest";

import { formatCount, formatDate, formatDateTime } from "./format";

describe("formatDateTime", () => {
  it("shows Asia/Colombo time", () => {
    // 18:45 UTC is 00:15 the next day in Colombo (UTC+05:30).
    expect(formatDateTime("2026-10-07T18:45:00Z")).toBe("8 Oct 2026, 00:15");
  });
});

describe("formatDate / formatCount", () => {
  it("formats a calendar date without shifting the day", () => {
    expect(formatDate("2028-02-29")).toBe("29 Feb 2028");
    expect(formatDate("2026-12-31")).toBe("31 Dec 2026");
  });

  it("groups counts", () => {
    expect(formatCount(1234567)).toBe("1,234,567");
    expect(formatCount(0)).toBe("0");
  });
});
