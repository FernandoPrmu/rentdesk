import { Plus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DepositsToSettle } from "@/components/deposits/deposits-to-settle";
import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { listDepositsToSettle } from "@/lib/deposits/queries";
import { countApprovals } from "@/lib/tickets/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Home" };

// Placeholder dashboard: the owner dashboard (RPT-01) comes with billing cycles.
export default async function OwnerHomePage() {
  const user = await requireUser("OWNER");
  const [deposits, approvals] = await Promise.all([listDepositsToSettle(), countApprovals()]);
  return (
    <>
      <PageHeader title={`Hello, ${user.full_name || user.username}`} description="Your rental business at a glance" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Customers</CardTitle>
            <CardDescription>Create logins for your customers and manage their accounts.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Link href="/owner/customers" className={cn(buttonVariants({ variant: "outline" }), "h-12 gap-2 text-base")}>
              <Users className="size-5" aria-hidden /> View customers
            </Link>
            <Link href="/owner/customers/new" className={cn(buttonVariants(), "h-12 gap-2 text-base")}>
              <Plus className="size-5" aria-hidden /> New customer
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Deposits to settle</CardTitle>
            <CardDescription>Security deposits kept when a machine came back.</CardDescription>
          </CardHeader>
          <CardContent>
            <DepositsToSettle items={deposits} empty="Nothing to settle." />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Waiting for your review</CardTitle>
            <CardDescription>
              {approvals === 0 ? "No meter readings to check." : `${approvals} meter ${approvals === 1 ? "reading" : "readings"} or estimates to check.`}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Link href="/owner/approvals" className={cn(buttonVariants({ variant: approvals > 0 ? "default" : "outline" }), "h-12 text-base")} data-testid="home-approvals">
              Approvals ({approvals})
            </Link>
            <Link href="/owner/tickets" className={cn(buttonVariants({ variant: "outline" }), "h-12 text-base")}>
              All tickets
            </Link>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
