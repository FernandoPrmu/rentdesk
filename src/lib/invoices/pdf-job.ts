import type { Rpc } from "../tickets/transitions.ts";

import { buildInvoiceDocument, documentHash, type InvoicePdfClaim } from "./pdf/document.ts";
import { type InvoiceFonts, renderInvoicePdf } from "./pdf/render.ts";

/**
 * Makes the PDF of an issued invoice (INV-09; decision 34): claim the pending
 * invoice (rpc_claim_invoice_pdf), build the document from its stored data and
 * branding snapshot, skip if it equals the newest version, otherwise render,
 * upload {owner}/{invoice}/v{n}.pdf and record it. A failure is recorded on the
 * invoice (still PENDING) and the daily job retries. The database is reached
 * only through `rpc` and storage through `files`, so DB tests run the same code.
 * Only relative imports.
 */

export { INVOICE_BUCKET } from "./bucket.ts";

export interface InvoiceFiles {
  /** A branding file (logo, letterhead); null when it does not exist. */
  readBranding(path: string): Promise<Uint8Array | null>;
  /** Uploads a PDF to the invoices bucket (overwrites an unrecorded earlier attempt). */
  writeInvoicePdf(path: string, bytes: Uint8Array): Promise<void>;
}

export type PdfOutcome =
  | { status: "SKIPPED" }
  | { status: "UNCHANGED"; version: number; ready: boolean }
  | { status: "CREATED"; version: number; ready: boolean; path: string };

export function invoicePdfPath(ownerId: string, invoiceId: string, version: number): string {
  return `${ownerId}/${invoiceId}/v${version}.pdf`;
}

export async function generateInvoicePdf(
  rpc: Rpc,
  files: InvoiceFiles,
  fonts: () => Promise<InvoiceFonts>,
  invoiceId: string,
  now: Date = new Date(),
): Promise<PdfOutcome> {
  const claim = (await rpc("rpc_claim_invoice_pdf", { p_invoice_id: invoiceId, p_now: now.toISOString() })) as InvoicePdfClaim | null;
  if (!claim) return { status: "SKIPPED" };
  const inv = claim.invoice;
  try {
    const doc = buildInvoiceDocument(claim);
    const hash = documentHash(doc);
    const record = (version: number | null, path: string | null, size: number, template: string) =>
      rpc("rpc_record_invoice_pdf", {
        p_invoice_id: inv.id,
        p_revision: inv.pdf_revision,
        p_version: version,
        p_path: path,
        p_hash: hash,
        p_size: size,
        p_template: template,
        p_parties: doc.parties,
      }) as Promise<{ version: number; ready: boolean }>;

    if (claim.latest?.content_hash === hash) {
      const r = await record(null, null, 1, "BUILT_IN");
      return { status: "UNCHANGED", version: r.version, ready: r.ready };
    }

    const [logo, letterhead] = await Promise.all([
      doc.logoPath ? files.readBranding(doc.logoPath) : null,
      doc.letterhead ? files.readBranding(doc.letterhead.path) : null,
    ]);
    const version = (claim.latest?.version ?? 0) + 1;
    const rendered = await renderInvoicePdf(doc, { logo, letterhead }, await fonts(), { version });
    const path = invoicePdfPath(inv.owner_id, inv.id, version);
    await files.writeInvoicePdf(path, rendered.bytes);
    const r = await record(version, path, rendered.bytes.length, rendered.template);
    return { status: "CREATED", version: r.version, ready: r.ready, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rpc("rpc_mark_invoice_pdf_failed", { p_invoice_id: inv.id, p_error: message }).catch(() => undefined);
    throw error;
  }
}
