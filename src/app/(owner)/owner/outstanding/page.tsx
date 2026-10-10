import type { Metadata } from "next";
import Link from "next/link";

import { OwnerMoneyTabs } from "@/components/payments/payment-views";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate } from "@/lib/format";
import { formatInvoiceMoney } from "@/lib/invoices/pdf/format";
import { AGE_BUCKET_LABEL, AGE_BUCKETS } from "@/lib/payments/ageing";
import { countPaymentsToVerify, getOutstanding } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Outstanding" };

/**
 * PAY-09 / RPT-04 (decision 45): unpaid bills per customer by days past the due
 * date: current, 1-30, 31-60, 60+. A bill with a slip waiting is current. Cards
 * at 360 px, a table on wider screens; tap a customer for their profile.
 */
export default async function OutstandingPage() {
  await requireUser("OWNER");
  const supabase = await createClient();
  const [report, toVerify] = await Promise.all([getOutstanding(supabase), countPaymentsToVerify(supabase)]);
  const money = (cents: number) => (cents > 0 ? formatInvoiceMoney(cents) : "–");
  return (
    <>
      <PageHeader title="Outstanding" description={`Unpaid bills by days past the due date, on ${formatDate(report.today)}.`} />
      <OwnerMoneyTabs active="outstanding" toVerify={toVerify} />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="ageing-totals">
        <Card className="col-span-2 sm:col-span-1">
          <CardContent>
            <p className="text-xs text-muted-foreground">Total</p>
            <p className="text-xl font-bold tabular-nums" data-testid="outstanding-total">{formatInvoiceMoney(report.totals.total)}</p>
          </CardContent>
        </Card>
        {AGE_BUCKETS.map((b) => (
          <Card key={b}>
            <CardContent>
              <p className="text-xs text-muted-foreground">{AGE_BUCKET_LABEL[b]}</p>
              <p className={cn("text-lg font-semibold tabular-nums", b !== "CURRENT" && report.totals[b] > 0 && "text-destructive")}>{money(report.totals[b])}</p>
            </CardContent>
          </Card>
        ))}
      </div>
      {report.totals.slipWaiting > 0 && (
        <p className="mb-3 text-sm text-muted-foreground">{formatInvoiceMoney(report.totals.slipWaiting)} of Current has a payment slip waiting for your check.</p>
      )}

      {report.customers.length === 0 ? (
        <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">Nothing outstanding. Every bill is paid.</p>
      ) : (
        <>
          <ul className="space-y-2 md:hidden" aria-label="Outstanding by customer">
            {report.customers.map((c) => (
              <li key={c.customerId}>
                <Link href={`/owner/customers/${c.customerId}`} className="block rounded-xl border bg-background p-4 hover:bg-muted/60" data-testid="ageing-row">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{c.customerName}</span>
                    <span className="font-bold tabular-nums">{formatInvoiceMoney(c.totalCents)}</span>
                  </div>
                  <dl className="mt-2 grid grid-cols-4 gap-1 text-xs">
                    {AGE_BUCKETS.map((b) => (
                      <div key={b}>
                        <dt className="text-muted-foreground">{AGE_BUCKET_LABEL[b]}</dt>
                        <dd className={cn("tabular-nums", b !== "CURRENT" && c.buckets[b] > 0 && "font-semibold text-destructive")}>{money(c.buckets[b])}</dd>
                      </div>
                    ))}
                  </dl>
                  {c.slipWaitingCents > 0 && <p className="mt-1 text-xs text-muted-foreground">Slip waiting: {formatInvoiceMoney(c.slipWaitingCents)}</p>}
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-x-auto rounded-xl border bg-background md:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/60 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Customer</th>
                  {AGE_BUCKETS.map((b) => (
                    <th key={b} className="px-4 py-2 text-right font-medium">
                      {AGE_BUCKET_LABEL[b]}
                    </th>
                  ))}
                  <th className="px-4 py-2 text-right font-medium">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {report.customers.map((c) => (
                  <tr key={c.customerId}>
                    <td className="px-4 py-2">
                      <Link href={`/owner/customers/${c.customerId}`} className="font-medium text-primary underline-offset-4 hover:underline">
                        {c.customerName}
                      </Link>
                      {c.slipWaitingCents > 0 && <span className="block text-xs text-muted-foreground">Slip waiting</span>}
                    </td>
                    {AGE_BUCKETS.map((b) => (
                      <td key={b} className={cn("px-4 py-2 text-right tabular-nums", b !== "CURRENT" && c.buckets[b] > 0 && "font-semibold text-destructive")}>
                        {money(c.buckets[b])}
                      </td>
                    ))}
                    <td className="px-4 py-2 text-right font-semibold tabular-nums">{formatInvoiceMoney(c.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
