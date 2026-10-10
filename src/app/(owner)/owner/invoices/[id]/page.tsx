import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { InvoiceDetailView, PdfVersionHistory } from "@/components/invoices/invoice-views";
import { BackLink } from "@/components/portal/back-link";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceDetail, listPdfVersions } from "@/lib/invoices/queries";

export const metadata: Metadata = { title: "Invoice" };

/** One invoice, its PDF and every PDF version (decision 34). RLS: own tenant. */
export default async function OwnerInvoicePage({ params }: PageProps<"/owner/invoices/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) notFound();
  const versions = await listPdfVersions(invoice.id);
  return (
    <div className="max-w-3xl space-y-4">
      <BackLink href="/owner/invoices" label="Invoices" />
      <InvoiceDetailView invoice={invoice} showCustomer />
      <PdfVersionHistory invoiceId={invoice.id} versions={versions} />
      <p className="text-sm">
        <Link href={`/owner/tickets/${invoice.ticket_id}`} className="font-medium text-primary underline">
          Open the billing ticket{invoice.ticket ? ` (cycle ${invoice.ticket.cycle_no})` : ""}
        </Link>
      </p>
    </div>
  );
}
