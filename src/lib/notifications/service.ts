import { formatDate } from "../format.ts";
import { formatRupees } from "../money.ts";

/**
 * The one place notifications are built (TKT-04, NOT-01, spec 9). Every workflow
 * rpc takes the result as `p_notifications` and writes the in-app rows in the same
 * transaction as the change. For events of the delivery catalogue (`events.ts`,
 * `public.notification_events`) the database adds the email (and SMS / WhatsApp)
 * delivery rows in that transaction too (outbox, decision 65); `outbox.ts` sends
 * them after the request. Each item carries its facts as template variables
 * (`data.vars`) for the editable email templates (NOT-04).
 * Only relative imports: the daily job runs in DB tests under plain Node.
 */

export type NotificationChannel = "IN_APP" | "EMAIL" | "SMS" | "WHATSAPP";
export type RecipientRole = "CUSTOMER" | "OWNER" | "ADMIN";

/** Shape the rpc functions expect (app.enqueue_notifications). */
export interface NotificationItem {
  user_id: string;
  event: NotificationEvent;
  channel: NotificationChannel;
  title: string;
  body: string;
  link?: string;
  data?: Record<string, unknown>;
}

export interface Recipient {
  userId: string;
  role: RecipientRole;
}

/** Facts a message may mention. Dates are ISO calendar dates (Colombo). */
export interface NotificationContext {
  machine?: string;
  customer?: string;
  cycleNo?: number;
  /** Last day to act ("by 14 Oct"). */
  byDate?: string;
  dueDate?: string;
  amountCents?: number;
  invoiceNo?: string | null;
  count?: number;
  hours?: number;
  reason?: string;
  months?: number;
  /** "B&W 12,500 → 12,050" (corrections). */
  changes?: string;
  /** Bills a payment is for. */
  invoiceNos?: string[];
  /** Still to pay after a payment (its bills). */
  balanceCents?: number;
  /** Kept as a customer credit. */
  creditCents?: number;
  days?: number;
  /** The start of a message (comments). */
  preview?: string;
  /** "Rs. 12,800.00 → Rs. 12,000.00" (corrected invoices). */
  totals?: string;
  /** When a daily job last succeeded (ISO timestamp). */
  lastRunAt?: string;
  /** Service requests (spec 9 "New service request / status change"). */
  urgency?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  /** "Toner (cyan, magenta)", "Breakdown / repair". */
  request?: string;
  technician?: string;
  plannedDate?: string | null;
  rating?: number;
}

type Template = (c: NotificationContext) => { title: string; body: string };

const by = (c: NotificationContext) => (c.byDate ? ` by ${formatDate(c.byDate)}` : "");
const money = (c: NotificationContext) => (c.amountCents === undefined ? "" : formatRupees(c.amountCents));
const machine = (c: NotificationContext) => c.machine ?? "your machine";
const bill = (c: NotificationContext) => (c.invoiceNo ? `Bill ${c.invoiceNo}` : "Your bill");
const reason = (c: NotificationContext) => (c.reason ? ` Reason: ${c.reason}` : "");
const bills = (c: NotificationContext) =>
  c.invoiceNos && c.invoiceNos.length > 0 ? `${c.invoiceNos.length === 1 ? "bill" : "bills"} ${c.invoiceNos.join(", ")}` : "your bill";
const credit = (c: NotificationContext) => (c.creditCents ? ` ${formatRupees(c.creditCents)} is kept as credit for your next bills.` : "");
/** URGENT and HIGH requests say so first, so the owner sees them at a glance. */
const priority = (c: NotificationContext) => (c.urgency === "URGENT" ? "URGENT: " : c.urgency === "HIGH" ? "High priority: " : "");
const request = (c: NotificationContext) => c.request ?? "Service request";
const visit = (c: NotificationContext) => (c.plannedDate ? ` Planned visit: ${formatDate(c.plannedDate)}.` : "");
const note = (c: NotificationContext) => (c.preview ? ` ${c.preview}` : "");

const TEMPLATES = {
  // Daily job
  "ticket.opened": (c) => ({
    title: `Meter reading needed: ${machine(c)}`,
    body: `Please send the meter reading and a photo${by(c)}.`,
  }),
  "ticket.meter_reminder": (c) => ({
    title: `Reminder: meter reading for ${machine(c)}`,
    body: `Please send the meter reading and a photo${by(c)}.`,
  }),
  "ticket.meter_overdue": (c) => ({
    title: `Meter reading overdue: ${machine(c)}`,
    body: "The deadline has passed. Please send the meter reading and a photo as soon as you can.",
  }),
  "ticket.meter_missed": (c) => ({
    title: `Meter reading missed: ${c.customer ?? "customer"}`,
    body: `No reading for ${machine(c)} (cycle ${c.cycleNo ?? "?"}). Follow up, or enter the reading yourself.`,
  }),
  "ticket.previous_overdue": (c) => ({
    title: `Earlier reading still missing: ${c.customer ?? "customer"}`,
    body: `A new cycle has started for ${machine(c)} while an earlier reading is still missing.`,
  }),
  "ticket.estimate_ready": (c) => ({
    title: `Estimated invoice to review: ${c.customer ?? "customer"}`,
    body: `No reading for ${machine(c)} (cycle ${c.cycleNo ?? "?"}). An estimated invoice of ${money(c)} is waiting for your review.`,
  }),
  "ticket.review_reminder": (c) => ({
    title: `Meter reading waiting for your review: ${c.customer ?? "customer"}`,
    body: `Please check the reading and photo for ${machine(c)} and confirm the invoice.`,
  }),
  "ticket.slip_reminder": (c) => ({
    title: `Payment slip waiting for you: ${c.customer ?? "customer"}`,
    body: `Please check the payment slip for ${machine(c)} and close the ticket.`,
  }),
  "ticket.escalated": (c) => ({
    title: `Owner has not acted for ${c.hours ?? "?"} hours`,
    body: `${c.customer ?? "A customer"}, ${machine(c)}, cycle ${c.cycleNo ?? "?"}: the owner has not reviewed it yet.`,
  }),
  "dispute.reminder": (c) => ({
    title: `Dispute waiting for your answer: ${c.customer ?? "customer"}`,
    body: `${bill(c)} for ${machine(c)} has been disputed for ${c.days ?? "?"} days. Please reject it, correct the bill or give a credit.`,
  }),
  "dispute.escalated": (c) => ({
    title: `Dispute not answered for ${c.days ?? "?"} days`,
    body: `${c.customer ?? "A customer"}, ${machine(c)}, cycle ${c.cycleNo ?? "?"}: the owner has not answered the dispute yet.`,
  }),
  "ticket.paused": (c) => ({
    title: `Billing paused: ${machine(c)}`,
    body: "The account is suspended, so this billing cycle is on hold.",
  }),
  "ticket.resumed": (c) => ({
    title: `Billing active again: ${machine(c)}`,
    body: c.byDate ? `Your deadlines moved forward. Next deadline: ${formatDate(c.byDate)}.` : "Your deadlines moved forward by the paused days.",
  }),
  "payment.due_soon": (c) => ({
    title: `Bill due on ${c.dueDate ? formatDate(c.dueDate) : "soon"}: ${money(c)}`,
    body: `${bill(c)} for ${machine(c)}. Please pay and send the payment slip.`,
  }),
  "payment.due_today": (c) => ({
    title: `Bill due today: ${money(c)}`,
    body: `${bill(c)} for ${machine(c)}. Please pay and send the payment slip today.`,
  }),
  "payment.overdue": (c) => ({
    title: `Bill overdue: ${money(c)}`,
    body: `${bill(c)} for ${machine(c)} was due on ${c.dueDate ? formatDate(c.dueDate) : "?"}. Please pay as soon as you can.`,
  }),
  "payment.overdue_owner": (c) => ({
    title: `Payment overdue: ${c.customer ?? "customer"}`,
    body: `${bill(c)} (${money(c)}) for ${machine(c)} was due on ${c.dueDate ? formatDate(c.dueDate) : "?"}.`,
  }),
  "payment.overdue_summary": (c) => ({
    title: `${c.count ?? 0} overdue ${c.count === 1 ? "bill" : "bills"}: ${money(c)}`,
    body: "Your weekly summary of bills that are past their due date.",
  }),
  "invoice.late_fee": (c) => ({
    title: `Late fee added: ${money(c)}`,
    body: `${bill(c)} for ${machine(c)} was not paid in time, so a late fee was added.`,
  }),
  // Hand-overs (TKT-04)
  "meter.submitted": (c) => ({
    title: `Meter reading received: ${c.customer ?? "customer"}`,
    body: `Check the reading and photo for ${machine(c)}${c.months && c.months > 1 ? ` (covers ${c.months} months)` : ""} and confirm the invoice.`,
  }),
  "meter.rejected": (c) => ({
    title: `Please send the meter reading again: ${machine(c)}`,
    body: `Your rental company could not accept the reading.${reason(c)}`,
  }),
  "meter.rejected_final": (c) => ({
    title: `Reading not accepted: ${machine(c)}`,
    body: `Your rental company will enter the reading for you.${reason(c)}`,
  }),
  "meter.corrected": (c) => ({
    title: `Your meter reading was corrected: ${machine(c)}`,
    body: `${c.changes ?? ""}.${reason(c)} New amount: ${money(c)}.`,
  }),
  "meter.entered": (c) => ({
    title: `Meter reading entered for you: ${machine(c)}`,
    body: `Your rental company entered the reading.${reason(c)}`,
  }),
  "invoice.issued": (c) => ({
    title: `New bill: ${money(c)}`,
    body: `${bill(c)} for ${machine(c)} is due on ${c.dueDate ? formatDate(c.dueDate) : "?"}.`,
  }),
  // Payments (PAY-04..07, PAY-12, TKT-10): one payment may cover several bills.
  "payment.submitted": (c) => ({
    title: `Payment slip received: ${c.customer ?? "customer"}`,
    body: `Check the payment of ${money(c)} for ${bills(c)}.`,
  }),
  "payment.receipt": (c) => ({
    title: `Payment received: ${money(c)}`,
    body: `Thank you. ${bills(c).replace(/^./, (x) => x.toUpperCase())} ${c.invoiceNos && c.invoiceNos.length > 1 ? "are" : "is"} paid. Your receipt is ready.${credit(c)}`,
  }),
  "payment.partial": (c) => ({
    title: `Part payment accepted: ${money(c)}`,
    body: `${formatRupees(c.balanceCents ?? 0)} is still to pay on ${bills(c)}. Your receipt is ready.`,
  }),
  "payment.rejected": (c) => ({ title: `Payment not accepted: ${money(c)}`, body: `Please check and send the slip again.${reason(c)}` }),
  "payment.recorded": (c) => ({
    title: `Payment recorded: ${money(c)}`,
    body: `Your rental company recorded your payment${c.invoiceNos && c.invoiceNos.length > 0 ? ` for ${bills(c)}` : ""}. Your receipt is ready.${credit(c)}`,
  }),
  "payment.reversed": (c) => ({
    title: `Payment reversed: ${money(c)}`,
    body: `Your rental company took back this payment, so ${bills(c)} must be paid again.${reason(c)}`,
  }),
  "payment.reallocated": (c) => ({
    title: `Payment moved to other bills: ${money(c)}`,
    body: `It now pays ${bills(c)}. Your receipt was updated.${reason(c)}`,
  }),
  "credit.refunded": (c) => ({
    title: `Credit refunded: ${money(c)}`,
    body: `Your rental company paid back ${money(c)} of your credit.${reason(c)}`,
  }),
  "dispute.raised": (c) => ({ title: `Bill disputed: ${c.customer ?? "customer"}`, body: `${bill(c)} for ${machine(c)}.${reason(c)}` }),
  "dispute.rejected": (c) => ({
    title: `Dispute not accepted: ${machine(c)}`,
    body: `${bill(c)} stays as it is${c.dueDate ? `; please pay by ${formatDate(c.dueDate)}` : ""}.${reason(c)}`,
  }),
  "dispute.credit": (c) => ({
    title: `Credit given: ${money(c)}`,
    body: `Your rental company took ${money(c)} off ${c.invoiceNo ? `bill ${c.invoiceNo}` : "your bill"} for ${machine(c)}.${credit(c)}${reason(c)}`,
  }),
  "dispute.photo_requested": (c) => ({
    title: `Please send a fresh meter photo: ${machine(c)}`,
    body: `To check your dispute, your rental company asks for a new photo of the meter.${reason(c)}`,
  }),
  "dispute.photo_received": (c) => ({
    title: `Fresh meter photo received: ${c.customer ?? "customer"}`,
    body: `The photo for the dispute on ${machine(c)} is ready to check.`,
  }),
  "invoice.corrected": (c) => ({
    title: `Corrected bill: ${money(c)}`,
    body: `${bill(c)} for ${machine(c)} replaces the earlier one (${c.totals ?? ""}). It is due on ${c.dueDate ? formatDate(c.dueDate) : "?"}.${credit(c)}${reason(c)}`,
  }),
  "invoice.resent": (c) => ({
    title: `Your bill: ${money(c)}`,
    body: `${bill(c)} for ${machine(c)}${c.dueDate ? `, due on ${formatDate(c.dueDate)}` : ""}. Sent again by your rental company.`,
  }),
  "comment.added": (c) => ({ title: `New message: ${c.customer ?? machine(c)}`, body: c.preview ?? "" }),
  "meter.baseline": (c) => ({
    title: `New meter recorded: ${machine(c)}`,
    body: `Your rental company recorded a new starting reading (${c.changes ?? ""}). Next time, read the new meter.${reason(c)}`,
  }),
  "cron.failed": (c) => ({
    title: "Daily job had problems",
    body: `The daily job of ${c.dueDate ? formatDate(c.dueDate) : "today"} did not finish cleanly (${c.count ?? 0} ${c.count === 1 ? "error" : "errors"}). Check Admin › Daily job.`,
  }),
  "cron.missed": (c) => ({
    title: "Daily job did not run",
    body: `No daily job finished for ${c.hours ?? "?"} hours (last: ${c.lastRunAt ? formatDate(c.lastRunAt.slice(0, 10)) : "?"}). This run caught up; check the scheduler.`,
  }),
  // Service requests (SRV-05, spec 9): the other side hears of every change.
  "service.raised": (c) => ({
    title: `${priority(c)}New service request: ${c.customer ?? "customer"}`,
    body: `${request(c)} for ${machine(c)}.${note(c)}`,
  }),
  "service.acknowledged": (c) => ({ title: `Request received: ${request(c)}`, body: `Your rental company has seen your request for ${machine(c)}.${note(c)}` }),
  "service.assigned": (c) => ({
    title: `Technician assigned: ${request(c)}`,
    body: `${c.technician ?? "A technician"} will handle your request for ${machine(c)}.${visit(c)}${note(c)}`,
  }),
  "service.started": (c) => ({ title: `Work started: ${request(c)}`, body: `Work on ${machine(c)} has started.${note(c)}` }),
  "service.resolved": (c) => ({
    title: `Please check: ${request(c)} done`,
    body: `Your rental company says ${machine(c)} is fixed. Please confirm, or tell them if it is still not working.${note(c)}`,
  }),
  "service.closed": (c) => ({ title: `Request closed: ${request(c)}`, body: `Your request for ${machine(c)} is closed. You can rate the service.${note(c)}` }),
  "service.confirmed": (c) => ({ title: `Repair confirmed: ${c.customer ?? "customer"}`, body: `${request(c)} for ${machine(c)} is closed by the customer.` }),
  "service.reopened": (c) => ({
    title: `${priority(c)}Still not fixed: ${c.customer ?? "customer"}`,
    body: `${request(c)} for ${machine(c)} is back In progress.${reason(c)}`,
  }),
  "service.cancelled": (c) => ({ title: `Request cancelled: ${request(c)}`, body: `The request for ${machine(c)} was cancelled.${reason(c)}` }),
  "service.cancelled_by_customer": (c) => ({ title: `Request cancelled: ${c.customer ?? "customer"}`, body: `${request(c)} for ${machine(c)}.${reason(c)}` }),
  "service.updated": (c) => ({ title: `Request updated: ${request(c)}`, body: `${machine(c)}: ${c.technician ? `${c.technician} will handle it.` : "details changed."}${visit(c)}${note(c)}` }),
  "service.note": (c) => ({ title: `Note on your request: ${request(c)}`, body: `${machine(c)}:${note(c)}` }),
  "service.rated": (c) => ({ title: `Service rated ${c.rating ?? "?"}/5: ${c.customer ?? "customer"}`, body: `${request(c)} for ${machine(c)}.${note(c)}` }),
  "service.escalated_owner": (c) => ({
    title: `${priority(c)}Service request waiting ${c.hours ?? "?"} hours: ${c.customer ?? "customer"}`,
    body: `${request(c)} for ${machine(c)} has not been acknowledged yet. Please acknowledge it.`,
  }),
  "service.escalated_admin": (c) => ({
    title: `${priority(c)}Service request not acknowledged for ${c.hours ?? "?"} hours`,
    body: `${c.customer ?? "A customer"}, ${machine(c)}: ${request(c).toLowerCase()} still waits for the owner.`,
  }),
  "ticket.cancelled": (c) => ({ title: `Billing ticket cancelled: ${machine(c)}`, body: `Cycle ${c.cycleNo ?? "?"} was cancelled.${reason(c)}` }),
  "ticket.reopened": (c) => ({ title: `Billing ticket reopened: ${machine(c)}`, body: `Cycle ${c.cycleNo ?? "?"} was reopened.${reason(c)}` }),
  "ticket.due_date_changed": (c) => ({
    title: `New due date: ${c.dueDate ? formatDate(c.dueDate) : "?"}`,
    body: `${bill(c)} for ${machine(c)}.${reason(c)}`,
  }),
} satisfies Record<string, Template>;

export type NotificationEvent = keyof typeof TEMPLATES;

/**
 * Template variables (NOT-04) from the facts of a message, formatted as the
 * in-app text formats them. Only the facts given are included.
 */
export function contextVars(c: NotificationContext): Record<string, string> {
  const v: Record<string, string | undefined> = {
    customer_name: c.customer,
    machine: c.machine,
    cycle_no: c.cycleNo === undefined ? undefined : String(c.cycleNo),
    deadline: c.byDate ? formatDate(c.byDate) : undefined,
    due_date: c.dueDate ? formatDate(c.dueDate) : undefined,
    amount: c.amountCents === undefined ? undefined : formatRupees(c.amountCents),
    invoice_no: c.invoiceNo ?? undefined,
    invoice_nos: c.invoiceNos && c.invoiceNos.length > 0 ? c.invoiceNos.join(", ") : undefined,
    balance: c.balanceCents === undefined ? undefined : formatRupees(c.balanceCents),
    credit: c.creditCents ? formatRupees(c.creditCents) : undefined,
    totals: c.totals,
    changes: c.changes,
    reason: c.reason,
    count: c.count === undefined ? undefined : String(c.count),
    days: c.days === undefined ? undefined : String(c.days),
    hours: c.hours === undefined ? undefined : String(c.hours),
    months: c.months === undefined ? undefined : String(c.months),
    preview: c.preview,
    last_run: c.lastRunAt ? formatDate(c.lastRunAt.slice(0, 10)) : undefined,
    urgency: c.urgency ? c.urgency.charAt(0) + c.urgency.slice(1).toLowerCase() : undefined,
    priority: c.urgency ? priority(c) : undefined,
    request: c.request,
    technician: c.technician,
    planned_date: c.plannedDate ? formatDate(c.plannedDate) : undefined,
    rating: c.rating === undefined ? undefined : String(c.rating),
  };
  // An empty {priority} is a value (NORMAL and LOW requests); other empty facts are left out.
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => e[1] !== undefined && (e[1] !== "" || e[0] === "priority")));
}

/** Where each role opens a ticket. "{entity_id}" is replaced with the ticket id by the rpc. */
const TICKET_LINK: Record<RecipientRole, string> = {
  CUSTOMER: "/customer/tickets/{entity_id}",
  OWNER: "/owner/tickets/{entity_id}",
  ADMIN: "/admin/escalations",
};

/** Admin alerts about the daily job link to its log. */
export const JOBS_LINK = "/admin/jobs";

export function notificationsFor(
  event: NotificationEvent,
  recipients: Recipient[],
  context: NotificationContext = {},
  options: { link?: string | null; data?: Record<string, unknown> } = {},
): NotificationItem[] {
  const { title, body } = TEMPLATES[event](context);
  // The in-app row; the database adds the email / SMS deliveries (decision 65).
  const data = { ...options.data, vars: contextVars(context) };
  return recipients.map((r) => {
    const link = options.link === null ? undefined : (options.link ?? TICKET_LINK[r.role]);
    return { user_id: r.userId, event, channel: "IN_APP" as const, title, body, ...(link ? { link } : {}), data };
  });
}

/** Where each role opens a payment. "{entity_id}" is replaced with the payment id by the rpc. */
export const PAYMENT_LINK: Record<"CUSTOMER" | "OWNER", string> = {
  CUSTOMER: "/customer/payments/{entity_id}",
  OWNER: "/owner/payments/{entity_id}",
};

/** Where each role opens a service request. "{entity_id}" is replaced with the request id by the rpc. */
export const SERVICE_LINK: Record<RecipientRole, string> = {
  CUSTOMER: "/customer/service/{entity_id}",
  OWNER: "/owner/service/{entity_id}",
  ADMIN: "/admin/escalations",
};

/** Service request notifications: their own links, and the urgency in `data` for the centre (NOT-01). */
export function serviceNotifications(
  event: NotificationEvent,
  recipients: Recipient[],
  context: NotificationContext,
): NotificationItem[] {
  return recipients.flatMap((r) =>
    notificationsFor(event, [r], context, {
      link: SERVICE_LINK[r.role],
      data: { urgency: context.urgency ?? "NORMAL", priority: context.urgency === "URGENT" || context.urgency === "HIGH" },
    }),
  );
}

export const customer = (userId: string): Recipient => ({ userId, role: "CUSTOMER" });
export const owner = (userId: string): Recipient => ({ userId, role: "OWNER" });
export const admins = (userIds: string[]): Recipient[] => userIds.map((userId) => ({ userId, role: "ADMIN" }));
