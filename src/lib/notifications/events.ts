/**
 * The notification event catalogue (NOT-02..05, decisions 65-74): which events go
 * out by email (and, once a paid provider exists, SMS / WhatsApp), how essential
 * each one is, and which template variables it offers.
 *
 * The database keeps the same list in `public.notification_events` (migration
 * 0032); `app.enqueue_notifications` reads it to add the email row in the same
 * transaction as the in-app one. `notifications.db.test.ts` checks both agree.
 * Only relative imports: the daily job runs in DB tests under plain Node.
 */

/**
 * ESSENTIAL emails always go (bills, receipts, login details, account status).
 * UPDATE and REMINDER can each be turned off by the user (decision 68).
 */
export type EmailCategory = "ESSENTIAL" | "UPDATE" | "REMINDER";
export const EMAIL_CATEGORIES: readonly EmailCategory[] = ["ESSENTIAL", "UPDATE", "REMINDER"];

/** Lower sends first when the daily email limit is near (decision 69). */
export const CATEGORY_PRIORITY: Record<EmailCategory, number> = { ESSENTIAL: 0, UPDATE: 1, REMINDER: 2 };

export type Audience = "CUSTOMER" | "OWNER" | "ADMIN";

/** Every variable a template may use, with the sample used by the live preview. */
export const VARIABLES = {
  recipient_name: { label: "Name of the person receiving it", sample: "Nimal Perera" },
  company_name: { label: "Your company name", sample: "Lanka Copiers" },
  title: { label: "The notification title", sample: "New bill: Rs. 12,800" },
  message: { label: "The notification text", sample: "Bill INV-000123 for Canon iR C3226 is due on 18 Oct 2026." },
  link: { label: "Link to the page in RentDesk", sample: "https://rentdesk.example/customer/tickets/123" },
  customer_name: { label: "Customer name", sample: "Perera Traders" },
  machine: { label: "Machine", sample: "Canon iR C3226" },
  cycle_no: { label: "Billing cycle number", sample: "3" },
  deadline: { label: "Last day to act", sample: "14 Oct 2026" },
  due_date: { label: "Due date", sample: "18 Oct 2026" },
  amount: { label: "Amount", sample: "Rs. 12,800" },
  invoice_no: { label: "Bill number", sample: "INV-000123" },
  invoice_nos: { label: "Bill numbers", sample: "INV-000123, INV-000124" },
  balance: { label: "Still to pay", sample: "Rs. 2,800" },
  credit: { label: "Kept as credit", sample: "Rs. 500" },
  totals: { label: "Old and new total", sample: "Rs. 12,800 → Rs. 12,000" },
  changes: { label: "What changed", sample: "B&W 12,500 → 12,050" },
  reason: { label: "Reason given", sample: "The photo was too dark." },
  count: { label: "Number of bills", sample: "4" },
  days: { label: "Number of days", sample: "5" },
  hours: { label: "Number of hours", sample: "48" },
  months: { label: "Number of months", sample: "2" },
  preview: { label: "Note or message", sample: "We will come on Monday morning." },
  last_run: { label: "Last daily job", sample: "10 Oct 2026" },
  urgency: { label: "Urgency", sample: "Urgent" },
  priority: { label: "\"URGENT: \" or \"High priority: \" (empty otherwise)", sample: "URGENT: " },
  request: { label: "Service request", sample: "Toner (cyan, magenta)" },
  technician: { label: "Technician", sample: "Sunil" },
  planned_date: { label: "Planned visit", sample: "20 Oct 2026" },
  rating: { label: "Rating (1-5)", sample: "5" },
  username: { label: "Username", sample: "cust.perera" },
  temporary_password: { label: "Temporary password", sample: "Kx7#mP2qLw9zRt" },
  login_url: { label: "Sign-in page", sample: "https://rentdesk.example/login" },
  email: { label: "New email address", sample: "accounts@perera.lk" },
} as const;

export type VariableName = keyof typeof VARIABLES;

/** Every email can use these. */
export const COMMON_VARIABLES: readonly VariableName[] = ["recipient_name", "company_name", "title", "message", "link"];

export interface EventInfo {
  label: string;
  audience: Audience;
  /** null: in-app only. */
  email: EmailCategory | null;
  /** SMS / WhatsApp once a paid provider is set up (NOT-03, deferred). */
  sms?: boolean;
  /** Event-specific variables, on top of COMMON_VARIABLES. */
  vars: readonly VariableName[];
  /** A template for this event must keep these. */
  required?: readonly VariableName[];
}

const e = (label: string, audience: Audience, email: EmailCategory | null, vars: VariableName[] = [], extra: Partial<EventInfo> = {}): EventInfo => ({
  label,
  audience,
  email,
  vars,
  ...extra,
});

export const EVENTS = {
  // Accounts (built in SQL or sent directly)
  "account.credentials": e("Login details (new account or password reset)", "CUSTOMER", "ESSENTIAL", ["username", "temporary_password", "login_url"], {
    required: ["username", "temporary_password"],
  }),
  "account.active": e("Account active again", "CUSTOMER", "ESSENTIAL"),
  "account.suspended": e("Account suspended", "CUSTOMER", "ESSENTIAL"),
  "account.deactivated": e("Account closed", "CUSTOMER", "ESSENTIAL"),
  "account.owner_active": e("Rental company back on RentDesk", "CUSTOMER", "ESSENTIAL"),
  "account.owner_suspended": e("Rental company on hold", "CUSTOMER", "ESSENTIAL"),
  "account.owner_deactivated": e("Rental company left RentDesk", "CUSTOMER", "ESSENTIAL"),
  "account.contact_changed": e("Email address changed (test message)", "CUSTOMER", "ESSENTIAL", ["email"]),
  "machine.assigned": e("Machine added to the account", "CUSTOMER", "ESSENTIAL"),
  "machine.returned": e("Machine returned", "CUSTOMER", "ESSENTIAL"),
  "agreement.terms_changed": e("Rental terms changing", "CUSTOMER", "ESSENTIAL"),
  "deposit.settled": e("Security deposit settled", "CUSTOMER", "ESSENTIAL"),
  "email.failed": e("An email could not be delivered", "OWNER", null),

  // Daily job
  "ticket.opened": e("Meter reading needed (new cycle)", "CUSTOMER", "ESSENTIAL", ["machine", "deadline"], { sms: true }),
  "ticket.meter_reminder": e("Meter reading reminder", "CUSTOMER", "REMINDER", ["machine", "deadline"], { sms: true }),
  "ticket.meter_overdue": e("Meter reading overdue", "CUSTOMER", "REMINDER", ["machine"], { sms: true }),
  "ticket.meter_missed": e("Customer missed the meter reading", "OWNER", "UPDATE", ["customer_name", "machine", "cycle_no"], { sms: true }),
  "ticket.previous_overdue": e("Earlier reading still missing", "OWNER", "UPDATE", ["customer_name", "machine"]),
  "ticket.estimate_ready": e("Estimated invoice to review", "OWNER", "UPDATE", ["customer_name", "machine", "cycle_no", "amount"]),
  "ticket.review_reminder": e("Reading waiting for your review", "OWNER", "REMINDER", ["customer_name", "machine"]),
  "ticket.slip_reminder": e("Payment slip waiting for you", "OWNER", "REMINDER", ["customer_name", "machine"]),
  "ticket.escalated": e("Owner has not acted (admin alert)", "ADMIN", "UPDATE", ["customer_name", "machine", "cycle_no", "hours"], { sms: true }),
  "dispute.reminder": e("Dispute waiting for your answer", "OWNER", "REMINDER", ["customer_name", "machine", "invoice_no", "days"]),
  "dispute.escalated": e("Dispute not answered (admin alert)", "ADMIN", "UPDATE", ["customer_name", "machine", "cycle_no", "days"], { sms: true }),
  "ticket.paused": e("Billing paused", "CUSTOMER", null, ["machine"]),
  "ticket.resumed": e("Billing active again", "CUSTOMER", null, ["machine", "deadline"]),
  "payment.due_soon": e("Bill due soon", "CUSTOMER", "REMINDER", ["machine", "invoice_no", "amount", "due_date"], { sms: true }),
  "payment.due_today": e("Bill due today", "CUSTOMER", "REMINDER", ["machine", "invoice_no", "amount"], { sms: true }),
  "payment.overdue": e("Bill overdue", "CUSTOMER", "REMINDER", ["machine", "invoice_no", "amount", "due_date"], { sms: true }),
  "payment.overdue_owner": e("Customer's payment overdue", "OWNER", "UPDATE", ["customer_name", "machine", "invoice_no", "amount", "due_date"]),
  "payment.overdue_summary": e("Weekly overdue summary", "OWNER", "REMINDER", ["count", "amount"]),
  "invoice.late_fee": e("Late fee added", "CUSTOMER", "ESSENTIAL", ["machine", "invoice_no", "amount"]),

  // Hand-overs (TKT-04)
  "meter.submitted": e("Meter reading received", "OWNER", "UPDATE", ["customer_name", "machine", "months"]),
  "meter.rejected": e("Reading not accepted, send again", "CUSTOMER", "UPDATE", ["machine", "reason"]),
  "meter.rejected_final": e("Reading not accepted, owner will enter it", "CUSTOMER", "UPDATE", ["machine", "reason"]),
  "meter.corrected": e("Reading corrected", "CUSTOMER", "UPDATE", ["machine", "changes", "reason", "amount"]),
  "meter.entered": e("Reading entered for the customer", "CUSTOMER", "UPDATE", ["machine", "reason"]),
  "meter.baseline": e("New meter recorded", "CUSTOMER", "UPDATE", ["machine", "changes", "reason"]),
  "invoice.issued": e("New bill (PDF attached)", "CUSTOMER", "ESSENTIAL", ["machine", "invoice_no", "amount", "due_date"]),
  "invoice.corrected": e("Corrected bill (PDF attached)", "CUSTOMER", "ESSENTIAL", ["machine", "invoice_no", "amount", "due_date", "totals", "credit", "reason"]),
  "invoice.resent": e("Bill sent again (PDF attached)", "CUSTOMER", "ESSENTIAL", ["machine", "invoice_no", "amount", "due_date"]),
  "payment.submitted": e("Payment slip received", "OWNER", "UPDATE", ["customer_name", "amount", "invoice_nos"]),
  "payment.receipt": e("Payment received (receipt attached)", "CUSTOMER", "ESSENTIAL", ["amount", "invoice_nos", "credit"]),
  "payment.partial": e("Part payment accepted (receipt attached)", "CUSTOMER", "ESSENTIAL", ["amount", "balance", "invoice_nos"]),
  "payment.rejected": e("Payment not accepted", "CUSTOMER", "ESSENTIAL", ["amount", "reason"]),
  "payment.recorded": e("Payment recorded (receipt attached)", "CUSTOMER", "ESSENTIAL", ["amount", "invoice_nos", "credit"]),
  "payment.reversed": e("Payment reversed", "CUSTOMER", "ESSENTIAL", ["amount", "invoice_nos", "reason"]),
  "payment.reallocated": e("Payment moved to other bills", "CUSTOMER", "ESSENTIAL", ["amount", "invoice_nos", "reason"]),
  "credit.refunded": e("Credit refunded", "CUSTOMER", "ESSENTIAL", ["amount", "reason"]),
  "dispute.raised": e("Bill disputed", "OWNER", "UPDATE", ["customer_name", "machine", "invoice_no", "reason"]),
  "dispute.rejected": e("Dispute not accepted", "CUSTOMER", "ESSENTIAL", ["machine", "invoice_no", "due_date", "reason"]),
  "dispute.credit": e("Credit given on a disputed bill", "CUSTOMER", "ESSENTIAL", ["machine", "invoice_no", "amount", "credit", "reason"]),
  "dispute.photo_requested": e("Fresh meter photo requested", "CUSTOMER", "UPDATE", ["machine", "reason"]),
  "dispute.photo_received": e("Fresh meter photo received", "OWNER", "UPDATE", ["customer_name", "machine"]),
  "comment.added": e("New ticket message", "CUSTOMER", null, ["customer_name", "machine", "preview"]),
  "cron.failed": e("Daily job had problems (admin alert)", "ADMIN", "UPDATE", ["due_date", "count"]),
  "cron.missed": e("Daily job did not run (admin alert)", "ADMIN", "UPDATE", ["hours", "last_run"]),
  "ticket.cancelled": e("Billing ticket cancelled", "CUSTOMER", "ESSENTIAL", ["machine", "cycle_no", "reason"]),
  "ticket.reopened": e("Billing ticket reopened", "CUSTOMER", "ESSENTIAL", ["machine", "cycle_no", "reason"]),
  "ticket.due_date_changed": e("New due date", "CUSTOMER", "ESSENTIAL", ["machine", "invoice_no", "due_date", "reason"]),

  // Service requests: only a new request reaches the owner by email (client decision, task 10).
  "service.raised": e("New service request", "OWNER", "UPDATE", ["customer_name", "machine", "request", "urgency", "priority", "preview"], { sms: true }),
  "service.acknowledged": e("Service request received", "CUSTOMER", null, ["machine", "request", "preview"]),
  "service.assigned": e("Technician assigned", "CUSTOMER", null, ["machine", "request", "preview"]),
  "service.started": e("Service work started", "CUSTOMER", null, ["machine", "request", "preview"]),
  "service.resolved": e("Service done, please check", "CUSTOMER", null, ["machine", "request", "preview"]),
  "service.closed": e("Service request closed", "CUSTOMER", null, ["machine", "request", "preview"]),
  "service.confirmed": e("Repair confirmed by the customer", "OWNER", null, ["customer_name", "machine", "request"]),
  "service.reopened": e("Still not fixed", "OWNER", null, ["customer_name", "machine", "request", "reason"]),
  "service.cancelled": e("Service request cancelled", "CUSTOMER", null, ["machine", "request", "reason"]),
  "service.cancelled_by_customer": e("Service request cancelled by the customer", "OWNER", null, ["customer_name", "machine", "request", "reason"]),
  "service.updated": e("Service request updated", "CUSTOMER", null, ["machine", "request", "preview"]),
  "service.note": e("Note on a service request", "CUSTOMER", null, ["machine", "request", "preview"]),
  "service.rated": e("Service rated", "OWNER", null, ["customer_name", "machine", "request", "preview"]),
  "service.escalated_owner": e("Service request waiting (reminder)", "OWNER", "REMINDER", ["customer_name", "machine", "request", "hours", "priority"], { sms: true }),
  "service.escalated_admin": e("Service request not acknowledged (admin alert)", "ADMIN", "UPDATE", ["customer_name", "machine", "request", "hours", "priority"], { sms: true }),
} satisfies Record<string, EventInfo>;

export type CatalogEvent = keyof typeof EVENTS;

export function isCatalogEvent(event: string): event is CatalogEvent {
  return Object.hasOwn(EVENTS, event);
}

export function eventInfo(event: string): EventInfo | null {
  return isCatalogEvent(event) ? EVENTS[event] : null;
}

/** Events that have an email (the template editor lists these). */
export function emailEvents(): CatalogEvent[] {
  return (Object.keys(EVENTS) as CatalogEvent[]).filter((k) => EVENTS[k].email !== null);
}

/** Variables a template of this event may use. */
export function allowedVariables(event: string): VariableName[] {
  const info = eventInfo(event);
  return [...COMMON_VARIABLES, ...(info?.vars ?? [])];
}

/** The rows `public.notification_events` must hold (events with a delivery channel). */
export function deliveryCatalog(): { event: string; category: EmailCategory | null; email: boolean; sms: boolean }[] {
  return (Object.keys(EVENTS) as CatalogEvent[])
    .map((k) => {
      const info: EventInfo = EVENTS[k];
      return { event: k, category: info.email, email: info.email !== null, sms: info.sms === true };
    })
    .filter((r) => r.email || r.sms)
    .sort((a, b) => a.event.localeCompare(b.event));
}
