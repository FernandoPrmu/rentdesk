import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import {
  type BuildContext,
  buildAgeing,
  buildCustomers,
  buildCycles,
  buildIncome,
  buildMachines,
  buildPlatform,
  buildRental,
  buildService,
  buildUsage,
} from "@/lib/reports/build";
import { REPORT_INFO, type OwnerReportId } from "@/lib/reports/catalogue";
import type { ReportDocument } from "@/lib/reports/document";
import type { DateRange } from "@/lib/reports/period";
import type {
  AdminActivity,
  AdminDashboard,
  AgeingInvoiceRow,
  CustomerDashboard,
  CustomerRow,
  CycleStatus,
  IncomeMonthRow,
  MachineRow,
  OwnerDashboard,
  RentalData,
  ServiceDemand,
  UsageRow,
} from "@/lib/reports/types";
import { createClient } from "@/lib/supabase/server";
import type { Database } from "@/types/db";

/**
 * Report and dashboard reads (RPT-01..08, CP-01, ADM-04). Each is one call to a
 * report function of migration 0034, made with the signed-in user's client: the
 * functions are security invoker, so RLS decides what they see (an owner their
 * tenant, an admin any owner in the support view, a customer their own rows).
 */

type Client = SupabaseClient<Database>;

async function call<T>(client: Client, fn: string, args: Record<string, unknown>): Promise<T> {
  // The report functions are typed in db.ts; the jsonb result is cast here once.
  const { data, error } = await (client.rpc as unknown as (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>)(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data as T;
}

export async function ownerDashboard(ownerId: string, today = todayInColombo(), client?: Client): Promise<OwnerDashboard> {
  return call(client ?? (await createClient()), "report_owner_dashboard", { p_owner_id: ownerId, p_today: today });
}

export async function customerDashboard(): Promise<CustomerDashboard> {
  return call(await createClient(), "report_customer_dashboard", {});
}

/**
 * The customer Home summary, or null when it cannot be read now (a slow free-tier
 * database): the tasks above it must still show (task 11).
 */
export async function customerDashboardOrNull(): Promise<CustomerDashboard | null> {
  try {
    return await customerDashboard();
  } catch (error) {
    console.error("[customer summary]", error instanceof Error ? error.message : error);
    return null;
  }
}

export async function adminDashboard(now = new Date()): Promise<AdminDashboard | null> {
  return call(await createClient(), "report_admin_dashboard", { p_today: todayInColombo(now), p_now: now.toISOString() });
}

/** The company name on owner reports (RLS: the owner, or an admin). */
export async function companyName(client: Client, ownerId: string): Promise<string> {
  const { data } = await client.from("owner_company_profiles").select("company_name").eq("owner_id", ownerId).maybeSingle();
  if (data?.company_name) return data.company_name;
  const { data: owner } = await client.from("owners").select("business_name").eq("id", ownerId).maybeSingle();
  return owner?.business_name ?? "RentDesk";
}

/** Raw data next to the document, for the charts on screen. */
export type OwnerReportData =
  | { report: "income"; rows: IncomeMonthRow[] }
  | { report: "machines"; rows: MachineRow[] }
  | { report: "customers"; rows: CustomerRow[] }
  | { report: "ageing"; rows: AgeingInvoiceRow[] }
  | { report: "service"; data: ServiceDemand }
  | { report: "usage"; rows: UsageRow[] }
  | { report: "rental"; data: RentalData }
  | { report: "cycles"; data: CycleStatus };

export interface LoadedReport {
  doc: ReportDocument;
  data: OwnerReportData;
}

/**
 * One owner report as a document (screen, PDF and Excel). `client` is the
 * signed-in user's; two calls: the report function and the company name.
 */
export async function loadOwnerReport(
  report: OwnerReportId,
  ownerId: string,
  range: DateRange,
  options: { client?: Client; today?: string; now?: Date } = {},
): Promise<LoadedReport> {
  const client = options.client ?? (await createClient());
  const now = options.now ?? new Date();
  const today = options.today ?? todayInColombo(now);
  const ranged = { p_owner_id: ownerId, p_from: range.from, p_to: range.to };
  const companyP = companyName(client, ownerId);
  const ctx = async (): Promise<BuildContext> => ({ range, today, company: await companyP, generatedAt: now.toISOString() });

  switch (report) {
    case "income": {
      const r = await call<{ months: IncomeMonthRow[] }>(client, "report_income", ranged);
      return { doc: buildIncome(r.months, await ctx()), data: { report, rows: r.months } };
    }
    case "machines": {
      const r = await call<{ machines: MachineRow[] }>(client, "report_machines", ranged);
      return { doc: buildMachines(r.machines, await ctx()), data: { report, rows: r.machines } };
    }
    case "customers": {
      const r = await call<{ customers: CustomerRow[] }>(client, "report_customers", ranged);
      return { doc: buildCustomers(r.customers, await ctx()), data: { report, rows: r.customers } };
    }
    case "ageing": {
      const rows = await call<AgeingInvoiceRow[]>(client, "report_ageing_invoices", { p_owner_id: ownerId });
      return { doc: buildAgeing(rows, await ctx()), data: { report, rows } };
    }
    case "service": {
      const data = await call<ServiceDemand>(client, "report_service_demand", ranged);
      return { doc: buildService(data, await ctx()), data: { report, data } };
    }
    case "usage": {
      const r = await call<{ rows: UsageRow[] }>(client, "report_usage", ranged);
      return { doc: buildUsage(r.rows, await ctx()), data: { report, rows: r.rows } };
    }
    case "rental": {
      const data = await call<RentalData>(client, "report_rental", { p_owner_id: ownerId, p_today: today });
      return { doc: buildRental(data, await ctx()), data: { report, data } };
    }
    case "cycles": {
      const data = await call<CycleStatus>(client, "report_cycle_status", ranged);
      return { doc: buildCycles(data, await ctx()), data: { report, data } };
    }
  }
}

/** RPT-08 (admins only; the function returns null for anyone else). */
export async function loadPlatformReport(range: DateRange, options: { client?: Client; now?: Date } = {}): Promise<{ doc: ReportDocument; data: AdminActivity } | null> {
  const client = options.client ?? (await createClient());
  const now = options.now ?? new Date();
  const data = await call<AdminActivity | null>(client, "report_admin_activity", { p_from: range.from, p_to: range.to });
  if (!data) return null;
  return { doc: buildPlatform(data, { range, today: todayInColombo(now), company: "RentDesk", generatedAt: now.toISOString() }), data };
}

export const reportTitle = (id: OwnerReportId) => REPORT_INFO[id].title;
