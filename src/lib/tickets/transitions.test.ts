import { describe, expect, it, vi } from "vitest";

import { type ActorKind, canPerform, REQUESTED_ACTIONS, TICKET_STATUSES, type TicketAction, type TicketStatus } from "./states";
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
const details = { amountCents: 500_000, paidOn: "2026-10-09", method: "BANK_TRANSFER" as const, reference: "TRX-1" };
const slip = { storagePath: `${OWNER}/${CUSTOMER}/${ID}.pdf`, sha256: "a".repeat(64), mimeType: "application/pdf" as const, sizeBytes: 10 };
const payment = { idempotencyKey: ID, invoiceIds: [ID], payment: details, slip, stageDueAt: NOW, context: { invoiceNos: ["INV-000007"] } };

/** Each action: its function, a valid input, and the rpc it must call. */
const CASES: Record<Exclude<TicketAction, "paymentWithdrawn">, { call: (rpc: Rpc, actor: Actor, t: TicketSnapshot) => Promise<unknown>; rpc: string }> = {
  submitReading: { call: (r, a, t) => T.submitReading(r, a, t, reading), rpc: "rpc_submit_meter_reading" },
  enterReadingManually: { call: (r, a, t) => T.enterReadingManually(r, a, t, reading), rpc: "rpc_submit_meter_reading" },
  createEstimate: { call: (r, a, t) => T.createEstimate(r, a, t, { invoice: { ...invoice, type: "ESTIMATED" }, stageDueAt: NOW, now: NOW }), rpc: "rpc_create_estimated_invoice" },
  confirmInvoice: { call: (r, a, t) => T.confirmInvoice(r, a, t, { submissionId: ID, dueDate: "2026-10-17", stageDueAt: NOW, totalCents: 1 }), rpc: "rpc_confirm_meter_submission" },
  correctReading: {
    call: (r, a, t) => T.correctReading(r, a, t, { submissionId: ID, readings: reading.readings, invoice, note: "Customer typed 8 for 3", changes: "B&W 1 → 2" }),
    rpc: "rpc_correct_meter_reading",
  },
  rejectReading: { call: (r, a, t) => T.rejectReading(r, a, t, { submissionId: ID, reason: "Photo blurry", stageDueAt: NOW, photoExpiresAt: NOW }), rpc: "rpc_reject_meter_submission" },
  submitSlip: { call: (r, a, t) => T.submitSlip(r, a, [t], payment), rpc: "rpc_submit_payment" },
  recordPayment: {
    call: (r, a, t) => T.recordPayment(r, a, [t], { customerId: CUSTOMER, idempotencyKey: ID, invoiceIds: [ID], payment: { ...details, method: "CASH" } }),
    rpc: "rpc_record_manual_payment",
  },
  acceptPayment: {
    call: (r, a, t) => T.acceptPayment(r, a, [t], { paymentId: ID, acceptedAmountCents: 500_000, outcome: { balanceCents: 0, creditCents: 0 } }),
    rpc: "rpc_verify_payment",
  },
  rejectPayment: { call: (r, a, t) => T.rejectPayment(r, a, [t], { paymentId: ID, reason: "Wrong amount" }), rpc: "rpc_verify_payment" },
  reversePayment: {
    call: (r, a, t) => T.reversePayment(r, a, [t], { paymentId: ID, customerId: CUSTOMER, reason: "Cheque returned", amountCents: 500_000 }),
    rpc: "rpc_reverse_payment",
  },
  reallocatePayment: {
    call: (r, a, t) => T.reallocatePayment(r, a, [t], { paymentId: ID, customerId: CUSTOMER, invoiceIds: [ID], reason: "Wrong bill", amountCents: 500_000 }),
    rpc: "rpc_reallocate_payment",
  },
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
  for (const action of REQUESTED_ACTIONS as Exclude<TicketAction, "paymentWithdrawn">[]) {
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

  it("an accepted payment that covers its bills sends the receipt; less sends the balance", async () => {
    const rpc = vi.fn<Rpc>(async () => ({}));
    const context = { invoiceNos: ["INV-000007", "INV-000009"] };
    await T.acceptPayment(rpc, ACTOR.OWNER, [ticket("PAYMENT_SUBMITTED")], { paymentId: ID, acceptedAmountCents: 500_000, outcome: { balanceCents: 0, creditCents: 25_000 }, context });
    await T.acceptPayment(rpc, ACTOR.OWNER, [ticket("PAYMENT_SUBMITTED")], { paymentId: ID, acceptedAmountCents: 200_000, outcome: { balanceCents: 300_000, creditCents: 0 }, context });
    const receipt = (rpc.mock.calls[0][1].p_notifications as { event: string; body: string; link: string; user_id: string }[])[0];
    expect(receipt).toMatchObject({ event: "payment.receipt", user_id: CUSTOMER, link: "/customer/payments/{entity_id}" });
    expect(receipt.body).toContain("Bills INV-000007, INV-000009 are paid");
    expect(receipt.body).toContain("Rs. 250 is kept as credit");
    const partial = (rpc.mock.calls[1][1].p_notifications as { event: string; title: string; body: string }[])[0];
    expect(partial.event).toBe("payment.partial");
    expect(partial.body).toContain("Rs. 3,000 is still to pay");
    expect(rpc.mock.calls[1][1]).toMatchObject({ p_payment_id: ID, p_accept: true, p_accepted_amount_cents: 200_000 });
  });

  it("a slip goes to the owner with every bill; the bills of two customers are refused", async () => {
    const rpc = vi.fn<Rpc>(async () => ({}));
    const other = { ...ticket("AWAITING_PAYMENT"), id: OTHER };
    await T.submitSlip(rpc, ACTOR.CUSTOMER, [ticket("AWAITING_PAYMENT"), other], { ...payment, invoiceIds: [ID, OTHER] });
    const args = rpc.mock.calls[0][1];
    expect(args).toMatchObject({ p_customer_id: CUSTOMER, p_invoice_ids: [ID, OTHER], p_payment: { amount_cents: 500_000, method: "BANK_TRANSFER", reference: "TRX-1" } });
    expect(args.p_notifications).toEqual([expect.objectContaining({ user_id: OWNER, event: "payment.submitted", link: "/owner/payments/{entity_id}" })]);
    await expect(T.submitSlip(rpc, ACTOR.CUSTOMER, [ticket("AWAITING_PAYMENT"), { ...other, customer_id: OTHER }], payment)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(T.submitSlip(rpc, ACTOR.CUSTOMER, [], payment)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // The customer names only the slip methods.
    await expect(T.submitSlip(rpc, ACTOR.CUSTOMER, [ticket("AWAITING_PAYMENT")], { ...payment, payment: { ...details, method: "CASH" as never } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("an advance needs no bill; reversal and reallocation need a reason", async () => {
    const rpc = vi.fn<Rpc>(async () => ({}));
    await T.recordPayment(rpc, ACTOR.OWNER, [], { customerId: CUSTOMER, idempotencyKey: ID, payment: { ...details, method: "CASH" }, outcome: { creditCents: 500_000 } });
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_invoice_ids: [], p_customer_id: CUSTOMER });
    expect((rpc.mock.calls[0][1].p_notifications as { body: string }[])[0].body).toContain("Rs. 5,000 is kept as credit");
    await expect(T.recordPayment(rpc, ACTOR.CUSTOMER, [], { customerId: CUSTOMER, idempotencyKey: ID, payment: { ...details, method: "CASH" } })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(T.reversePayment(rpc, ACTOR.OWNER, [ticket("CLOSED")], { paymentId: ID, customerId: CUSTOMER, reason: " ", amountCents: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(T.reallocatePayment(rpc, ACTOR.OWNER, [ticket("CLOSED")], { paymentId: ID, customerId: CUSTOMER, invoiceIds: [], reason: "", amountCents: 1 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    // A ticket with a slip waiting or a dispute cannot have its payment reversed.
    await expect(T.reversePayment(rpc, ACTOR.OWNER, [ticket("PAYMENT_SUBMITTED")], { paymentId: ID, customerId: CUSTOMER, reason: "x", amountCents: 1 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(T.reversePayment(rpc, ACTOR.OWNER, [ticket("DISPUTED")], { paymentId: ID, customerId: CUSTOMER, reason: "x", amountCents: 1 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(rpc).toHaveBeenCalledTimes(1);
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
