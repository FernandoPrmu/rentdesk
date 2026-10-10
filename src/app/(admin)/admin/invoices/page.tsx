import type { Metadata } from "next";

import { InvoiceFilters, InvoiceList } from "@/components/invoices/invoice-views";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { invoiceFilterSchema, listInvoices } from "@/lib/invoices/queries";

export const metadata: Metadata = { title: "Invoices" };

/** Admin: any owner's issued invoices, read-only (RLS: admin reads all). */
export default async function AdminInvoicesPage({ searchParams }: PageProps<"/admin/invoices">) {
  await requireUser("ADMIN");
  const filter = invoiceFilterSchema.parse(await searchParams);
  const invoices = await listInvoices({ ...filter, customer: undefined });
  const filtered = Boolean(filter.status || filter.from || filter.to);
  return (
    <>
      <PageHeader title="Invoices" description="Issued invoices of every owner, newest first (at most 200)." />
      <InvoiceFilters filter={filter} />
      <InvoiceList invoices={invoices} hrefBase="/admin/invoices" showCustomer empty={filtered ? "No invoices match these filters." : "No invoices yet."} />
    </>
  );
}
