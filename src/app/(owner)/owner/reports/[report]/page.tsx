import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { OwnerReportScreen } from "@/components/reports/owner-report";
import { requireUser } from "@/lib/auth/current-user";
import { isOwnerReport, REPORT_INFO } from "@/lib/reports/catalogue";

type Props = { params: Promise<{ report: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { report } = await params;
  return { title: isOwnerReport(report) ? REPORT_INFO[report].title : "Report" };
}

/** One report of the owner's own business (RLS: their tenant only). */
export default async function OwnerReportPage({ params, searchParams }: Props) {
  const user = await requireUser("OWNER");
  const { report } = await params;
  if (!isOwnerReport(report)) notFound();
  return <OwnerReportScreen report={report} ownerId={user.id} params={await searchParams} basePath={`/owner/reports/${report}`} backHref="/owner/reports" />;
}
