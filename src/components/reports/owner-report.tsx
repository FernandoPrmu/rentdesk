import Link from "next/link";

import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { BarList, ExportButtons, exportHref, RangeFilter, ReportBody, SummaryTiles } from "@/components/reports/report-view";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { type OwnerReportId, REPORT_INFO } from "@/lib/reports/catalogue";
import { incomeMonth, machineProfit, type UsageBy, usageSeries } from "@/lib/reports/maths";
import { monthLabel, monthsIn, type RangeParams, resolveRange } from "@/lib/reports/period";
import { type LoadedReport, loadOwnerReport } from "@/lib/reports/queries";
import { TYPE_LABEL } from "@/lib/service/states";
import { cn } from "@/lib/utils";

/**
 * One owner report on screen (RPT-02..07): period filter, export buttons, summary,
 * a simple chart where it helps, then the tables. Used by the owner's Reports and,
 * read-only, by the admin's support view (`supportOwnerId`, decision 81).
 */
export async function OwnerReportScreen({
  report,
  ownerId,
  params,
  basePath,
  backHref,
  supportOwnerId,
}: {
  report: OwnerReportId;
  ownerId: string;
  params: RangeParams & { by?: string | string[] };
  /** This page, without the query string. */
  basePath: string;
  backHref: string;
  supportOwnerId?: string;
}) {
  const info = REPORT_INFO[report];
  const today = todayInColombo();
  const range = resolveRange(params, today, info.defaultPreset);
  const loaded = await loadOwnerReport(report, ownerId, range, { today });
  const by: UsageBy = (Array.isArray(params.by) ? params.by[0] : params.by) === "customer" ? "customer" : "machine";

  return (
    <>
      <BackLink href={backHref} label="Reports" />
      <PageHeader
        title={info.title}
        description={`${loaded.doc.period} · ${info.description}`}
        action={<ExportButtons href={(f) => exportHref(report, range, f, supportOwnerId)} />}
      />
      {info.range && <RangeFilter basePath={basePath} range={range} error={range.error} extra={report === "usage" ? `&by=${by}` : ""} />}
      <SummaryTiles items={loaded.doc.summary} />
      {report === "usage" && (
        <nav aria-label="Group by" className="mb-3 flex gap-1.5">
          {(["machine", "customer"] as const).map((b) => (
            <Link
              key={b}
              href={`${basePath}?${new URLSearchParams({ range: range.preset, ...(range.preset === "custom" ? { from: range.from, to: range.to } : {}), by: b })}`}
              aria-current={by === b ? "true" : undefined}
              className={cn("inline-flex h-10 items-center rounded-full border px-3 text-sm", by === b ? "border-primary bg-primary text-primary-foreground" : "bg-background")}
            >
              Per {b}
            </Link>
          ))}
        </nav>
      )}
      <Charts loaded={loaded} range={range} by={by} />
      <ReportBody doc={loaded.doc} />
    </>
  );
}

function Charts({ loaded, range, by }: { loaded: LoadedReport; range: { from: string; to: string }; by: UsageBy }) {
  const { data } = loaded;
  switch (data.report) {
    case "income":
      return (
        <BarList
          title="Collected by month"
          type="money"
          items={data.rows.map(incomeMonth).map((m) => ({ label: monthLabel(m.month), value: m.collected_cents }))}
        />
      );
    case "machines":
      return (
        <BarList
          title="Revenue per machine (top 10)"
          type="money"
          items={data.rows
            .map(machineProfit)
            .filter((m) => m.revenue_cents !== 0)
            .slice(0, 10)
            .map((m) => ({ label: m.name, value: m.revenue_cents }))}
        />
      );
    case "customers":
      return (
        <BarList
          title="Outstanding per customer (top 10)"
          type="money"
          items={[...data.rows]
            .filter((c) => c.outstanding_cents > 0)
            .sort((a, b) => b.outstanding_cents - a.outstanding_cents)
            .slice(0, 10)
            .map((c) => ({ label: c.name, value: c.outstanding_cents }))}
        />
      );
    case "service":
      return <BarList title="Requests by type" type="count" items={Object.entries(TYPE_LABEL).map(([k, label]) => ({ label, value: data.data.by_type[k] ?? 0 }))} />;
    case "usage": {
      const series = usageSeries(data.rows, by).slice(0, 5);
      const months = monthsIn(range);
      return (
        <>
          {series.map((s) => (
            <BarList
              key={s.id}
              title={`${s.label}: copies per month (B&W + colour)`}
              type="count"
              items={months.map((m) => ({ label: monthLabel(m), value: (s.bw[m] ?? 0) + (s.colour[m] ?? 0) }))}
            />
          ))}
        </>
      );
    }
    default:
      return null;
  }
}
