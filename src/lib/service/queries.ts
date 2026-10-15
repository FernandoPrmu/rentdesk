import "server-only";

import { z } from "zod";

import { must } from "@/lib/actions/errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { acknowledgeBy, SERVICE_DEFAULTS, type ServiceSettings } from "./rules";
import { ACTIVE_STATUSES, OPEN_STATUSES, SERVICE_STATUSES, SERVICE_TYPES, type ServiceStatus, type ServiceType, type TonerColour, type Urgency, URGENCIES, URGENCY_RANK } from "./states";

/**
 * Service request screens (SRV-05, CP-07, MAC-05, CUS-04, RPT-01, ADM escalations).
 * They run as the signed-in user, so RLS decides what is visible: an owner their
 * tenant, a customer their own requests, an admin everything. Photos are read
 * through 5-minute signed links made with the same client (storage RLS: the owner
 * reads only photos sent with a request).
 */

const SIGNED_URL_SECONDS = 5 * 60;

export const STATUS_FILTERS = ["OPEN", "ALL", ...SERVICE_STATUSES] as const;
export const serviceFilterSchema = z.object({
  status: z.enum(STATUS_FILTERS).catch("OPEN").default("OPEN"),
  urgency: z.enum(URGENCIES).optional().catch(undefined),
  type: z.enum(SERVICE_TYPES).optional().catch(undefined),
  machine: z.uuid().optional().catch(undefined),
  customer: z.uuid().optional().catch(undefined),
});
export type ServiceFilter = z.output<typeof serviceFilterSchema>;

const LIST_COLUMNS = `id, status, type, urgency, toner_colours, part_name, description, created_at, acknowledged_at, resolved_at, closed_at,
  escalation_level, assigned_to_name, planned_date, rating, reopen_count, charge_cents, owner_id,
  machine:machines!service_requests_machine_fkey(id, brand, model, serial_no, type),
  customer:customers!service_requests_customer_fkey(id, name)`;

export interface ServiceRow {
  id: string;
  status: ServiceStatus;
  type: ServiceType;
  urgency: Urgency;
  tonerColours: TonerColour[];
  partName: string | null;
  description: string;
  createdAt: string;
  resolvedAt: string | null;
  escalationLevel: number;
  technician: string | null;
  plannedDate: string | null;
  rating: number | null;
  reopenCount: number;
  machine: { id: string; name: string; serialNo: string; type: "MONO" | "COLOUR" };
  customer: { id: string; name: string };
  /** Still New after the acknowledgement time (decision 61). */
  overdue: boolean;
}

type RawRow = {
  id: string;
  status: string;
  type: string;
  urgency: string;
  toner_colours: string[];
  part_name: string | null;
  description: string;
  created_at: string;
  resolved_at: string | null;
  escalation_level: number;
  assigned_to_name: string | null;
  planned_date: string | null;
  rating: number | null;
  reopen_count: number;
  machine: { id: string; brand: string; model: string; serial_no: string; type: "MONO" | "COLOUR" };
  customer: { id: string; name: string };
};

function toRow(r: RawRow, settings: ServiceSettings, now: Date): ServiceRow {
  const status = r.status as ServiceStatus;
  const urgency = r.urgency as Urgency;
  return {
    id: r.id,
    status,
    type: r.type as ServiceType,
    urgency,
    tonerColours: r.toner_colours as TonerColour[],
    partName: r.part_name,
    description: r.description,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    escalationLevel: r.escalation_level,
    technician: r.assigned_to_name,
    plannedDate: r.planned_date,
    rating: r.rating,
    reopenCount: r.reopen_count,
    machine: { id: r.machine.id, name: `${r.machine.brand} ${r.machine.model}`, serialNo: r.machine.serial_no, type: r.machine.type },
    customer: { id: r.customer.id, name: r.customer.name },
    overdue: status === "NEW" && acknowledgeBy(new Date(r.created_at), urgency, settings).getTime() <= now.getTime(),
  };
}

/** Open first (URGENT and HIGH at the top, decision 62), then the newest. */
export function sortRequests(rows: ServiceRow[]): ServiceRow[] {
  const open = (s: ServiceStatus) => (OPEN_STATUSES.includes(s) ? 0 : 1);
  return [...rows].sort(
    (a, b) =>
      open(a.status) - open(b.status) ||
      (open(a.status) === 0 ? URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] : 0) ||
      b.createdAt.localeCompare(a.createdAt),
  );
}

async function ownerSettings(ownerId: string | null): Promise<ServiceSettings> {
  if (!ownerId) return SERVICE_DEFAULTS;
  const supabase = await createClient();
  const data = must(
    await supabase
      .from("owner_settings_effective")
      .select("service_ack_hours_urgent, service_ack_hours_normal, service_admin_escalation_hours_urgent, service_admin_escalation_hours_normal")
      .eq("owner_id", ownerId)
      .maybeSingle(),
    "owner settings",
  );
  return (data as ServiceSettings | null) ?? SERVICE_DEFAULTS;
}

/** Owner: the service requests list with filters (status, urgency, type, machine, customer). */
export async function listOwnerRequests(ownerId: string, filter: ServiceFilter): Promise<ServiceRow[]> {
  const supabase = await createClient();
  let query = supabase.from("service_requests").select(LIST_COLUMNS).eq("owner_id", ownerId);
  if (filter.status === "OPEN") query = query.in("status", [...OPEN_STATUSES]);
  else if (filter.status !== "ALL") query = query.eq("status", filter.status);
  if (filter.urgency) query = query.eq("urgency", filter.urgency);
  if (filter.type) query = query.eq("type", filter.type);
  if (filter.machine) query = query.eq("machine_id", filter.machine);
  if (filter.customer) query = query.eq("customer_id", filter.customer);
  const [{ data, error }, settings] = await Promise.all([query.order("created_at", { ascending: false }).limit(300), ownerSettings(ownerId)]);
  if (error) throw new Error(`service requests: ${error.message}`);
  const now = new Date();
  return sortRequests((data as unknown as RawRow[]).map((r) => toRow(r, settings, now)));
}

/** Owner Home card: open requests by urgency and type (spec 10.1), URGENT and HIGH first. */
export async function openRequestSummary(ownerId: string) {
  const rows = await listOwnerRequests(ownerId, { status: "OPEN" });
  const byUrgency = Object.fromEntries(URGENCIES.map((u) => [u, rows.filter((r) => r.urgency === u).length])) as Record<Urgency, number>;
  const byType = Object.fromEntries(SERVICE_TYPES.map((t) => [t, rows.filter((r) => r.type === t).length])) as Record<ServiceType, number>;
  return {
    total: rows.length,
    byUrgency,
    byType,
    overdue: rows.filter((r) => r.overdue).length,
    escalated: rows.filter((r) => r.escalationLevel > 0 && r.status === "NEW").length,
    toConfirm: rows.filter((r) => r.status === "RESOLVED").length,
    /** The top of the list: URGENT and HIGH first. */
    top: rows.slice(0, 5),
  };
}

/** Customer: "My requests", open first. */
export async function listCustomerRequests(customerId: string): Promise<ServiceRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("service_requests").select(LIST_COLUMNS).eq("customer_id", customerId).order("created_at", { ascending: false }).limit(200);
  if (error) throw new Error(`service requests: ${error.message}`);
  const now = new Date();
  return sortRequests((data as unknown as RawRow[]).map((r) => toRow(r, SERVICE_DEFAULTS, now)));
}

/** MAC-05: the service history of a machine (owner), newest first. */
export async function listMachineRequests(machineId: string): Promise<ServiceRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("service_requests").select(LIST_COLUMNS).eq("machine_id", machineId).order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(`machine service: ${error.message}`);
  const now = new Date();
  return (data as unknown as RawRow[]).map((r) => toRow(r, SERVICE_DEFAULTS, now));
}

/**
 * The owner's own service cost on a machine (SRV-07, for RPT-03 later). Clients
 * cannot read cost_cents (0031): call it only after RLS showed the machine is the
 * owner's (getMachine).
 */
export async function machineServiceCost(machineId: string): Promise<number> {
  const { data, error } = await createAdminClient().from("service_requests").select("cost_cents").eq("machine_id", machineId).not("cost_cents", "is", null);
  if (error) throw new Error(`service cost: ${error.message}`);
  return data.reduce((total, r) => total + (r.cost_cents ?? 0), 0);
}

/** CUS-04: a customer's requests and their average rating (owner). */
export async function listCustomerServiceHistory(customerId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.from("service_requests").select(LIST_COLUMNS).eq("customer_id", customerId).order("created_at", { ascending: false }).limit(100);
  if (error) throw new Error(`customer service: ${error.message}`);
  const now = new Date();
  const rows = (data as unknown as RawRow[]).map((r) => toRow(r, SERVICE_DEFAULTS, now));
  return { rows, rating: averageRating(rows.map((r) => r.rating)) };
}

/** SRV-09: the average of the given ratings (one decimal), or null when none. */
export function averageRating(ratings: (number | null)[]): { average: number; count: number } | null {
  const given = ratings.filter((r): r is number => r !== null);
  if (given.length === 0) return null;
  return { average: Math.round((given.reduce((a, b) => a + b, 0) / given.length) * 10) / 10, count: given.length };
}

/** Machines with a request New through In progress ("Service in progress" badge; the machine stays Rented). */
export async function machinesInService(machineIds: string[]): Promise<Set<string>> {
  if (machineIds.length === 0) return new Set();
  const supabase = await createClient();
  const { data, error } = await supabase.from("service_requests").select("machine_id").in("machine_id", machineIds).in("status", [...ACTIVE_STATUSES]);
  if (error) throw new Error(`machines in service: ${error.message}`);
  return new Set(data.map((r) => r.machine_id));
}

/** Customer Home: requests waiting for them (confirm the repair, rate the service). */
export async function customerServiceTasks(customerId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("service_requests")
    .select(LIST_COLUMNS)
    .eq("customer_id", customerId)
    .or("status.eq.RESOLVED,and(status.eq.CLOSED,rating.is.null)")
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(`service tasks: ${error.message}`);
  const now = new Date();
  const rows = (data as unknown as RawRow[]).map((r) => toRow(r, SERVICE_DEFAULTS, now));
  return { toConfirm: rows.filter((r) => r.status === "RESOLVED"), toRate: rows.filter((r) => r.status === "CLOSED") };
}

export interface TrailEntry {
  id: string;
  kind: "STATUS" | "NOTE" | "ASSIGNMENT" | "ESCALATION" | "RATING" | "CHARGE";
  from: ServiceStatus | null;
  to: ServiceStatus;
  note: string | null;
  at: string;
  by: { name: string; role: string } | null;
  metadata: Record<string, unknown>;
}

export interface ChargeState {
  amountCents: number;
  description: string;
  /** On a bill: its number, or null while that bill waits for review. */
  invoice: { id: string; invoiceNo: string | null; status: string } | null;
}

/**
 * One request with its trail, photo link, charge and discount. Owner, admin and
 * the request's customer only (RLS); null otherwise. Clients cannot read the
 * owner's own cost (migration 0031): `withCost` reads it on the server, for the
 * owner's page, once RLS has shown the row is theirs.
 */
export async function getRequest(id: string, options: { withCost?: boolean } = {}) {
  const supabase = await createClient();
  const { data: r, error } = await supabase
    .from("service_requests")
    .select(
      `${LIST_COLUMNS}, agreement_id, preferred_date, work_done, parts_used, charge_description, rating_comment, rated_at,
       cancel_reason, cancelled_at, photo_path, photo_mime,
       history:service_request_history!service_request_history_request_fkey(id, kind, from_status, to_status, note, changed_at, metadata,
         actor:profiles!service_request_history_changed_by_fkey(full_name, username, role))`,
    )
    .eq("id", id)
    .order("changed_at", { referencedTable: "service_request_history", ascending: true })
    .maybeSingle();
  if (error) throw new Error(`service request: ${error.message}`);
  if (!r) return null;

  const [photo, invoices, discount, settings, cost] = await Promise.all([
    r.photo_path ? supabase.storage.from("service-photos").createSignedUrl(r.photo_path, SIGNED_URL_SECONDS) : null,
    r.charge_cents && r.agreement_id
      ? supabase.from("invoices").select("id, invoice_no, status, calculation").eq("agreement_id", r.agreement_id).not("status", "in", "(REJECTED,CANCELLED)")
      : null,
    supabase.from("credits").select("id, amount_cents, reason, status").eq("service_request_id", r.id).maybeSingle(),
    ownerSettings(r.owner_id),
    options.withCost ? createAdminClient().from("service_requests").select("cost_cents").eq("id", r.id).single() : null,
  ]);
  const billedOn = invoices?.data?.find((i) => ((i.calculation as { service_charges?: { id: string }[] } | null)?.service_charges ?? []).some((c) => c.id === r.id));
  const charge: ChargeState | null =
    r.charge_cents && r.charge_description
      ? { amountCents: r.charge_cents, description: r.charge_description, invoice: billedOn ? { id: billedOn.id, invoiceNo: billedOn.invoice_no, status: billedOn.status } : null }
      : null;

  const row = toRow(r as unknown as RawRow, settings, new Date());
  return {
    ...row,
    agreementId: r.agreement_id,
    preferredDate: r.preferred_date,
    workDone: r.work_done,
    partsUsed: r.parts_used,
    costCents: cost?.data?.cost_cents ?? null,
    ratingComment: r.rating_comment,
    ratedAt: r.rated_at,
    cancelReason: r.cancel_reason,
    acknowledgeBy: acknowledgeBy(new Date(r.created_at), row.urgency, settings).toISOString(),
    photo: r.photo_path ? { url: photo?.data?.signedUrl ?? null, mime: r.photo_mime ?? "image/jpeg" } : null,
    charge,
    discount: discount.data ? { amountCents: discount.data.amount_cents, reason: discount.data.reason, status: discount.data.status } : null,
    trail: r.history.map(
      (h): TrailEntry => ({
        id: h.id,
        kind: h.kind as TrailEntry["kind"],
        from: h.from_status as ServiceStatus | null,
        to: h.to_status as ServiceStatus,
        note: h.note,
        at: h.changed_at,
        by: h.actor ? { name: h.actor.full_name || h.actor.username, role: h.actor.role } : null,
        metadata: (h.metadata ?? {}) as Record<string, unknown>,
      }),
    ),
  };
}

export type ServiceDetail = NonNullable<Awaited<ReturnType<typeof getRequest>>>;

/** Admin › Escalations: requests still not acknowledged after the admin time (level 2). */
export async function listServiceEscalations() {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("service_requests")
    .select(`${LIST_COLUMNS}, escalated_at, owner:owners!service_requests_owner_id_fkey(id, business_name)`)
    .gte("escalation_level", 2)
    .eq("status", "NEW")
    .order("created_at")
    .limit(300);
  if (error) throw new Error(`service escalations: ${error.message}`);
  const now = new Date();
  return (data as unknown as (RawRow & { escalated_at: string | null; owner: { id: string; business_name: string } })[]).map((r) => ({
    ...toRow(r, SERVICE_DEFAULTS, now),
    escalatedAt: r.escalated_at,
    owner: r.owner,
  }));
}
