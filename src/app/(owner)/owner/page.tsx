import { BarChart3, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DepositsToSettle } from "@/components/deposits/deposits-to-settle";
import { PageHeader } from "@/components/portal/portal-shell";
import { OWNER_LINKS, OwnerDashboardCards } from "@/components/reports/owner-dashboard";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/current-user";
import { listDepositsToSettle } from "@/lib/deposits/queries";
import { ownerDashboard } from "@/lib/reports/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Home" };

/**
 * Owner Home (RPT-01, spec 10.1): one database call for every card (income this month
 * against last month, outstanding and overdue, readings and slips to review, tickets by
 * stage, open service requests by urgency, machines, rating, deposits to settle, ending
 * agreements, top machines, recent payments). The deposits list loads only when there is one.
 */
export default async function OwnerHomePage() {
  const user = await requireUser("OWNER");
  const d = await ownerDashboard(user.id);
  const deposits = d.deposits.count > 0 ? await listDepositsToSettle() : [];
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
      <OwnerDashboardCards d={d} links={OWNER_LINKS} depositsList={deposits.length > 0 ? <DepositsToSettle items={deposits} empty="Nothing to settle." /> : null} />
    </>
  );
}
