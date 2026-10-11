import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { InvoiceDetailView, PdfVersionHistory } from "@/components/invoices/invoice-views";
import { PaymentList } from "@/components/payments/payment-views";
import { BackLink } from "@/components/portal/back-link";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceDetail, listPdfVersions } from "@/lib/invoices/queries";
import { listPayments } from "@/lib/payments/service";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Invoice" };

/** Admin: any invoice, its PDF versions and its payments, read-only. */
export default async function AdminInvoicePage({ params }: PageProps<"/admin/invoices/[id]">) {
  await requireUser("ADMIN");
  const { id } = await params;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) notFound();
  const [versions, payments] = await Promise.all([listPdfVersions(invoice.id), listPayments(await createClient(), { invoiceId: invoice.id })]);
  return (
    <div className="max-w-3xl space-y-4">
      <BackLink href="/admin/invoices" label="Invoices" />
      <InvoiceDetailView invoice={invoice} showCustomer />
      <section className="space-y-2" aria-labelledby="admin-invoice-payments">
        <h2 id="admin-invoice-payments" className="text-lg font-semibold">Payments</h2>
        <PaymentList payments={payments} hrefBase={null} audience="OWNER" empty="No payments for this invoice." />
      </section>
      <PdfVersionHistory invoiceId={invoice.id} versions={versions} />
    </div>
  );
}
