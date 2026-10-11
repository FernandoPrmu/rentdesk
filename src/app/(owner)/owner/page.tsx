import { Plus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { DepositsToSettle } from "@/components/deposits/deposits-to-settle";
import { PageHeader } from "@/components/portal/portal-shell";
import { OverdueBadge, requestTitle, UrgencyBadge } from "@/components/service/service-display";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { listDepositsToSettle } from "@/lib/deposits/queries";
import { formatRupees } from "@/lib/money";
import { countPaymentsToVerify, getOutstanding } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";
import { openRequestSummary } from "@/lib/service/queries";
import { SERVICE_TYPES, STATUS_LABEL, TYPE_LABEL } from "@/lib/service/states";
import { countApprovals } from "@/lib/tickets/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Home" };

// Owner Home: open service requests (URGENT and HIGH first), outstanding money, slips to
// verify, readings to review, deposits to settle. The rest of RPT-01 (income, comparisons)
// comes with reports.
export default async function OwnerHomePage() {
  const user = await requireUser("OWNER");
  const supabase = await createClient();
  const [deposits, approvals, toVerify, outstanding, service] = await Promise.all([
    listDepositsToSettle(),
    countApprovals(),
    countPaymentsToVerify(supabase),
    getOutstanding(supabase),
    openRequestSummary(user.id),
  ]);
  const overdue = outstanding.totals.total - outstanding.totals.CURRENT;
  const priority = service.byUrgency.URGENT + service.byUrgency.HIGH;
  return (
    <>
      <PageHeader title={`Hello, ${user.full_name || user.username}`} description="Your rental business at a glance" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className={cn("sm:col-span-2", priority > 0 && "border-red-600/50")} data-testid="home-service">
          <CardHeader>
            <CardTitle>Open service requests</CardTitle>
            <CardDescription>
              {service.total === 0
                ? "No open requests."
                : [
                    `${service.total} open`,
                    priority > 0 ? `${priority} urgent or high` : null,
                    service.overdue > 0 ? `${service.overdue} not acknowledged in time` : null,
                    service.toConfirm > 0 ? `${service.toConfirm} waiting for the customer` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {service.total > 0 && (
              <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
                {SERVICE_TYPES.filter((t) => service.byType[t] > 0).map((t) => (
                  <span key={t}>
                    {TYPE_LABEL[t]}: {service.byType[t]}
                  </span>
                ))}
              </p>
            )}
            {service.top.length > 0 && (
              <ul className="divide-y overflow-hidden rounded-lg border" aria-label="Top service requests">
                {service.top.map((r) => (
                  <li key={r.id}>
                    <Link href={`/owner/service/${r.id}`} className="flex min-h-12 flex-wrap items-center gap-2 px-3 py-2">
                      <UrgencyBadge urgency={r.urgency} quiet />
                      <span className="font-medium">{requestTitle(r)}</span>
                      <span className="text-sm text-muted-foreground">
                        {r.customer.name} · {STATUS_LABEL[r.status]}
                      </span>
                      {r.overdue && <OverdueBadge />}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/owner/service" className={cn(buttonVariants({ variant: priority > 0 ? "default" : "outline" }), "h-12 w-full text-base sm:w-auto")}>
              Service requests ({service.total})
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Outstanding</CardTitle>
            <CardDescription>Unpaid bills of all your customers (RPT-01).</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <p className="text-3xl font-bold tabular-nums" data-testid="home-outstanding">{formatRupees(outstanding.totals.total)}</p>
              {overdue > 0 && <p className="text-sm font-medium text-destructive">{formatRupees(overdue)} overdue</p>}
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Link href="/owner/outstanding" className={cn(buttonVariants({ variant: "outline" }), "h-12 text-base")}>
                See by customer and age
              </Link>
              <Link href="/owner/invoices" className={cn(buttonVariants({ variant: "outline" }), "h-12 text-base")}>
                All invoices
              </Link>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Payments to verify</CardTitle>
            <CardDescription>{toVerify === 0 ? "No payment slips waiting." : `${toVerify} payment ${toVerify === 1 ? "slip" : "slips"} to check.`}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Link href="/owner/payments" className={cn(buttonVariants({ variant: toVerify > 0 ? "default" : "outline" }), "h-12 text-base")} data-testid="home-payments">
              Payments ({toVerify})
            </Link>
            <Link href="/owner/payments/new" className={cn(buttonVariants({ variant: "outline" }), "h-12 text-base")}>
              Record a payment
            </Link>
          </CardContent>
        </Card>
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
