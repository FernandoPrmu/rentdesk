import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OwnerReportScreen } from "@/components/reports/owner-report";
import { requireUser } from "@/lib/auth/current-user";
import { isOwnerReport } from "@/lib/reports/catalogue";
import { openSupportView, supportBase } from "@/lib/support/view";

export const metadata: Metadata = { title: "Support view" };

/** ADM-08: one owner report, exactly as the owner sees it, read only. Logged. */
export default async function SupportReportPage({ params, searchParams }: PageProps<"/admin/owners/[id]/support/reports/[report]">) {
  const admin = await requireUser("ADMIN");
  const { id, report } = await params;
  if (!isOwnerReport(report)) notFound();
  await openSupportView(admin, id, `${supportBase(id)}/reports/${report}`);
  const base = `${supportBase(id)}/reports/${report}`;
  return <OwnerReportScreen report={report} ownerId={id} params={await searchParams} basePath={base} backHref={`${supportBase(id)}/reports`} supportOwnerId={id} />;
}
