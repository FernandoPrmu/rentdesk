import type { Metadata } from "next";

import Link from "next/link";

import { InvoiceList } from "@/components/invoices/invoice-views";
import { CustomerMoneyTabs } from "@/components/payments/payment-views";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { listInvoices, UNPAID_STATUSES, unpaidFirst } from "@/lib/invoices/queries";
import { formatRupees } from "@/lib/money";
import { customerMoney } from "@/lib/payments/service";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Bills" };

const isUnpaid = (status: string) => (UNPAID_STATUSES as readonly string[]).includes(status);

/**
 * Customer portal: bills to pay first, then earlier bills (CP-04, CP-05; RET-01:
 * unpaid bills stay after a machine is returned). Each opens its detail page with
 * the PDF; "Send a payment slip" pays one or more of them (PAY-02). RLS: own
 * issued invoices only. Credits are shown apart: they come off the next bills.
 */
export default async function CustomerBillsPage() {
  const user = await requireUser("CUSTOMER");
  const [money, invoices] = await Promise.all([customerMoney(user), listInvoices({})]);
  const sorted = unpaidFirst(invoices);
  const unpaid = sorted.filter((i) => isUnpaid(i.status));
  const earlier = sorted.filter((i) => !isUnpaid(i.status));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Your bills</h1>
      <CustomerMoneyTabs active="bills" />
      <Card>
        <CardContent className="space-y-1">
          <p className="text-sm text-muted-foreground">Balance to pay</p>
          <p className="text-3xl font-bold" data-testid="customer-balance">
            {money.outstandingCents > 0 ? formatRupees(money.outstandingCents) : "Nothing to pay"}
          </p>
          {money.creditCents > 0 && (
            <p className="text-sm" data-testid="customer-credit">
              Credit: {formatRupees(money.creditCents)}, taken off your next bills.
            </p>
          )}
          {unpaid.some((i) => i.status !== "PAYMENT_SUBMITTED" && i.status !== "DISPUTED") && (
            <Link href="/customer/pay" className={cn(buttonVariants(), "mt-2 h-12 w-full text-base")} data-testid="pay-bills">
              Send a payment slip
            </Link>
          )}
        </CardContent>
      </Card>
      {unpaid.length > 0 && (
        <section className="space-y-2" aria-labelledby="bills-to-pay">
          <h2 id="bills-to-pay" className="text-lg font-semibold">To pay</h2>
          <InvoiceList invoices={unpaid} hrefBase="/customer/bills" empty="" />
        </section>
      )}
      <section className="space-y-2" aria-labelledby="bills-earlier">
        <h2 id="bills-earlier" className="text-lg font-semibold">Earlier bills</h2>
        <InvoiceList invoices={earlier} hrefBase="/customer/bills" empty="No earlier bills yet." />
      </section>
    </div>
  );
}
