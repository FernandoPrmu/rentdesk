import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { ReportSection } from "@/lib/reports/document";
import { STATUS_LABEL as SERVICE_STATUS_LABEL, type ServiceStatus, TYPE_LABEL, type ServiceType, URGENCY_LABEL, type Urgency } from "@/lib/service/states";
import { INVOICE_STATUS_LABEL, PAYMENT_METHOD_LABEL, PAYMENT_STATUS_LABEL, TICKET_STATUS_LABEL } from "@/lib/status-labels";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * ADM-08 (decision 81): the admin's read-only support view of one owner. Every page
 * writes a SUPPORT_VIEW audit entry first (who, when, which owner, which page,
 * optional reason). The pages read with the admin's own client (RLS: admins read
 * every tenant) filtered to the owner, render no forms or actions, and the admin's
 * database role cannot write tenant data anyway (no write policies for admins; the
 * workflow rpcs check the actor is the owner).
 */

export const SUPPORT_SECTIONS = ["customers", "machines", "tickets", "invoices", "payments", "service"] as const;
export type SupportSection = (typeof SUPPORT_SECTIONS)[number];

export const SECTION_LABEL: Record<SupportSection, string> = {
  customers: "Customers",
  machines: "Machines",
  tickets: "Billing tickets",
  invoices: "Invoices",
  payments: "Payments",
  service: "Service requests",
};

export const supportBase = (ownerId: string) => `/admin/owners/${ownerId}/support`;

/** Logs the view, then returns the owner (or the not-found page). Call first on every support page. */
export async function openSupportView(admin: CurrentUser, ownerId: string, path: string, reason?: string | null): Promise<{ id: string; business_name: string }> {
  if (!z.uuid().safeParse(ownerId).success) notFound();
  const supabase = await createClient();
  const { data: owner } = await supabase.from("owners").select("id, business_name").eq("id", ownerId).maybeSingle();
  if (!owner) notFound();
  const { error } = await createAdminClient().rpc("rpc_log_support_view", {
    p_admin_id: admin.id,
    p_owner_id: ownerId,
    p_path: path.slice(0, 300),
    p_reason: reason?.trim() ? reason.trim().slice(0, 300) : undefined,
  });
  // No log, no view.
  if (error) throw new Error(`support view log: ${error.message}`);
  return owner;
}

const LIMIT = 300;
const colomboDay = (ts: string) => todayInColombo(new Date(ts));
const label = (s: string | null | undefined) => (s ? s.charAt(0) + s.slice(1).toLowerCase().replaceAll("_", " ") : null);

/** One read-only list of the owner's records. `status` filters where it makes sense. */
export async function supportList(section: SupportSection, ownerId: string, status?: string): Promise<ReportSection> {
  const supabase = await createClient();
  switch (section) {
    case "customers": {
      const [{ data, error }, balances] = await Promise.all([
        supabase.from("customers").select("id, name, business_name, phone, profile:profiles!customers_profile_fkey!inner(username, status)").eq("owner_id", ownerId).order("name").limit(LIMIT),
        supabase.from("customer_balances").select("customer_id, outstanding_cents").eq("owner_id", ownerId),
      ]);
      if (error) throw new Error(`support customers: ${error.message}`);
      const owed = new Map((balances.data ?? []).map((b) => [b.customer_id, b.outstanding_cents]));
      return {
        title: SECTION_LABEL.customers,
        columns: [
          { key: "name", label: "Customer", type: "text" },
          { key: "username", label: "Username", type: "text" },
          { key: "phone", label: "Phone", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "outstanding", label: "Outstanding", type: "money" },
        ],
        rows: data.map((c) => ({
          name: c.business_name ? `${c.name} (${c.business_name})` : c.name,
          username: c.profile.username,
          phone: c.phone,
          status: label(c.profile.status),
          outstanding: owed.get(c.id) ?? 0,
        })),
        empty: "No customers.",
      };
    }
    case "machines": {
      let q = supabase.from("machines").select("id, brand, model, serial_no, type, status").eq("owner_id", ownerId).order("brand").limit(LIMIT);
      const machineStatus = z.enum(["AVAILABLE", "RENTED", "UNDER_REPAIR", "RETIRED"]).safeParse(status);
      if (machineStatus.success) q = q.eq("status", machineStatus.data);
      const [{ data, error }, live] = await Promise.all([
        q,
        supabase.from("rental_agreements").select("machine_id, customer:customers!rental_agreements_customer_fkey(name)").eq("owner_id", ownerId).eq("status", "ACTIVE"),
      ]);
      if (error) throw new Error(`support machines: ${error.message}`);
      const rentedTo = new Map((live.data ?? []).map((a) => [a.machine_id, a.customer.name]));
      return {
        title: SECTION_LABEL.machines,
        columns: [
          { key: "machine", label: "Machine", type: "text" },
          { key: "type", label: "Type", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "customer", label: "Rented to", type: "text" },
        ],
        rows: data.map((m) => ({ machine: `${m.brand} ${m.model} (${m.serial_no})`, type: label(m.type), status: label(m.status), customer: rentedTo.get(m.id) ?? null })),
        empty: "No machines.",
      };
    }
    case "tickets": {
      let q = supabase
        .from("billing_cycle_tickets")
        .select("id, cycle_no, cycle_date, status, stage_due_at, escalation_level, customer:customers!billing_cycle_tickets_customer_fkey(name), machine:machines!billing_cycle_tickets_machine_fkey(brand, model, serial_no)")
        .eq("owner_id", ownerId)
        .order("cycle_date", { ascending: false })
        .limit(LIMIT);
      if (status === "ESCALATED") q = q.gt("escalation_level", 0).not("status", "in", "(CLOSED,CANCELLED)");
      else if (status && status in TICKET_STATUS_LABEL) q = q.eq("status", status as never);
      else q = q.not("status", "in", "(CLOSED,CANCELLED)");
      const { data, error } = await q;
      if (error) throw new Error(`support tickets: ${error.message}`);
      return {
        title: SECTION_LABEL.tickets,
        columns: [
          { key: "customer", label: "Customer", type: "text" },
          { key: "machine", label: "Machine", type: "text" },
          { key: "cycle", label: "Cycle", type: "count" },
          { key: "cycle_date", label: "Cycle date", type: "date" },
          { key: "status", label: "Stage", type: "text" },
          { key: "due", label: "Stage due", type: "date" },
        ],
        rows: data.map((t) => ({
          customer: t.customer.name,
          machine: `${t.machine.brand} ${t.machine.model} (${t.machine.serial_no})`,
          cycle: t.cycle_no,
          cycle_date: t.cycle_date,
          status: `${TICKET_STATUS_LABEL[t.status] ?? t.status}${t.escalation_level > 0 ? " (escalated)" : ""}`,
          due: t.stage_due_at ? colomboDay(t.stage_due_at) : null,
        })),
        empty: "No tickets match.",
      };
    }
    case "invoices": {
      const { data, error } = await supabase
        .from("invoices")
        .select("invoice_no, issued_at, due_date, status, total_cents, amount_paid_cents, customer:customers!invoices_customer_fkey(name)")
        .eq("owner_id", ownerId)
        .not("invoice_no", "is", null)
        .order("issued_at", { ascending: false })
        .limit(LIMIT);
      if (error) throw new Error(`support invoices: ${error.message}`);
      return {
        title: SECTION_LABEL.invoices,
        columns: [
          { key: "invoice_no", label: "Bill", type: "text" },
          { key: "customer", label: "Customer", type: "text" },
          { key: "issued", label: "Issued", type: "date" },
          { key: "due", label: "Due", type: "date" },
          { key: "status", label: "Status", type: "text" },
          { key: "total", label: "Total", type: "money" },
          { key: "paid", label: "Paid", type: "money" },
        ],
        rows: data.map((i) => ({
          invoice_no: i.invoice_no,
          customer: i.customer.name,
          issued: i.issued_at ? colomboDay(i.issued_at) : null,
          due: i.due_date,
          status: INVOICE_STATUS_LABEL[i.status] ?? i.status,
          total: i.total_cents,
          paid: i.amount_paid_cents,
        })),
        empty: "No invoices.",
      };
    }
    case "payments": {
      let q = supabase
        .from("payments")
        .select("paid_on, status, amount_cents, accepted_amount_cents, method, reference, customer:customers!payments_customer_fkey(name)")
        .eq("owner_id", ownerId)
        .order("submitted_at", { ascending: false })
        .limit(LIMIT);
      if (status === "TO_VERIFY") q = q.eq("status", "SUBMITTED");
      const { data, error } = await q;
      if (error) throw new Error(`support payments: ${error.message}`);
      return {
        title: SECTION_LABEL.payments,
        columns: [
          { key: "paid_on", label: "Paid on", type: "date" },
          { key: "customer", label: "Customer", type: "text" },
          { key: "method", label: "Method", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "amount", label: "Amount", type: "money" },
        ],
        rows: data.map((p) => ({
          paid_on: p.paid_on,
          customer: p.customer.name,
          method: PAYMENT_METHOD_LABEL[p.method] ?? p.method,
          status: PAYMENT_STATUS_LABEL[p.status] ?? p.status,
          amount: p.accepted_amount_cents ?? p.amount_cents,
        })),
        empty: "No payments.",
      };
    }
    case "service": {
      let q = supabase
        .from("service_requests")
        .select("created_at, type, urgency, status, customer:customers!service_requests_customer_fkey(name), machine:machines!service_requests_machine_fkey(brand, model, serial_no)")
        .eq("owner_id", ownerId)
        .order("created_at", { ascending: false })
        .limit(LIMIT);
      const urgency = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).safeParse(status);
      if (urgency.success) q = q.eq("urgency", urgency.data).in("status", ["NEW", "ACKNOWLEDGED", "ASSIGNED", "IN_PROGRESS", "RESOLVED"]);
      else if (status === "CLOSED") q = q.eq("status", "CLOSED");
      const { data, error } = await q;
      if (error) throw new Error(`support service: ${error.message}`);
      return {
        title: SECTION_LABEL.service,
        columns: [
          { key: "request", label: "Request", type: "text" },
          { key: "customer", label: "Customer", type: "text" },
          { key: "machine", label: "Machine", type: "text" },
          { key: "urgency", label: "Urgency", type: "text" },
          { key: "status", label: "Status", type: "text" },
          { key: "created", label: "Raised", type: "date" },
        ],
        rows: data.map((r) => ({
          request: TYPE_LABEL[r.type as ServiceType] ?? r.type,
          customer: r.customer.name,
          machine: `${r.machine.brand} ${r.machine.model} (${r.machine.serial_no})`,
          urgency: URGENCY_LABEL[r.urgency as Urgency] ?? r.urgency,
          status: SERVICE_STATUS_LABEL[r.status as ServiceStatus] ?? r.status,
          created: colomboDay(r.created_at),
        })),
        empty: "No service requests match.",
      };
    }
  }
}
