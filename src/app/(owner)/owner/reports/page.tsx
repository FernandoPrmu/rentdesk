import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { OWNER_REPORTS, REPORT_INFO } from "@/lib/reports/catalogue";

export const metadata: Metadata = { title: "Reports" };

/** Owner reports (spec 10.2; RPT-02..07): each with a period, PDF and Excel. */
export default async function OwnerReportsPage() {
  await requireUser("OWNER");
  return (
    <div className="max-w-2xl">
      <PageHeader title="Reports" description="Choose a report. Each one can be downloaded as PDF or Excel." />
      <ul className="divide-y overflow-hidden rounded-xl border bg-background" data-testid="report-list">
        {OWNER_REPORTS.map((id) => (
          <li key={id}>
            <Link href={`/owner/reports/${id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{REPORT_INFO[id].title}</span>
                <span className="block text-sm text-muted-foreground">{REPORT_INFO[id].description}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
