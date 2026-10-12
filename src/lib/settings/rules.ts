import { z } from "zod";

import { centsToRupeesInput, rupeesToCents } from "../money.ts";

/**
 * Platform defaults and owner overrides (ADM-06, decision 82): every setting the
 * admin and owner screens edit, with its bounds and the rules between settings.
 * `app.settings_problems` (migration 0034) checks the same rules in the database;
 * `settings.db.test.ts` checks both agree. Only relative imports.
 */

export type SettingKind = "int" | "list" | "bool" | "money" | "weekday";

export interface SettingField {
  key: SettingKey;
  label: string;
  help?: string;
  kind: SettingKind;
  unit?: "days" | "hours" | "minutes" | "emails" | "attempts" | "failures" | "rejections" | "values";
  min?: number;
  max?: number;
  /** Lists: most values allowed. */
  maxItems?: number;
  /** Lists: every value must be lower than this setting. */
  below?: SettingKey;
  group: SettingGroup;
  /** The owner may override it (null = platform default). */
  owner: boolean;
}

export const SETTING_GROUPS = ["meter", "review", "payment", "slip", "late_fee", "service", "dispute", "agreement", "login", "email"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export const GROUP_LABEL: Record<SettingGroup, string> = {
  meter: "Meter readings",
  review: "Owner review of readings",
  payment: "Payments and reminders",
  slip: "Payment slip checks",
  late_fee: "Late fee and estimates",
  service: "Service requests",
  dispute: "Disputes",
  agreement: "Agreements",
  login: "Sign-in and sessions",
  email: "Email limits",
};

const f = (key: SettingKey, label: string, kind: SettingKind, group: SettingGroup, owner: boolean, o: Partial<SettingField> = {}): SettingField => ({
  key,
  label,
  kind,
  group,
  owner,
  ...o,
});

export const SETTING_KEYS = [
  "meter_deadline_days",
  "meter_reminder_days",
  "max_meter_rejections",
  "rejected_photo_retention_days",
  "review_deadline_hours",
  "review_reminder_hours",
  "review_escalation_hours",
  "payment_due_days",
  "payment_reminder_before_days",
  "payment_reminder_on_due",
  "payment_overdue_reminder_days",
  "weekly_summary_dow",
  "payment_slip_retention_days",
  "slip_review_deadline_hours",
  "slip_review_reminder_hours",
  "slip_review_escalation_hours",
  "late_fee_enabled",
  "late_fee_cents",
  "grace_period_days",
  "estimated_billing_enabled",
  "service_ack_hours_urgent",
  "service_ack_hours_normal",
  "service_admin_escalation_hours_urgent",
  "service_admin_escalation_hours_normal",
  "dispute_reminder_days",
  "dispute_escalation_days",
  "agreement_end_notice_days",
  "login_max_failures",
  "login_lockout_minutes",
  "login_ip_max_failures",
  "login_ip_window_minutes",
  "session_idle_minutes",
  "session_max_hours",
  "email_daily_limit",
  "email_monthly_limit",
  "email_essential_reserve",
  "email_max_attempts",
  "email_reminder_expiry_days",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export const SETTING_FIELDS: readonly SettingField[] = [
  f("meter_deadline_days", "Days to send the meter reading", "int", "meter", true, { unit: "days", min: 1, max: 28, help: "After this the reading is overdue and you are told." }),
  f("meter_reminder_days", "Remind the customer on day", "list", "meter", true, { unit: "days", min: 1, max: 27, maxItems: 5, below: "meter_deadline_days", help: "Days after the ticket opens, e.g. 2, 4." }),
  f("max_meter_rejections", "Rejected readings before you enter it yourself", "int", "meter", true, { unit: "rejections", min: 1, max: 10 }),
  f("rejected_photo_retention_days", "Keep rejected meter photos for", "int", "meter", true, { unit: "days", min: 1, max: 90 }),
  f("review_deadline_hours", "Hours to review a reading", "int", "review", true, { unit: "hours", min: 1, max: 336 }),
  f("review_reminder_hours", "Remind the owner after", "list", "review", true, { unit: "hours", min: 1, max: 719, maxItems: 5, below: "review_escalation_hours", help: "Hours after the reading arrived, e.g. 24, 48." }),
  f("review_escalation_hours", "Tell the admin after", "int", "review", true, { unit: "hours", min: 1, max: 720 }),
  f("payment_due_days", "Days to pay after the bill is issued", "int", "payment", true, { unit: "days", min: 0, max: 90 }),
  f("payment_reminder_before_days", "Remind before the due date", "list", "payment", true, { unit: "days", min: 1, max: 30, maxItems: 5, help: "Days before, e.g. 3." }),
  f("payment_reminder_on_due", "Remind on the due date", "bool", "payment", true),
  f("payment_overdue_reminder_days", "Remind after the due date", "list", "payment", true, { unit: "days", min: 1, max: 365, maxItems: 6, help: "Days after, e.g. 1, 7, 14." }),
  f("weekly_summary_dow", "Weekly overdue summary on", "weekday", "payment", true, { min: 0, max: 6 }),
  f("payment_slip_retention_days", "Keep payment slips for", "int", "payment", true, { unit: "days", min: 30, max: 3650 }),
  f("slip_review_deadline_hours", "Hours to check a payment slip", "int", "slip", true, { unit: "hours", min: 1, max: 336 }),
  f("slip_review_reminder_hours", "Remind the owner after", "list", "slip", true, { unit: "hours", min: 1, max: 719, maxItems: 5, below: "slip_review_escalation_hours" }),
  f("slip_review_escalation_hours", "Tell the admin after", "int", "slip", true, { unit: "hours", min: 1, max: 720 }),
  f("late_fee_enabled", "Charge a late fee", "bool", "late_fee", true),
  f("late_fee_cents", "Late fee", "money", "late_fee", true, { min: 0, max: 10_000_000 }),
  f("grace_period_days", "Grace period after the due date", "int", "late_fee", true, { unit: "days", min: 0, max: 90 }),
  f("estimated_billing_enabled", "Estimated bill when no reading arrives", "bool", "late_fee", true),
  f("service_ack_hours_urgent", "Urgent and high: remind the owner after", "int", "service", true, { unit: "hours", min: 1, max: 168 }),
  f("service_ack_hours_normal", "Normal and low: remind the owner after", "int", "service", true, { unit: "hours", min: 1, max: 168 }),
  f("service_admin_escalation_hours_urgent", "Urgent and high: tell the admin after", "int", "service", true, { unit: "hours", min: 1, max: 336 }),
  f("service_admin_escalation_hours_normal", "Normal and low: tell the admin after", "int", "service", true, { unit: "hours", min: 1, max: 336 }),
  f("dispute_reminder_days", "Remind the owner on day", "list", "dispute", false, { unit: "days", min: 1, max: 59, maxItems: 5, below: "dispute_escalation_days" }),
  f("dispute_escalation_days", "Tell the admin on day", "int", "dispute", false, { unit: "days", min: 1, max: 60 }),
  f("agreement_end_notice_days", "Remind the owner before an agreement ends", "int", "agreement", true, { unit: "days", min: 1, max: 180 }),
  f("login_max_failures", "Wrong passwords before a lockout", "int", "login", false, { unit: "failures", min: 3, max: 20 }),
  f("login_lockout_minutes", "Lockout length", "int", "login", false, { unit: "minutes", min: 1, max: 1440 }),
  f("login_ip_max_failures", "Failed sign-ins from one network before it is blocked", "int", "login", false, { unit: "failures", min: 3, max: 1000 }),
  f("login_ip_window_minutes", "Counted over", "int", "login", false, { unit: "minutes", min: 1, max: 1440 }),
  f("session_idle_minutes", "Sign out after no activity for", "int", "login", false, { unit: "minutes", min: 5, max: 1440 }),
  f("session_max_hours", "Sign out after", "int", "login", false, { unit: "hours", min: 1, max: 168, help: "Counted from sign-in." }),
  f("email_daily_limit", "Emails per day", "int", "email", false, { unit: "emails", min: 1, max: 100_000, help: "Resend free tier: 100 per day." }),
  f("email_monthly_limit", "Emails per month", "int", "email", false, { unit: "emails", min: 1, max: 3_000_000, help: "Resend free tier: 3,000 per month." }),
  f("email_essential_reserve", "Kept for essential emails each day", "int", "email", false, { unit: "emails", min: 0, max: 100_000 }),
  f("email_max_attempts", "Tries before an email fails", "int", "email", false, { unit: "attempts", min: 1, max: 10 }),
  f("email_reminder_expiry_days", "Drop reminder emails still waiting after", "int", "email", false, { unit: "days", min: 1, max: 30 }),
];

export const FIELD: Record<SettingKey, SettingField> = Object.fromEntries(SETTING_FIELDS.map((s) => [s.key, s])) as Record<SettingKey, SettingField>;

export const OWNER_KEYS: readonly SettingKey[] = SETTING_FIELDS.filter((s) => s.owner).map((s) => s.key);

export const WEEKDAY_LABEL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

export type SettingValue = number | number[] | boolean;
export type SettingsValues = Partial<Record<SettingKey, SettingValue>>;

export interface SettingProblem {
  key: SettingKey;
  message: string;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/**
 * Problems in a complete settings object (the platform defaults, or an owner's
 * effective settings). The same checks, in the same order, as app.settings_problems.
 */
export function settingsProblems(s: SettingsValues): SettingProblem[] {
  const out: SettingProblem[] = [];
  const add = (key: SettingKey, message: string) => out.push({ key, message });
  const num = (key: SettingKey) => (isInt(s[key]) ? (s[key] as number) : null);

  for (const field of SETTING_FIELDS) {
    if (!(field.key in s)) continue;
    const v = s[field.key];
    if (field.kind === "int" || field.kind === "money" || field.kind === "weekday") {
      if (!isInt(v)) add(field.key, "Enter a whole number.");
      else if (v < field.min! || v > field.max!) add(field.key, rangeMessage(field));
    } else if (field.kind === "list") {
      if (!Array.isArray(v) || !v.every(isInt)) {
        add(field.key, "Enter whole numbers separated by commas.");
        continue;
      }
      if (v.length > field.maxItems!) add(field.key, `At most ${field.maxItems} values.`);
      if (v.some((x) => x < field.min! || x > field.max!)) add(field.key, `Each value must be between ${field.min} and ${field.max}.`);
      else if (v.some((x, i) => i > 0 && x <= v[i - 1])) add(field.key, "Put the values in order, from low to high, without repeats.");
      const limit = field.below ? num(field.below) : null;
      if (limit !== null && v.some((x) => x >= limit)) add(field.key, `Every value must be lower than "${FIELD[field.below!].label}" (${limit}).`);
    } else if (typeof v !== "boolean") {
      add(field.key, "Choose yes or no.");
    }
  }

  const lt = (a: SettingKey, b: SettingKey) => num(a) !== null && num(b) !== null && num(a)! < num(b)!;
  if (lt("review_escalation_hours", "review_deadline_hours")) add("review_escalation_hours", "The admin must not be told before the review deadline.");
  if (lt("slip_review_escalation_hours", "slip_review_deadline_hours")) add("slip_review_escalation_hours", "The admin must not be told before the slip check deadline.");
  if (num("service_admin_escalation_hours_urgent") !== null && num("service_ack_hours_urgent") !== null && num("service_admin_escalation_hours_urgent")! <= num("service_ack_hours_urgent")!) {
    add("service_admin_escalation_hours_urgent", "The admin must be told later than the owner's reminder.");
  }
  if (num("service_admin_escalation_hours_normal") !== null && num("service_ack_hours_normal") !== null && num("service_admin_escalation_hours_normal")! <= num("service_ack_hours_normal")!) {
    add("service_admin_escalation_hours_normal", "The admin must be told later than the owner's reminder.");
  }
  if (lt("service_ack_hours_normal", "service_ack_hours_urgent")) add("service_ack_hours_urgent", "Urgent requests must not wait longer than normal ones.");
  if (s.late_fee_enabled === true && num("late_fee_cents") !== null && num("late_fee_cents")! <= 0) add("late_fee_cents", "Enter the late fee, or switch it off.");
  if (lt("login_ip_max_failures", "login_max_failures")) add("login_ip_max_failures", "Must not be lower than the wrong passwords before a lockout.");
  if (num("session_idle_minutes") !== null && num("session_max_hours") !== null && num("session_idle_minutes")! > num("session_max_hours")! * 60) {
    add("session_idle_minutes", "Must not be longer than the maximum session.");
  }
  if (lt("email_monthly_limit", "email_daily_limit")) add("email_monthly_limit", "Must not be lower than the daily limit.");
  if (num("email_essential_reserve") !== null && num("email_daily_limit") !== null && num("email_essential_reserve")! > num("email_daily_limit")!) {
    add("email_essential_reserve", "Must not be more than the daily limit.");
  }
  return out;
}

function rangeMessage(field: SettingField): string {
  if (field.kind === "money") return `Enter an amount up to ${(field.max! / 100).toLocaleString("en-US")} rupees.`;
  return `Enter a number from ${field.min} to ${field.max}.`;
}

/** "meter_reminder_days: must be ..." from the database -> { key, message }. */
export function parseDbProblems(message: string): SettingProblem[] {
  return message
    .split("; ")
    .map((part) => {
      const at = part.indexOf(": ");
      const key = part.slice(0, at) as SettingKey;
      return at > 0 && key in FIELD ? { key, message: part.slice(at + 2).replace(/^./, (c) => c.toUpperCase()) + "." } : null;
    })
    .filter((p): p is SettingProblem => p !== null);
}

/** A value as the form shows it. */
export function formatSettingInput(field: SettingField, value: SettingValue | null | undefined): string {
  if (value === null || value === undefined) return "";
  if (field.kind === "list") return (value as number[]).join(", ");
  if (field.kind === "money") return centsToRupeesInput(value as number);
  if (field.kind === "bool") return value ? "on" : "";
  return String(value);
}

/** A value as text ("2, 4 days", "Rs. 500", "Yes", "Monday"). */
export function describeSetting(field: SettingField, value: SettingValue | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (field.kind === "bool") return value ? "Yes" : "No";
  if (field.kind === "weekday") return WEEKDAY_LABEL[value as number] ?? String(value);
  if (field.kind === "money") return `Rs. ${centsToRupeesInput(value as number)}`;
  const text = field.kind === "list" ? ((value as number[]).length ? (value as number[]).join(", ") : "none") : String(value);
  return field.unit && !(field.kind === "list" && (value as number[]).length === 0) ? `${text} ${field.unit}` : text;
}

const intText = z
  .string()
  .trim()
  .regex(/^\d{1,9}$/, "Enter a whole number.")
  .transform(Number);
const listText = z
  .string()
  .trim()
  .max(200, "Too many values.")
  .regex(/^(\d{1,9}(\s*,\s*\d{1,9})*)?$/, "Enter whole numbers separated by commas.")
  .transform((t) => (t === "" ? [] : t.split(",").map((x) => Number(x.trim()))));
const moneyText = z
  .string()
  .trim()
  .transform((t, ctx) => {
    const cents = rupeesToCents(t === "" ? "0" : t);
    if (cents === null) {
      ctx.addIssue({ code: "custom", message: "Enter an amount in rupees, e.g. 500 or 500.00." });
      return z.NEVER;
    }
    return cents;
  });

/** Zod schema for one field's form text. */
export function fieldSchema(field: SettingField): z.ZodType<SettingValue> {
  switch (field.kind) {
    case "bool":
      return z.string().optional().transform((v) => v === "on");
    case "list":
      return listText;
    case "money":
      return moneyText;
    default:
      return intText;
  }
}

export interface ParsedSettingsForm {
  /** key -> new value, or null for "use the platform default" (owners). */
  changes: Partial<Record<SettingKey, SettingValue | null>>;
  fieldErrors: Record<string, string>;
}

/**
 * Reads the settings form: one input per key (a list as "2, 4", a checkbox as "on",
 * money in rupees). With `inherit`, a ticked "default:<key>" box means null.
 */
export function parseSettingsForm(values: Record<string, string | undefined>, keys: readonly SettingKey[], options: { inherit?: boolean } = {}): ParsedSettingsForm {
  const changes: ParsedSettingsForm["changes"] = {};
  const fieldErrors: Record<string, string> = {};
  for (const key of keys) {
    const field = FIELD[key];
    if (options.inherit && values[`default:${key}`] === "on") {
      changes[key] = null;
      continue;
    }
    const parsed = fieldSchema(field).safeParse(values[key] ?? (field.kind === "bool" ? undefined : ""));
    if (parsed.success) changes[key] = parsed.data;
    else fieldErrors[key] = parsed.error.issues[0]?.message ?? "Please check this value.";
  }
  return { changes, fieldErrors };
}

/** Owner overrides over the platform defaults (null = default). */
export function effectiveSettings(platform: SettingsValues, owner: Partial<Record<SettingKey, SettingValue | null>>): SettingsValues {
  const out: SettingsValues = { ...platform };
  for (const key of OWNER_KEYS) {
    const v = owner[key];
    if (v !== null && v !== undefined) out[key] = v;
  }
  return out;
}

/** Only the keys whose value differs (lists compared by content). */
export function changedKeys(before: Partial<Record<SettingKey, SettingValue | null>>, after: Partial<Record<SettingKey, SettingValue | null>>): SettingKey[] {
  return (Object.keys(after) as SettingKey[]).filter((k) => JSON.stringify(before[k] ?? null) !== JSON.stringify(after[k] ?? null));
}
