import { describe, expect, it } from "vitest";

import {
  changedKeys,
  describeSetting,
  effectiveSettings,
  FIELD,
  formatSettingInput,
  OWNER_KEYS,
  parseDbProblems,
  parseSettingsForm,
  SETTING_FIELDS,
  SETTING_KEYS,
  settingsProblems,
  type SettingsValues,
} from "./rules";

/** The platform defaults of the dev database (migrations 0002-0034). */
const DEFAULTS: SettingsValues = {
  meter_deadline_days: 5,
  meter_reminder_days: [2, 4],
  max_meter_rejections: 3,
  rejected_photo_retention_days: 7,
  review_deadline_hours: 48,
  review_reminder_hours: [24, 48],
  review_escalation_hours: 72,
  payment_due_days: 7,
  payment_reminder_before_days: [3],
  payment_reminder_on_due: true,
  payment_overdue_reminder_days: [1, 7, 14],
  weekly_summary_dow: 1,
  payment_slip_retention_days: 2555,
  slip_review_deadline_hours: 48,
  slip_review_reminder_hours: [24, 48],
  slip_review_escalation_hours: 72,
  late_fee_enabled: false,
  late_fee_cents: 0,
  grace_period_days: 7,
  estimated_billing_enabled: false,
  service_ack_hours_urgent: 4,
  service_ack_hours_normal: 24,
  service_admin_escalation_hours_urgent: 8,
  service_admin_escalation_hours_normal: 48,
  dispute_reminder_days: [3, 5],
  dispute_escalation_days: 7,
  agreement_end_notice_days: 30,
  login_max_failures: 5,
  login_lockout_minutes: 15,
  login_ip_max_failures: 30,
  login_ip_window_minutes: 15,
  session_idle_minutes: 30,
  session_max_hours: 12,
  email_daily_limit: 100,
  email_monthly_limit: 3000,
  email_essential_reserve: 20,
  email_max_attempts: 5,
  email_reminder_expiry_days: 3,
};

const keys = (s: SettingsValues) => settingsProblems(s).map((p) => p.key);

describe("settings rules (ADM-06, decision 82)", () => {
  it("the catalogue covers every key once; the current defaults are valid", () => {
    expect(SETTING_FIELDS.map((f) => f.key).sort()).toEqual([...SETTING_KEYS].sort());
    expect(Object.keys(DEFAULTS).sort()).toEqual([...SETTING_KEYS].sort());
    expect(settingsProblems(DEFAULTS)).toEqual([]);
    expect(OWNER_KEYS).not.toContain("login_max_failures");
    expect(OWNER_KEYS).toContain("agreement_end_notice_days");
  });

  it("ranges", () => {
    expect(keys({ ...DEFAULTS, meter_deadline_days: 0 })).toEqual(["meter_deadline_days", "meter_reminder_days"]);
    expect(keys({ ...DEFAULTS, payment_due_days: 91 })).toEqual(["payment_due_days"]);
    expect(keys({ ...DEFAULTS, agreement_end_notice_days: 181 })).toEqual(["agreement_end_notice_days"]);
    expect(keys({ ...DEFAULTS, weekly_summary_dow: 7 })).toEqual(["weekly_summary_dow"]);
    expect(keys({ ...DEFAULTS, session_idle_minutes: 2.5 })).toEqual(["session_idle_minutes"]);
  });

  it("reminder lists: in order, in range, before their deadline", () => {
    expect(keys({ ...DEFAULTS, meter_reminder_days: [4, 2] })).toEqual(["meter_reminder_days"]);
    expect(keys({ ...DEFAULTS, meter_reminder_days: [2, 2] })).toEqual(["meter_reminder_days"]);
    expect(keys({ ...DEFAULTS, meter_reminder_days: [2, 5] })).toEqual(["meter_reminder_days"]);
    expect(keys({ ...DEFAULTS, meter_reminder_days: [] })).toEqual([]);
    expect(keys({ ...DEFAULTS, review_reminder_hours: [24, 72] })).toEqual(["review_reminder_hours"]);
    expect(keys({ ...DEFAULTS, payment_overdue_reminder_days: [1, 2, 3, 4, 5, 6, 7] })).toEqual(["payment_overdue_reminder_days"]);
    expect(keys({ ...DEFAULTS, dispute_reminder_days: [3, 7] })).toEqual(["dispute_reminder_days"]);
  });

  it("rules between settings", () => {
    expect(keys({ ...DEFAULTS, review_escalation_hours: 40 })).toEqual(["review_reminder_hours", "review_escalation_hours"]);
    expect(keys({ ...DEFAULTS, service_admin_escalation_hours_urgent: 4 })).toEqual(["service_admin_escalation_hours_urgent"]);
    expect(keys({ ...DEFAULTS, service_ack_hours_urgent: 30, service_admin_escalation_hours_urgent: 40 })).toEqual(["service_ack_hours_urgent"]);
    expect(keys({ ...DEFAULTS, late_fee_enabled: true })).toEqual(["late_fee_cents"]);
    expect(keys({ ...DEFAULTS, late_fee_enabled: true, late_fee_cents: 50_000 })).toEqual([]);
    expect(keys({ ...DEFAULTS, login_ip_max_failures: 4 })).toEqual(["login_ip_max_failures"]);
    expect(keys({ ...DEFAULTS, session_idle_minutes: 800 })).toEqual(["session_idle_minutes"]);
    expect(keys({ ...DEFAULTS, email_monthly_limit: 50 })).toEqual(["email_monthly_limit"]);
    expect(keys({ ...DEFAULTS, email_essential_reserve: 101 })).toEqual(["email_essential_reserve"]);
  });

  it("reads the form: numbers, lists, money, yes/no, and 'use the default'", () => {
    const parsed = parseSettingsForm(
      { meter_deadline_days: " 6 ", meter_reminder_days: "2,4 , 5", late_fee_cents: "500.50", payment_reminder_on_due: undefined, "default:grace_period_days": "on", grace_period_days: "x" },
      ["meter_deadline_days", "meter_reminder_days", "late_fee_cents", "payment_reminder_on_due", "grace_period_days"],
      { inherit: true },
    );
    expect(parsed.fieldErrors).toEqual({});
    expect(parsed.changes).toEqual({ meter_deadline_days: 6, meter_reminder_days: [2, 4, 5], late_fee_cents: 50_050, payment_reminder_on_due: false, grace_period_days: null });
    const bad = parseSettingsForm({ meter_deadline_days: "-1", meter_reminder_days: "2;4", late_fee_cents: "abc" }, ["meter_deadline_days", "meter_reminder_days", "late_fee_cents"]);
    expect(Object.keys(bad.fieldErrors).sort()).toEqual(["late_fee_cents", "meter_deadline_days", "meter_reminder_days"]);
  });

  it("owner overrides on top of the defaults; only changed keys are sent", () => {
    const eff = effectiveSettings(DEFAULTS, { meter_deadline_days: 7, meter_reminder_days: null, login_max_failures: 99 as never });
    expect(eff.meter_deadline_days).toBe(7);
    expect(eff.meter_reminder_days).toEqual([2, 4]);
    expect(eff.login_max_failures).toBe(5);
    expect(changedKeys({ meter_reminder_days: [2, 4], meter_deadline_days: 5 }, { meter_reminder_days: [2, 4], meter_deadline_days: 6 })).toEqual(["meter_deadline_days"]);
    expect(changedKeys({ grace_period_days: 3 }, { grace_period_days: null })).toEqual(["grace_period_days"]);
  });

  it("database messages map to fields; values display", () => {
    expect(parseDbProblems("meter_reminder_days: values must go up, without repeats; nope")).toEqual([
      { key: "meter_reminder_days", message: "Values must go up, without repeats." },
    ]);
    expect(describeSetting(FIELD.meter_reminder_days, [2, 4])).toBe("2, 4 days");
    expect(describeSetting(FIELD.meter_reminder_days, [])).toBe("none");
    expect(describeSetting(FIELD.weekly_summary_dow, 1)).toBe("Monday");
    expect(describeSetting(FIELD.late_fee_cents, 50_000)).toBe("Rs. 500");
    expect(describeSetting(FIELD.payment_reminder_on_due, true)).toBe("Yes");
    expect(formatSettingInput(FIELD.review_reminder_hours, [24, 48])).toBe("24, 48");
    expect(formatSettingInput(FIELD.late_fee_cents, 50_050)).toBe("500.50");
  });
});
