import { describe, expect, it } from "vitest";

import {
  dueReminder,
  invoiceDueDate,
  lastDayBefore,
  meterDeadline,
  meterReminders,
  overdueReminders,
  ownerReviewEscalation,
  ownerReviewReminders,
  paymentDeadline,
  paymentReminders,
  reached,
  rejectedPhotoExpiry,
  reviewDeadline,
  PLATFORM_DEFAULTS as DEFAULTS,
  startOfColomboDay,
} from "./deadlines";

const at = (s: string) => new Date(s);

describe("Colombo days", () => {
  it("00:00 in Sri Lanka is 18:30 UTC the day before", () => {
    expect(startOfColomboDay("2026-10-15").toISOString()).toBe("2026-10-14T18:30:00.000Z");
  });

  it("the last day before a midnight deadline", () => {
    expect(lastDayBefore(startOfColomboDay("2026-10-15"))).toBe("2026-10-14");
  });
});

describe("meter stage (5.4: 5 days, reminders day 2 and 4)", () => {
  // The ticket opened by the 00:30-01:29 run on 10 October (Colombo).
  const opened = at("2026-10-10T01:10:00+05:30");

  it("is due at 00:00 on day 5, so the day-5 run marks it overdue", () => {
    expect(meterDeadline(opened, DEFAULTS)).toEqual(startOfColomboDay("2026-10-15"));
    // A ticket opened just before midnight still gets 5 calendar days.
    expect(meterDeadline(at("2026-10-10T23:59:00+05:30"), DEFAULTS)).toEqual(startOfColomboDay("2026-10-15"));
  });

  it("reminders on day 2 and day 4, before the deadline only", () => {
    const r = meterReminders(opened, DEFAULTS);
    expect(r.map((x) => [x.no, x.at.toISOString()])).toEqual([
      [1, startOfColomboDay("2026-10-12").toISOString()],
      [2, startOfColomboDay("2026-10-14").toISOString()],
    ]);
    expect(meterReminders(opened, { ...DEFAULTS, meter_reminder_days: [4, 2, 9, 0, 4] }).map((x) => x.dayOffset)).toEqual([2, 4]);
  });

  it("the run sends one reminder per day, the latest one due, never a backlog", () => {
    const r = meterReminders(opened, DEFAULTS);
    expect(dueReminder(r, 0, at("2026-10-11T01:00:00+05:30"))).toBeNull();
    expect(dueReminder(r, 0, at("2026-10-12T00:30:00+05:30"))?.no).toBe(1);
    expect(dueReminder(r, 1, at("2026-10-13T01:00:00+05:30"))).toBeNull();
    // Missed runs: only the day-4 reminder is sent.
    expect(dueReminder(r, 0, at("2026-10-14T01:00:00+05:30"))?.no).toBe(2);
    expect(dueReminder(r, 2, at("2026-10-14T01:00:00+05:30"))).toBeNull();
  });
});

describe("owner review stages (5.4: 2 days, reminders 24 h and 48 h, admin after 3 days)", () => {
  const entered = at("2026-10-10T15:00:00+05:30");

  it("deadline and reminders count hours from the moment the reading arrived", () => {
    expect(reviewDeadline(entered, DEFAULTS)).toEqual(at("2026-10-12T15:00:00+05:30"));
    expect(ownerReviewReminders(entered, DEFAULTS, "REVIEW").map((r) => r.at)).toEqual([at("2026-10-11T15:00:00+05:30"), at("2026-10-12T15:00:00+05:30")]);
    expect(ownerReviewEscalation(entered, DEFAULTS, "SLIP_REVIEW").at).toEqual(at("2026-10-13T15:00:00+05:30"));
  });

  it("an hour of lookahead absorbs Vercel's hour-long window; day-based ones get none", () => {
    const r = ownerReviewReminders(at("2026-10-10T01:20:00+05:30"), DEFAULTS, "REVIEW")[0];
    expect(reached(r, at("2026-10-11T00:35:00+05:30"))).toBe(true);
    expect(reached(r, at("2026-10-10T23:00:00+05:30"))).toBe(false);
    const dayBased = { at: startOfColomboDay("2026-10-15"), hourBased: false };
    expect(reached(dayBased, at("2026-10-14T23:30:00+05:30"))).toBe(false);
  });
});

describe("payment stage (5.4, 8.3)", () => {
  it("due 7 days after confirmation; overdue from 00:00 the day after", () => {
    expect(invoiceDueDate(at("2026-10-10T20:00:00+05:30"), 7)).toBe("2026-10-17");
    expect(paymentDeadline("2026-10-17")).toEqual(startOfColomboDay("2026-10-18"));
  });

  it("reminders 3 days before and on the due date", () => {
    expect(paymentReminders("2026-10-17", DEFAULTS).map((r) => [r.no, r.kind, r.dayOffset])).toEqual([
      [1, "PAYMENT_DUE_SOON", -3],
      [2, "PAYMENT_DUE_TODAY", 0],
    ]);
    expect(paymentReminders("2026-10-17", { ...DEFAULTS, payment_reminder_on_due: false }).map((r) => r.kind)).toEqual(["PAYMENT_DUE_SOON"]);
  });

  it("overdue reminders 1, 7 and 14 days after", () => {
    const r = overdueReminders("2026-10-17", DEFAULTS);
    expect(r.map((x) => x.at)).toEqual([startOfColomboDay("2026-10-18"), startOfColomboDay("2026-10-24"), startOfColomboDay("2026-10-31")]);
    expect(dueReminder(r, 1, at("2026-10-24T01:00:00+05:30"))?.no).toBe(2);
  });
});

it("a rejected photo is purged after the retention days (6.5)", () => {
  expect(rejectedPhotoExpiry(at("2026-10-10T10:00:00+05:30"), DEFAULTS)).toEqual(startOfColomboDay("2026-10-18"));
});
