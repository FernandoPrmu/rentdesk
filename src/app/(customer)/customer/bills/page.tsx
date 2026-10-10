import type { Metadata } from "next";

import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { getCustomerBalances, listOpenInvoices } from "@/lib/customers/queries";
import { formatDate } from "@/lib/format";
import { formatRupees } from "@/lib/money";
import { INVOICE_STATUS_LABEL } from "@/lib/status-labels";

export const metadata: Metadata = { title: "Bills" };

/**
 * Customer portal: what is still to pay (RET-01: unpaid bills stay after a
 * machine is returned). Paying with a slip comes with PAY-02; the full history
 * with CP-05. RLS: the customer's own issued invoices only.
 */
export default async function CustomerBillsPage() {
  const user = await requireUser("CUSTOMER");
  const [balances, invoices] = await Promise.all([getCustomerBalances(user.id), listOpenInvoices(user.id)]);
  const balance = balances.get(user.id);

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
      {invoices.length > 0 && (
        <ul className="space-y-3" aria-label="Unpaid bills">
          {invoices.map((i) => (
            <li key={i.id} className="rounded-xl border bg-background p-4" data-testid="open-invoice">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-semibold">{i.invoice_no}</span>
                <span className="text-lg font-semibold tabular-nums">{formatRupees(i.total_cents - i.amount_paid_cents)}</span>
              </div>
              <p className="text-sm text-muted-foreground">
                {i.machine.brand} {i.machine.model} · {INVOICE_STATUS_LABEL[i.status] ?? i.status}
                {i.due_date ? ` · due ${formatDate(i.due_date)}` : ""}
                {i.amount_paid_cents > 0 ? ` · ${formatRupees(i.amount_paid_cents)} of ${formatRupees(i.total_cents)} paid` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted-foreground">Pay your machine owner as agreed. Sending a payment slip from here is coming soon.</p>
    </div>
  );
}
