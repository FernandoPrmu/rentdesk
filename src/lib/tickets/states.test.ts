import { describe, expect, it } from "vitest";

import {
  ACTIONS,
  canPerform,
  isMeterStage,
  isPaymentStage,
  refusal,
  responsibleParty,
  TICKET_ACTIONS,
  TICKET_STATUSES,
  type TicketState,
  type TicketStatus,
  transitionAllowed,
  TRANSITIONS,
} from "./states";

/** Every state a ticket can be in: each status, and OVERDUE from each status. */
const ALL_STATES: TicketState[] = [
  ...TICKET_STATUSES.filter((s) => s !== "OVERDUE").map((status) => ({ status, statusBeforeOverdue: null })),
  ...TICKET_STATUSES.filter((s) => s !== "OVERDUE").map((before) => ({ status: "OVERDUE" as const, statusBeforeOverdue: before })),
];

describe("transition table (spec 5.3, section 11)", () => {
  it("spec 5.3: the happy path is allowed", () => {
    const path: TicketStatus[] = ["METER_REQUESTED", "PENDING_OWNER_REVIEW", "AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "CLOSED"];
    for (let i = 0; i < path.length - 1; i++) expect(transitionAllowed(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`).toBe(true);
  });

  it("spec 5.3: the side paths are allowed", () => {
    expect(transitionAllowed("PENDING_OWNER_REVIEW", "METER_REQUESTED")).toBe(true); // reject
    expect(transitionAllowed("PAYMENT_SUBMITTED", "AWAITING_PAYMENT")).toBe(true); // slip rejected
    expect(transitionAllowed("PAYMENT_SUBMITTED", "PARTIALLY_PAID")).toBe(true);
    expect(transitionAllowed("PARTIALLY_PAID", "PAYMENT_SUBMITTED")).toBe(true);
    expect(transitionAllowed("DISPUTED", "AWAITING_PAYMENT")).toBe(true);
    expect(transitionAllowed("DISPUTED", "CANCELLED")).toBe(true);
    expect(transitionAllowed("CLOSED", "REOPENED")).toBe(true);
    expect(transitionAllowed("REOPENED", "AWAITING_PAYMENT")).toBe(true);
  });

  it("final and forbidden moves are refused", () => {
    for (const to of TICKET_STATUSES) expect(transitionAllowed("CANCELLED", to)).toBe(false);
    expect(transitionAllowed("CLOSED", "AWAITING_PAYMENT")).toBe(false);
    expect(transitionAllowed("METER_REQUESTED", "AWAITING_PAYMENT")).toBe(false); // no skipping the review
    expect(transitionAllowed("PENDING_OWNER_REVIEW", "CLOSED")).toBe(false); // never automatic (11.1)
    expect(transitionAllowed("PAYMENT_SUBMITTED", "OVERDUE")).toBe(false); // 8.2: not overdue while a slip waits
    expect(transitionAllowed("PAYMENT_SUBMITTED", "CANCELLED")).toBe(false);
    for (const s of TICKET_STATUSES) expect(transitionAllowed(s, s), s).toBe(false);
  });

  it("every action moves along an allowed edge", () => {
    for (const action of TICKET_ACTIONS) {
      const rule = ACTIONS[action];
      const froms: TicketStatus[] = [...rule.from, ...((rule as { overdueFrom?: readonly TicketStatus[] }).overdueFrom?.length ? ["OVERDUE" as const] : [])];
      for (const from of froms) {
        for (const to of rule.to) expect(transitionAllowed(from, to), `${action}: ${from} -> ${to}`).toBe(true);
      }
    }
  });

  it("every allowed edge is produced by at least one action", () => {
    for (const from of TICKET_STATUSES) {
      for (const to of TRANSITIONS[from]) {
        const producers = TICKET_ACTIONS.filter((a) => {
          const rule = ACTIONS[a] as { from: readonly TicketStatus[]; overdueFrom?: readonly TicketStatus[]; to: readonly TicketStatus[] };
          const fromOk = from === "OVERDUE" ? (rule.overdueFrom?.length ?? 0) > 0 : rule.from.includes(from);
          return fromOk && rule.to.includes(to);
        });
        expect(producers.length, `${from} -> ${to}`).toBeGreaterThan(0);
      }
    }
  });
});

describe("who may act (refusal)", () => {
  it("customers act only on their own stages", () => {
    const meter = { status: "METER_REQUESTED" as const, statusBeforeOverdue: null };
    expect(canPerform("submitReading", "CUSTOMER", meter)).toBe(true);
    expect(canPerform("submitReading", "OWNER", meter)).toBe(false);
    expect(canPerform("confirmInvoice", "CUSTOMER", { status: "PENDING_OWNER_REVIEW", statusBeforeOverdue: null })).toBe(false);
    expect(canPerform("cancelTicket", "CUSTOMER", meter)).toBe(false);
  });

  it("admins never act on a ticket; the system only opens, flags overdue and estimates", () => {
    for (const state of ALL_STATES) {
      for (const action of TICKET_ACTIONS) {
        expect(canPerform(action, "ADMIN", state), `${action} ${state.status}`).toBe(false);
        if (canPerform(action, "SYSTEM", state)) expect(["markOverdue", "createEstimate"]).toContain(action);
      }
    }
  });

  it("an overdue ticket returns to the flow it came from", () => {
    const meterOverdue = { status: "OVERDUE" as const, statusBeforeOverdue: "METER_REQUESTED" as const };
    const payOverdue = { status: "OVERDUE" as const, statusBeforeOverdue: "AWAITING_PAYMENT" as const };
    expect(canPerform("submitReading", "CUSTOMER", meterOverdue)).toBe(true);
    expect(canPerform("submitSlip", "CUSTOMER", meterOverdue)).toBe(false);
    expect(canPerform("submitSlip", "CUSTOMER", payOverdue)).toBe(true);
    expect(canPerform("submitReading", "CUSTOMER", payOverdue)).toBe(false);
    expect(canPerform("clearOverdue", "OWNER", payOverdue)).toBe(true);
    expect(canPerform("clearOverdue", "OWNER", meterOverdue)).toBe(false);
    expect(canPerform("markOverdue", "SYSTEM", payOverdue)).toBe(false);
  });

  it("explains why", () => {
    expect(refusal("reopenTicket", "OWNER", { status: "AWAITING_PAYMENT", statusBeforeOverdue: null })).toMatch(/while the ticket is AWAITING_PAYMENT/);
    expect(refusal("reopenTicket", "CUSTOMER", { status: "CLOSED", statusBeforeOverdue: null })).toMatch(/not allowed for customer/);
  });
});

describe("stage helpers", () => {
  it("spec 5.3 responsible party", () => {
    expect(responsibleParty({ status: "METER_REQUESTED", statusBeforeOverdue: null })).toBe("CUSTOMER");
    expect(responsibleParty({ status: "PENDING_OWNER_REVIEW", statusBeforeOverdue: null })).toBe("OWNER");
    expect(responsibleParty({ status: "DISPUTED", statusBeforeOverdue: null })).toBe("OWNER");
    expect(responsibleParty({ status: "REOPENED", statusBeforeOverdue: null })).toBe("OWNER");
    expect(responsibleParty({ status: "OVERDUE", statusBeforeOverdue: "AWAITING_PAYMENT" })).toBe("CUSTOMER");
    expect(responsibleParty({ status: "CLOSED", statusBeforeOverdue: null })).toBeNull();
  });

  it("meter and payment stages include their overdue form", () => {
    expect(isMeterStage({ status: "OVERDUE", statusBeforeOverdue: "METER_REQUESTED" })).toBe(true);
    expect(isMeterStage({ status: "OVERDUE", statusBeforeOverdue: "PARTIALLY_PAID" })).toBe(false);
    expect(isPaymentStage({ status: "OVERDUE", statusBeforeOverdue: "PARTIALLY_PAID" })).toBe(true);
    expect(isPaymentStage({ status: "PAYMENT_SUBMITTED", statusBeforeOverdue: null })).toBe(false);
  });
});
