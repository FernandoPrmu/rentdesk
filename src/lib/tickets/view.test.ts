import { describe, expect, it } from "vitest";

import { startOfColomboDay } from "./deadlines";
import { currentDue, type CustomerTicketRow, customerHome, nextStep, ticketFlags, type TicketView } from "./view";

const NOW = new Date("2026-10-20T10:00:00+05:30");

function view(o: Partial<TicketView> = {}): TicketView {
  return { status: "METER_REQUESTED", status_before_overdue: null, stage_due_at: startOfColomboDay("2026-10-25").toISOString(), escalation_level: 0, paused_at: null, invoice: null, ...o };
}

const bill = (o: Partial<NonNullable<TicketView["invoice"]>> = {}) => ({
  invoice_no: "INV-000007",
  type: "NORMAL" as const,
  status: "AWAITING_PAYMENT",
  due_date: "2026-10-27",
  total_cents: 650_000,
  amount_paid_cents: 0,
  ...o,
});

function row(o: Partial<CustomerTicketRow> = {}): CustomerTicketRow {
  return { ...view(), id: "t1", agreement_id: "a1", cycle_no: 1, cycle_date: "2026-10-20", machine: "Ricoh MP 2014", last_confirmed_cycle: 0, ...o };
}

describe("ticket flags (owner list badges)", () => {
  it("overdue: the status, or a customer deadline already passed", () => {
    expect(ticketFlags(view(), NOW).overdue).toBe(false);
    expect(ticketFlags(view({ stage_due_at: startOfColomboDay("2026-10-20").toISOString() }), NOW).overdue).toBe(true);
    expect(ticketFlags(view({ status: "OVERDUE", status_before_overdue: "METER_REQUESTED" }), NOW).overdue).toBe(true);
    expect(ticketFlags(view({ status: "AWAITING_PAYMENT", invoice: bill({ due_date: "2026-10-19" }) }), NOW).overdue).toBe(true);
    expect(ticketFlags(view({ status: "AWAITING_PAYMENT", invoice: bill({ due_date: "2026-10-20" }) }), NOW).overdue).toBe(false);
    // A slip waiting for the owner is never overdue (8.2).
    expect(ticketFlags(view({ status: "PAYMENT_SUBMITTED", invoice: bill({ due_date: "2026-10-01" }) }), NOW).overdue).toBe(false);
  });

  it("escalated while open; paused", () => {
    expect(ticketFlags(view({ escalation_level: 2 }), NOW).escalated).toBe(true);
    expect(ticketFlags(view({ escalation_level: 2, status: "CLOSED" }), NOW).escalated).toBe(false);
    expect(ticketFlags(view({ paused_at: NOW.toISOString() }), NOW).paused).toBe(true);
  });
});

describe("next step and deadline (TKT-06)", () => {
  it("names who acts and what to do", () => {
    expect(nextStep(view())).toEqual({ who: "CUSTOMER", label: "Send the meter reading and photo" });
    expect(nextStep(view({ status: "PENDING_OWNER_REVIEW", invoice: bill({ type: "ESTIMATED" }) }))).toEqual({ who: "OWNER", label: "Review the estimated invoice" });
    expect(nextStep(view({ status: "OVERDUE", status_before_overdue: "AWAITING_PAYMENT" })).who).toBe("CUSTOMER");
    expect(nextStep(view({ status: "CLOSED" }))).toEqual({ who: null, label: "Paid and closed" });
  });

  it("meter: the last day; payment: the due date; reviews: the moment", () => {
    expect(currentDue(view())).toEqual({ kind: "day", date: "2026-10-24" });
    expect(currentDue(view({ status: "PARTIALLY_PAID", invoice: bill() }))).toEqual({ kind: "day", date: "2026-10-27" });
    expect(currentDue(view({ status: "PAYMENT_SUBMITTED", stage_due_at: "2026-10-21T10:00:00Z" }))).toEqual({ kind: "moment", at: "2026-10-21T10:00:00Z" });
    expect(currentDue(view({ status: "DISPUTED" }))).toBeNull();
  });
});

describe("customer Home: what you need to do now (CP-01, CP-02, rule 25)", () => {
  it("one meter task per machine: the newest ticket, with the months it covers", () => {
    const home = customerHome(
      [
        row({ id: "old1", cycle_no: 4, status: "OVERDUE", status_before_overdue: "METER_REQUESTED", last_confirmed_cycle: 3 }),
        row({ id: "old2", cycle_no: 5, status: "OVERDUE", status_before_overdue: "METER_REQUESTED", last_confirmed_cycle: 3 }),
        row({ id: "new", cycle_no: 6, last_confirmed_cycle: 3 }),
        row({ id: "other", agreement_id: "a2", machine: "Canon iR", cycle_no: 2, last_confirmed_cycle: 1 }),
      ],
      NOW,
    );
    const meter = home.tasks.filter((t) => t.kind === "METER");
    expect(meter).toHaveLength(2);
    expect(meter[0]).toMatchObject({ ticketId: "new", months: 3, dueDate: "2026-10-24", overdue: true });
    expect(meter[1]).toMatchObject({ ticketId: "other", months: 1, overdue: false });
  });

  it("a pay task per unpaid bill with what is left; overdue first", () => {
    const home = customerHome(
      [
        row({ id: "p1", status: "AWAITING_PAYMENT", invoice: bill({ due_date: "2026-10-27" }) }),
        row({ id: "p2", agreement_id: "a2", status: "OVERDUE", status_before_overdue: "PARTIALLY_PAID", invoice: bill({ status: "OVERDUE", due_date: "2026-10-10", amount_paid_cents: 150_000 }) }),
      ],
      NOW,
    );
    expect(home.tasks.map((t) => [t.ticketId, t.kind, t.kind === "PAY" ? t.amountCents : null, t.overdue])).toEqual([
      ["p2", "PAY", 500_000, true],
      ["p1", "PAY", 650_000, false],
    ]);
  });

  it("tickets with the rental company are listed as waiting, closed ones not at all", () => {
    const home = customerHome(
      [row({ id: "r", status: "PENDING_OWNER_REVIEW" }), row({ id: "s", status: "PAYMENT_SUBMITTED" }), row({ id: "c", status: "CLOSED" })],
      NOW,
    );
    expect(home.tasks).toEqual([]);
    expect(home.waiting.map((w) => w.ticketId)).toEqual(["r", "s"]);
  });
});
