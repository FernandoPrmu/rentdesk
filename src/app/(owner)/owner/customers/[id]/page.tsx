import { UserPlus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  resetCustomerPasswordAction,
  setCustomerStatusAction,
  updateCustomerAction,
} from "@/app/(owner)/owner/customers/actions";
import { AccountActions } from "@/components/accounts/account-actions";
import { AccountForm } from "@/components/accounts/account-form";
import { AccountSummary } from "@/components/accounts/account-summary";
import { AgreementCards } from "@/components/agreements/agreement-cards";
import { Facts } from "@/components/agreements/agreement-display";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCustomer } from "@/lib/accounts/queries";
import { uuidSchema } from "@/lib/accounts/schemas";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import { listCustomerAgreements } from "@/lib/agreements/queries";
import { requireUser } from "@/lib/auth/current-user";
import { getCustomerBalances, getCustomerBilling } from "@/lib/customers/queries";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { INVOICE_STATUS_LABEL, TICKET_STATUS_LABEL } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Customer" };

/** CUS-04: contact details, account, machines and agreements, balance, tickets, invoices, requests. */
export default async function CustomerDetailPage({ params }: PageProps<"/owner/customers/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  // RLS: an owner only ever sees their own customers; anything else is "not found".
  const customer = await getCustomer(id);
  if (!customer) notFound();

  const [agreements, balances, billing] = await Promise.all([
    listCustomerAgreements(id),
    getCustomerBalances(id),
    getCustomerBilling(id),
  ]);
  const balance = balances.get(id);
  const today = todayInColombo();
  const live = agreements.filter((a) => a.status !== "TERMINATED");
  const past = agreements.filter((a) => a.status === "TERMINATED");

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href="/owner/customers" label="Customers" />
        <PageHeader title={customer.name} description={customer.business_name ?? undefined} />
        <AccountSummary
          username={customer.profile.username}
          status={customer.profile.status}
          lastLoginAt={customer.profile.last_login_at}
          mustChangePassword={customer.profile.must_change_password}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <Facts
            items={[
              ["Phone", customer.phone ?? "—"],
              ["Email", customer.email ?? "—"],
              ["Address", customer.address ?? "—"],
              ["Machines rented", String(live.length)],
              [
                "Outstanding balance",
                <span key="b" data-testid="outstanding-balance">
                  {balance && balance.outstandingCents > 0
                    ? `${formatRupees(balance.outstandingCents)} (${balance.unpaidInvoices} unpaid invoice${balance.unpaidInvoices === 1 ? "" : "s"})`
                    : "Nothing due"}
                </span>,
              ],
            ]}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Machines and agreements</CardTitle>
          {customer.profile.status === "ACTIVE" && (
            <Link href={`/owner/customers/${id}/assign`} className={cn(buttonVariants(), "h-11 gap-2")}>
              <UserPlus className="size-4" aria-hidden /> Assign a machine
            </Link>
          )}
        </CardHeader>
        <CardContent className="space-y-4">
          <AgreementCards agreements={live} today={today} linkBase="/owner/agreements" empty="No machines rented at the moment." />
          {past.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer py-2 font-medium">Earlier rentals ({past.length})</summary>
              <AgreementCards agreements={past} today={today} linkBase="/owner/agreements" empty="" />
            </details>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Billing tickets</CardTitle>
        </CardHeader>
        <CardContent>
          {billing.tickets.length === 0 ? (
            <p className="text-sm text-muted-foreground">No billing tickets yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {billing.tickets.map((t) => (
                <li key={t.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    {t.machine.brand} {t.machine.model} · cycle {t.cycle_no} · {formatDate(t.cycle_date)}
                  </span>
                  <span className="text-muted-foreground">{TICKET_STATUS_LABEL[t.status] ?? t.status}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices and payments</CardTitle>
        </CardHeader>
        <CardContent>
          {billing.invoices.length === 0 ? (
            <p className="text-sm text-muted-foreground">No invoices yet.</p>
          ) : (
            <ul className="divide-y text-sm">
              {billing.invoices.map((i) => (
                <li key={i.id} className="flex flex-wrap justify-between gap-2 py-2">
                  <span>
                    {i.invoice_no ?? "Not issued"} · {formatRupees(i.total_cents)}
                    {i.amount_paid_cents > 0 ? ` (paid ${formatRupees(i.amount_paid_cents)})` : ""}
                    {i.due_date ? ` · due ${formatDate(i.due_date)}` : ""}
                  </span>
                  <span className="text-muted-foreground">{INVOICE_STATUS_LABEL[i.status] ?? i.status}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted-foreground">Payment history per invoice is added with payments (PAY-08).</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Service requests</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">Service requests will be listed here once they are built.</CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountActions
            name={customer.name}
            status={customer.profile.status}
            statusAction={setCustomerStatusAction.bind(null, customer.id)}
            resetAction={resetCustomerPasswordAction.bind(null, customer.id)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Contact details</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountForm
            kind="customer"
            mode="edit"
            action={updateCustomerAction.bind(null, customer.id)}
            defaults={{
              name: customer.name,
              business_name: customer.business_name,
              phone: customer.phone,
              email: customer.email,
              address: customer.address,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
