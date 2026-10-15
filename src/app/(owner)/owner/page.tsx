import { BarChart3, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DepositsToSettle } from "@/components/deposits/deposits-to-settle";
import { PageHeader } from "@/components/portal/portal-shell";
import { DashboardSkeleton, OWNER_LINKS, OwnerDashboardCards } from "@/components/reports/owner-dashboard";
import { SummaryUnavailable } from "@/components/reports/summary-unavailable";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/current-user";
import { listDepositsToSettle } from "@/lib/deposits/queries";
import { ownerDashboardForHome } from "@/lib/reports/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Home" };

/**
 * Owner Home (RPT-01, spec 10.1). The header and actions render at once; the cards
 * (income vs last month, outstanding and overdue, to review, tickets by stage, service
 * by urgency, machines, rating, deposits, ending agreements, top machines, recent
 * payments) stream in from one cached database call (decision 84) and show "Try again"
 * if it takes longer than a few seconds, never a page error.
 */
export default async function OwnerHomePage() {
  const user = await requireUser("OWNER");
  return (
    <>
      <PageHeader
        title={`Hello, ${user.full_name || user.username}`}
        description="Your rental business at a glance"
        action={
          <div className="flex gap-2">
            <Link href="/owner/reports" className={cn(buttonVariants({ variant: "outline" }), "h-11 gap-2")}>
              <BarChart3 className="size-4" aria-hidden /> Reports
            </Link>
            <Link href="/owner/customers/new" className={cn(buttonVariants(), "h-11 gap-2")}>
              <Plus className="size-4" aria-hidden /> New customer
            </Link>
          </div>
        }
      />
      <Suspense fallback={<DashboardSkeleton />}>
        <OwnerCards ownerId={user.id} />
      </Suspense>
    </>
  );
}

async function OwnerCards({ ownerId }: { ownerId: string }) {
  const result = await ownerDashboardForHome(ownerId);
  if (!result.ok) return <SummaryUnavailable href="/owner" message="Your dashboard could not be loaded just now." />;
  const d = result.data;
  // A failed read is never "nothing to settle" (decision 47): the card keeps its count and says the list did not load.
  const deposits = d.deposits.count > 0 ? await listDepositsToSettle().catch(() => null) : [];
  const depositsList =
    deposits === null ? (
      <p className="text-sm text-muted-foreground">The list could not be loaded just now. Reload the page to see it.</p>
    ) : deposits.length > 0 ? (
      <DepositsToSettle items={deposits} empty="Nothing to settle." />
    ) : null;
  return <OwnerDashboardCards d={d} links={OWNER_LINKS} depositsList={depositsList} />;
}
