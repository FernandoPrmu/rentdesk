import { type IsoDate, todayInColombo } from "../agreements/cycle-calendar.ts";
import { AGE_BUCKET_LABEL, AGE_BUCKETS, type AgeingInvoice, ageBucket, ageingReport, daysOverdue } from "../payments/ageing.ts";
import { COLOUR_LABEL, SERVICE_TYPES, type TonerColour, TYPE_LABEL, URGENCIES, URGENCY_LABEL } from "../service/states.ts";
import { INVOICE_STATUS_LABEL, TICKET_STATUS_LABEL } from "../status-labels.ts";
import { REPORT_INFO, type ReportId } from "./catalogue.ts";
import { MAX_EXPORT_ROWS, type ReportDocument, type ReportRow, type ReportSection, type SummaryItem } from "./document.ts";
import {
  BEHAVIOUR_LABEL,
  incomeMonth,
  incomeTotals,
  machineProfit,
  machineTotals,
  onTimePercent,
  paymentBehaviour,
  tonerForecast,
  usageSeries,
} from "./maths.ts";
import { type DateRange, rangeLabel } from "./period.ts";
import type { AdminActivity, AgeingInvoiceRow, CustomerRow, CycleStatus, IncomeMonthRow, MachineRow, RentalData, ServiceDemand, UsageRow } from "./types.ts";

/**
 * Report data -> ReportDocument (RPT-02..08). The same document feeds the screen,
 * the PDF and the Excel file. Pure.
 */

export interface BuildContext {
  range: DateRange;
  today: IsoDate;
  company: string;
  generatedAt: string;
}

const asOf = (today: IsoDate) => `As of ${rangeLabel({ from: today, to: today })}`;

function doc(report: ReportId, ctx: BuildContext, summary: SummaryItem[], sections: ReportSection[], notes?: string[]): ReportDocument {
  const info = REPORT_INFO[report];
  return {
    report,
    title: info.title,
    period: info.range ? rangeLabel(ctx.range) : asOf(ctx.today),
    company: ctx.company,
    generatedAt: ctx.generatedAt,
    summary,
    sections: sections.map((s) => ({ ...s, rows: s.rows.slice(0, MAX_EXPORT_ROWS) })),
    notes,
  };
}

// RPT-02 ----------------------------------------------------------------------
export function buildIncome(rows: IncomeMonthRow[], ctx: BuildContext): ReportDocument {
  const months = rows.map(incomeMonth);
  const t = incomeTotals(months);
  return doc(
    "income",
    ctx,
    [
      { label: "Invoiced", value: t.invoiced_cents, type: "money" },
      { label: "Collected", value: t.collected_cents, type: "money" },
      { label: "Bills issued", value: t.invoices, type: "count" },
    ],
    [
      {
        title: "By month",
        columns: [
          { key: "month", label: "Month", type: "month" },
          { key: "commitment_cents", label: "Commitment", type: "money" },
          { key: "excess_cents", label: "Excess copies", type: "money" },
          { key: "other_cents", label: "Other charges", type: "money" },
          { key: "discount_cents", label: "Discounts", type: "money" },
          { key: "invoiced_cents", label: "Invoiced", type: "money" },
          { key: "payments_cents", label: "Payments", type: "money" },
          { key: "advances_cents", label: "Advances", type: "money" },
          { key: "deposits_kept_cents", label: "Deposits kept", type: "money" },
          { key: "refunds_cents", label: "Refunds", type: "money" },
          { key: "collected_cents", label: "Collected", type: "money" },
          { key: "invoices", label: "Bills", type: "count" },
        ],
        rows: months.map((m) => ({ ...m }) as unknown as ReportRow),
        totals: { month: "Total", ...t },
      },
    ],
    [
      "Invoiced: charges on bills issued in the month (cancelled bills left out), less discounts and estimate credits. Credits that carry money already received do not reduce it.",
      "Collected: accepted payments by the date paid (including payments from a security deposit), advances received with an agreement, and deposit kept, less credit refunds. Deposits received and refunded are not income.",
    ],
  );
}

// RPT-03 ----------------------------------------------------------------------
export function buildMachines(rows: MachineRow[], ctx: BuildContext): ReportDocument {
  const machines = rows.map(machineProfit);
  const t = machineTotals(machines);
  return doc(
    "machines",
    ctx,
    [
      { label: "Revenue", value: t.revenue_cents, type: "money" },
      { label: "Service and toner cost", value: t.service_cost_cents, type: "money" },
      { label: "Profit", value: t.profit_cents, type: "money" },
      { label: "Margin", value: t.margin_percent, type: "percent" },
    ],
    [
      {
        title: "Per machine",
        columns: [
          { key: "name", label: "Machine", type: "text" },
          { key: "customer", label: "Rented to", type: "text" },
          { key: "revenue_cents", label: "Revenue", type: "money" },
          { key: "commitment_cents", label: "Commitment", type: "money" },
          { key: "bw_excess_cents", label: "B&W excess", type: "money" },
          { key: "colour_excess_cents", label: "Colour excess", type: "money" },
          { key: "bw_copies", label: "B&W copies", type: "count" },
          { key: "colour_copies", label: "Colour copies", type: "count" },
          { key: "service_cost_cents", label: "Service cost", type: "money" },
          { key: "toner_cost_cents", label: "of which toner", type: "money" },
          { key: "profit_cents", label: "Profit", type: "money" },
          { key: "margin_percent", label: "Margin", type: "percent" },
        ],
        rows: machines.map((m) => ({ ...m, customer: m.customer ?? (m.status === "RENTED" ? null : "Not rented") }) as unknown as ReportRow),
        totals: { name: "Total", customer: null, ...t },
        empty: "No machines yet.",
      },
    ],
    [
      "Revenue: charges on bills issued in the period, less discounts. Copies: from the readings billed in the period.",
      "Service cost: the cost you recorded when resolving service requests in the period (customers never see it). Profit = revenue - service cost.",
    ],
  );
}

// RPT-05 ----------------------------------------------------------------------
export function buildCustomers(rows: CustomerRow[], ctx: BuildContext): ReportDocument {
  const sum = (k: keyof CustomerRow) => rows.reduce((t, r) => t + (r[k] as number), 0);
  return doc(
    "customers",
    ctx,
    [
      { label: "Invoiced", value: sum("invoiced_cents"), type: "money" },
      { label: "Collected", value: sum("collected_cents"), type: "money" },
      { label: "Outstanding now", value: sum("outstanding_cents"), type: "money" },
      { label: "Overdue now", value: sum("overdue_cents"), type: "money" },
    ],
    [
      {
        title: "Per customer",
        columns: [
          { key: "name", label: "Customer", type: "text" },
          { key: "machines", label: "Machines", type: "count" },
          { key: "invoiced_cents", label: "Invoiced", type: "money" },
          { key: "collected_cents", label: "Collected", type: "money" },
          { key: "outstanding_cents", label: "Outstanding", type: "money" },
          { key: "overdue_cents", label: "Overdue", type: "money" },
          { key: "credit_cents", label: "Credit", type: "money" },
          { key: "paid_bills", label: "Bills paid", type: "count" },
          { key: "on_time", label: "On time", type: "percent" },
          { key: "avg_days_to_pay", label: "Days to pay", type: "decimal" },
          { key: "behaviour", label: "Payment behaviour", type: "text" },
        ],
        rows: rows.map((r) => ({
          ...(r as unknown as ReportRow),
          name: r.business_name ? `${r.name} (${r.business_name})` : r.name,
          on_time: onTimePercent(r),
          behaviour: BEHAVIOUR_LABEL[paymentBehaviour(r)],
        })),
        totals: {
          name: "Total",
          machines: sum("machines"),
          invoiced_cents: sum("invoiced_cents"),
          collected_cents: sum("collected_cents"),
          outstanding_cents: sum("outstanding_cents"),
          overdue_cents: sum("overdue_cents"),
          credit_cents: sum("credit_cents"),
          paid_bills: sum("paid_bills"),
        },
        empty: "No customers yet.",
      },
    ],
    [
      "Invoiced and collected: in the period. Outstanding, overdue and credit: today.",
      "On time: bills due in the period and paid in full by their due date. Days to pay: from the bill's issue date to the last payment.",
    ],
  );
}

// RPT-04 ----------------------------------------------------------------------
export function buildAgeing(rows: AgeingInvoiceRow[], ctx: BuildContext): ReportDocument {
  const invoices: AgeingInvoice[] = rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoice_no,
    customerId: r.customer_id,
    customerName: r.customer_name,
    status: r.status,
    dueDate: r.due_date,
    balanceCents: r.balance_cents,
  }));
  const report = ageingReport(invoices, ctx.today);
  return doc(
    "ageing",
    ctx,
    [
      { label: "Outstanding", value: report.totals.total, type: "money" },
      ...AGE_BUCKETS.map((b) => ({ label: AGE_BUCKET_LABEL[b], value: report.totals[b], type: "money" as const })),
    ],
    [
      {
        title: "By customer",
        columns: [
          { key: "customer", label: "Customer", type: "text" },
          ...AGE_BUCKETS.map((b) => ({ key: b, label: AGE_BUCKET_LABEL[b], type: "money" as const })),
          { key: "total", label: "Total", type: "money" },
          { key: "slip_waiting", label: "Slip being checked", type: "money" },
          { key: "oldest_days", label: "Oldest (days)", type: "count" },
        ],
        rows: report.customers.map((c) => ({
          customer: c.customerName,
          ...c.buckets,
          total: c.totalCents,
          slip_waiting: c.slipWaitingCents,
          oldest_days: c.oldestDays,
        })),
        totals: { customer: "Total", ...Object.fromEntries(AGE_BUCKETS.map((b) => [b, report.totals[b]])), total: report.totals.total, slip_waiting: report.totals.slipWaiting },
        empty: "Nothing unpaid.",
      },
      {
        title: "Unpaid bills",
        columns: [
          { key: "invoice_no", label: "Bill", type: "text" },
          { key: "customer", label: "Customer", type: "text" },
          { key: "due_date", label: "Due date", type: "date" },
          { key: "days", label: "Days overdue", type: "count" },
          { key: "age", label: "Age", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "balance", label: "Still to pay", type: "money" },
        ],
        rows: invoices.map((i) => ({
          invoice_no: i.invoiceNo,
          customer: i.customerName,
          due_date: i.dueDate,
          days: Math.max(0, daysOverdue(i.dueDate, ctx.today)),
          age: AGE_BUCKET_LABEL[ageBucket(i, ctx.today)],
          status: INVOICE_STATUS_LABEL[i.status] ?? i.status,
          balance: i.balanceCents,
        })),
        empty: "Nothing unpaid.",
      },
    ],
    ["A bill with a payment slip waiting for your check is not overdue (spec 8.2). Disputed bills age normally."],
  );
}

// RPT-06 ----------------------------------------------------------------------
export function buildService(data: ServiceDemand, ctx: BuildContext): ReportDocument {
  const forecasts = data.toner_history
    .map((m) => ({ m, f: tonerForecast(m.dates, ctx.today) }))
    .sort((a, b) => (a.f?.inDays ?? 1e9) - (b.f?.inDays ?? 1e9));
  return doc(
    "service",
    ctx,
    [
      { label: "Requests", value: data.total, type: "count" },
      { label: "Still open", value: data.open, type: "count" },
      { label: "Hours to acknowledge", value: data.avg_ack_hours, type: "decimal" },
      { label: "Hours to resolve", value: data.avg_resolve_hours, type: "decimal" },
      { label: `Average rating (${data.ratings})`, value: data.avg_rating, type: "decimal" },
    ],
    [
      {
        title: "By type",
        columns: [
          { key: "type", label: "Type", type: "text" },
          { key: "requests", label: "Requests", type: "count" },
        ],
        rows: SERVICE_TYPES.map((t) => ({ type: TYPE_LABEL[t], requests: data.by_type[t] ?? 0 })),
        totals: { type: "Total", requests: data.total },
      },
      {
        title: "By urgency",
        columns: [
          { key: "urgency", label: "Urgency", type: "text" },
          { key: "requests", label: "Requests", type: "count" },
        ],
        rows: [...URGENCIES].reverse().map((u) => ({ urgency: URGENCY_LABEL[u], requests: data.by_urgency[u] ?? 0 })),
      },
      {
        title: "By month",
        columns: [
          { key: "month", label: "Month", type: "month" },
          { key: "requests", label: "Requests", type: "count" },
          { key: "toner", label: "Toner", type: "count" },
        ],
        rows: data.by_month.map((m) => ({ ...m })),
        empty: "No requests in this period.",
      },
      {
        title: "By machine",
        columns: [
          { key: "name", label: "Machine", type: "text" },
          { key: "requests", label: "Requests", type: "count" },
          { key: "toner", label: "Toner", type: "count" },
          { key: "breakdowns", label: "Breakdowns", type: "count" },
        ],
        rows: data.by_machine.map((m) => ({ ...m })),
        empty: "No requests in this period.",
      },
      {
        title: "By customer",
        columns: [
          { key: "name", label: "Customer", type: "text" },
          { key: "requests", label: "Requests", type: "count" },
          { key: "toner", label: "Toner", type: "count" },
        ],
        rows: data.by_customer.map((c) => ({ ...c })),
        empty: "No requests in this period.",
      },
      {
        title: "Toner colours requested",
        columns: [
          { key: "colour", label: "Colour", type: "text" },
          { key: "requests", label: "Requests", type: "count" },
        ],
        rows: (Object.keys(COLOUR_LABEL) as TonerColour[]).map((c) => ({ colour: COLOUR_LABEL[c], requests: data.toner_colours[c] ?? 0 })),
      },
      {
        title: "Toner forecast",
        columns: [
          { key: "name", label: "Machine", type: "text" },
          { key: "last", label: "Last request", type: "date" },
          { key: "every", label: "About every (days)", type: "count" },
          { key: "next", label: "Next expected", type: "date" },
          { key: "when", label: "When", type: "text" },
        ],
        rows: forecasts.map(({ m, f }) => ({
          name: m.name,
          last: m.dates && m.dates.length ? [...m.dates].sort().at(-1)! : null,
          every: f?.everyDays ?? null,
          next: f?.nextDate ?? null,
          when: !f ? "Needs two requests" : f.inDays < 0 ? "Due now" : f.inDays <= 14 ? `In ${f.inDays} days` : "Later",
        })),
        empty: "No toner requests yet.",
      },
    ],
    ["Toner forecast: the average time between a machine's toner requests (its last six), added to the last one."],
  );
}

// Usage trends -------------------------------------------------------------------
export function buildUsage(rows: UsageRow[], ctx: BuildContext): ReportDocument {
  const machines = usageSeries(rows, "machine");
  const totalBw = rows.reduce((t, r) => t + r.bw, 0);
  const totalColour = rows.reduce((t, r) => t + r.colour, 0);
  return doc(
    "usage",
    ctx,
    [
      { label: "B&W copies", value: totalBw, type: "count" },
      { label: "Colour copies", value: totalColour, type: "count" },
    ],
    [
      {
        title: "Totals per machine",
        columns: [
          { key: "label", label: "Machine", type: "text" },
          { key: "bw", label: "B&W copies", type: "count" },
          { key: "colour", label: "Colour copies", type: "count" },
        ],
        rows: machines.map((m) => ({ label: m.label, bw: m.totalBw, colour: m.totalColour })),
        totals: { label: "Total", bw: totalBw, colour: totalColour },
        empty: "No readings billed in this period.",
      },
      {
        title: "By month",
        columns: [
          { key: "month", label: "Month", type: "month" },
          { key: "machine", label: "Machine", type: "text" },
          { key: "customer", label: "Customer", type: "text" },
          { key: "bw", label: "B&W copies", type: "count" },
          { key: "colour", label: "Colour copies", type: "count" },
        ],
        rows: rows.map((r) => ({ month: r.month, machine: r.machine, customer: r.customer, bw: r.bw, colour: r.colour })),
        empty: "No readings billed in this period.",
      },
    ],
    ["Copies come from confirmed readings (not estimates), in the month the billing period ended."],
  );
}

// Rental information ---------------------------------------------------------------
const MACHINE_STATUS_LABEL: Record<string, string> = { RENTED: "Rented", AVAILABLE: "Available", UNDER_REPAIR: "Under repair", RETIRED: "Retired" };

export function buildRental(data: RentalData, ctx: BuildContext): ReportDocument {
  const notice = data.notice_days ?? 30;
  return doc(
    "rental",
    ctx,
    Object.keys(MACHINE_STATUS_LABEL).map((s) => ({ label: MACHINE_STATUS_LABEL[s], value: data.machines[s] ?? 0, type: "count" as const })),
    [
      {
        title: "Live agreements",
        columns: [
          { key: "customer", label: "Customer", type: "text" },
          { key: "machine", label: "Machine", type: "text" },
          { key: "start_date", label: "Started", type: "date" },
          { key: "next_cycle_date", label: "Next cycle", type: "date" },
          { key: "end_date", label: "Ends", type: "date" },
          { key: "days_left", label: "Days left", type: "count" },
          { key: "ending", label: "Ending soon", type: "text" },
          { key: "monthly_commitment_cents", label: "Monthly commitment", type: "money" },
        ],
        rows: data.agreements.map((a) => ({
          customer: a.customer,
          machine: a.machine,
          start_date: a.start_date,
          next_cycle_date: a.next_cycle_date,
          end_date: a.end_date,
          days_left: a.days_left,
          ending: a.days_left !== null && a.days_left >= 0 && a.days_left <= notice ? "Yes" : "",
          monthly_commitment_cents: a.monthly_commitment_cents,
        })),
        empty: "No machines rented.",
      },
    ],
    [`"Ending soon": the agreement ends within ${notice} days (Settings › Reminders and deadlines).`],
  );
}

// Billing cycle status ---------------------------------------------------------------
const STAGES = ["METER_REQUESTED", "PENDING_OWNER_REVIEW", "AWAITING_PAYMENT", "PAYMENT_SUBMITTED", "PARTIALLY_PAID", "OVERDUE", "DISPUTED", "REOPENED", "CLOSED", "CANCELLED"];

export function buildCycles(data: CycleStatus, ctx: BuildContext): ReportDocument {
  return doc(
    "cycles",
    ctx,
    [
      { label: "Tickets", value: data.tickets, type: "count" },
      { label: "Missed a deadline", value: data.went_overdue, type: "count" },
      { label: "Late readings", value: data.late_readings, type: "count" },
      { label: "Escalations", value: data.escalations, type: "count" },
    ],
    [
      {
        title: "Tickets by stage",
        columns: [
          { key: "stage", label: "Stage now", type: "text" },
          { key: "tickets", label: "Tickets", type: "count" },
        ],
        rows: STAGES.filter((s) => data.by_status[s]).map((s) => ({ stage: TICKET_STATUS_LABEL[s] ?? s, tickets: data.by_status[s] })),
        totals: { stage: "Total", tickets: data.tickets },
        empty: "No billing cycles in this period.",
      },
      {
        title: "Average time in each stage",
        columns: [
          { key: "stage", label: "Stage", type: "text" },
          { key: "hours", label: "Hours", type: "decimal" },
          { key: "days", label: "Days", type: "decimal" },
        ],
        rows: STAGES.filter((s) => data.avg_hours[s] !== undefined).map((s) => ({
          stage: TICKET_STATUS_LABEL[s] ?? s,
          hours: data.avg_hours[s],
          days: Math.round((data.avg_hours[s] / 24) * 10) / 10,
        })),
        empty: "No finished stages in this period.",
      },
      {
        title: "Reminders and deadlines",
        columns: [
          { key: "what", label: "", type: "text" },
          { key: "n", label: "Count", type: "count" },
        ],
        rows: [
          { what: "Reminders sent", n: data.reminders },
          { what: "Tickets that became overdue", n: data.went_overdue },
          { what: "Readings sent after the deadline", n: data.late_readings },
          { what: "Escalations", n: data.escalations },
        ],
      },
    ],
    ["Billing cycles dated in the period. Time in a stage: from entering it to the next stage."],
  );
}

// RPT-08 ----------------------------------------------------------------------------
export function buildPlatform(data: AdminActivity, ctx: BuildContext): ReportDocument {
  const delivery = (channel: string, status: string) => data.deliveries[`${channel}:${status}`] ?? 0;
  const statuses = ["SENT", "PENDING", "FAILED", "SKIPPED"];
  return doc(
    "platform",
    ctx,
    [
      { label: "Owners", value: data.owners.length, type: "count" },
      { label: "Emails sent", value: delivery("EMAIL", "SENT"), type: "count" },
      { label: "Emails failed", value: delivery("EMAIL", "FAILED"), type: "count" },
      { label: "In-app read", value: data.in_app.sent > 0 ? Math.round((data.in_app.read * 1000) / data.in_app.sent) / 10 : null, type: "percent" },
    ],
    [
      {
        title: "Over time",
        columns: [
          { key: "month", label: "Month", type: "month" },
          { key: "owners", label: "Owners", type: "count" },
          { key: "customers", label: "Customers", type: "count" },
          { key: "machines", label: "Machines", type: "count" },
          { key: "invoices", label: "Bills issued", type: "count" },
        ],
        rows: data.months.map((m) => ({ ...m })),
      },
      {
        title: "Owner activity",
        columns: [
          { key: "business_name", label: "Owner", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "last_login", label: "Last sign-in", type: "date" },
          { key: "customers", label: "Customers", type: "count" },
          { key: "machines", label: "Machines", type: "count" },
          { key: "invoices", label: "Bills issued", type: "count" },
          { key: "open_tickets", label: "Open tickets", type: "count" },
          { key: "escalated", label: "Escalated", type: "count" },
          { key: "actions", label: "Actions", type: "count" },
        ],
        rows: data.owners.map((o) => ({
          business_name: o.business_name,
          status: o.status.charAt(0) + o.status.slice(1).toLowerCase(),
          last_login: o.last_login_at ? todayInColombo(new Date(o.last_login_at)) : null,
          customers: o.customers,
          machines: o.machines,
          invoices: o.invoices,
          open_tickets: o.open_tickets,
          escalated: o.escalated,
          actions: o.actions,
        })),
        empty: "No owners yet.",
      },
      {
        title: "Notification delivery",
        columns: [
          { key: "channel", label: "Channel", type: "text" },
          ...statuses.map((s) => ({ key: s, label: s.charAt(0) + s.slice(1).toLowerCase(), type: "count" as const })),
        ],
        rows: [
          { channel: "Email", ...Object.fromEntries(statuses.map((s) => [s, delivery("EMAIL", s)])) },
          { channel: "SMS", ...Object.fromEntries(statuses.map((s) => [s, delivery("SMS", s)])) },
          { channel: "In-app", SENT: data.in_app.sent, PENDING: 0, FAILED: 0, SKIPPED: 0 },
        ],
      },
    ],
    ["Owner activity: actions are the owner's own entries in the audit log in the period. Last sign-in is shown as a date (Colombo)."],
  );
}
