import type { Metadata } from "next";

import { RunDailyJobButton } from "@/components/admin/run-daily-job-button";
import { PageHeader } from "@/components/portal/portal-shell";
import { Badge } from "@/components/ui/badge";
import { requireUser } from "@/lib/auth/current-user";
import { COUNT_KEYS } from "@/lib/cron/daily";
import { formatDate, formatDateTime } from "@/lib/format";
import { listCronRuns } from "@/lib/tickets/queries";

import { runDailyJobAction } from "./actions";

export const metadata: Metadata = { title: "Daily job" };

const COUNT_LABEL: Record<(typeof COUNT_KEYS)[number], string> = {
  opened: "Tickets opened",
  flaggedOverdue: "Older tickets flagged",
  reminders: "Reminders",
  overdue: "Marked overdue",
  escalated: "Escalated to admin",
  estimated: "Estimated invoices",
  lateFees: "Late fees",
  paused: "Paused",
  resumed: "Resumed",
  photosDeleted: "Photos deleted",
  summaries: "Weekly summaries",
  skipped: "Already done",
};

const STATUS_VARIANT = { SUCCESS: "secondary", PARTIAL: "destructive", FAILED: "destructive", RUNNING: "outline", SKIPPED: "outline" } as const;
const TRIGGER_LABEL: Record<string, string> = { CRON: "Scheduled", ADMIN: "Admin", LOCAL: "Local" };

/** The daily job's log (cron_runs): latest runs, what each did, errors; and a button to run it now. */
export default async function DailyJobPage() {
  await requireUser("ADMIN");
  const runs = await listCronRuns();

  return (
    <>
      <PageHeader
        title="Daily job"
        description="Runs every night (00:30-01:30 Sri Lanka time): opens billing tickets, sends reminders, marks overdue, adds late fees, deletes meter photos."
        action={<RunDailyJobButton action={runDailyJobAction} />}
      />
      {runs.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">The daily job has not run yet.</p>
      ) : (
        <ul className="space-y-3" aria-label="Runs">
          {runs.map((r) => {
            const counts = COUNT_KEYS.filter((k) => (r.counts[k] ?? 0) > 0).map((k) => `${COUNT_LABEL[k]}: ${r.counts[k]}`);
            return (
              <li key={r.id} className="rounded-xl border bg-background p-4" data-testid="cron-run">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{formatDateTime(r.started_at)}</span>
                  <Badge variant={STATUS_VARIANT[r.status as keyof typeof STATUS_VARIANT] ?? "outline"}>{r.status.toLowerCase()}</Badge>
                  <span className="text-sm text-muted-foreground">{TRIGGER_LABEL[r.trigger] ?? r.trigger}</span>
                  {r.simulated && <Badge variant="outline">Simulated date {formatDate(r.run_date)}</Badge>}
                  {r.remaining && <Badge variant="outline">More work left</Badge>}
                </div>
                <p className="mt-1 text-sm">{counts.length ? counts.join(" · ") : "Nothing to do"}</p>
                {r.finished_at && (
                  <p className="text-xs text-muted-foreground">
                    Took {Math.max(0, Math.round((Date.parse(r.finished_at) - Date.parse(r.started_at)) / 100) / 10)} s
                  </p>
                )}
                {r.errors.length > 0 && (
                  <details className="mt-2 text-sm">
                    <summary className="cursor-pointer text-destructive">{r.errors.length} error(s)</summary>
                    <ul className="mt-1 space-y-1">
                      {r.errors.map((e, i) => (
                        <li key={i} className="rounded-md bg-muted px-2 py-1 font-mono text-xs break-all">
                          {e.step}
                          {e.id ? ` ${e.id}` : ""}
                          {e.code ? ` [${e.code}]` : ""}: {e.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
