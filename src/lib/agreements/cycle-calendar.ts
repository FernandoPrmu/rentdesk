import { TIME_ZONE } from "@/lib/format";

/**
 * Billing cycle calendar (spec 5.5, TKT-07). Mirrors app.cycle_date and
 * app.cycle_in_progress in the database.
 *
 *   cycle n is due on  first_billing_date + (n - 1) * cycle_length
 *   and covers the cycle_length days before that date.
 *
 * Dates are ISO "YYYY-MM-DD" strings in Asia/Colombo. Arithmetic is done on UTC
 * midnight, so daylight saving and the server's time zone never shift a day.
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

/** Date cycle `cycleNo` (1-based) is due. */
export function cycleDate(firstBillingDate: IsoDate, cycleLength: number, cycleNo: number): IsoDate {
  return addDays(firstBillingDate, (cycleNo - 1) * cycleLength);
}

/** The cycle whose usage period contains `today` (the first cycle due after today). */
export function cycleInProgress(firstBillingDate: IsoDate, cycleLength: number, today: IsoDate): number {
  const elapsed = daysBetween(firstBillingDate, today);
  return elapsed < 0 ? 1 : Math.floor(elapsed / cycleLength) + 2;
}

/**
 * First cycle a pricing change applies to (AGR-02, spec 11.3): the cycle after the
 * one in progress. Copies made today stay on the old terms, and so does every
 * ticket that is open or not yet opened for an earlier cycle.
 */
export function effectiveCycleForChange(input: {
  firstBillingDate: IsoDate;
  cycleLength: number;
  nextCycleNo: number;
  today: IsoDate;
}): { cycleNo: number; date: IsoDate } {
  const cycleNo = Math.max(cycleInProgress(input.firstBillingDate, input.cycleLength, input.today) + 1, input.nextCycleNo);
  return { cycleNo, date: cycleDate(input.firstBillingDate, input.cycleLength, cycleNo) };
}

/**
 * Suggested first billing date: keeps the rhythm of the start date (start + k cycles)
 * and is never in the past. For a new rental that is one cycle after the start.
 */
export function defaultFirstBillingDate(startDate: IsoDate, cycleLength: number, today: IsoDate): IsoDate {
  const first = addDays(startDate, cycleLength);
  const behind = daysBetween(first, today);
  if (behind <= 0) return first;
  return addDays(first, Math.ceil(behind / cycleLength) * cycleLength);
}

/** Usage period covered by a cycle (cycle 1 never starts before the agreement). */
export function cyclePeriod(input: {
  startDate: IsoDate;
  firstBillingDate: IsoDate;
  cycleLength: number;
  cycleNo: number;
}): { start: IsoDate; end: IsoDate } {
  const due = cycleDate(input.firstBillingDate, input.cycleLength, input.cycleNo);
  let start = addDays(due, -input.cycleLength);
  if (input.cycleNo === 1 && start < input.startDate) start = input.startDate;
  return { start, end: addDays(due, -1) };
}

/** AGR-03: an end date within `withinDays` (default 30) from today, not yet passed. */
export function isEndingSoon(endDate: IsoDate | null, today: IsoDate, withinDays = 30): boolean {
  if (!endDate) return false;
  const left = daysBetween(today, endDate);
  return left >= 0 && left <= withinDays;
}
