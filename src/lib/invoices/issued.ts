import "server-only";

import { renderInvoicePdfNow } from "./pdf-server";

/**
 * Runs after an invoice is issued (owner confirms a reading or an estimate, or a
 * machine is returned), once the database transaction has committed. The
 * customer's in-app notification is already written by the rpc.
 *
 * INV-09: the invoice PDF is made now. The database already marked it PENDING
 * (trigger, migration 0022), so if rendering or the upload fails the invoice is
 * still issued, the customer sees "Invoice PDF is being prepared" and the daily
 * job retries. Idempotent: a second call finds nothing pending. Email (NOT-02)
 * plugs in here later.
 */
export interface IssuedInvoice {
  invoiceId: string;
  ticketId: string;
  ownerId: string;
}

export async function onInvoiceIssued(invoice: IssuedInvoice): Promise<void> {
  await renderInvoicePdfNow(invoice.invoiceId);
}

/**
 * An issued invoice changed in a way its PDF shows (late fee, due date,
 * cancellation; decision 34): make the next version now, or leave it to the
 * daily job. Never throws.
 */
export async function onInvoiceChanged(invoiceId: string | null | undefined): Promise<void> {
  if (invoiceId) await renderInvoicePdfNow(invoiceId);
}
