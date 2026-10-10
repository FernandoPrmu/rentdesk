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
import { DepositsToSettle } from "@/components/deposits/deposits-to-settle";
import { CreditsPanel } from "@/components/payments/credits-panel";
import { PaymentList } from "@/components/payments/payment-views";
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
import { getDepositsHeld, listDepositsToSettle } from "@/lib/deposits/queries";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { listCustomerCredits, listPayments } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";

import { refundCreditAction } from "../../payments/actions";
import { INVOICE_STATUS_LABEL, TICKET_STATUS_LABEL } from "@/lib/status-labels";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Customer" };

/** CUS-04: contact details, account, machines and agreements, balance, tickets, invoices, payments, credits, requests. */
export default async function CustomerDetailPage({ params }: PageProps<"/owner/customers/[id]">) {
  const owner = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  // RLS: an owner only ever sees their own customers; anything else is "not found".
  const customer = await getCustomer(id);
  if (!customer) notFound();

  const [agreements, balances, billing, toSettle, payments, credits] = await Promise.all([
    listCustomerAgreements(id),
    getCustomerBalances(id),
    getCustomerBilling(id),
    listDepositsToSettle(id),
    listPayments(await createClient(), { customerId: id, limit: 20 }),
    listCustomerCredits(owner, id),
  ]);
  const deposits = await getDepositsHeld(agreements.map((a) => a.id));
  const depositHeld = [...deposits.values()].reduce((s, v) => s + v, 0);
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
              ["Deposit held", <span key="d" data-testid="customer-deposit-held">{depositHeld > 0 ? formatRupees(depositHeld) : "None"}</span>],
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
          <AgreementCards agreements={live} today={today} linkBase="/owner/agreements" deposits={deposits} empty="No machines rented at the moment." />
          {past.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer py-2 font-medium">Earlier rentals ({past.length})</summary>
              <AgreementCards agreements={past} today={today} linkBase="/owner/agreements" deposits={deposits} empty="" />
            </details>
          )}
        </CardContent>
      </Card>

      {toSettle.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Deposits to settle</CardTitle>
          </CardHeader>
          <CardContent>
            <DepositsToSettle items={toSettle} empty="" />
          </CardContent>
        </Card>
      )}

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
                    {i.invoice_no ? (
                      <Link href={`/owner/invoices/${i.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {i.invoice_no}
                      </Link>
                    ) : (
                      "Not issued"
                    )}{" "}
                    · {formatRupees(i.total_cents)}
                    {i.amount_paid_cents > 0 ? ` (paid ${formatRupees(i.amount_paid_cents)})` : ""}
                    {i.due_date ? ` · due ${formatDate(i.due_date)}` : ""}
                  </span>
                  <span className="text-muted-foreground">{INVOICE_STATUS_LABEL[i.status] ?? i.status}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Payments</CardTitle>
          <Link href={`/owner/payments/new?customer=${customer.id}`} className={cn(buttonVariants({ variant: "outline" }), "h-11")}>
            Record a payment
          </Link>
        </CardHeader>
        <CardContent>
          <PaymentList payments={payments} hrefBase="/owner/payments" audience="OWNER" empty="No payments yet." />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Credits</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-sm text-muted-foreground">Credits come off the next bills automatically. You can refund what is free instead.</p>
          <CreditsPanel credits={credits} today={today} action={refundCreditAction} />
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
