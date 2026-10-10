import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { OwnerMoneyTabs, PaymentList } from "@/components/payments/payment-views";
import { PageHeader } from "@/components/portal/portal-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/current-user";
import { countPaymentsToVerify, listPayments, PAYMENT_FILTERS, type PaymentFilter } from "@/lib/payments/service";
import { PAYMENT_STATUS_LABEL } from "@/lib/status-labels";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Payments" };

const FILTER_LABEL: Record<PaymentFilter, string> = {
  TO_VERIFY: "To verify",
  ALL: "All payments",
  ACCEPTED: PAYMENT_STATUS_LABEL.ACCEPTED,
  PARTIAL: PAYMENT_STATUS_LABEL.PARTIAL,
  REJECTED: PAYMENT_STATUS_LABEL.REJECTED,
  REVERSED: PAYMENT_STATUS_LABEL.REVERSED,
};

/**
 * PAY-05 / PAY-08: payment slips to verify (oldest first) and every payment of the
 * tenant (RLS), with possible duplicates flagged. "Record a payment" for money
 * received without a slip (PAY-07).
 */
export default async function OwnerPaymentsPage({ searchParams }: PageProps<"/owner/payments">) {
  await requireUser("OWNER");
  const supabase = await createClient();
  const toVerify = await countPaymentsToVerify(supabase);
  const { status } = await searchParams;
  const filter: PaymentFilter = PAYMENT_FILTERS.includes(status as PaymentFilter) ? (status as PaymentFilter) : toVerify > 0 ? "TO_VERIFY" : "ALL";
  const payments = await listPayments(supabase, { status: filter });
  return (
    <>
      <PageHeader
        title="Payments"
        description="Slips to verify and every payment received."
        action={
          <Link href="/owner/payments/new" className={cn(buttonVariants(), "h-12 gap-2 text-base")}>
            <Plus className="size-5" aria-hidden /> Record a payment
          </Link>
        }
      />
      <OwnerMoneyTabs active="payments" toVerify={toVerify} />
      <form key={filter} method="get" role="search" className="mb-4 flex gap-2">
        <div className="flex-1">
          <ChoiceSelect name="status" ariaLabel="Show" defaultValue={filter} options={PAYMENT_FILTERS.map((f) => ({ value: f, label: FILTER_LABEL[f] }))} />
        </div>
        <Button type="submit" variant="secondary" className="h-12 px-5 text-base">
          Show
        </Button>
      </form>
      <PaymentList
        payments={payments}
        hrefBase="/owner/payments"
        audience="OWNER"
        empty={filter === "TO_VERIFY" ? "No payment slips waiting for you." : "No payments here yet."}
      />
    </>
  );
}
