import "server-only";

/**
 * Runs after an invoice is issued (owner confirms a reading or an estimate), once
 * the database transaction has committed. The customer's in-app notification is
 * already written by the confirm rpc.
 *
 * Task 6b plugs in here: render the invoice PDF with @react-pdf/renderer (owner
 * branding from invoices.branding_snapshot, BRD-04..06), store it privately,
 * set invoices.pdf_path, and email it to the customer (INV-09, NOT-02). Keep this
 * idempotent: a retry must not create a second PDF or email.
 */
export interface IssuedInvoice {
  invoiceId: string;
  ticketId: string;
  ownerId: string;
}

export async function onInvoiceIssued(invoice: IssuedInvoice): Promise<void> {
  // PDF and email come with task 6b; nothing else to do yet.
  void invoice;
}
