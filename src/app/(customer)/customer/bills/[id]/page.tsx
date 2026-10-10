import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { InvoiceDetailView } from "@/components/invoices/invoice-views";
import { BackLink } from "@/components/portal/back-link";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceDetail } from "@/lib/invoices/queries";

export const metadata: Metadata = { title: "Bill" };

/** CP-04 / CP-05: one bill with its lines, status, due date and the PDF (RLS: own issued invoices). */
export default async function CustomerBillPage({ params }: PageProps<"/customer/bills/[id]">) {
  await requireUser("CUSTOMER");
  const { id } = await params;
  const invoice = await getInvoiceDetail(id);
  if (!invoice) notFound();
  return (
    <div className="space-y-4">
      <BackLink href="/customer/bills" label="Bills" />
      <InvoiceDetailView invoice={invoice} />
    </div>
  );
}
