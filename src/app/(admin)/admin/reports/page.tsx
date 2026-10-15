import type { Metadata } from "next";

import { PageHeader } from "@/components/portal/portal-shell";
import { BarList, ExportButtons, exportHref, RangeFilter, ReportBody, SummaryTiles } from "@/components/reports/report-view";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { requireUser } from "@/lib/auth/current-user";
import { REPORT_INFO } from "@/lib/reports/catalogue";
import { monthLabel, resolveRange } from "@/lib/reports/period";
import { loadPlatformReport } from "@/lib/reports/queries";

export const metadata: Metadata = { title: "Platform report" };

/** RPT-08 (spec 10.3): counts over time, owner activity and notification delivery. PDF and Excel. */
export default async function AdminReportsPage({ searchParams }: PageProps<"/admin/reports">) {
  await requireUser("ADMIN");
  const info = REPORT_INFO.platform;
  const range = resolveRange(await searchParams, todayInColombo(), info.defaultPreset);
  const loaded = await loadPlatformReport(range);
  if (!loaded) throw new Error("platform report: not available");
  return (
    <>
      <PageHeader title={info.title} description={`${loaded.doc.period} · ${info.description}`} action={<ExportButtons href={(f) => exportHref("platform", range, f)} />} />
      <RangeFilter basePath="/admin/reports" range={range} error={range.error} />
      <SummaryTiles items={loaded.doc.summary} />
      <BarList title="Bills issued per month" type="count" items={loaded.data.months.map((m) => ({ label: monthLabel(m.month), value: m.invoices }))} />
      <ReportBody doc={loaded.doc} />
      <p className="mt-4 text-sm text-muted-foreground">Subscription plans and platform billing are not used yet (ADM-07, deferred).</p>
    </>
  );
}
