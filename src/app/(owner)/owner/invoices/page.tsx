import type { Metadata } from "next";

import { InvoiceFilters, InvoiceList } from "@/components/invoices/invoice-views";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { invoiceFilterSchema, listInvoiceCustomers, listInvoices } from "@/lib/invoices/queries";

export const metadata: Metadata = { title: "Invoices" };

/** The owner's issued invoices with status, customer and issue-date filters (RLS: own tenant). */
export default async function OwnerInvoicesPage({ searchParams }: PageProps<"/owner/invoices">) {
  await requireUser("OWNER");
  const filter = invoiceFilterSchema.parse(await searchParams);
  const [invoices, customers] = await Promise.all([listInvoices({ ...filter, owner: undefined }), listInvoiceCustomers()]);
  const filtered = Boolean(filter.status || filter.customer || filter.from || filter.to);
  return (
    <>
      <PageHeader title="Invoices" description="Issued invoices, newest first. Drafts wait under Approvals." />
      <InvoiceFilters filter={filter} customers={customers} />
      <InvoiceList invoices={invoices} hrefBase="/owner/invoices" showCustomer empty={filtered ? "No invoices match these filters." : "No invoices yet."} />
    </>
  );
}
