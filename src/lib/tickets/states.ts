/**
 * Billing cycle ticket state machine (spec 5.3 and section 11, TKT-03). Pure data
 * and checks: the transition functions (transitions.ts) and the daily job use it
 * before calling the atomic rpc functions, which check the same rules again under
 * the ticket lock (app.ticket_transition_allowed, migration 0008).
 * Only relative imports: DB tests and scripts import it under plain Node.
 */

export const TICKET_STATUSES = [
  "METER_REQUESTED",
  "PENDING_OWNER_REVIEW",
  "AWAITING_PAYMENT",
  "PAYMENT_SUBMITTED",
  "CLOSED",
  "OVERDUE",
  "PARTIALLY_PAID",
  "DISPUTED",
  "CANCELLED",
  "REOPENED",
] as const;

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** Every allowed status change. Must equal app.ticket_transition_allowed (DB test). */
export const TRANSITIONS: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  METER_REQUESTED: ["PENDING_OWNER_REVIEW", "OVERDUE", "CANCELLED"],
  PENDING_OWNER_REVIEW: ["AWAITING_PAYMENT", "METER_REQUESTED", "CANCELLED"],
  AWAITING_PAYMENT: ["PAYMENT_SUBMITTED", "OVERDUE", "DISPUTED", "CANCELLED"],
  PAYMENT_SUBMITTED: ["CLOSED", "AWAITING_PAYMENT", "PARTIALLY_PAID"],
  PARTIALLY_PAID: ["PAYMENT_SUBMITTED", "OVERDUE", "DISPUTED", "CANCELLED"],
  OVERDUE: ["PENDING_OWNER_REVIEW", "AWAITING_PAYMENT", "PARTIALLY_PAID", "PAYMENT_SUBMITTED", "DISPUTED", "CANCELLED"],
  DISPUTED: ["AWAITING_PAYMENT", "CANCELLED"],
  CLOSED: ["REOPENED"],
  REOPENED: ["AWAITING_PAYMENT", "OVERDUE"],
  CANCELLED: [],
};

export function transitionAllowed(from: TicketStatus, to: TicketStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Who triggers a transition. SYSTEM is the daily job. */
export type ActorKind = "CUSTOMER" | "OWNER" | "ADMIN" | "SYSTEM";

/** The ticket's status, and where an OVERDUE ticket came from. */
export interface TicketState {
  status: TicketStatus;
  statusBeforeOverdue: TicketStatus | null;
}

/** Statuses that wait for the customer's meter reading (an overdue one included). */
export const METER_STAGE: readonly TicketStatus[] = ["METER_REQUESTED"];
/** Statuses where the customer owes money on an issued invoice. */
export const PAYMENT_STAGE: readonly TicketStatus[] = ["AWAITING_PAYMENT", "PARTIALLY_PAID", "REOPENED"];

export interface ActionRule {
  /** Plain-language name for messages. */
  label: string;
  actors: readonly ActorKind[];
  /** Statuses the action starts from (not OVERDUE: see overdueFrom). */
  from: readonly TicketStatus[];
  /** Also from OVERDUE, when the ticket became overdue from one of these. */
  overdueFrom?: readonly TicketStatus[];
  /** Possible results (the rpc picks one, e.g. paid in full or partly); none = the status stays. */
  to: readonly TicketStatus[];
  /** A reason (or note) is mandatory. */
  reason?: boolean;
}

/**
 * Every action on a ticket and who may take it (spec 5.2, 5.3, 11). Each edge of
 * TRANSITIONS is produced by at least one action (unit test).
 */
export const ACTIONS = {
  submitReading: {
    label: "Submit the meter reading",
    actors: ["CUSTOMER"],
    from: ["METER_REQUESTED"],
    overdueFrom: ["METER_REQUESTED"],
    to: ["PENDING_OWNER_REVIEW"],
  },
  enterReadingManually: {
    label: "Enter the reading for the customer",
    actors: ["OWNER"],
    from: ["METER_REQUESTED"],
    overdueFrom: ["METER_REQUESTED"],
    to: ["PENDING_OWNER_REVIEW"],
    reason: true,
  },
  createEstimate: {
    label: "Create an estimated invoice",
    actors: ["SYSTEM"],
    from: ["METER_REQUESTED"],
    overdueFrom: ["METER_REQUESTED"],
    to: ["PENDING_OWNER_REVIEW"],
  },
  confirmInvoice: {
    label: "Confirm the invoice",
    actors: ["OWNER"],
    from: ["PENDING_OWNER_REVIEW"],
    to: ["AWAITING_PAYMENT"],
  },
  correctReading: {
    label: "Correct the reading",
    actors: ["OWNER"],
    from: ["PENDING_OWNER_REVIEW"],
    // Stays with the owner: the draft is recalculated, the status does not change.
    to: [],
    reason: true,
  },
  rejectReading: {
    label: "Reject the reading",
    actors: ["OWNER"],
    from: ["PENDING_OWNER_REVIEW"],
    to: ["METER_REQUESTED"],
    reason: true,
  },
  submitSlip: {
    label: "Submit the payment slip",
    actors: ["CUSTOMER"],
    from: ["AWAITING_PAYMENT", "PARTIALLY_PAID"],
    overdueFrom: PAYMENT_STAGE,
    to: ["PAYMENT_SUBMITTED"],
  },
  recordPayment: {
    label: "Record a cash or cheque payment",
    actors: ["OWNER"],
    from: ["AWAITING_PAYMENT", "PARTIALLY_PAID"],
    overdueFrom: PAYMENT_STAGE,
    to: ["PAYMENT_SUBMITTED"],
  },
  acceptPayment: {
    label: "Accept the payment",
    actors: ["OWNER"],
    from: ["PAYMENT_SUBMITTED"],
    to: ["CLOSED", "PARTIALLY_PAID"],
  },
  rejectPayment: {
    label: "Reject the payment",
    actors: ["OWNER"],
    from: ["PAYMENT_SUBMITTED"],
    to: ["AWAITING_PAYMENT", "PARTIALLY_PAID"],
    reason: true,
  },
  markOverdue: {
    label: "Mark overdue",
    actors: ["SYSTEM"],
    from: ["METER_REQUESTED", ...PAYMENT_STAGE],
    to: ["OVERDUE"],
  },
  clearOverdue: {
    label: "Give a new due date",
    actors: ["OWNER"],
    from: [],
    overdueFrom: PAYMENT_STAGE,
    to: ["AWAITING_PAYMENT", "PARTIALLY_PAID"],
    reason: true,
  },
  raiseDispute: {
    label: "Dispute the invoice",
    actors: ["CUSTOMER"],
    from: ["AWAITING_PAYMENT", "PARTIALLY_PAID"],
    overdueFrom: PAYMENT_STAGE,
    to: ["DISPUTED"],
    reason: true,
  },
  resolveDispute: {
    label: "Answer the dispute",
    actors: ["OWNER"],
    from: ["DISPUTED"],
    to: ["AWAITING_PAYMENT"],
    reason: true,
  },
  cancelTicket: {
    label: "Cancel the ticket",
    actors: ["OWNER"],
    from: ["METER_REQUESTED", "PENDING_OWNER_REVIEW", "AWAITING_PAYMENT", "PARTIALLY_PAID", "DISPUTED"],
    overdueFrom: ["METER_REQUESTED", ...PAYMENT_STAGE],
    to: ["CANCELLED"],
    reason: true,
  },
  reopenTicket: {
    label: "Reopen the ticket",
    actors: ["OWNER"],
    from: ["CLOSED"],
    to: ["REOPENED"],
    reason: true,
  },
  requestPaymentAgain: {
    label: "Ask for payment again",
    actors: ["OWNER"],
    from: ["REOPENED"],
    to: ["AWAITING_PAYMENT"],
  },
} as const satisfies Record<string, ActionRule>;

export type TicketAction = keyof typeof ACTIONS;
export const TICKET_ACTIONS = Object.keys(ACTIONS) as TicketAction[];

/** Why an action is refused, or null when it is allowed. */
export function refusal(action: TicketAction, actor: ActorKind, ticket: TicketState): string | null {
  const rule: ActionRule = ACTIONS[action];
  if (!rule.actors.includes(actor)) return `${rule.label}: not allowed for ${actor.toLowerCase()}`;
  const fromOk =
    ticket.status === "OVERDUE"
      ? ticket.statusBeforeOverdue !== null && (rule.overdueFrom ?? []).includes(ticket.statusBeforeOverdue)
      : rule.from.includes(ticket.status);
  if (!fromOk) return `${rule.label}: not possible while the ticket is ${ticket.status}`;
  return null;
}

export function canPerform(action: TicketAction, actor: ActorKind, ticket: TicketState): boolean {
  return refusal(action, actor, ticket) === null;
}

/** Spec 5.3 "Responsible": who must act next. */
export function responsibleParty(ticket: TicketState): "CUSTOMER" | "OWNER" | null {
  switch (ticket.status) {
    case "METER_REQUESTED":
    case "AWAITING_PAYMENT":
    case "PARTIALLY_PAID":
      return "CUSTOMER";
    case "PENDING_OWNER_REVIEW":
    case "PAYMENT_SUBMITTED":
    case "DISPUTED":
    case "REOPENED":
      return "OWNER";
    case "OVERDUE":
      return ticket.statusBeforeOverdue ? responsibleParty({ status: ticket.statusBeforeOverdue, statusBeforeOverdue: null }) : "CUSTOMER";
    case "CLOSED":
    case "CANCELLED":
      return null;
  }
}

/** Waiting for the customer's meter reading (also when overdue). */
export function isMeterStage(ticket: TicketState): boolean {
  return ticket.status === "METER_REQUESTED" || (ticket.status === "OVERDUE" && ticket.statusBeforeOverdue === "METER_REQUESTED");
}

/** The customer owes money on the issued invoice (also when overdue). */
export function isPaymentStage(ticket: TicketState): boolean {
  return (
    PAYMENT_STAGE.includes(ticket.status) ||
    (ticket.status === "OVERDUE" && ticket.statusBeforeOverdue !== null && PAYMENT_STAGE.includes(ticket.statusBeforeOverdue))
  );
}

export function isOpen(status: TicketStatus): boolean {
  return status !== "CLOSED" && status !== "CANCELLED";
}
