import { describe, expect, it } from "vitest";

import {
  addDays,
  cycleDate,
  cycleInProgress,
  cyclePeriod,
  daysBetween,
  defaultFirstBillingDate,
  effectiveCycleForChange,
  isEndingSoon,
  isIsoDate,
  todayInColombo,
} from "./cycle-calendar";

describe("date arithmetic", () => {
  it("crosses month ends and leap days", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
    expect(addDays("2027-02-28", 1)).toBe("2027-03-01"); // not a leap year
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2028-02-01", "2028-03-01")).toBe(29);
    expect(daysBetween("2027-02-01", "2027-03-01")).toBe(28);
    expect(daysBetween("2026-10-08", "2026-10-01")).toBe(-7);
  });

  it("validates ISO dates", () => {
    expect(isIsoDate("2028-02-29")).toBe(true);
    expect(isIsoDate("2027-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("8/10/2026")).toBe(false);
  });

  it("takes today in Asia/Colombo, not UTC", () => {
    // 19:00 UTC on 7 Oct is 00:30 on 8 Oct in Colombo (the cron's hour).
    expect(todayInColombo(new Date("2026-10-07T19:00:00Z"))).toBe("2026-10-08");
    expect(todayInColombo(new Date("2026-10-07T18:29:00Z"))).toBe("2026-10-07");
  });
});

describe("cycleDate (every N days from the first billing date)", () => {
  it("steps 30 days at a time, across month ends", () => {
    expect(cycleDate("2026-01-31", 30, 1)).toBe("2026-01-31");
    expect(cycleDate("2026-01-31", 30, 2)).toBe("2026-03-02");
    expect(cycleDate("2026-01-31", 30, 3)).toBe("2026-04-01");
    expect(cycleDate("2026-10-31", 30, 3)).toBe("2026-12-30");
  });

  it("lands on and steps over 29 February in a leap year", () => {
    expect(cycleDate("2028-01-30", 30, 2)).toBe("2028-02-29");
    expect(cycleDate("2028-02-29", 30, 2)).toBe("2028-03-30");
    expect(cycleDate("2027-01-30", 30, 2)).toBe("2027-03-01");
  });

  it("does not drift: cycle n is always first + (n - 1) * length", () => {
    for (let n = 1; n <= 40; n++) {
      expect(daysBetween("2026-10-08", cycleDate("2026-10-08", 30, n))).toBe((n - 1) * 30);
    }
    expect(cycleDate("2026-10-08", 28, 13)).toBe("2027-09-09");
  });
});

describe("cycleInProgress", () => {
  const first = "2026-11-07";
  it("is cycle 1 until the first billing date", () => {
    expect(cycleInProgress(first, 30, "2026-10-08")).toBe(1);
    expect(cycleInProgress(first, 30, "2026-11-06")).toBe(1);
  });

  it("moves to the next cycle on each cycle date", () => {
    expect(cycleInProgress(first, 30, "2026-11-07")).toBe(2);
    expect(cycleInProgress(first, 30, "2026-12-06")).toBe(2);
    expect(cycleInProgress(first, 30, "2026-12-07")).toBe(3);
  });
});

describe("effectiveCycleForChange (AGR-02: from the next cycle only)", () => {
  const base = { firstBillingDate: "2026-11-07", cycleLength: 30 };

  it("before any ticket: the period running now is cycle 1, so the change starts at cycle 2", () => {
    expect(effectiveCycleForChange({ ...base, nextCycleNo: 1, today: "2026-10-08" })).toEqual({
      cycleNo: 2,
      date: "2026-12-07",
    });
  });

  it("on a cycle date the ticket for that cycle keeps the old terms", () => {
    // Cycle 1 opened today (next_cycle_no = 2); cycle 2's period runs now.
    expect(effectiveCycleForChange({ ...base, nextCycleNo: 2, today: "2026-11-07" }).cycleNo).toBe(3);
    // The day before cycle 2 is due.
    expect(effectiveCycleForChange({ ...base, nextCycleNo: 2, today: "2026-12-06" }).cycleNo).toBe(3);
  });

  it("follows the calendar when the daily job is behind", () => {
    // Cycle 2 was due on 7 Dec but has not been opened yet (next_cycle_no still 2).
    expect(effectiveCycleForChange({ ...base, nextCycleNo: 2, today: "2026-12-10" })).toEqual({
      cycleNo: 4,
      date: "2027-02-05",
    });
  });

  it("never points at a cycle that is already open", () => {
    expect(effectiveCycleForChange({ ...base, nextCycleNo: 9, today: "2026-10-08" }).cycleNo).toBe(9);
  });
});

describe("defaultFirstBillingDate", () => {
  it("is one cycle after a new rental's start", () => {
    expect(defaultFirstBillingDate("2026-10-08", 30, "2026-10-08")).toBe("2026-11-07");
    expect(defaultFirstBillingDate("2028-01-30", 30, "2028-01-30")).toBe("2028-02-29");
  });

  it("keeps the rhythm of a past start date and is never in the past", () => {
    // Started 100 days ago: cycles fell on +30, +60, +90; the next is +120.
    expect(defaultFirstBillingDate("2026-06-30", 30, "2026-10-08")).toBe("2026-10-28");
    // Today is exactly a cycle date: bill today.
    expect(defaultFirstBillingDate("2026-08-09", 30, "2026-10-08")).toBe("2026-10-08");
  });
});

describe("cyclePeriod", () => {
  it("covers the cycle length before the due date", () => {
    expect(
      cyclePeriod({ startDate: "2026-01-01", firstBillingDate: "2026-01-31", cycleLength: 30, cycleNo: 2 }),
    ).toEqual({ start: "2026-01-31", end: "2026-03-01" });
  });

  it("never starts cycle 1 before the agreement", () => {
    expect(
      cyclePeriod({ startDate: "2026-10-20", firstBillingDate: "2026-11-07", cycleLength: 30, cycleNo: 1 }),
    ).toEqual({ start: "2026-10-20", end: "2026-11-06" });
  });
});

describe("isEndingSoon (AGR-03)", () => {
  it("flags end dates within 30 days that have not passed", () => {
    expect(isEndingSoon("2026-11-07", "2026-10-08")).toBe(true);
    expect(isEndingSoon("2026-11-08", "2026-10-08")).toBe(false);
    expect(isEndingSoon("2026-10-07", "2026-10-08")).toBe(false);
    expect(isEndingSoon(null, "2026-10-08")).toBe(false);
  });
});
