import { z } from "zod";

import type { InvoicePayload, MeterReadingRow } from "../billing/meter-invoice.ts";
import {
  customer,
  type NotificationContext,
  type NotificationItem,
  notificationsFor,
  owner,
} from "../notifications/service.ts";
import { ACTIONS, type ActorKind, refusal, type TicketAction, type TicketStatus } from "./states.ts";

/**
 * One function per ticket transition (spec 5.3, 11; TKT-03, TKT-09, TKT-10).
 * Each one validates its input (Zod), checks the actor's role, the ticket's
 * tenant and its current status against the state machine (states.ts), builds
 * the notifications for the hand-over (TKT-04), and only then calls the atomic
 * rpc. The rpc locks the ticket, checks everything again, writes the
 * ticket_events row (actor, from, to, reason) and the notifications in one
 * transaction.
 * Only relative imports: the daily job runs in DB tests under plain Node.
 */

/** Calls a public.rpc_* wrapper with named arguments; throws RpcError. */
export type Rpc = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export class RpcError extends Error {
  constructor(
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export type TransitionErrorCode = "FORBIDDEN" | "INVALID_STATE" | "INVALID_INPUT";

export class TransitionError extends Error {
  constructor(
    readonly code: TransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export type Actor = { kind: "SYSTEM" } | { kind: "USER"; id: string; role: "ADMIN" | "OWNER" | "CUSTOMER" };
export const SYSTEM: Actor = { kind: "SYSTEM" };

/** What the transition functions need to know about a ticket (loaded by the caller). */
export interface TicketSnapshot {
  id: string;
  owner_id: string;
  customer_id: string;
  cycle_no: number;
  status: TicketStatus;
  status_before_overdue: TicketStatus | null;
  machine_name?: string | null;
  customer_name?: string | null;
}

function actorKind(actor: Actor): ActorKind {
  return actor.kind === "SYSTEM" ? "SYSTEM" : actor.role;
}

function actorId(actor: Actor): string | null {
  return actor.kind === "SYSTEM" ? null : actor.id;
}

/** Role, tenant and status checks shared by every transition. */
export function assertTransition(action: TicketAction, actor: Actor, ticket: TicketSnapshot): void {
  const kind = actorKind(actor);
  const reason = refusal(action, kind, { status: ticket.status, statusBeforeOverdue: ticket.status_before_overdue });
  if (reason) {
    const forbidden = !(ACTIONS[action].actors as readonly ActorKind[]).includes(kind);
    throw new TransitionError(forbidden ? "FORBIDDEN" : "INVALID_STATE", reason);
  }
  if (actor.kind === "USER") {
    if (actor.role === "OWNER" && actor.id !== ticket.owner_id) throw new TransitionError("FORBIDDEN", "This ticket belongs to another owner");
    if (actor.role === "CUSTOMER" && actor.id !== ticket.customer_id) {
      throw new TransitionError("FORBIDDEN", "This ticket belongs to another customer");
    }
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new TransitionError("INVALID_INPUT", result.error.issues[0]?.message ?? "Invalid input");
  return result.data;
}

function context(ticket: TicketSnapshot, extra: NotificationContext = {}): NotificationContext {
  return {
    machine: ticket.machine_name ?? undefined,
    customer: ticket.customer_name ?? undefined,
    cycleNo: ticket.cycle_no,
    ...extra,
  };
}

const iso = (d: Date) => d.toISOString();
const reasonText = z.string().trim().min(1, "A reason is required").max(1000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-10-31");
const cents = z.number().int().nonnegative();
const positiveCents = z.number().int().positive();

// -----------------------------------------------------------------------------
// System (daily job)
// -----------------------------------------------------------------------------

const openSchema = z.object({
  agreementId: z.uuid(),
  cycleNo: z.number().int().positive(),
  ownerId: z.uuid(),
  customerId: z.uuid(),
  stageDueAt: z.date(),
  now: z.date(),
  context: z.custom<NotificationContext>().default({}),
});

/** TKT-01: open the next cycle (system only). Older tickets still waiting for a reading are flagged Overdue (11.6). */
export async function openCycle(rpc: Rpc, actor: Actor, input: z.input<typeof openSchema>) {
  if (actor.kind !== "SYSTEM") throw new TransitionError("FORBIDDEN", "Only the daily job opens billing cycles");
  const i = parse(openSchema, input);
  return (await rpc("rpc_open_billing_cycle", {
    p_agreement_id: i.agreementId,
    p_cycle_no: i.cycleNo,
    p_stage_due_at: iso(i.stageDueAt),
    p_now: iso(i.now),
    p_notifications: notificationsFor("ticket.opened", [customer(i.customerId)], i.context),
    p_overdue_notifications: notificationsFor("ticket.previous_overdue", [owner(i.ownerId)], i.context),
  })) as { ticket_id?: string; replayed?: boolean; skipped?: string; flagged_overdue?: number[] };
}

const overdueSchema = z.object({
  now: z.date(),
  reminderNo: z.number().int().min(0),
  escalationLevel: z.number().int().min(0).max(2),
  context: z.custom<NotificationContext>().default({}),
});

/** A customer stage missed its deadline: Overdue, customer reminded, owner alerted (5.4, 8.3). */
export async function markOverdue(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof overdueSchema>) {
  assertTransition("markOverdue", actor, ticket);
  const i = parse(overdueSchema, input);
  const meter = ticket.status === "METER_REQUESTED";
  const ctx = context(ticket, i.context);
  const notifications: NotificationItem[] = meter
    ? [...notificationsFor("ticket.meter_overdue", [customer(ticket.customer_id)], ctx), ...notificationsFor("ticket.meter_missed", [owner(ticket.owner_id)], ctx)]
    : [...notificationsFor("payment.overdue", [customer(ticket.customer_id)], ctx), ...notificationsFor("payment.overdue_owner", [owner(ticket.owner_id)], ctx)];
  return (await rpc("rpc_mark_ticket_overdue", {
    p_ticket_id: ticket.id,
    p_from: ticket.status,
    p_now: iso(i.now),
    p_reason: meter ? "Meter reading not received by the deadline" : "Invoice not paid by the due date",
    p_reminder_no: i.reminderNo,
    p_escalation_level: i.escalationLevel,
    p_notifications: notifications,
  })) as { status?: TicketStatus; skipped?: string };
}

/** rpc payload of an estimated invoice (commitment only, built by the billing engine). */
export type EstimatePayload = Omit<InvoicePayload, "type"> & { type: "ESTIMATED" };

const estimateSchema = z.object({
  invoice: z.custom<EstimatePayload>((v) => typeof v === "object" && v !== null && (v as { type?: string }).type === "ESTIMATED", {
    message: "An estimated invoice is required",
  }),
  stageDueAt: z.date(),
  now: z.date(),
  context: z.custom<NotificationContext>().default({}),
});

/** Spec 11.6: estimated invoice (draft) for the owner's review when the reading never came. */
export async function createEstimate(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof estimateSchema>) {
  assertTransition("createEstimate", actor, ticket);
  const i = parse(estimateSchema, input);
  return (await rpc("rpc_create_estimated_invoice", {
    p_ticket_id: ticket.id,
    p_invoice: i.invoice,
    p_stage_due_at: iso(i.stageDueAt),
    p_now: iso(i.now),
    p_notifications: notificationsFor("ticket.estimate_ready", [owner(ticket.owner_id)], context(ticket, { amountCents: i.invoice.total_cents, ...i.context })),
  })) as { invoice_id?: string; skipped?: string };
}

// -----------------------------------------------------------------------------
// Meter reading and owner review
// -----------------------------------------------------------------------------

const readingSchema = z.object({
  idempotencyKey: z.uuid(),
  readings: z.custom<MeterReadingRow[]>((v) => Array.isArray(v) && v.length > 0, { message: "The readings are required" }),
  invoice: z.custom<InvoicePayload>((v) => typeof v === "object" && v !== null, { message: "The invoice is required" }),
  anomalyFlag: z.enum(["HIGH", "LOW", "ZERO"]).nullable().default(null),
  photo: z.object({ storagePath: z.string().min(1), capturedAt: z.date().optional() }).nullable().default(null),
  note: z.string().trim().max(1000).optional(),
  stageDueAt: z.date(),
});

function readingArgs(ticket: TicketSnapshot, actor: Actor, i: z.output<typeof readingSchema>, source: "CUSTOMER" | "OWNER_MANUAL") {
  return {
    p_ticket_id: ticket.id,
    p_actor_id: actorId(actor),
    p_idempotency_key: i.idempotencyKey,
    p_source: source,
    p_readings: i.readings,
    p_photo: i.photo ? { storage_path: i.photo.storagePath, captured_at: i.photo.capturedAt ? iso(i.photo.capturedAt) : null } : null,
    p_invoice: i.invoice,
    p_stage_due_at: iso(i.stageDueAt),
    p_note: i.note ?? null,
    p_anomaly_flag: i.anomalyFlag,
    // The hand-over goes to whoever acts next: the owner reviews a customer's reading;
    // the customer is told when the owner entered it (INV-12).
    p_notifications:
      source === "CUSTOMER"
        ? notificationsFor("meter.submitted", [owner(ticket.owner_id)], context(ticket, { amountCents: i.invoice.total_cents, months: i.invoice.cycles_covered }))
        : notificationsFor("meter.entered", [customer(ticket.customer_id)], context(ticket, { reason: i.note })),
  };
}

/** Steps 2-3 (INV-01..06): the customer's reading and live photo; draft invoice to the owner. */
export async function submitReading(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof readingSchema>) {
  assertTransition("submitReading", actor, ticket);
  const i = parse(readingSchema, input);
  if (!i.photo) throw new TransitionError("INVALID_INPUT", "A live meter photo is required");
  return rpc("rpc_submit_meter_reading", readingArgs(ticket, actor, i, "CUSTOMER"));
}

/** INV-12: the owner types the reading for the customer, with a note. */
export async function enterReadingManually(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof readingSchema>) {
  assertTransition("enterReadingManually", actor, ticket);
  const i = parse(readingSchema, input);
  if (!i.note) throw new TransitionError("INVALID_INPUT", "A note is required");
  return rpc("rpc_submit_meter_reading", readingArgs(ticket, actor, i, "OWNER_MANUAL"));
}

const confirmSchema = z.object({
  /** null = the estimated draft invoice. */
  submissionId: z.uuid().nullable(),
  dueDate: isoDate,
  stageDueAt: z.date(),
  totalCents: cents,
  invoiceNo: z.string().nullable().optional(),
  brandingSnapshot: z.record(z.string(), z.unknown()).nullable().default(null),
  rolloverConfirmed: z.boolean().default(false),
});

/** Steps 4-5 (INV-07, INV-09): invoice numbered and issued; the photo is deleted after commit. */
export async function confirmInvoice(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof confirmSchema>) {
  assertTransition("confirmInvoice", actor, ticket);
  const i = parse(confirmSchema, input);
  return (await rpc("rpc_confirm_meter_submission", {
    p_ticket_id: ticket.id,
    p_submission_id: i.submissionId,
    p_actor_id: actorId(actor),
    p_due_date: i.dueDate,
    p_stage_due_at: iso(i.stageDueAt),
    p_branding_snapshot: i.brandingSnapshot,
    p_rollover_confirmed: i.rolloverConfirmed,
    p_notifications: notificationsFor(
      "invoice.issued",
      [customer(ticket.customer_id)],
      context(ticket, { amountCents: i.totalCents, dueDate: i.dueDate, invoiceNo: i.invoiceNo ?? null }),
    ),
  })) as { invoice_id: string; invoice_no: string; photo_paths: string[]; photo_ids: string[] };
}

const rejectReadingSchema = z.object({
  submissionId: z.uuid().nullable(),
  reason: reasonText,
  stageDueAt: z.date(),
  photoExpiresAt: z.date(),
  /** The rejection limit is reached (rule 28): the owner will enter the reading. */
  final: z.boolean().default(false),
});

/** INV-07 / 11.3: back to the customer with a mandatory reason. */
export async function rejectReading(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof rejectReadingSchema>) {
  assertTransition("rejectReading", actor, ticket);
  const i = parse(rejectReadingSchema, input);
  return rpc("rpc_reject_meter_submission", {
    p_ticket_id: ticket.id,
    p_submission_id: i.submissionId,
    p_actor_id: actorId(actor),
    p_reason: i.reason,
    p_stage_due_at: iso(i.stageDueAt),
    p_photo_expires_at: iso(i.photoExpiresAt),
    p_notifications: notificationsFor(i.final ? "meter.rejected_final" : "meter.rejected", [customer(ticket.customer_id)], context(ticket, { reason: i.reason })),
  });
}

const correctSchema = z.object({
  submissionId: z.uuid(),
  readings: z.custom<MeterReadingRow[]>((v) => Array.isArray(v) && v.length > 0, { message: "The readings are required" }),
  invoice: z.custom<InvoicePayload>((v) => typeof v === "object" && v !== null, { message: "The invoice is required" }),
  anomalyFlag: z.enum(["HIGH", "LOW", "ZERO"]).nullable().default(null),
  note: reasonText,
  /** "B&W 12,500 → 12,050" for the customer. */
  changes: z.string().min(1),
});

/** INV-08 / 11.3: the owner corrects a mistyped reading with a note; the draft is recalculated, the customer told. */
export async function correctReading(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof correctSchema>) {
  assertTransition("correctReading", actor, ticket);
  const i = parse(correctSchema, input);
  return (await rpc("rpc_correct_meter_reading", {
    p_ticket_id: ticket.id,
    p_submission_id: i.submissionId,
    p_actor_id: actorId(actor),
    p_readings: i.readings,
    p_invoice: i.invoice,
    p_anomaly_flag: i.anomalyFlag,
    p_note: i.note,
    p_notifications: notificationsFor(
      "meter.corrected",
      [customer(ticket.customer_id)],
      context(ticket, { reason: i.note, changes: i.changes, amountCents: i.invoice.total_cents }),
    ),
  })) as { changes: { counter_type: string; from: number; to: number }[]; total_cents: number };
}

// -----------------------------------------------------------------------------
// Payment
// -----------------------------------------------------------------------------

const paymentSchema = z.object({
  idempotencyKey: z.uuid(),
  amountCents: positiveCents,
  paidOn: isoDate,
  method: z.enum(["BANK_TRANSFER", "DEPOSIT", "CASH", "CHEQUE", "ONLINE", "OTHER"]).optional(),
  reference: z.string().trim().max(100).optional(),
  note: z.string().trim().max(1000).optional(),
  slip: z
    .object({ storagePath: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/), mimeType: z.string(), sizeBytes: z.number().int().positive() })
    .nullable()
    .default(null),
  stageDueAt: z.date(),
});

function paymentArgs(ticket: TicketSnapshot, actor: Actor, i: z.output<typeof paymentSchema>, source: "CUSTOMER_SLIP" | "OWNER_MANUAL") {
  return {
    p_ticket_id: ticket.id,
    p_actor_id: actorId(actor),
    p_idempotency_key: i.idempotencyKey,
    p_source: source,
    p_payment: { amount_cents: i.amountCents, paid_on: i.paidOn, method: i.method, reference: i.reference, note: i.note },
    p_slip: i.slip ? { storage_path: i.slip.storagePath, sha256: i.slip.sha256, mime_type: i.slip.mimeType, size_bytes: i.slip.sizeBytes } : null,
    p_stage_due_at: iso(i.stageDueAt),
    p_notifications: source === "CUSTOMER_SLIP" ? notificationsFor("payment.submitted", [owner(ticket.owner_id)], context(ticket, { amountCents: i.amountCents })) : [],
  };
}

/** Steps 6-7 (PAY-02..04): the customer's slip goes to the owner. */
export async function submitSlip(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof paymentSchema>) {
  assertTransition("submitSlip", actor, ticket);
  const i = parse(paymentSchema, input);
  if (!i.slip) throw new TransitionError("INVALID_INPUT", "A payment slip is required");
  return rpc("rpc_submit_payment", paymentArgs(ticket, actor, i, "CUSTOMER_SLIP"));
}

/** PAY-07: cash or cheque recorded by the owner. */
export async function recordPayment(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof paymentSchema>) {
  assertTransition("recordPayment", actor, ticket);
  return rpc("rpc_submit_payment", paymentArgs(ticket, actor, parse(paymentSchema, input), "OWNER_MANUAL"));
}

const acceptSchema = z.object({
  paymentId: z.uuid(),
  acceptedAmountCents: positiveCents,
  /** What was left to pay before this payment. */
  balanceCents: cents,
  stageDueAt: z.date(),
});

/** Steps 8-9 (PAY-05, PAY-06): paid in full closes the ticket (receipt); less leaves a balance. */
export async function acceptPayment(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof acceptSchema>) {
  assertTransition("acceptPayment", actor, ticket);
  const i = parse(acceptSchema, input);
  const full = i.acceptedAmountCents >= i.balanceCents;
  return rpc("rpc_verify_payment", {
    p_ticket_id: ticket.id,
    p_payment_id: i.paymentId,
    p_actor_id: actorId(actor),
    p_accept: true,
    p_accepted_amount_cents: i.acceptedAmountCents,
    p_stage_due_at: iso(i.stageDueAt),
    p_notifications: full
      ? notificationsFor("payment.receipt", [customer(ticket.customer_id)], context(ticket, { amountCents: i.acceptedAmountCents }))
      : notificationsFor("payment.partial", [customer(ticket.customer_id)], context(ticket, { amountCents: i.balanceCents - i.acceptedAmountCents })),
  });
}

const rejectPaymentSchema = z.object({ paymentId: z.uuid(), reason: reasonText, stageDueAt: z.date() });

/** PAY-05 / 11.5: slip refused with a reason; back to Awaiting payment (or Partially paid). */
export async function rejectPayment(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof rejectPaymentSchema>) {
  assertTransition("rejectPayment", actor, ticket);
  const i = parse(rejectPaymentSchema, input);
  return rpc("rpc_verify_payment", {
    p_ticket_id: ticket.id,
    p_payment_id: i.paymentId,
    p_actor_id: actorId(actor),
    p_accept: false,
    p_reason: i.reason,
    p_stage_due_at: iso(i.stageDueAt),
    p_notifications: notificationsFor("payment.rejected", [customer(ticket.customer_id)], context(ticket, { reason: i.reason })),
  });
}

const clearOverdueSchema = z.object({ reason: reasonText, dueDate: isoDate, stageDueAt: z.date() });

/** Owner override (11.1): an overdue payment gets a new due date, with a reason. */
export async function clearOverdue(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof clearOverdueSchema>) {
  assertTransition("clearOverdue", actor, ticket);
  const i = parse(clearOverdueSchema, input);
  return rpc("rpc_transition_ticket", {
    p_ticket_id: ticket.id,
    p_from: "OVERDUE",
    p_to: ticket.status_before_overdue === "PARTIALLY_PAID" ? "PARTIALLY_PAID" : "AWAITING_PAYMENT",
    p_actor_id: actorId(actor),
    p_reason: i.reason,
    p_stage_due_at: iso(i.stageDueAt),
    p_due_date: i.dueDate,
    p_notifications: notificationsFor("ticket.due_date_changed", [customer(ticket.customer_id)], context(ticket, { dueDate: i.dueDate, reason: i.reason })),
  });
}

// -----------------------------------------------------------------------------
// Disputes, cancel, reopen
// -----------------------------------------------------------------------------

const disputeSchema = z.object({ reason: reasonText });

/** 11.4 / CP-06: the customer disputes the issued invoice; reminders and late fees pause. */
export async function raiseDispute(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof disputeSchema>) {
  assertTransition("raiseDispute", actor, ticket);
  const i = parse(disputeSchema, input);
  return rpc("rpc_raise_dispute", {
    p_ticket_id: ticket.id,
    p_actor_id: actorId(actor),
    p_reason: i.reason,
    p_notifications: notificationsFor("dispute.raised", [owner(ticket.owner_id)], context(ticket, { reason: i.reason })),
  });
}

const resolveSchema = z.object({ outcome: z.enum(["RESOLVED", "REJECTED"]), resolution: reasonText, stageDueAt: z.date() });

/** 11.4: the owner answers without cancelling the invoice (rejected, or resolved with a credit). */
export async function resolveDispute(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof resolveSchema>) {
  assertTransition("resolveDispute", actor, ticket);
  const i = parse(resolveSchema, input);
  return rpc("rpc_resolve_dispute", {
    p_ticket_id: ticket.id,
    p_actor_id: actorId(actor),
    p_outcome: i.outcome,
    p_resolution: i.resolution,
    p_stage_due_at: iso(i.stageDueAt),
    p_notifications: notificationsFor("dispute.resolved", [customer(ticket.customer_id)], context(ticket, { reason: i.resolution })),
  });
}

const reasonSchema = z.object({ reason: reasonText });

/** TKT-10 / 11.7: cancel with a mandatory reason (a paid amount becomes a credit). */
export async function cancelTicket(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof reasonSchema>) {
  assertTransition("cancelTicket", actor, ticket);
  const i = parse(reasonSchema, input);
  return rpc("rpc_transition_ticket", {
    p_ticket_id: ticket.id,
    p_from: ticket.status,
    p_to: "CANCELLED",
    p_actor_id: actorId(actor),
    p_reason: i.reason,
    p_notifications: notificationsFor("ticket.cancelled", [customer(ticket.customer_id)], context(ticket, { reason: i.reason })),
  });
}

/** TKT-10 / 11.5, 11.7: reopen a closed ticket with a mandatory reason (e.g. a returned cheque). */
export async function reopenTicket(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof reasonSchema>) {
  assertTransition("reopenTicket", actor, ticket);
  const i = parse(reasonSchema, input);
  return rpc("rpc_transition_ticket", {
    p_ticket_id: ticket.id,
    p_from: "CLOSED",
    p_to: "REOPENED",
    p_actor_id: actorId(actor),
    p_reason: i.reason,
    p_notifications: notificationsFor("ticket.reopened", [customer(ticket.customer_id)], context(ticket, { reason: i.reason })),
  });
}

const paymentAgainSchema = z.object({ stageDueAt: z.date(), amountCents: cents, dueDate: isoDate });

/** Spec 5.3: a reopened ticket goes back to Awaiting payment. */
export async function requestPaymentAgain(rpc: Rpc, actor: Actor, ticket: TicketSnapshot, input: z.input<typeof paymentAgainSchema>) {
  assertTransition("requestPaymentAgain", actor, ticket);
  const i = parse(paymentAgainSchema, input);
  return rpc("rpc_transition_ticket", {
    p_ticket_id: ticket.id,
    p_from: "REOPENED",
    p_to: "AWAITING_PAYMENT",
    p_actor_id: actorId(actor),
    p_stage_due_at: iso(i.stageDueAt),
    p_notifications: notificationsFor("invoice.issued", [customer(ticket.customer_id)], context(ticket, { amountCents: i.amountCents, dueDate: i.dueDate })),
  });
}
