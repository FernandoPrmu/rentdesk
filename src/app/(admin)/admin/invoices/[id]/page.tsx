import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { InvoiceDetailView, PdfVersionHistory } from "@/components/invoices/invoice-views";
import { BackLink } from "@/components/portal/back-link";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceDetail, listPdfVersions } from "@/lib/invoices/queries";

export const metadata: Metadata = { title: "Invoice" };

/** Admin: any invoice and its PDF versions, read-only. */
export default async function AdminInvoicePage({ params }: PageProps<"/admin/invoices/[id]">) {
  await requireUser("ADMIN");
  const { id } = await params;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) notFound();
  const versions = await listPdfVersions(invoice.id);
  return (
    <div className="max-w-3xl space-y-4">
      <BackLink href="/admin/invoices" label="Invoices" />
      <InvoiceDetailView invoice={invoice} showCustomer />
      <PdfVersionHistory invoiceId={invoice.id} versions={versions} />
    </div>
  );
}
