import { describe, expect, it } from "vitest";

import { PLATFORM_DEFAULTS, startOfColomboDay } from "../tickets/deadlines";
import type { TicketStatus } from "../tickets/states";
import { type CronInvoice, type CronTicket, decideTicket, type PlatformLateFee } from "./decide";

const PLATFORM: PlatformLateFee = { enabled: false, fee_cents: 0, grace_days: 7 };
const at = (s: string) => new Date(s);
/** The daily run at ~01:00 Colombo on a date. */
const run = (date: string) => at(`${date}T01:00:00+05:30`);

function ticket(overrides: Partial<CronTicket> = {}): CronTicket {
  return {
    id: "t1",
    owner_id: "o1",
    customer_id: "c1",
    agreement_id: "a1",
    cycle_no: 1,
    cycle_date: "2026-10-10",
    status: "METER_REQUESTED",
    status_before_overdue: null,
    stage_due_at: startOfColomboDay("2026-10-15").toISOString(),
    stage_entered_at: run("2026-10-10").toISOString(),
    escalation_level: 0,
    reminder_count: 0,
    paused_at: null,
    machine_type: "MONO",
    commitment_cents: 500_000,
    bw_included: 2000,
    bw_rate_cents: 250,
    colour_included: null,
    colour_rate_cents: null,
    late_fee_mode: "OWNER_DEFAULT",
    late_fee_cents: null,
    machine_name: "Ricoh MP",
    serial_no: "S1",
    customer_name: "Silva",
    accounts_active: true,
    has_estimate: false,
    invoice: null,
    settings: PLATFORM_DEFAULTS,
    owner_late_fee: { enabled: null, fee_cents: null, grace_days: null },
    credits: null,
    ...overrides,
  };
}

function invoice(overrides: Partial<CronInvoice> = {}): CronInvoice {
  return {
    id: "i1",
    invoice_no: "INV-000001",
    type: "NORMAL",
    status: "AWAITING_PAYMENT",
    due_date: "2026-10-17",
    subtotal_cents: 650_000,
    late_fee_cents: 0,
    credit_applied_cents: 0,
    total_cents: 650_000,
    amount_paid_cents: 0,
    ...overrides,
  };
}

const kinds = (t: CronTicket, now: Date, platform = PLATFORM) => decideTicket(t, now, platform).map((d) => d.kind);

describe("meter stage timeline (5.4: reminders day 2 and 4, overdue + owner day 5)", () => {
  it("day 1: nothing; day 2: reminder 1; day 4: reminder 2; day 5: overdue", () => {
    expect(decideTicket(ticket(), run("2026-10-11"), PLATFORM)).toEqual([]);
    expect(decideTicket(ticket(), run("2026-10-12"), PLATFORM)).toEqual([expect.objectContaining({ kind: "REMIND", recipient: "CUSTOMER", reminder: expect.objectContaining({ no: 1 }) })]);
    expect(decideTicket(ticket({ reminder_count: 1 }), run("2026-10-13"), PLATFORM)).toEqual([]);
    expect(decideTicket(ticket({ reminder_count: 1 }), run("2026-10-14"), PLATFORM)[0]).toMatchObject({ kind: "REMIND", reminder: { no: 2 } });
    expect(decideTicket(ticket({ reminder_count: 2 }), run("2026-10-15"), PLATFORM)).toEqual([{ kind: "MARK_OVERDUE", stage: "METER", reminderNo: 0 }]);
  });

  it("the same day twice: the second run finds the reminder already sent", () => {
    expect(kinds(ticket({ reminder_count: 1 }), run("2026-10-12"))).toEqual([]);
  });

  it("11.6: estimated billing on -> overdue, then the estimate; once per ticket", () => {
    const s = { ...PLATFORM_DEFAULTS, estimated_billing_enabled: true };
    expect(kinds(ticket({ settings: s }), run("2026-10-15"))).toEqual(["MARK_OVERDUE", "ESTIMATE"]);
    // A run that marked it overdue but failed before the estimate: next run estimates.
    expect(kinds(ticket({ settings: s, status: "OVERDUE", status_before_overdue: "METER_REQUESTED" }), run("2026-10-16"))).toEqual(["ESTIMATE"]);
    expect(kinds(ticket({ settings: s, status: "OVERDUE", status_before_overdue: "METER_REQUESTED", has_estimate: true }), run("2026-10-16"))).toEqual([]);
    expect(kinds(ticket({ status: "OVERDUE", status_before_overdue: "METER_REQUESTED" }), run("2026-10-16"))).toEqual([]);
  });

  it("TKT-12: a paused ticket (or inactive account) is left alone", () => {
    expect(kinds(ticket({ paused_at: run("2026-10-11").toISOString() }), run("2026-10-20"))).toEqual([]);
    expect(kinds(ticket({ accounts_active: false }), run("2026-10-20"))).toEqual([]);
  });
});

describe("owner review stages (5.4: reminders 24 h / 48 h, admin after 72 h)", () => {
  const review = (status: TicketStatus, o: Partial<CronTicket> = {}) =>
    ticket({ status, stage_entered_at: at("2026-10-10T15:00:00+05:30").toISOString(), stage_due_at: null, ...o });

  it("reading and slip reviews remind the owner, then alert the admin", () => {
    for (const status of ["PENDING_OWNER_REVIEW", "PAYMENT_SUBMITTED"] as const) {
      expect(kinds(review(status), run("2026-10-11"))).toEqual([]);
      expect(decideTicket(review(status), run("2026-10-12"), PLATFORM)).toEqual([expect.objectContaining({ kind: "REMIND", recipient: "OWNER", reminder: expect.objectContaining({ no: 1 }) })]);
      expect(decideTicket(review(status, { reminder_count: 1 }), run("2026-10-13"), PLATFORM)[0]).toMatchObject({ kind: "REMIND", reminder: { no: 2 } });
      expect(kinds(review(status, { reminder_count: 2 }), run("2026-10-14"))).toEqual(["ESCALATE_ADMIN"]);
      expect(kinds(review(status, { reminder_count: 2, escalation_level: 2 }), run("2026-10-20"))).toEqual([]);
    }
  });

  it("11.1: never confirmed automatically, whatever the delay", () => {
    expect(kinds(review("PENDING_OWNER_REVIEW", { reminder_count: 2, escalation_level: 2 }), run("2027-01-01"))).toEqual([]);
  });
});

describe("payment stage (8.3: 3 days before, on the day, overdue 1 / 7 / 14)", () => {
  const pay = (o: Partial<CronTicket> = {}, inv: Partial<CronInvoice> = {}) =>
    ticket({ status: "AWAITING_PAYMENT", stage_due_at: startOfColomboDay("2026-10-18").toISOString(), invoice: invoice(inv), ...o });

  it("reminders before and on the due date, then overdue the day after", () => {
    expect(kinds(pay(), run("2026-10-13"))).toEqual([]);
    expect(decideTicket(pay(), run("2026-10-14"), PLATFORM)[0]).toMatchObject({ kind: "REMIND", reminder: { kind: "PAYMENT_DUE_SOON" } });
    expect(decideTicket(pay({ reminder_count: 1 }), run("2026-10-17"), PLATFORM)[0]).toMatchObject({ kind: "REMIND", reminder: { kind: "PAYMENT_DUE_TODAY" } });
    // The overdue notice counts as the day-1 overdue reminder.
    expect(decideTicket(pay({ reminder_count: 2 }), run("2026-10-18"), PLATFORM)).toEqual([{ kind: "MARK_OVERDUE", stage: "PAYMENT", reminderNo: 1 }]);
  });

  it("overdue reminders on day 7 and day 14", () => {
    const overdue = (n: number) => pay({ status: "OVERDUE", status_before_overdue: "AWAITING_PAYMENT", reminder_count: n }, { status: "OVERDUE" });
    expect(kinds(overdue(1), run("2026-10-23"))).toEqual([]);
    expect(decideTicket(overdue(1), run("2026-10-24"), PLATFORM)[0]).toMatchObject({ kind: "REMIND", reminder: { no: 2, kind: "PAYMENT_OVERDUE" } });
    expect(decideTicket(overdue(2), run("2026-10-31"), PLATFORM)[0]).toMatchObject({ kind: "REMIND", reminder: { no: 3 } });
    expect(kinds(overdue(3), run("2026-11-30"))).toEqual([]);
  });

  it("8.2: a slip waiting for the owner is never overdue; a dispute pauses reminders", () => {
    expect(kinds(pay({ status: "PAYMENT_SUBMITTED", stage_entered_at: run("2026-10-30").toISOString() }, { status: "PAYMENT_SUBMITTED" }), run("2026-10-30"))).toEqual([]);
    expect(kinds(pay({ status: "DISPUTED" }, { status: "DISPUTED" }), run("2026-11-30"))).toEqual([]);
  });

  it("nothing is chased when the invoice is paid", () => {
    expect(kinds(pay({}, { amount_paid_cents: 650_000 }), run("2026-10-30"))).toEqual([]);
  });

  it("a partially paid invoice is chased like an unpaid one", () => {
    expect(kinds(pay({ status: "PARTIALLY_PAID", reminder_count: 2 }, { status: "PARTIALLY_PAID", amount_paid_cents: 100 }), run("2026-10-18"))).toEqual(["MARK_OVERDUE"]);
  });

  it("a reopened ticket is not reminded but becomes overdue past the due date", () => {
    expect(kinds(pay({ status: "REOPENED" }), run("2026-10-14"))).toEqual([]);
    expect(kinds(pay({ status: "REOPENED" }), run("2026-10-18"))).toEqual(["MARK_OVERDUE"]);
  });
});

describe("late fee (PAY-13, LATE-01: after due date + grace, once)", () => {
  const owing = (o: Partial<CronTicket> = {}, inv: Partial<CronInvoice> = {}) =>
    ticket({ status: "OVERDUE", status_before_overdue: "AWAITING_PAYMENT", reminder_count: 3, invoice: invoice({ status: "OVERDUE", ...inv }), ...o });
  const ownerFee = { enabled: true, fee_cents: 50_000, grace_days: 7 };

  it("charged the day after due date + grace, at the owner's amount", () => {
    expect(kinds(owing({ owner_late_fee: ownerFee, reminder_count: 1 }), run("2026-10-24"))).toEqual(["REMIND"]);
    expect(decideTicket(owing({ owner_late_fee: ownerFee, reminder_count: 2 }), run("2026-10-25"), PLATFORM)).toContainEqual({ kind: "LATE_FEE", feeCents: 50_000 });
  });

  it("never twice", () => {
    expect(kinds(owing({ owner_late_fee: ownerFee }, { late_fee_cents: 50_000 }), run("2026-11-30"))).not.toContain("LATE_FEE");
  });

  it("the agreement's own setting wins: custom amount, or none", () => {
    expect(decideTicket(owing({ late_fee_mode: "CUSTOM", late_fee_cents: 75_000 }), run("2026-11-30"), PLATFORM)).toContainEqual({ kind: "LATE_FEE", feeCents: 75_000 });
    expect(kinds(owing({ late_fee_mode: "NONE", owner_late_fee: ownerFee }), run("2026-11-30"))).not.toContain("LATE_FEE");
  });

  it("falls back to the platform default", () => {
    expect(decideTicket(owing(), run("2026-11-30"), { enabled: true, fee_cents: 10_000, grace_days: 3 })).toContainEqual({ kind: "LATE_FEE", feeCents: 10_000 });
    expect(kinds(owing(), run("2026-11-30"))).not.toContain("LATE_FEE");
  });
});
