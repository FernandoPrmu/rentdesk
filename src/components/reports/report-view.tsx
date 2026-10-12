import { FileSpreadsheet, FileText } from "lucide-react";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { barPercents } from "@/lib/reports/maths";
import { type CellValue, type ColumnType, formatCell, type ReportDocument, type ReportSection, type SummaryItem } from "@/lib/reports/document";
import { type DateRange, PRESET_LABEL, RANGE_PRESETS, rangeQuery } from "@/lib/reports/period";
import { cn } from "@/lib/utils";

/**
 * Report screens (RPT-02..08): summary tiles, then each section as cards at 360 px
 * and a table from md up, from the same ReportDocument as the PDF and Excel files.
 * Server components; no chart library (decision 83: tables first, simple bars second).
 */

const numeric = (t: ColumnType) => t !== "text";

export function SummaryTiles({ items }: { items: SummaryItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="report-summary">
      {items.map((s) => (
        <Card key={s.label} size="sm">
          <CardContent>
            <p className="text-xs text-muted-foreground">{s.label}</p>
            <p className="text-lg font-bold tabular-nums">{formatCell(s.type, s.value, "screen")}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function cellText(type: ColumnType, value: CellValue | undefined) {
  return value === undefined ? "" : formatCell(type, value, "screen");
}

export function SectionView({ section, linkFor }: { section: ReportSection; linkFor?: (row: ReportSection["rows"][number]) => string | null }) {
  const [first, ...rest] = section.columns;
  return (
    <section className="mb-6" aria-label={section.title}>
      {section.title && <h2 className="mb-2 text-lg font-semibold">{section.title}</h2>}
      {section.rows.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-background p-5 text-center text-sm text-muted-foreground">{section.empty ?? "Nothing to show."}</p>
      ) : (
        <>
          <ul className="space-y-2 md:hidden" data-testid="report-cards">
            {section.rows.map((row, i) => {
              const href = linkFor?.(row) ?? null;
              const body = (
                <>
                  <p className="font-semibold">{cellText(first.type, row[first.key])}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                    {rest.map((c) => (
                      <div key={c.key} className="min-w-0">
                        <dt className="truncate text-muted-foreground">{c.label}</dt>
                        <dd className="tabular-nums">{cellText(c.type, row[c.key])}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              );
              return (
                <li key={i}>
                  {href ? (
                    <Link href={href} className="block rounded-xl border bg-background p-4 hover:bg-muted/60">
                      {body}
                    </Link>
                  ) : (
                    <div className="rounded-xl border bg-background p-4">{body}</div>
                  )}
                </li>
              );
            })}
            {section.totals && (
              <li className="rounded-xl border bg-muted/60 p-4">
                <p className="font-semibold">{cellText(first.type, section.totals[first.key]) || "Total"}</p>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {rest
                    .filter((c) => section.totals![c.key] !== undefined && section.totals![c.key] !== null)
                    .map((c) => (
                      <div key={c.key}>
                        <dt className="text-muted-foreground">{c.label}</dt>
                        <dd className="font-semibold tabular-nums">{cellText(c.type, section.totals![c.key])}</dd>
                      </div>
                    ))}
                </dl>
              </li>
            )}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border bg-background md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-xs text-muted-foreground">
                <tr>
                  {section.columns.map((c) => (
                    <th key={c.key} className={cn("px-3 py-2 font-medium whitespace-nowrap", numeric(c.type) ? "text-right" : "text-left")}>
                      {c.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y">
                {section.rows.map((row, i) => {
                  const href = linkFor?.(row) ?? null;
                  return (
                    <tr key={i}>
                      {section.columns.map((c, j) => (
                        <td key={c.key} className={cn("px-3 py-2", numeric(c.type) ? "text-right tabular-nums whitespace-nowrap" : "text-left")}>
                          {j === 0 && href ? (
                            <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline">
                              {cellText(c.type, row[c.key])}
                            </Link>
                          ) : (
                            cellText(c.type, row[c.key])
                          )}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
              {section.totals && (
                <tfoot className="bg-muted/60 font-semibold">
                  <tr>
                    {section.columns.map((c) => (
                      <td key={c.key} className={cn("px-3 py-2", numeric(c.type) ? "text-right tabular-nums whitespace-nowrap" : "text-left")}>
                        {cellText(c.type, section.totals![c.key])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </>
      )}
    </section>
  );
}

export function ReportNotes({ notes }: { notes?: string[] }) {
  if (!notes?.length) return null;
  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      {notes.map((n) => (
        <p key={n}>{n}</p>
      ))}
    </div>
  );
}

export function ReportBody({ doc, linkFor }: { doc: ReportDocument; linkFor?: Record<string, (row: ReportSection["rows"][number]) => string | null> }) {
  return (
    <>
      {doc.sections.map((s) => (
        <SectionView key={s.title} section={s} linkFor={linkFor?.[s.title]} />
      ))}
      <ReportNotes notes={doc.notes} />
    </>
  );
}

/**
 * One measure as horizontal bars (one series, the primary colour; the title names
 * it). The value sits next to each bar in text colour; a native title gives the
 * same on hover. The table below the chart is the full view.
 */
export function BarList({ title, items, type }: { title: string; items: { label: string; value: number }[]; type: ColumnType }) {
  if (items.length === 0 || items.every((i) => i.value === 0)) return null;
  const pct = barPercents(items.map((i) => i.value));
  return (
    <figure className="mb-6 rounded-xl border bg-background p-4" data-testid="report-chart">
      <figcaption className="mb-3 text-sm font-semibold">{title}</figcaption>
      <ul className="space-y-2.5">
        {items.map((item, i) => {
          const text = formatCell(type, item.value, "screen");
          return (
            <li key={item.label} title={`${item.label}: ${text}`}>
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="min-w-0 truncate text-muted-foreground">{item.label}</span>
                <span className="shrink-0 font-medium tabular-nums">{text}</span>
              </div>
              <div className="mt-1 h-2.5 w-full rounded-full bg-muted">
                <div className={cn("h-full rounded-full", item.value < 0 ? "bg-destructive" : "bg-primary")} style={{ width: `${Math.max(pct[i], item.value === 0 ? 0 : 1)}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
    </figure>
  );
}

/** Preset chips and a "choose dates" form (GET; the range lives in the URL). */
export function RangeFilter({ basePath, range, extra = "", error }: { basePath: string; range: DateRange; extra?: string; error?: string }) {
  const presets = RANGE_PRESETS.filter((p) => p !== "custom");
  return (
    <div className="mb-4 space-y-2" data-testid="range-filter">
      <nav aria-label="Period" className="-mx-1 flex flex-wrap gap-1.5">
        {presets.map((p) => (
          <Link
            key={p}
            href={`${basePath}?range=${p}${extra}`}
            aria-current={range.preset === p ? "true" : undefined}
            className={cn(
              "inline-flex h-10 items-center rounded-full border px-3 text-sm",
              range.preset === p ? "border-primary bg-primary text-primary-foreground" : "bg-background hover:bg-muted",
            )}
          >
            {PRESET_LABEL[p]}
          </Link>
        ))}
      </nav>
      <details open={range.preset === "custom" || !!error} className="rounded-xl border bg-background">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">Choose dates</summary>
        <form action={basePath} method="get" className="flex flex-wrap items-end gap-2 px-3 pb-3">
          <input type="hidden" name="range" value="custom" />
          {extra
            .split("&")
            .filter(Boolean)
            .map((kv) => {
              const [k, v] = kv.split("=");
              return <input key={k} type="hidden" name={k} value={decodeURIComponent(v ?? "")} />;
            })}
          <label className="grid gap-1 text-xs text-muted-foreground">
            From
            <input type="date" name="from" defaultValue={range.from} required className="h-11 rounded-md border bg-background px-2 text-base text-foreground" />
          </label>
          <label className="grid gap-1 text-xs text-muted-foreground">
            To
            <input type="date" name="to" defaultValue={range.to} required className="h-11 rounded-md border bg-background px-2 text-base text-foreground" />
          </label>
          <button type="submit" className={cn(buttonVariants(), "h-11")}>
            Show
          </button>
        </form>
      </details>
      {error && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Download links (RPT-07). Plain links: the route answers with the file. */
export function ExportButtons({ href }: { href: (format: "pdf" | "xlsx") => string }) {
  return (
    <div className="flex gap-2" data-testid="report-export">
      <a href={href("pdf")} download className={cn(buttonVariants({ variant: "outline" }), "h-11 gap-2")}>
        <FileText className="size-4" aria-hidden /> PDF
      </a>
      <a href={href("xlsx")} download className={cn(buttonVariants({ variant: "outline" }), "h-11 gap-2")}>
        <FileSpreadsheet className="size-4" aria-hidden /> Excel
      </a>
    </div>
  );
}

/** The export URL for a report and range (and owner, for the admin's support view). */
export function exportHref(report: string, range: DateRange, format: "pdf" | "xlsx", owner?: string): string {
  return `/api/reports/${report}?format=${format}&${rangeQuery(range)}${owner ? `&owner=${owner}` : ""}`;
}
