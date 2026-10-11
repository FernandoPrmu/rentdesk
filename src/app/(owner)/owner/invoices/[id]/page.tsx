import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { InvoiceDetailView, PdfVersionHistory } from "@/components/invoices/invoice-views";
import { ResendInvoiceButton } from "@/components/invoices/resend-button";
import { PaymentList } from "@/components/payments/payment-views";
import { BackLink } from "@/components/portal/back-link";
import { deniedNotFound } from "@/lib/audit/access";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceDetail, listPdfVersions } from "@/lib/invoices/queries";
import { listPayments } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";

import { resendInvoiceAction } from "../actions";

export const metadata: Metadata = { title: "Invoice" };

/** One invoice, its PDF, every PDF version (decision 34) and its payments (PAY-08). RLS: own tenant. */
export default async function OwnerInvoicePage({ params }: PageProps<"/owner/invoices/[id]">) {
  const user = await requireUser("OWNER");
  const { id } = await params;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) return z.uuid().safeParse(id).success ? deniedNotFound(user, "invoices", id, "/owner/invoices/[id]") : notFound();
  const [versions, payments] = await Promise.all([listPdfVersions(invoice.id), listPayments(await createClient(), { invoiceId: invoice.id })]);
  const payable = ["AWAITING_PAYMENT", "PARTIALLY_PAID", "OVERDUE"].includes(invoice.status) && invoice.total_cents > invoice.amount_paid_cents;
  return (
    <div className="max-w-3xl space-y-4">
      <BackLink href="/owner/invoices" label="Invoices" />
      <InvoiceDetailView invoice={invoice} showCustomer hrefBase="/owner/invoices" />
      {invoice.status !== "CANCELLED" && <ResendInvoiceButton invoiceId={invoice.id} action={resendInvoiceAction} />}
      <section className="space-y-2" aria-labelledby="invoice-payments">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="invoice-payments" className="text-lg font-semibold">Payments</h2>
          {payable && (
            <Link href={`/owner/payments/new?customer=${invoice.customer.id}`} className="inline-flex h-11 items-center rounded-lg border px-3 text-sm font-medium hover:bg-muted">
              Record a payment
            </Link>
          )}
        </div>
        <PaymentList payments={payments} hrefBase="/owner/payments" audience="OWNER" empty="No payments for this invoice yet." />
      </section>
      <PdfVersionHistory invoiceId={invoice.id} versions={versions} />
      <p className="text-sm">
        <Link href={`/owner/tickets/${invoice.ticket_id}`} className="font-medium text-primary underline">
          Open the billing ticket{invoice.ticket ? ` (cycle ${invoice.ticket.cycle_no})` : ""}
        </Link>
      </p>
    </div>
  );
}
