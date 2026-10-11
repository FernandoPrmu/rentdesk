import { formatDate } from "../format.ts";
import { formatRupees } from "../money.ts";

/**
 * The one place notifications are built (TKT-04, NOT-01, spec 9). Every workflow
 * rpc takes the result as `p_notifications` and writes the rows in the same
 * transaction as the change (outbox). Today every event goes to the in-app centre
 * only; NOT-02 adds EMAIL to CHANNELS below and a sender for the PENDING email
 * rows, without touching any caller.
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
  "dispute.resolved": (c) => ({ title: `Answer to your dispute: ${machine(c)}`, body: `${c.reason ?? ""}`.trim() }),
  "ticket.cancelled": (c) => ({ title: `Billing ticket cancelled: ${machine(c)}`, body: `Cycle ${c.cycleNo ?? "?"} was cancelled.${reason(c)}` }),
  "ticket.reopened": (c) => ({ title: `Billing ticket reopened: ${machine(c)}`, body: `Cycle ${c.cycleNo ?? "?"} was reopened.${reason(c)}` }),
  "ticket.due_date_changed": (c) => ({
    title: `New due date: ${c.dueDate ? formatDate(c.dueDate) : "?"}`,
    body: `${bill(c)} for ${machine(c)}.${reason(c)}`,
  }),
} satisfies Record<string, Template>;

export type NotificationEvent = keyof typeof TEMPLATES;

/** Channels per event. NOT-02 (email) and NOT-03 (SMS/WhatsApp, paid) extend this. */
const CHANNELS: Partial<Record<NotificationEvent, NotificationChannel[]>> = {};
const DEFAULT_CHANNELS: NotificationChannel[] = ["IN_APP"];

/** Where each role opens a ticket. "{entity_id}" is replaced with the ticket id by the rpc. */
const TICKET_LINK: Record<RecipientRole, string> = {
  CUSTOMER: "/customer/tickets/{entity_id}",
  OWNER: "/owner/tickets/{entity_id}",
  ADMIN: "/admin/escalations",
};

export function notificationsFor(
  event: NotificationEvent,
  recipients: Recipient[],
  context: NotificationContext = {},
  options: { link?: string | null; data?: Record<string, unknown> } = {},
): NotificationItem[] {
  const { title, body } = TEMPLATES[event](context);
  const channels = CHANNELS[event] ?? DEFAULT_CHANNELS;
  const items: NotificationItem[] = [];
  for (const r of recipients) {
    const link = options.link === null ? undefined : (options.link ?? TICKET_LINK[r.role]);
    for (const channel of channels) {
      items.push({ user_id: r.userId, event, channel, title, body, ...(link ? { link } : {}), ...(options.data ? { data: options.data } : {}) });
    }
  }
  return items;
}

/** Where each role opens a payment. "{entity_id}" is replaced with the payment id by the rpc. */
export const PAYMENT_LINK: Record<"CUSTOMER" | "OWNER", string> = {
  CUSTOMER: "/customer/payments/{entity_id}",
  OWNER: "/owner/payments/{entity_id}",
};

export const customer = (userId: string): Recipient => ({ userId, role: "CUSTOMER" });
export const owner = (userId: string): Recipient => ({ userId, role: "OWNER" });
export const admins = (userIds: string[]): Recipient[] => userIds.map((userId) => ({ userId, role: "ADMIN" }));
