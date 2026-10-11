import { CircleCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PhotoViewer } from "@/components/meter/photo-viewer";
import { AllocationList, PaymentStatusBadge, paymentAmount, ReceiptButton } from "@/components/payments/payment-views";
import { BackLink } from "@/components/portal/back-link";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatInvoiceMoney } from "@/lib/invoices/pdf/format";
import { getPaymentDetail } from "@/lib/payments/service";
import { PAYMENT_METHOD_LABEL } from "@/lib/status-labels";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Payment" };

const NEXT_STEP: Record<string, string> = {
  SUBMITTED: "Your rental company is checking this payment.",
  ACCEPTED: "Thank you. This payment was accepted.",
  PARTIAL: "This payment was accepted. Some of the bill is still to pay.",
  REJECTED: "This slip was not accepted. Please check the reason and send a new slip.",
  REVERSED: "This payment was taken back by your rental company. Its bills are to pay again.",
};

/** CP-05: one payment: status, bills, receipt and the slip (RLS: own payments). */
export default async function CustomerPaymentPage({ params, searchParams }: PageProps<"/customer/payments/[id]">) {
  await requireUser("CUSTOMER");
  const { id } = await params;
  const { sent } = await searchParams;
  if (!uuidSchema.safeParse(id).success) notFound();
  const p = await getPaymentDetail(await createClient(), id);
  if (!p) notFound();
  const receipt = p.receipts[0];
  return (
    <div className="space-y-4">
      <BackLink href="/customer/payments" label="Payments" />
      {sent === "1" && p.status === "SUBMITTED" && (
        <p role="status" className="flex items-center gap-2 rounded-xl bg-primary/10 p-4 font-medium" data-testid="payment-sent">
          <CircleCheck className="size-6 shrink-0 text-primary" aria-hidden /> Payment slip sent. Your rental company will check it.
        </p>
      )}
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-3xl font-bold tabular-nums" data-testid="payment-amount">{formatInvoiceMoney(paymentAmount(p))}</p>
            <PaymentStatusBadge status={p.status} audience="CUSTOMER" />
          </div>
          <p className={cn("text-sm", (p.status === "REJECTED" || p.status === "REVERSED") && "font-medium text-destructive")}>{NEXT_STEP[p.status]}</p>
          {p.reject_reason && <p className="rounded-lg bg-destructive/10 p-3 text-sm" data-testid="reject-reason">Reason: {p.reject_reason}</p>}
          {p.reverse_reason && <p className="rounded-lg bg-destructive/10 p-3 text-sm">Reason: {p.reverse_reason}</p>}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Paid on</dt>
            <dd>{formatDate(p.paid_on)}</dd>
            <dt className="text-muted-foreground">Method</dt>
            <dd>{PAYMENT_METHOD_LABEL[p.method] ?? p.method}</dd>
            {p.reference && (
              <>
                <dt className="text-muted-foreground">Reference</dt>
                <dd>{p.reference}</dd>
              </>
            )}
            {p.accepted_amount_cents !== null && p.accepted_amount_cents !== p.amount_cents && (
              <>
                <dt className="text-muted-foreground">On the slip</dt>
                <dd>{formatInvoiceMoney(p.amount_cents)}</dd>
              </>
            )}
            {p.credit_cents > 0 && p.status !== "REVERSED" && (
              <>
                <dt className="text-muted-foreground">Kept as credit</dt>
                <dd>{formatInvoiceMoney(p.credit_cents)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Sent</dt>
            <dd>{formatDateTime(p.submitted_at)}</dd>
          </dl>
          <ReceiptButton receipt={receipt} />
          {p.status === "REJECTED" && (
            <Link href="/customer/pay" className={cn(buttonVariants(), "h-12 w-full text-base")}>
              Send a new slip
            </Link>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Bills</CardTitle>
        </CardHeader>
        <CardContent>
          <AllocationList payment={p} hrefBase="/customer/bills" />
        </CardContent>
      </Card>
      {p.slipUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Your slip</CardTitle>
          </CardHeader>
          <CardContent>
            {p.slipMime?.startsWith("image/") ? (
              <PhotoViewer url={p.slipUrl} alt="Your payment slip" />
            ) : (
              <a href={p.slipUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline">
                Open the slip (PDF)
              </a>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
