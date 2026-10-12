import { CalendarClock, ChevronRight, Mail } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { MISSED_RUN_HOURS } from "@/lib/cron/daily";
import { formatDateTime } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { adminDashboard } from "@/lib/reports/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Admin" };

const sum = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

function Stat({ label, value, href, sub, alert, testId }: { label: string; value: ReactNode; href: string; sub?: ReactNode; alert?: boolean; testId?: string }) {
  return (
    <Link href={href} className="block rounded-xl border bg-background p-4 hover:bg-muted/60" data-testid={testId}>
      <p className="flex items-center justify-between text-xs text-muted-foreground">
        {label} <ChevronRight className="size-4" aria-hidden />
      </p>
      <p className={cn("text-2xl font-bold tabular-nums", alert && "text-destructive")}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </Link>
  );
}

function Meter({ used, limit, label }: { used: number; limit: number; label: string }) {
  const pct = limit > 0 ? Math.min(100, Math.round((used * 100) / limit)) : 0;
  return (
    <div title={`${label}: ${used} of ${limit}`}>
      <div className="flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums">
          {used} / {limit}
        </span>
      </div>
      <div className="mt-1 h-2.5 rounded-full bg-muted">
        <div className={cn("h-full rounded-full", pct >= 90 ? "bg-destructive" : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** ADM-04: platform counts, email usage against the free-tier limits, daily-job health. One database call. */
export default async function AdminHomePage() {
  await requireUser("ADMIN");
  const now = new Date();
  const d = await adminDashboard(now);
  if (!d) throw new Error("admin dashboard: not available");
  const lastSuccess = d.job.last_success;
  const gapHours = lastSuccess ? Math.floor((now.getTime() - Date.parse(lastSuccess)) / 3_600_000) : null;
  const jobLate = gapHours === null || gapHours >= MISSED_RUN_HOURS;
  return (
    <>
      <PageHeader title="Dashboard" description="Platform overview" />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" data-testid="admin-dashboard">
        <Stat label="Owners" value={sum(d.owners)} href="/admin/owners" sub={`${d.owners.ACTIVE ?? 0} active · ${d.owners.SUSPENDED ?? 0} suspended`} testId="stat-owners" />
        <Stat label="Customers" value={sum(d.customers)} href="/admin/reports" sub={`${d.customers.ACTIVE ?? 0} active`} />
        <Stat label="Machines" value={sum(d.machines)} href="/admin/reports" sub={`${d.machines.RENTED ?? 0} rented`} />
        <Stat label="Open tickets" value={d.open_tickets} href="/admin/escalations" sub={`${d.escalated_tickets} escalated to you`} alert={d.escalated_tickets > 0} />
        <Stat label="Bills this month" value={d.invoices_this_month.count} href="/admin/invoices" sub={formatRupees(d.invoices_this_month.total_cents)} />
        <Stat label="Open service requests" value={d.open_requests} href="/admin/escalations" />
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <Card data-testid="email-usage">
          <CardHeader className="flex flex-row items-center gap-2">
            <Mail className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle className="flex-1">Email usage</CardTitle>
            <Link href="/admin/emails/log" className="text-sm font-medium text-primary">
              Delivery log
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            <Meter used={d.email.sent_today} limit={d.email.daily_limit} label="Today (UTC day)" />
            <Meter used={d.email.sent_month} limit={d.email.monthly_limit} label="This month" />
            <p className="text-xs text-muted-foreground">
              {d.email.pending} waiting · {d.email.failed_month} failed this month. Limits: Settings › Email limits.
            </p>
          </CardContent>
        </Card>
        <Card className={cn(jobLate && "ring-destructive/50")} data-testid="job-health">
          <CardHeader className="flex flex-row items-center gap-2">
            <CalendarClock className="size-5 text-muted-foreground" aria-hidden />
            <CardTitle className="flex-1">Daily job</CardTitle>
            <Link href="/admin/jobs" className="text-sm font-medium text-primary">
              Runs
            </Link>
          </CardHeader>
          <CardContent className="space-y-1 text-sm">
            <p className={cn("font-semibold", jobLate ? "text-destructive" : "text-emerald-700 dark:text-emerald-400")}>
              {lastSuccess === null ? "Never ran successfully" : jobLate ? `No successful run for ${gapHours} hours` : "Healthy"}
            </p>
            {lastSuccess && <p className="text-muted-foreground">Last success: {formatDateTime(lastSuccess)}</p>}
            {d.job.last_run && (
              <p className="text-muted-foreground">
                Last run: {formatDateTime(d.job.last_run.started_at)} · {d.job.last_run.status.toLowerCase()}
                {d.job.last_run.remaining ? " · work left for the next run" : ""}
              </p>
            )}
            <p className="text-muted-foreground">Failed or partial runs in 7 days: {d.job.failed_7d}</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
