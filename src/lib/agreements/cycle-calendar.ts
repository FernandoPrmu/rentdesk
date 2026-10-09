import { TIME_ZONE } from "../format.ts";

/**
 * Billing cycle calendar (spec 5.5, TKT-07; client decision, docs/decisions.md
 * rule 1). Mirrors app.cycle_date and app.cycle_in_progress in the database.
 *
 *   cycle n is due on  first_billing_date + (n - 1) months
 *   on the same day of the month as the first billing date. When that day does
 *   not exist (29th-31st), the last day of the month is used, and the next month
 *   goes back to the original day: always counted from the first billing date, so
 *   Jan 31 -> Feb 28 -> Mar 31 never drifts.
 *   Cycle n covers [date(n - 1), date(n) - 1]; cycle 1 never starts before the
 *   agreement.
 *
 * Dates are ISO "YYYY-MM-DD" strings in Asia/Colombo. Arithmetic is done on UTC
 * midnight, so daylight saving and the server's time zone never shift a day.
 * Only relative imports: the seed runs this under plain Node (via the billing engine).
 */

export type IsoDate = string;

const DAY_MS = 86_400_000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function toUtc(date: IsoDate): number {
  if (!ISO_DATE.test(date)) throw new Error(`Invalid date: ${date}`);
  const ms = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) throw new Error(`Invalid date: ${date}`);
  return ms;
}

function fromUtc(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function isIsoDate(value: string): boolean {
  try {
    toUtc(value);
    return true;
  } catch {
    return false;
  }
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

function daysInMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * Same day of the month, `months` later (or earlier); the last day of the month
 * when that day does not exist. Like Postgres `date + interval 'n months'`.
 */
export function addMonths(date: IsoDate, months: number): IsoDate {
  const d = new Date(toUtc(date));
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const year = Math.floor(total / 12);
  const month0 = total - year * 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(year, month0));
  return fromUtc(Date.UTC(year, month0, day));
}

const colomboDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's date in Sri Lanka. */
export function todayInColombo(now: Date = new Date()): IsoDate {
  return colomboDate.format(now);
}

/** Date cycle `cycleNo` is due (cycle 0 = one month before the first billing date). */
export function cycleDate(firstBillingDate: IsoDate, cycleNo: number): IsoDate {
  return addMonths(firstBillingDate, cycleNo - 1);
}

/** Calendar days in cycle `cycleNo` (28 to 31): proration uses these real days. */
export function daysInCycle(firstBillingDate: IsoDate, cycleNo: number): number {
  return daysBetween(cycleDate(firstBillingDate, cycleNo - 1), cycleDate(firstBillingDate, cycleNo));
}

/** The cycle whose usage period contains `today` (the first cycle due after today). */
export function cycleInProgress(firstBillingDate: IsoDate, today: IsoDate): number {
  if (today < firstBillingDate) return 1;
  const f = new Date(toUtc(firstBillingDate));
  const t = new Date(toUtc(today));
  const months = (t.getUTCFullYear() - f.getUTCFullYear()) * 12 + t.getUTCMonth() - f.getUTCMonth();
  // Cycle months + 1 is due in today's month: in progress until its date.
  const n = months + 1;
  return cycleDate(firstBillingDate, n) <= today ? n + 1 : n;
}

/**
 * First cycle a pricing change applies to (AGR-02, spec 11.3): the cycle after the
 * one in progress. Copies made today stay on the old terms, and so does every
 * ticket that is open or not yet opened for an earlier cycle.
 */
export function effectiveCycleForChange(input: { firstBillingDate: IsoDate; nextCycleNo: number; today: IsoDate }): {
  cycleNo: number;
  date: IsoDate;
} {
  const cycleNo = Math.max(cycleInProgress(input.firstBillingDate, input.today) + 1, input.nextCycleNo);
  return { cycleNo, date: cycleDate(input.firstBillingDate, cycleNo) };
}

/**
 * Suggested first billing date: keeps the day of the month of the start date
 * (start + k months) and is never in the past. For a new rental that is one month
 * after the start.
 */
export function defaultFirstBillingDate(startDate: IsoDate, today: IsoDate): IsoDate {
  for (let k = 1; ; k++) {
    const date = addMonths(startDate, k);
    if (date >= today) return date;
  }
}

/** Usage period covered by a cycle (cycle 1 never starts before the agreement). */
export function cyclePeriod(input: { startDate: IsoDate; firstBillingDate: IsoDate; cycleNo: number }): { start: IsoDate; end: IsoDate } {
  let start = cycleDate(input.firstBillingDate, input.cycleNo - 1);
  if (input.cycleNo === 1 && start < input.startDate) start = input.startDate;
  return { start, end: addDays(cycleDate(input.firstBillingDate, input.cycleNo), -1) };
}

export interface FinalCycle {
  /** The cycle in progress on the return date: billed as the final (partial) cycle. */
  cycleNo: number;
  /** Whole cycles since the last confirmed reading that ended before the return. */
  fullCycles: number;
  periodStart: IsoDate;
  /** Days of the final cycle the machine was rented, the return day included. */
  daysUsed: number;
  /** Calendar days of the final cycle. */
  daysInCycle: number;
  /** False when nothing can be billed: returned before its first billing period began. */
  billable: boolean;
}

/**
 * The final invoice on return (RET-01, spec 11.4): every whole cycle since the last
 * confirmed reading, plus the cycle in progress as a partial cycle (days used =
 * return date - period start + 1). Mirrors app.final_cycle in the database.
 */
export function finalCycle(input: {
  startDate: IsoDate;
  firstBillingDate: IsoDate;
  today: IsoDate;
  lastConfirmedCycle: number;
}): FinalCycle {
  const cycleNo = cycleInProgress(input.firstBillingDate, input.today);
  const { start } = cyclePeriod({ startDate: input.startDate, firstBillingDate: input.firstBillingDate, cycleNo });
  const daysUsed = daysBetween(start, input.today) + 1;
  return {
    cycleNo,
    fullCycles: Math.max(0, cycleNo - 1 - input.lastConfirmedCycle),
    periodStart: start,
    daysUsed: Math.max(0, daysUsed),
    daysInCycle: daysInCycle(input.firstBillingDate, cycleNo),
    billable: daysUsed >= 1,
  };
}

/** 1 -> "1st", 22 -> "22nd", 31 -> "31st". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/** "Monthly on the 31st (the last day in shorter months)". */
export function billingDayText(firstBillingDate: IsoDate): string {
  const day = Number(firstBillingDate.slice(8, 10));
  return `Monthly on the ${ordinal(day)}${day > 28 ? " (the last day in shorter months)" : ""}`;
}

/** AGR-03: an end date within `withinDays` (default 30) from today, not yet passed. */
export function isEndingSoon(endDate: IsoDate | null, today: IsoDate, withinDays = 30): boolean {
  if (!endDate) return false;
  const left = daysBetween(today, endDate);
  return left >= 0 && left <= withinDays;
}
