/**
 * What the report functions of migration 0034 return (jsonb), as plain data.
 * Money is integer cents; dates are ISO calendar dates (Colombo).
 */

export interface IncomeMonthRow {
  month: string;
  commitment_cents: number;
  excess_cents: number;
  other_cents: number;
  /** Negative: estimate, dispute, service-discount and manual credits on bills. */
  discount_cents: number;
  invoices: number;
  payments_cents: number;
  advances_cents: number;
  deposits_kept_cents: number;
  /** Negative: credit refunds. */
  refunds_cents: number;
}

export interface MachineRow {
  id: string;
  brand: string;
  model: string;
  serial_no: string;
  type: "MONO" | "COLOUR";
  status: string;
  customer: string | null;
  revenue_cents: number;
  commitment_cents: number;
  bw_excess_cents: number;
  colour_excess_cents: number;
  other_cents: number;
  bw_copies: number;
  colour_copies: number;
  service_cost_cents: number;
  toner_cost_cents: number;
  requests: number;
  toner_requests: number;
}

export interface CustomerRow {
  id: string;
  name: string;
  business_name: string | null;
  status: string;
  machines: number;
  invoiced_cents: number;
  invoices: number;
  collected_cents: number;
  outstanding_cents: number;
  overdue_cents: number;
  credit_cents: number;
  paid_bills: number;
  paid_on_time: number;
  avg_days_to_pay: number | null;
}

export interface ServiceDemand {
  total: number;
  open: number;
  by_type: Record<string, number>;
  by_urgency: Record<string, number>;
  by_month: { month: string; requests: number; toner: number }[];
  toner_colours: Record<string, number>;
  avg_ack_hours: number | null;
  avg_resolve_hours: number | null;
  avg_rating: number | null;
  ratings: number;
  by_machine: { id: string; name: string; requests: number; toner: number; breakdowns: number }[];
  by_customer: { id: string; name: string; requests: number; toner: number }[];
  toner_history: { id: string; name: string; type: "MONO" | "COLOUR"; dates: string[] | null }[];
}

export interface UsageRow {
  month: string;
  machine_id: string;
  machine: string;
  customer_id: string;
  customer: string;
  bw: number;
  colour: number;
}

export interface RentalData {
  machines: Record<string, number>;
  notice_days: number | null;
  agreements: {
    id: string;
    start_date: string;
    end_date: string | null;
    next_cycle_date: string;
    monthly_commitment_cents: number;
    days_left: number | null;
    customer: string;
    machine: string;
    type: "MONO" | "COLOUR";
  }[];
}

export interface CycleStatus {
  tickets: number;
  by_status: Record<string, number>;
  avg_hours: Record<string, number>;
  late_tickets: number;
  went_overdue: number;
  late_readings: number;
  escalations: number;
  reminders: number;
}

export interface AgeingInvoiceRow {
  id: string;
  invoice_no: string;
  customer_id: string;
  customer_name: string;
  status: string;
  due_date: string | null;
  balance_cents: number;
}

export interface OwnerDashboard {
  today: string;
  collected_this_month: number;
  collected_last_month: number;
  collected_last_month_to_date: number;
  invoiced_this_month: number;
  invoiced_last_month: number;
  outstanding_cents: number;
  overdue_cents: number;
  overdue_bills: number;
  readings_to_review: number;
  slips_to_verify: number;
  tickets_by_status: Record<string, number>;
  tickets_escalated: number;
  service: {
    total: number;
    by_urgency: Record<string, number>;
    by_type: Record<string, number>;
    overdue: number;
    to_confirm: number;
    top: {
      id: string;
      type: string;
      urgency: string;
      status: string;
      customer: string;
      overdue: boolean;
      toner_colours: string[];
      part_name: string | null;
    }[];
  };
  deposits: { count: number; held_cents: number };
  machines: Record<string, number>;
  machines_in_service: number;
  rating: { average: number | null; count: number };
  ending_soon: number;
  top_machines: { id: string; name: string; revenue_cents: number }[];
  recent_payments: { id: string; paid_on: string; status: string; amount_cents: number; method: string; customer: string }[];
}

export interface CustomerDashboard {
  outstanding_cents: number;
  credit_cents: number;
  machines: {
    agreement_id: string;
    name: string;
    serial_no: string;
    type: "MONO" | "COLOUR";
    next_cycle_date: string;
    end_date: string | null;
    location: string | null;
  }[];
  latest_invoice: {
    id: string;
    invoice_no: string;
    status: string;
    total_cents: number;
    amount_paid_cents: number;
    due_date: string | null;
    issued_at: string | null;
    has_pdf: boolean;
  } | null;
  recent_payments: { id: string; paid_on: string; status: string; amount_cents: number; accepted_amount_cents: number | null }[];
  open_requests: { id: string; type: string; status: string; urgency: string; toner_colours: string[]; part_name: string | null; machine: string }[];
}

export interface AdminDashboard {
  owners: Record<string, number>;
  customers: Record<string, number>;
  machines: Record<string, number>;
  open_tickets: number;
  escalated_tickets: number;
  open_requests: number;
  invoices_this_month: { count: number; total_cents: number };
  email: { sent_today: number; sent_month: number; failed_month: number; pending: number; daily_limit: number; monthly_limit: number };
  job: {
    last_success: string | null;
    last_run: { started_at: string; finished_at: string | null; status: string; remaining: boolean } | null;
    failed_7d: number;
  };
}

export interface AdminActivity {
  months: { month: string; owners: number; customers: number; machines: number; invoices: number }[];
  owners: {
    id: string;
    business_name: string;
    status: string;
    last_login_at: string | null;
    customers: number;
    machines: number;
    invoices: number;
    open_tickets: number;
    escalated: number;
    actions: number;
  }[];
  deliveries: Record<string, number>;
  in_app: { sent: number; read: number };
}
