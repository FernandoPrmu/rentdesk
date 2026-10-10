import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PhotoViewer } from "@/components/meter/photo-viewer";
import { AcceptedPaymentActions, VerifyPanel } from "@/components/payments/owner-payment-actions";
import { AllocationList, DuplicateNotice, PaymentStatusBadge, paymentAmount, ReceiptButton } from "@/components/payments/payment-views";
import { BackLink } from "@/components/portal/back-link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { formatDate, formatDateTime } from "@/lib/format";
import { formatInvoiceMoney } from "@/lib/invoices/pdf/format";
import { activeAllocations, getPaymentDetail, getReallocateOptions, getVerifyContext } from "@/lib/payments/service";
import { CREDIT_KIND_LABEL, CREDIT_STATUS_LABEL, PAYMENT_METHOD_LABEL } from "@/lib/status-labels";
import { createClient } from "@/lib/supabase/server";

import { reallocatePaymentAction, reversePaymentAction, verifyPaymentAction } from "../actions";

export const metadata: Metadata = { title: "Payment" };

const REASON_LABEL: Record<string, string> = { ISSUED: "Issued", REVERSED: "Reversed", REALLOCATED: "Moved to other bills" };

/**
 * PAY-05 / PAY-06 / TKT-10: one payment: the slip (zoom, or the PDF by a short
 * signed link), amount, reference, duplicate flags and its bills; verify it, or
 * reverse or move an accepted one. RLS: own tenant.
 */
export default async function OwnerPaymentPage({ params }: PageProps<"/owner/payments/[id]">) {
  const owner = await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const p = await getPaymentDetail(await createClient(), id);
  if (!p) notFound();
  const receipt = p.receipts[0];
  const accepted = p.status === "ACCEPTED" || p.status === "PARTIAL";
  const [verify, move] = await Promise.all([
    p.status === "SUBMITTED" ? getVerifyContext(owner, id) : null,
    accepted && p.method !== "SECURITY_DEPOSIT" ? getReallocateOptions(owner, id) : null,
  ]);
  const applied = new Map(activeAllocations(p).map((a) => [a.invoice_id, a.applied_cents]));

  return (
    <div className="max-w-3xl space-y-4">
      <BackLink href="/owner/payments" label="Payments" />
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-3xl font-bold tabular-nums" data-testid="payment-amount">{formatInvoiceMoney(paymentAmount(p))}</p>
            <PaymentStatusBadge status={p.status} />
          </div>
          <p className="font-medium">
            <Link href={`/owner/customers/${p.customer.id}`} className="underline-offset-4 hover:underline">
              {p.customer.name}
            </Link>
            {p.customer.business_name ? <span className="text-muted-foreground"> · {p.customer.business_name}</span> : null}
          </p>
          {p.duplicate_of_payment_id && <DuplicateNotice reasons={p.duplicate_reasons} earlier={p.duplicateOf} />}
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Paid on</dt>
            <dd>{formatDate(p.paid_on)}</dd>
            <dt className="text-muted-foreground">Method</dt>
            <dd>
              {PAYMENT_METHOD_LABEL[p.method] ?? p.method}
              {p.source === "OWNER_MANUAL" ? " (recorded by you)" : ""}
            </dd>
            <dt className="text-muted-foreground">Reference</dt>
            <dd data-testid="payment-reference">{p.reference ?? "None"}</dd>
            {p.accepted_amount_cents !== null && p.accepted_amount_cents !== p.amount_cents && (
              <>
                <dt className="text-muted-foreground">On the slip</dt>
                <dd>{formatInvoiceMoney(p.amount_cents)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Sent</dt>
            <dd>{formatDateTime(p.submitted_at)}</dd>
            {p.verified_at && (
              <>
                <dt className="text-muted-foreground">Checked</dt>
                <dd>{formatDateTime(p.verified_at)}</dd>
              </>
            )}
            {p.note && (
              <>
                <dt className="text-muted-foreground">Note</dt>
                <dd>{p.note}</dd>
              </>
            )}
          </dl>
          {p.reject_reason && <p className="rounded-lg bg-destructive/10 p-3 text-sm">Rejected: {p.reject_reason}</p>}
          {p.reverse_reason && <p className="rounded-lg bg-destructive/10 p-3 text-sm">Reversed: {p.reverse_reason}</p>}
          <ReceiptButton receipt={receipt} />
        </CardContent>
      </Card>

      {p.slipUrl && (
        <Card>
          <CardHeader>
            <CardTitle>Payment slip</CardTitle>
          </CardHeader>
          <CardContent>
            {p.slipMime?.startsWith("image/") ? (
              <PhotoViewer url={p.slipUrl} alt="Payment slip" />
            ) : (
              <div className="space-y-2">
                <object data={p.slipUrl} type="application/pdf" className="hidden h-96 w-full rounded-lg border sm:block" aria-label="Payment slip PDF" />
                <a href={p.slipUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-primary underline" data-testid="slip-pdf">
                  Open the slip (PDF)
                </a>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Bills</CardTitle>
        </CardHeader>
        <CardContent>
          <AllocationList payment={p} hrefBase="/owner/invoices" />
          {p.credits.filter((c) => c.status !== "VOID").map((c) => (
            <p key={c.id} className="mt-2 text-sm">
              {CREDIT_KIND_LABEL[c.kind] ?? c.kind}: {formatInvoiceMoney(c.amount_cents)} credit ({CREDIT_STATUS_LABEL[c.status] ?? c.status})
            </p>
          ))}
        </CardContent>
      </Card>

      {verify && verify.payment.status === "SUBMITTED" && (
        <Card>
          <CardHeader>
            <CardTitle>Check the payment</CardTitle>
          </CardHeader>
          <CardContent>
            <VerifyPanel
              paymentId={p.id}
              slipCents={p.amount_cents}
              bills={verify.bills.map((b) => ({ id: b.id, invoiceNo: b.invoiceNo, dueDate: b.dueDate, seq: b.seq, balanceCents: b.balanceCents }))}
              action={verifyPaymentAction}
            />
          </CardContent>
        </Card>
      )}

      {move && (
        <Card>
          <CardHeader>
            <CardTitle>Change this payment</CardTitle>
          </CardHeader>
          <CardContent>
            <AcceptedPaymentActions
              paymentId={p.id}
              acceptedCents={p.accepted_amount_cents ?? p.amount_cents}
              current={move.current}
              options={move.bills.map((b) => ({
                id: b.id,
                invoiceNo: b.invoiceNo,
                dueDate: b.dueDate,
                seq: b.seq,
                machine: b.machine,
                balanceCents: b.balanceCents + (applied.get(b.id) ?? 0),
              }))}
              reverse={reversePaymentAction}
              move={reallocatePaymentAction}
            />
          </CardContent>
        </Card>
      )}

      {p.receiptVersions.length > 0 && receipt && (
        <Card>
          <CardHeader>
            <CardTitle>Receipt versions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm" aria-label="Receipt versions">
              {p.receiptVersions.map((v) => (
                <li key={v.version} className="flex items-center justify-between gap-3 py-2">
                  <span>
                    Version {v.version} · {REASON_LABEL[v.reason] ?? v.reason}
                    <span className="block text-xs text-muted-foreground">{formatDateTime(v.created_at)}</span>
                  </span>
                  <a href={`/api/receipts/${receipt.id}/pdf?v=${v.version}`} target="_blank" rel="noopener noreferrer" className="inline-flex h-11 items-center rounded-lg border px-3 font-medium hover:bg-muted">
                    PDF
                  </a>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
