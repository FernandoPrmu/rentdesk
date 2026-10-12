import type { RangePreset } from "./period.ts";

/** The reports (spec 10.2, 10.3; RPT-02..08). */

export const OWNER_REPORTS = ["income", "machines", "customers", "ageing", "service", "usage", "rental", "cycles"] as const;
export type OwnerReportId = (typeof OWNER_REPORTS)[number];
export const ADMIN_REPORTS = ["platform"] as const;
export type AdminReportId = (typeof ADMIN_REPORTS)[number];
export type ReportId = OwnerReportId | AdminReportId;

export interface ReportInfo {
  title: string;
  description: string;
  /** Requirement IDs (for docs and the index page). */
  ids: string;
  /** Has a date range; otherwise it shows today's position. */
  range: boolean;
  defaultPreset: Exclude<RangePreset, "custom">;
}

export const REPORT_INFO: Record<ReportId, ReportInfo> = {
  income: {
    title: "Monthly income and sales",
    description: "Commitment and excess charges invoiced, and money collected, by month.",
    ids: "RPT-02",
    range: true,
    defaultPreset: "last_12_months",
  },
  machines: {
    title: "Machine performance",
    description: "Revenue, copies, excess charges, service and toner cost and profit per machine.",
    ids: "RPT-03",
    range: true,
    defaultPreset: "last_3_months",
  },
  customers: {
    title: "Customers",
    description: "Bills, payments, balance and payment behaviour per customer.",
    ids: "RPT-05",
    range: true,
    defaultPreset: "last_3_months",
  },
  ageing: {
    title: "Outstanding and ageing",
    description: "Unpaid bills grouped by how many days they are overdue.",
    ids: "RPT-04",
    range: false,
    defaultPreset: "this_month",
  },
  service: {
    title: "Service and toner demand",
    description: "Requests by type, machine and customer; response times; toner forecast.",
    ids: "RPT-06",
    range: true,
    defaultPreset: "last_3_months",
  },
  usage: {
    title: "Usage trends",
    description: "Copies per month for each machine or customer.",
    ids: "RPT-03",
    range: true,
    defaultPreset: "last_12_months",
  },
  rental: {
    title: "Rental information",
    description: "Machines rented and available, and agreement end dates.",
    ids: "AGR-03",
    range: false,
    defaultPreset: "this_month",
  },
  cycles: {
    title: "Billing cycle status",
    description: "Tickets by stage, average time per stage, late readings and missed deadlines.",
    ids: "TKT-06",
    range: true,
    defaultPreset: "last_3_months",
  },
  platform: {
    title: "Platform activity",
    description: "Owners, customers, machines and bills over time, owner activity and deliveries.",
    ids: "RPT-08",
    range: true,
    defaultPreset: "last_12_months",
  },
};

export function isOwnerReport(id: string): id is OwnerReportId {
  return (OWNER_REPORTS as readonly string[]).includes(id);
}

export function isReport(id: string): id is ReportId {
  return isOwnerReport(id) || (ADMIN_REPORTS as readonly string[]).includes(id);
}
