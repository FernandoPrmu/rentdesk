import type { IsoDate } from "../agreements/cycle-calendar.ts";
import { colomboDate, lastDayBefore } from "./deadlines.ts";
import { isMeterStage, isPaymentStage, responsibleParty, type TicketStatus } from "./states.ts";

/**
 * What the ticket screens show (TKT-06, CP-01, CP-02): the next step and who
 * takes it, the deadline, and the overdue / escalated / paused flags. Pure, so
 * the customer Home rules are unit-tested.
 * Only relative imports.
 */

export interface TicketViewInvoice {
  invoice_no: string | null;
  type: "NORMAL" | "ESTIMATED";
  status: string;
  due_date: IsoDate | null;
  total_cents: number;
  amount_paid_cents: number;
}

export interface TicketView {
  status: TicketStatus;
  status_before_overdue: TicketStatus | null;
  stage_due_at: string | null;
  escalation_level: number;
  paused_at: string | null;
  invoice: TicketViewInvoice | null;
}

const state = (t: TicketView) => ({ status: t.status, statusBeforeOverdue: t.status_before_overdue });

export interface TicketFlags {
  overdue: boolean;
  escalated: boolean;
  paused: boolean;
}

export function ticketFlags(t: TicketView, now: Date): TicketFlags {
  const meterLate = isMeterStage(state(t)) && t.stage_due_at !== null && new Date(t.stage_due_at).getTime() <= now.getTime();
  const payLate =
    isPaymentStage(state(t)) && t.invoice?.due_date != null && t.invoice.amount_paid_cents < t.invoice.total_cents && colomboDate(now) > t.invoice.due_date;
  return {
    overdue: t.status === "OVERDUE" || meterLate || payLate,
    escalated: t.escalation_level > 0 && t.status !== "CLOSED" && t.status !== "CANCELLED",
    paused: t.paused_at !== null,
  };
}

/** The next step, in plain words, and who takes it (spec 5.3 "Responsible"). */
export function nextStep(t: TicketView): { who: "CUSTOMER" | "OWNER" | null; label: string } {
  const who = responsibleParty(state(t));
  if (isMeterStage(state(t))) return { who, label: "Send the meter reading and photo" };
  if (isPaymentStage(state(t)) && t.status !== "REOPENED") return { who, label: "Pay and send the payment slip" };
  switch (t.status) {
    case "PENDING_OWNER_REVIEW":
      return { who, label: t.invoice?.type === "ESTIMATED" ? "Review the estimated invoice" : "Check the reading and confirm the invoice" };
    case "PAYMENT_SUBMITTED":
      return { who, label: "Check the payment slip" };
    case "DISPUTED":
      return { who, label: "Answer the dispute" };
    case "REOPENED":
      return { who, label: "Ask for the payment again" };
    case "CLOSED":
      return { who, label: "Paid and closed" };
    default:
      return { who, label: "Cancelled" };
  }
}

/** The deadline of the current step: a last day (customer steps) or a moment (owner reviews). */
export type Due = { kind: "day"; date: IsoDate } | { kind: "moment"; at: string };

export function currentDue(t: TicketView): Due | null {
  if (isMeterStage(state(t))) return t.stage_due_at ? { kind: "day", date: lastDayBefore(new Date(t.stage_due_at)) } : null;
  if (isPaymentStage(state(t))) return t.invoice?.due_date ? { kind: "day", date: t.invoice.due_date } : null;
  if ((t.status === "PENDING_OWNER_REVIEW" || t.status === "PAYMENT_SUBMITTED") && t.stage_due_at) return { kind: "moment", at: t.stage_due_at };
  return null;
}

// -----------------------------------------------------------------------------
// Customer Home: "What you need to do now" (CP-01, CP-02)
// -----------------------------------------------------------------------------

export interface CustomerTicketRow extends TicketView {
  id: string;
  agreement_id: string;
  cycle_no: number;
  cycle_date: IsoDate;
  machine: string;
  /** Highest cycle with a confirmed reading for this agreement (0 = none yet). */
  last_confirmed_cycle: number;
}

export type CustomerTask =
  | {
      kind: "METER";
      ticketId: string;
      machine: string;
      /** Months the reading covers (rule 12): every cycle since the last confirmed reading. */
      months: number;
      dueDate: IsoDate | null;
      overdue: boolean;
    }
  | {
      kind: "PAY";
      ticketId: string;
      machine: string;
      invoiceNo: string | null;
      amountCents: number;
      dueDate: IsoDate | null;
      overdue: boolean;
    };

export interface CustomerHome {
  tasks: CustomerTask[];
  /** Tickets with the rental company (reading or slip being checked, a dispute). */
  waiting: { ticketId: string; machine: string; label: string }[];
}

const WAITING_LABEL: Partial<Record<TicketStatus, string>> = {
  PENDING_OWNER_REVIEW: "Your reading is being checked",
  PAYMENT_SUBMITTED: "Your payment slip is being checked",
  DISPUTED: "Your dispute is being looked at",
  REOPENED: "Your rental company reopened this bill",
};

/**
 * One "Enter meter reading" task per machine: the newest ticket still waiting for a
 * reading, covering every month since the last confirmed reading (older tickets are
 * closed by that reading, rule 25). One "Pay" task per unpaid bill.
 */
export function customerHome(rows: CustomerTicketRow[], now: Date): CustomerHome {
  const tasks: CustomerTask[] = [];
  const waiting: CustomerHome["waiting"] = [];
  const meterByAgreement = new Map<string, CustomerTicketRow[]>();

  for (const r of rows) {
    if (r.status === "CLOSED" || r.status === "CANCELLED") continue;
    if (isMeterStage(state(r))) {
      meterByAgreement.set(r.agreement_id, [...(meterByAgreement.get(r.agreement_id) ?? []), r]);
    } else if (isPaymentStage(state(r)) && r.status !== "REOPENED" && r.invoice) {
      const amountCents = r.invoice.total_cents - r.invoice.amount_paid_cents;
      if (amountCents <= 0) continue;
      tasks.push({
        kind: "PAY",
        ticketId: r.id,
        machine: r.machine,
        invoiceNo: r.invoice.invoice_no,
        amountCents,
        dueDate: r.invoice.due_date,
        overdue: ticketFlags(r, now).overdue,
      });
    } else if (WAITING_LABEL[r.status]) {
      waiting.push({ ticketId: r.id, machine: r.machine, label: WAITING_LABEL[r.status]! });
    }
  }

  for (const group of meterByAgreement.values()) {
    const newest = group.reduce((a, b) => (b.cycle_no > a.cycle_no ? b : a));
    const due = currentDue(newest);
    tasks.push({
      kind: "METER",
      ticketId: newest.id,
      machine: newest.machine,
      months: Math.max(1, newest.cycle_no - newest.last_confirmed_cycle),
      dueDate: due?.kind === "day" ? due.date : null,
      overdue: group.some((r) => ticketFlags(r, now).overdue),
    });
  }

  // Overdue first, then the nearest deadline.
  tasks.sort((a, b) => Number(b.overdue) - Number(a.overdue) || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  return { tasks, waiting };
}
