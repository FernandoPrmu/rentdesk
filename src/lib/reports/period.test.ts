import { describe, expect, it } from "vitest";

import { monthEnd, monthLabel, monthsIn, presetRange, rangeLabel, rangeQuery, resolveRange } from "./period";

describe("report date ranges (decision 78)", () => {
  const today = "2026-10-12";

  it("presets on the Colombo calendar", () => {
    expect(presetRange("this_month", today)).toMatchObject({ from: "2026-10-01", to: "2026-10-12" });
    expect(presetRange("last_month", today)).toMatchObject({ from: "2026-09-01", to: "2026-09-30" });
    expect(presetRange("last_3_months", today)).toMatchObject({ from: "2026-08-01", to: "2026-10-12" });
    expect(presetRange("last_12_months", today)).toMatchObject({ from: "2025-11-01", to: "2026-10-12" });
    expect(presetRange("this_year", today)).toMatchObject({ from: "2026-01-01", to: "2026-10-12" });
    // Across a year end and a leap February.
    expect(presetRange("last_month", "2024-03-05")).toMatchObject({ from: "2024-02-01", to: "2024-02-29" });
    expect(presetRange("last_month", "2026-01-15")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("custom ranges are checked; the default is used with a message", () => {
    expect(resolveRange({ range: "custom", from: "2026-01-01", to: "2026-03-31" }, today)).toEqual({ preset: "custom", from: "2026-01-01", to: "2026-03-31" });
    expect(resolveRange({ range: "custom", from: "2026-03-31", to: "2026-01-01" }, today).error).toMatch(/before/);
    expect(resolveRange({ range: "custom", from: "2026-02-30", to: "2026-03-01" }, today).error).toMatch(/both dates/);
    expect(resolveRange({ range: "custom", from: "2020-01-01", to: "2026-01-01" }, today).error).toMatch(/3 years/);
    expect(resolveRange({ range: "nonsense" }, today, "last_12_months")).toMatchObject({ preset: "last_12_months" });
    expect(resolveRange({}, today)).toMatchObject({ preset: "last_3_months", from: "2026-08-01" });
  });

  it("labels, months and the query string", () => {
    expect(monthLabel("2026-10-01")).toBe("Oct 2026");
    expect(rangeLabel({ from: "2026-08-01", to: "2026-10-12" })).toBe("1 Aug 2026 – 12 Oct 2026");
    expect(monthsIn({ from: "2026-08-15", to: "2026-10-12" })).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
    expect(monthEnd("2024-02-10")).toBe("2024-02-29");
    expect(rangeQuery({ preset: "custom", from: "2026-01-01", to: "2026-02-01" })).toBe("range=custom&from=2026-01-01&to=2026-02-01");
    expect(rangeQuery(presetRange("this_month", today))).toBe("range=this_month");
  });
});
