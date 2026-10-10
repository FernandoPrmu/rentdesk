import { addDays, type IsoDate, todayInColombo } from "../agreements/cycle-calendar.ts";

/**
 * Stage deadlines, reminders and escalation (spec 5.4, 8.3, TKT-05; decisions.md
 * rules 20-21). Pure: the daily job, the transition functions and the pages all
 * use these. Settings come from owner_settings_effective (owner override, else the
 * platform default).
 *
 * Day-based stages (meter reading, payment) fall due at 00:00 Asia/Colombo on the
 * day: "day 5" means the run on day 5 acts. Hour-based stages (owner review of a
 * reading or a slip) count hours from when the stage started.
 * Only relative imports: DB tests import it under plain Node.
 */

export interface StageSettings {
  meter_deadline_days: number;
  meter_reminder_days: number[];
  review_deadline_hours: number;
  review_reminder_hours: number[];
  review_escalation_hours: number;
  payment_due_days: number;
  payment_reminder_before_days: number[];
  payment_reminder_on_due: boolean;
  payment_overdue_reminder_days: number[];
  slip_review_deadline_hours: number;
  slip_review_reminder_hours: number[];
  slip_review_escalation_hours: number;
  grace_period_days: number;
  estimated_billing_enabled: boolean;
  weekly_summary_dow: number;
  rejected_photo_retention_days: number;
}

/** The platform defaults (platform_settings, spec 5.4 and 8.3); tests and fallbacks. */
export const PLATFORM_DEFAULTS: StageSettings = {
  meter_deadline_days: 5,
  meter_reminder_days: [2, 4],
  review_deadline_hours: 48,
  review_reminder_hours: [24, 48],
  review_escalation_hours: 72,
  payment_due_days: 7,
  payment_reminder_before_days: [3],
  payment_reminder_on_due: true,
  payment_overdue_reminder_days: [1, 7, 14],
  slip_review_deadline_hours: 48,
  slip_review_reminder_hours: [24, 48],
  slip_review_escalation_hours: 72,
  grace_period_days: 7,
  estimated_billing_enabled: false,
  weekly_summary_dow: 1,
  rejected_photo_retention_days: 7,
};

const HOUR_MS = 3_600_000;
/** Sri Lanka has no daylight saving: always UTC+05:30. */
const COLOMBO_OFFSET = "+05:30";

/** 00:00 in Colombo on a calendar date. */
export function startOfColomboDay(date: IsoDate): Date {
  return new Date(`${date}T00:00:00${COLOMBO_OFFSET}`);
}

export function colomboDate(at: Date): IsoDate {
  return todayInColombo(at);
}

function addHours(at: Date, hours: number): Date {
  return new Date(at.getTime() + hours * HOUR_MS);
}

/** Sorted, unique, positive values below an optional limit. */
function schedule(values: number[], below?: number): number[] {
  return [...new Set(values)].filter((v) => Number.isFinite(v) && v > 0 && (below === undefined || v < below)).sort((a, b) => a - b);
}

/** Meter stage (5.4): due at the start of day `meter_deadline_days` after the stage began. */
export function meterDeadline(enteredAt: Date, s: Pick<StageSettings, "meter_deadline_days">): Date {
  return startOfColomboDay(addDays(colomboDate(enteredAt), s.meter_deadline_days));
}

/** Owner review of a reading (5.4): `review_deadline_hours` after it arrived. */
export function reviewDeadline(enteredAt: Date, s: Pick<StageSettings, "review_deadline_hours">): Date {
  return addHours(enteredAt, s.review_deadline_hours);
}

/** Owner verification of a slip (5.4): `slip_review_deadline_hours` after it arrived. */
export function slipReviewDeadline(enteredAt: Date, s: Pick<StageSettings, "slip_review_deadline_hours">): Date {
  return addHours(enteredAt, s.slip_review_deadline_hours);
}

/** Invoice due date (5.4: 7 days after confirmation by default; the agreement's days to pay). */
export function invoiceDueDate(confirmedAt: Date, dueDays: number): IsoDate {
  return addDays(colomboDate(confirmedAt), dueDays);
}

/** A payment stage ends when its due date has passed: 00:00 the next day. */
export function paymentDeadline(dueDate: IsoDate): Date {
  return startOfColomboDay(addDays(dueDate, 1));
}

/** The last calendar day the customer has ("by 14 Oct") for a midnight deadline. */
export function lastDayBefore(deadline: Date): IsoDate {
  return colomboDate(new Date(deadline.getTime() - 1));
}

export interface Milestone {
  at: Date;
  /** Hour-based thresholds may fire up to an hour early (Vercel runs anywhere in the hour). */
  hourBased: boolean;
}

export interface ReminderMilestone extends Milestone {
  /** 1-based position in the stage's reminder schedule (tickets.reminder_count). */
  no: number;
  kind: ReminderKind;
  /** Day offset for payment reminders (negative = before the due date). */
  dayOffset?: number;
}

export type ReminderKind = "METER" | "REVIEW" | "SLIP_REVIEW" | "PAYMENT_DUE_SOON" | "PAYMENT_DUE_TODAY" | "PAYMENT_OVERDUE";

/** Meter reminders on day 2 and day 4 (default) of the stage, before the deadline. */
export function meterReminders(enteredAt: Date, s: StageSettings): ReminderMilestone[] {
  const start = colomboDate(enteredAt);
  return schedule(s.meter_reminder_days, s.meter_deadline_days).map((d, i) => ({
    at: startOfColomboDay(addDays(start, d)),
    hourBased: false,
    no: i + 1,
    kind: "METER" as const,
    dayOffset: d,
  }));
}

/** Owner reminders at 24 and 48 hours (default) after a reading or a slip arrived. */
export function ownerReviewReminders(enteredAt: Date, s: StageSettings, kind: "REVIEW" | "SLIP_REVIEW"): ReminderMilestone[] {
  const hours = kind === "REVIEW" ? s.review_reminder_hours : s.slip_review_reminder_hours;
  const escalation = kind === "REVIEW" ? s.review_escalation_hours : s.slip_review_escalation_hours;
  return schedule(hours, escalation).map((h, i) => ({ at: addHours(enteredAt, h), hourBased: true, no: i + 1, kind }));
}

/** Admin alerted after 3 days (default) without the owner's review (spec 5.4). */
export function ownerReviewEscalation(enteredAt: Date, s: StageSettings, kind: "REVIEW" | "SLIP_REVIEW"): Milestone {
  return { at: addHours(enteredAt, kind === "REVIEW" ? s.review_escalation_hours : s.slip_review_escalation_hours), hourBased: true };
}

/** Before the due date: 3 days before and on the day (spec 8.3). */
export function paymentReminders(dueDate: IsoDate, s: StageSettings): ReminderMilestone[] {
  const out: { offset: number; kind: ReminderKind }[] = schedule(s.payment_reminder_before_days).map((b) => ({
    offset: -b,
    kind: "PAYMENT_DUE_SOON" as const,
  }));
  out.sort((a, b) => a.offset - b.offset);
  if (s.payment_reminder_on_due) out.push({ offset: 0, kind: "PAYMENT_DUE_TODAY" });
  return out.map((r, i) => ({ at: startOfColomboDay(addDays(dueDate, r.offset)), hourBased: false, no: i + 1, kind: r.kind, dayOffset: r.offset }));
}

/** After the due date: 1, 7 and 14 days (spec 8.3). The first comes with the Overdue status. */
export function overdueReminders(dueDate: IsoDate, s: StageSettings): ReminderMilestone[] {
  return schedule(s.payment_overdue_reminder_days).map((a, i) => ({
    at: startOfColomboDay(addDays(dueDate, a)),
    hourBased: false,
    no: i + 1,
    kind: "PAYMENT_OVERDUE" as const,
    dayOffset: a,
  }));
}

/** One hour of slack for hour-based thresholds; day-based ones are already past by run time. */
export const HOUR_LOOKAHEAD_MS = HOUR_MS;

export function reached(m: Milestone, now: Date): boolean {
  return m.at.getTime() <= now.getTime() + (m.hourBased ? HOUR_LOOKAHEAD_MS : 0);
}

/** The latest reached reminder after `alreadySent` (one message per run, never a backlog). */
export function dueReminder<T extends ReminderMilestone>(reminders: T[], alreadySent: number, now: Date): T | null {
  const passed = reminders.filter((r) => reached(r, now));
  const latest = passed.at(-1);
  return latest && latest.no > alreadySent ? latest : null;
}

/** Meter photo of a rejected attempt is purged after the retention days (spec 6.5). */
export function rejectedPhotoExpiry(rejectedAt: Date, s: Pick<StageSettings, "rejected_photo_retention_days">): Date {
  return startOfColomboDay(addDays(colomboDate(rejectedAt), s.rejected_photo_retention_days + 1));
}
