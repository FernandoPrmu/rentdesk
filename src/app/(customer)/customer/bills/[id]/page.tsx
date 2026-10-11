import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InvoiceDetailView } from "@/components/invoices/invoice-views";
import { PaymentList } from "@/components/payments/payment-views";
import { BackLink } from "@/components/portal/back-link";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceDetail } from "@/lib/invoices/queries";
import { listPayments } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Bill" };

/** CP-04 / CP-05, PAY-08: one bill with its lines, status, due date, the PDF and its payments (RLS: own issued invoices). */
export default async function CustomerBillPage({ params }: PageProps<"/customer/bills/[id]">) {
  await requireUser("CUSTOMER");
  const { id } = await params;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) notFound();
  const payments = await listPayments(await createClient(), { invoiceId: invoice.id });
  const payable = ["AWAITING_PAYMENT", "PARTIALLY_PAID", "OVERDUE"].includes(invoice.status) && invoice.total_cents > invoice.amount_paid_cents;
  return (
    <div className="space-y-4">
      <BackLink href="/customer/bills" label="Bills" />
      <InvoiceDetailView invoice={invoice} />
      {payable && (
        <Link href={`/customer/pay?invoice=${invoice.id}`} className={cn(buttonVariants(), "h-12 w-full text-base")} data-testid="pay-this-bill">
          Pay this bill
        </Link>
      )}
      {payments.length > 0 && (
        <section className="space-y-2" aria-labelledby="bill-payments">
          <h2 id="bill-payments" className="text-lg font-semibold">Payments</h2>
          <PaymentList payments={payments} hrefBase="/customer/payments" audience="CUSTOMER" empty="" />
        </section>
      )}
    </div>
  );
}
