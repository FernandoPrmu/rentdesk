import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  billingDayText,
  cycleDate,
  cycleInProgress,
  cyclePeriod,
  daysBetween,
  daysInCycle,
  defaultFirstBillingDate,
  effectiveCycleForChange,
  finalCycle,
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

describe("addMonths (same day of the month, last day when it does not exist)", () => {
  it("clamps to the month end and never drifts", () => {
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29"); // leap year
    expect(addMonths("2026-01-31", 2)).toBe("2026-03-31");
    expect(addMonths("2026-01-31", 3)).toBe("2026-04-30");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-03-31", -1)).toBe("2026-02-28");
    expect(addMonths("2027-01-31", -11)).toBe("2026-02-28");
  });
});

describe("cycleDate (monthly from the first billing date)", () => {
  it("Jan 31 -> Feb 28 -> Mar 31 -> Apr 30: back to the original day after a short month", () => {
    const first = "2026-01-31";
    expect([1, 2, 3, 4, 5].map((n) => cycleDate(first, n))).toEqual(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("uses 29 February in a leap year and 28 February otherwise", () => {
    expect(cycleDate("2028-01-31", 2)).toBe("2028-02-29");
    expect(cycleDate("2028-01-29", 2)).toBe("2028-02-29");
    expect(cycleDate("2027-01-29", 2)).toBe("2027-02-28");
    expect(cycleDate("2027-01-29", 3)).toBe("2027-03-29");
    // A first billing date on 29 Feb keeps the 29th in later months.
    expect(cycleDate("2028-02-29", 2)).toBe("2028-03-29");
    expect(cycleDate("2028-02-29", 13)).toBe("2029-02-28");
    expect(cycleDate("2028-02-29", 49)).toBe("2032-02-29");
  });

  it("crosses the year end: December to January", () => {
    expect(cycleDate("2026-11-30", 2)).toBe("2026-12-30");
    expect(cycleDate("2026-11-30", 3)).toBe("2027-01-30");
    expect(cycleDate("2026-12-31", 2)).toBe("2027-01-31");
    expect(cycleDate("2026-12-31", 3)).toBe("2027-02-28");
  });

  it("does not drift over many cycles", () => {
    for (let n = 1; n <= 60; n++) {
      const date = cycleDate("2026-10-31", n);
      const lastDay = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();
      expect(Number(date.slice(8, 10))).toBe(Math.min(31, lastDay));
    }
    expect(cycleDate("2026-10-08", 13)).toBe("2027-10-08");
  });

  it("cycle 0 is one month before the first billing date", () => {
    expect(cycleDate("2026-03-31", 0)).toBe("2026-02-28");
  });
});

describe("daysInCycle (real calendar days, for proration)", () => {
  it("counts the days between two cycle dates", () => {
    expect(daysInCycle("2026-01-31", 2)).toBe(28); // 31 Jan -> 28 Feb
    expect(daysInCycle("2026-01-31", 3)).toBe(31); // 28 Feb -> 31 Mar
    expect(daysInCycle("2026-01-31", 4)).toBe(30); // 31 Mar -> 30 Apr
    expect(daysInCycle("2028-01-31", 2)).toBe(29); // leap year
    expect(daysInCycle("2026-12-15", 2)).toBe(31); // 15 Dec -> 15 Jan
    expect(daysInCycle("2026-03-31", 1)).toBe(31); // 28 Feb -> 31 Mar
  });
});

describe("cycleInProgress", () => {
  const first = "2026-11-07";
  it("is cycle 1 until the first billing date", () => {
    expect(cycleInProgress(first, "2026-10-08")).toBe(1);
    expect(cycleInProgress(first, "2026-11-06")).toBe(1);
  });

  it("moves to the next cycle on each cycle date", () => {
    expect(cycleInProgress(first, "2026-11-07")).toBe(2);
    expect(cycleInProgress(first, "2026-12-06")).toBe(2);
    expect(cycleInProgress(first, "2026-12-07")).toBe(3);
    expect(cycleInProgress(first, "2027-01-06")).toBe(3);
    expect(cycleInProgress(first, "2027-01-07")).toBe(4);
  });

  it("handles month ends: cycle dates on the 31st fall on the 28th in February", () => {
    expect(cycleInProgress("2026-01-31", "2026-02-27")).toBe(2);
    expect(cycleInProgress("2026-01-31", "2026-02-28")).toBe(3);
    expect(cycleInProgress("2026-01-31", "2026-03-30")).toBe(3);
    expect(cycleInProgress("2026-01-31", "2026-03-31")).toBe(4);
  });

  it("agrees with cycleDate for every day of two years", () => {
    const first = "2027-01-30";
    for (let d = 0; d < 730; d++) {
      const today = addDays(first, d);
      const n = cycleInProgress(first, today);
      expect(cycleDate(first, n) > today).toBe(true);
      expect(cycleDate(first, n - 1) <= today).toBe(true);
    }
  });
});

describe("effectiveCycleForChange (AGR-02: from the next cycle only)", () => {
  const base = { firstBillingDate: "2026-11-07" };

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
      date: "2027-02-07",
    });
  });

  it("never points at a cycle that is already open", () => {
    expect(effectiveCycleForChange({ ...base, nextCycleNo: 9, today: "2026-10-08" }).cycleNo).toBe(9);
  });
});

describe("defaultFirstBillingDate", () => {
  it("is one month after a new rental's start", () => {
    expect(defaultFirstBillingDate("2026-10-08", "2026-10-08")).toBe("2026-11-08");
    expect(defaultFirstBillingDate("2028-01-31", "2028-01-31")).toBe("2028-02-29");
    expect(defaultFirstBillingDate("2026-12-20", "2026-12-20")).toBe("2027-01-20");
  });

  it("keeps the day of a past start date and is never in the past", () => {
    // Started on 30 June: cycles fell on 30 Jul, 30 Aug, 30 Sep; the next is 30 Oct.
    expect(defaultFirstBillingDate("2026-06-30", "2026-10-08")).toBe("2026-10-30");
    // Today is exactly a cycle date: bill today.
    expect(defaultFirstBillingDate("2026-08-08", "2026-10-08")).toBe("2026-10-08");
  });
});

describe("cyclePeriod", () => {
  it("runs from the previous cycle date to the day before the due date", () => {
    expect(cyclePeriod({ startDate: "2026-01-01", firstBillingDate: "2026-01-31", cycleNo: 2 })).toEqual({
      start: "2026-01-31",
      end: "2026-02-27",
    });
    expect(cyclePeriod({ startDate: "2026-01-01", firstBillingDate: "2026-01-31", cycleNo: 3 })).toEqual({
      start: "2026-02-28",
      end: "2026-03-30",
    });
  });

  it("never starts cycle 1 before the agreement", () => {
    expect(cyclePeriod({ startDate: "2026-10-20", firstBillingDate: "2026-11-07", cycleNo: 1 })).toEqual({
      start: "2026-10-20",
      end: "2026-11-06",
    });
  });
});

describe("finalCycle (RET-01: the final invoice on return)", () => {
  const agreement = { startDate: "2026-01-10", firstBillingDate: "2026-01-31" };

  it("bills the days used in the cycle in progress, the return day included", () => {
    // Cycle 2 runs 31 Jan - 27 Feb (28 days); returned on 10 Feb = 11 days.
    expect(finalCycle({ ...agreement, today: "2026-02-10", lastConfirmedCycle: 1 })).toEqual({
      cycleNo: 2,
      fullCycles: 0,
      periodStart: "2026-01-31",
      daysUsed: 11,
      daysInCycle: 28,
      billable: true,
    });
  });

  it("returned on a cycle date: one day of the new cycle", () => {
    expect(finalCycle({ ...agreement, today: "2026-02-28", lastConfirmedCycle: 2 })).toMatchObject({ cycleNo: 3, daysUsed: 1, daysInCycle: 31 });
  });

  it("adds whole cycles that were never confirmed (open meter request, missed days)", () => {
    expect(finalCycle({ ...agreement, today: "2026-03-05", lastConfirmedCycle: 0 })).toMatchObject({ cycleNo: 3, fullCycles: 2, daysUsed: 6 });
  });

  it("cycle 1 starts on the start date and keeps the month's real length", () => {
    expect(finalCycle({ ...agreement, today: "2026-01-20", lastConfirmedCycle: 0 })).toMatchObject({
      cycleNo: 1,
      fullCycles: 0,
      periodStart: "2026-01-10",
      daysUsed: 11,
      daysInCycle: 31,
    });
  });

  it("is not billable before the first billing period begins", () => {
    // Migrated rental: started in January, first billing in April (period from 15 Mar).
    expect(finalCycle({ startDate: "2026-01-02", firstBillingDate: "2026-04-15", today: "2026-02-01", lastConfirmedCycle: 0 })).toMatchObject({
      billable: false,
      daysUsed: 0,
    });
    // A start date in the future.
    expect(finalCycle({ startDate: "2026-02-10", firstBillingDate: "2026-03-10", today: "2026-02-01", lastConfirmedCycle: 0 }).billable).toBe(false);
  });
});

describe("billingDayText", () => {
  it("names the day and explains short months", () => {
    expect(billingDayText("2026-01-08")).toBe("Monthly on the 8th");
    expect(billingDayText("2026-01-21")).toBe("Monthly on the 21st");
    expect(billingDayText("2026-01-12")).toBe("Monthly on the 12th");
    expect(billingDayText("2026-01-31")).toBe("Monthly on the 31st (the last day in shorter months)");
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
