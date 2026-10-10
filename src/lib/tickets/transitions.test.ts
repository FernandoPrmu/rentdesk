import { describe, expect, it, vi } from "vitest";

import { type ActorKind, canPerform, TICKET_ACTIONS, TICKET_STATUSES, type TicketAction, type TicketStatus } from "./states";
import * as T from "./transitions";
import { type Actor, type Rpc, type TicketSnapshot, TransitionError } from "./transitions";

const OWNER = "00000000-0000-4000-8000-000000000001";
const CUSTOMER = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-000000000009";
const ID = "00000000-0000-4000-8000-0000000000aa";
const NOW = new Date("2026-10-10T01:00:00+05:30");

const ACTOR: Record<ActorKind, Actor> = {
  CUSTOMER: { kind: "USER", id: CUSTOMER, role: "CUSTOMER" },
  OWNER: { kind: "USER", id: OWNER, role: "OWNER" },
  ADMIN: { kind: "USER", id: OTHER, role: "ADMIN" },
  SYSTEM: T.SYSTEM,
};

function ticket(status: TicketStatus, before: TicketStatus | null = null): TicketSnapshot {
  return { id: ID, owner_id: OWNER, customer_id: CUSTOMER, cycle_no: 3, status, status_before_overdue: before, machine_name: "Ricoh MP", customer_name: "Silva" };
}

const invoice = { type: "NORMAL" as const, cycles_covered: 1, subtotal_cents: 500_000, credit_applied_cents: 0, total_cents: 500_000, lines: [], calculation: {} };
const reading = {
  idempotencyKey: ID,
  readings: [{ counter_type: "BW" as const, previous_value: 1, current_value: 2, rolled_over: false }],
  invoice,
  photo: { storagePath: `${OWNER}/${ID}/p.jpg` },
  note: "Customer phoned the reading in",
  stageDueAt: NOW,
};
const payment = { idempotencyKey: ID, amountCents: 500_000, paidOn: "2026-10-09", slip: { storagePath: `${OWNER}/${ID}/s.pdf`, sha256: "a".repeat(64), mimeType: "application/pdf", sizeBytes: 10 }, stageDueAt: NOW };

/** Each action: its function, a valid input, and the rpc it must call. */
const CASES: Record<TicketAction, { call: (rpc: Rpc, actor: Actor, t: TicketSnapshot) => Promise<unknown>; rpc: string }> = {
  submitReading: { call: (r, a, t) => T.submitReading(r, a, t, reading), rpc: "rpc_submit_meter_reading" },
  enterReadingManually: { call: (r, a, t) => T.enterReadingManually(r, a, t, reading), rpc: "rpc_submit_meter_reading" },
  createEstimate: { call: (r, a, t) => T.createEstimate(r, a, t, { invoice: { ...invoice, type: "ESTIMATED" }, stageDueAt: NOW, now: NOW }), rpc: "rpc_create_estimated_invoice" },
  confirmInvoice: { call: (r, a, t) => T.confirmInvoice(r, a, t, { submissionId: ID, dueDate: "2026-10-17", stageDueAt: NOW, totalCents: 1 }), rpc: "rpc_confirm_meter_submission" },
  rejectReading: { call: (r, a, t) => T.rejectReading(r, a, t, { submissionId: ID, reason: "Photo blurry", stageDueAt: NOW, photoExpiresAt: NOW }), rpc: "rpc_reject_meter_submission" },
  submitSlip: { call: (r, a, t) => T.submitSlip(r, a, t, payment), rpc: "rpc_submit_payment" },
  recordPayment: { call: (r, a, t) => T.recordPayment(r, a, t, { ...payment, slip: null, method: "CASH" }), rpc: "rpc_submit_payment" },
  acceptPayment: { call: (r, a, t) => T.acceptPayment(r, a, t, { paymentId: ID, acceptedAmountCents: 500_000, balanceCents: 500_000, stageDueAt: NOW }), rpc: "rpc_verify_payment" },
  rejectPayment: { call: (r, a, t) => T.rejectPayment(r, a, t, { paymentId: ID, reason: "Wrong amount", stageDueAt: NOW }), rpc: "rpc_verify_payment" },
  markOverdue: { call: (r, a, t) => T.markOverdue(r, a, t, { now: NOW, reminderNo: 0, escalationLevel: 1 }), rpc: "rpc_mark_ticket_overdue" },
  clearOverdue: { call: (r, a, t) => T.clearOverdue(r, a, t, { reason: "Agreed by phone", dueDate: "2026-10-20", stageDueAt: NOW }), rpc: "rpc_transition_ticket" },
  raiseDispute: { call: (r, a, t) => T.raiseDispute(r, a, t, { reason: "Too many copies" }), rpc: "rpc_raise_dispute" },
  resolveDispute: { call: (r, a, t) => T.resolveDispute(r, a, t, { outcome: "REJECTED", resolution: "Reading checked", stageDueAt: NOW }), rpc: "rpc_resolve_dispute" },
  cancelTicket: { call: (r, a, t) => T.cancelTicket(r, a, t, { reason: "Created in error" }), rpc: "rpc_transition_ticket" },
  reopenTicket: { call: (r, a, t) => T.reopenTicket(r, a, t, { reason: "Cheque returned" }), rpc: "rpc_transition_ticket" },
  requestPaymentAgain: { call: (r, a, t) => T.requestPaymentAgain(r, a, t, { stageDueAt: NOW, amountCents: 1, dueDate: "2026-10-20" }), rpc: "rpc_transition_ticket" },
};

const STATES: [TicketStatus, TicketStatus | null][] = [
  ...TICKET_STATUSES.filter((s) => s !== "OVERDUE").map((s) => [s, null] as [TicketStatus, null]),
  ...TICKET_STATUSES.filter((s) => s !== "OVERDUE").map((b) => ["OVERDUE", b] as [TicketStatus, TicketStatus]),
];
const ACTORS: ActorKind[] = ["CUSTOMER", "OWNER", "ADMIN", "SYSTEM"];

describe("every transition function: allowed ones call their rpc, forbidden ones are refused", () => {
  for (const action of TICKET_ACTIONS) {
    it(action, async () => {
      let allowedSomewhere = false;
      for (const [status, before] of STATES) {
        for (const actor of ACTORS) {
          const rpc = vi.fn<Rpc>(async () => ({}));
          const t = ticket(status, before);
          const label = `${action} by ${actor} on ${status}${before ? ` (from ${before})` : ""}`;
          if (canPerform(action, actor, { status, statusBeforeOverdue: before })) {
            allowedSomewhere = true;
            await CASES[action].call(rpc, ACTOR[actor], t);
            expect(rpc, label).toHaveBeenCalledTimes(1);
            expect(rpc.mock.calls[0][0], label).toBe(CASES[action].rpc);
          } else {
            await expect(CASES[action].call(rpc, ACTOR[actor], t), label).rejects.toBeInstanceOf(TransitionError);
            expect(rpc, label).not.toHaveBeenCalled();
          }
        }
      }
      expect(allowedSomewhere).toBe(true);
    });
  }
});

describe("tenant, reason and input checks", () => {
  it("an owner or customer of another ticket is refused before any rpc", async () => {
    const rpc = vi.fn(async () => ({}));
    await expect(T.cancelTicket(rpc, { kind: "USER", id: OTHER, role: "OWNER" }, ticket("METER_REQUESTED"), { reason: "x" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(T.submitReading(rpc, { kind: "USER", id: OTHER, role: "CUSTOMER" }, ticket("METER_REQUESTED"), reading)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("TKT-10: cancel and reopen need a reason", async () => {
    const rpc = vi.fn(async () => ({}));
    await expect(T.cancelTicket(rpc, ACTOR.OWNER, ticket("METER_REQUESTED"), { reason: "   " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(T.reopenTicket(rpc, ACTOR.OWNER, ticket("CLOSED"), { reason: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(T.rejectReading(rpc, ACTOR.OWNER, ticket("PENDING_OWNER_REVIEW"), { submissionId: ID, reason: "", stageDueAt: NOW, photoExpiresAt: NOW })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a customer reading needs a live photo; a manual entry needs a note", async () => {
    const rpc = vi.fn(async () => ({}));
    await expect(T.submitReading(rpc, ACTOR.CUSTOMER, ticket("METER_REQUESTED"), { ...reading, photo: null })).rejects.toThrow(/photo/);
    await expect(T.enterReadingManually(rpc, ACTOR.OWNER, ticket("METER_REQUESTED"), { ...reading, note: undefined })).rejects.toThrow(/note/);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("only the daily job opens cycles", async () => {
    const rpc = vi.fn(async () => ({ ticket_id: ID }));
    const input = { agreementId: ID, cycleNo: 1, ownerId: OWNER, customerId: CUSTOMER, stageDueAt: NOW, now: NOW };
    await expect(T.openCycle(rpc, ACTOR.OWNER, input)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await T.openCycle(rpc, T.SYSTEM, input);
    expect(rpc).toHaveBeenCalledWith("rpc_open_billing_cycle", expect.objectContaining({ p_cycle_no: 1, p_now: NOW.toISOString() }));
  });
});

describe("rpc arguments and hand-over notifications (TKT-04)", () => {
  it("submitting a reading notifies the owner and passes the photo and idempotency key", async () => {
    const rpc = vi.fn<Rpc>(async () => ({}));
    await T.submitReading(rpc, ACTOR.CUSTOMER, ticket("METER_REQUESTED"), reading);
    const args = rpc.mock.calls[0][1];
    expect(args).toMatchObject({ p_source: "CUSTOMER", p_actor_id: CUSTOMER, p_idempotency_key: ID, p_photo: { storage_path: `${OWNER}/${ID}/p.jpg` } });
    expect(args.p_notifications).toEqual([expect.objectContaining({ user_id: OWNER, event: "meter.submitted", channel: "IN_APP", link: "/owner/tickets/{entity_id}" })]);
  });

  it("an accepted payment that covers the balance sends a receipt; less sends the balance", async () => {
    const rpc = vi.fn<Rpc>(async () => ({}));
    await T.acceptPayment(rpc, ACTOR.OWNER, ticket("PAYMENT_SUBMITTED"), { paymentId: ID, acceptedAmountCents: 500_000, balanceCents: 500_000, stageDueAt: NOW });
    await T.acceptPayment(rpc, ACTOR.OWNER, ticket("PAYMENT_SUBMITTED"), { paymentId: ID, acceptedAmountCents: 200_000, balanceCents: 500_000, stageDueAt: NOW });
    expect((rpc.mock.calls[0][1].p_notifications as { event: string }[])[0].event).toBe("payment.receipt");
    const partial = (rpc.mock.calls[1][1].p_notifications as { event: string; title: string; body: string }[])[0];
    expect(partial.event).toBe("payment.partial");
    expect(partial.body).toContain("Rs. 3,000");
  });

  it("clearing an overdue payment goes back where it came from, with the new due date", async () => {
    const rpc = vi.fn<Rpc>(async () => ({}));
    await T.clearOverdue(rpc, ACTOR.OWNER, ticket("OVERDUE", "PARTIALLY_PAID"), { reason: "Agreed", dueDate: "2026-10-20", stageDueAt: NOW });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_from: "OVERDUE", p_to: "PARTIALLY_PAID", p_due_date: "2026-10-20", p_reason: "Agreed" });
  });

  it("marking overdue alerts the customer and the owner, by stage", async () => {
    const rpc = vi.fn<Rpc>(async () => ({}));
    await T.markOverdue(rpc, T.SYSTEM, ticket("METER_REQUESTED"), { now: NOW, reminderNo: 0, escalationLevel: 1 });
    await T.markOverdue(rpc, T.SYSTEM, ticket("AWAITING_PAYMENT"), { now: NOW, reminderNo: 1, escalationLevel: 1 });
    const events = rpc.mock.calls.map((c) => (c[1].p_notifications as { event: string }[]).map((n) => n.event));
    expect(events).toEqual([
      ["ticket.meter_overdue", "ticket.meter_missed"],
      ["payment.overdue", "payment.overdue_owner"],
    ]);
  });
});
