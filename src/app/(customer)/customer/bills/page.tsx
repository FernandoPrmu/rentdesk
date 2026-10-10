import type { Metadata } from "next";

import { InvoiceList } from "@/components/invoices/invoice-views";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { getCustomerBalances } from "@/lib/customers/queries";
import { listInvoices, UNPAID_STATUSES, unpaidFirst } from "@/lib/invoices/queries";
import { formatRupees } from "@/lib/money";

export const metadata: Metadata = { title: "Bills" };

const isUnpaid = (status: string) => (UNPAID_STATUSES as readonly string[]).includes(status);

/**
 * Customer portal: bills to pay first, then earlier bills (CP-04, CP-05; RET-01:
 * unpaid bills stay after a machine is returned). Each opens its detail page with
 * the PDF. Paying with a slip comes with PAY-02. RLS: own issued invoices only.
 */
export default async function CustomerBillsPage() {
  const user = await requireUser("CUSTOMER");
  const [balances, invoices] = await Promise.all([getCustomerBalances(user.id), listInvoices({})]);
  const balance = balances.get(user.id);
  const sorted = unpaidFirst(invoices);
  const unpaid = sorted.filter((i) => isUnpaid(i.status));
  const earlier = sorted.filter((i) => !isUnpaid(i.status));

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Your bills</h1>
      <Card>
        <CardContent>
          <p className="text-sm text-muted-foreground">Balance to pay</p>
          <p className="text-3xl font-bold" data-testid="customer-balance">
            {balance && balance.outstandingCents > 0 ? formatRupees(balance.outstandingCents) : "Nothing to pay"}
          </p>
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
      <p className="text-sm text-muted-foreground">Pay your machine owner as agreed. Sending a payment slip from here is coming soon.</p>
    </div>
  );
}
