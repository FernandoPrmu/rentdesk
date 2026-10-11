import type { Metadata } from "next";
import Link from "next/link";

import { CustomerMoneyTabs, PaymentList } from "@/components/payments/payment-views";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { formatRupees } from "@/lib/money";
import { customerMoney, listPayments } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Payments" };

/** CP-05 / PAY-08: every payment with its status, receipt and what is left to pay (RLS: own payments). */
export default async function CustomerPaymentsPage() {
  const user = await requireUser("CUSTOMER");
  const [payments, money] = await Promise.all([listPayments(await createClient()), customerMoney(user)]);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Your payments</h1>
      <CustomerMoneyTabs active="payments" />
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
          {money.outstandingCents > 0 && (
            <Link href="/customer/pay" className={cn(buttonVariants(), "mt-2 h-12 w-full text-base")}>
              Send a payment slip
            </Link>
          )}
        </CardContent>
      </Card>
      <PaymentList payments={payments} hrefBase="/customer/payments" audience="CUSTOMER" empty="No payments yet." />
    </div>
  );
}
