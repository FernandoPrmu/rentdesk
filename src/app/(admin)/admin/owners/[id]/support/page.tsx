import type { Metadata } from "next";

import { PageHeader } from "@/components/portal/portal-shell";
import { type DashboardLinks, OwnerDashboardCards } from "@/components/reports/owner-dashboard";
import { SummaryUnavailable } from "@/components/reports/summary-unavailable";
import { requireUser } from "@/lib/auth/current-user";
import { ownerDashboardForHome } from "@/lib/reports/queries";
import { openSupportView, supportBase } from "@/lib/support/view";

export const metadata: Metadata = { title: "Support view" };

function supportLinks(ownerId: string): DashboardLinks {
  const base = supportBase(ownerId);
  return {
    income: `${base}/reports/income?range=this_month`,
    outstanding: `${base}/reports/ageing`,
    approvals: `${base}/tickets?status=PENDING_OWNER_REVIEW`,
    payments: `${base}/payments?status=TO_VERIFY`,
    payment: () => `${base}/payments`,
    tickets: (status) => `${base}/tickets${status ? `?status=${status}` : ""}`,
    service: (urgency) => `${base}/service${urgency ? `?status=${urgency}` : ""}`,
    serviceItem: () => `${base}/service`,
    machines: (status) => `${base}/machines${status ? `?status=${status}` : ""}`,
    machineReport: `${base}/reports/machines`,
    rental: `${base}/reports/rental`,
    ratings: `${base}/service?status=CLOSED`,
  };
}

/** ADM-08: the owner's dashboard as the owner sees it, read only; the visit is logged with the optional reason. */
export default async function SupportDashboardPage({ params, searchParams }: PageProps<"/admin/owners/[id]/support">) {
  const admin = await requireUser("ADMIN");
  const { id } = await params;
  const { reason } = await searchParams;
  const owner = await openSupportView(admin, id, supportBase(id), typeof reason === "string" ? reason : null);
  const result = await ownerDashboardForHome(id);
  return (
    <>
      <PageHeader title={owner.business_name} description="The owner's Home, as they see it." />
      {result.ok ? (
        <OwnerDashboardCards d={result.data} links={supportLinks(id)} />
      ) : (
        <SummaryUnavailable href={supportBase(id)} message="The dashboard could not be loaded just now." />
      )}
    </>
  );
}
