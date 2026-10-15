import { ChevronRight } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { OWNER_REPORTS, REPORT_INFO } from "@/lib/reports/catalogue";
import { openSupportView, supportBase } from "@/lib/support/view";

export const metadata: Metadata = { title: "Support view" };

/** ADM-08: the owner's reports, read only (exports are logged too). */
export default async function SupportReportsPage({ params }: PageProps<"/admin/owners/[id]/support/reports">) {
  const admin = await requireUser("ADMIN");
  const { id } = await params;
  const owner = await openSupportView(admin, id, `${supportBase(id)}/reports`);
  return (
    <div className="max-w-2xl">
      <PageHeader title="Reports" description={owner.business_name} />
      <ul className="divide-y overflow-hidden rounded-xl border bg-background">
        {OWNER_REPORTS.map((r) => (
          <li key={r}>
            <Link href={`${supportBase(id)}/reports/${r}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60">
              <span className="min-w-0 flex-1">
                <span className="block font-medium">{REPORT_INFO[r].title}</span>
                <span className="block text-sm text-muted-foreground">{REPORT_INFO[r].description}</span>
              </span>
              <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
