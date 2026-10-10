import type { PdfFonts } from "../../invoices/pdf/kit.ts";
import type { Rpc } from "../../tickets/transitions.ts";

import { buildReceiptDocument, receiptHash, type ReceiptPdfClaim } from "./document.ts";
import { renderReceiptPdf } from "./render.ts";

/**
 * Makes the PDF of a receipt (decision 44), like invoice PDFs (decision 34): claim
 * the pending receipt, build the document from its snapshot, skip if it equals the
 * newest version, otherwise render, upload {owner}/{receipt}/v{n}.pdf to the
 * private `receipts` bucket and record it. A failure is recorded and the daily job
 * retries. Database only through `rpc`, storage only through `files`, so DB tests
 * run the same code. Only relative imports.
 */

export const RECEIPT_BUCKET = "receipts";

export interface ReceiptFiles {
  /** A branding file (logo, letterhead); null when it does not exist. */
  readBranding(path: string): Promise<Uint8Array | null>;
  writeReceiptPdf(path: string, bytes: Uint8Array): Promise<void>;
}

export type ReceiptPdfOutcome =
  | { status: "SKIPPED" }
  | { status: "UNCHANGED"; version: number; ready: boolean }
  | { status: "CREATED"; version: number; ready: boolean; path: string };

export function receiptPdfPath(ownerId: string, receiptId: string, version: number): string {
  return `${ownerId}/${receiptId}/v${version}.pdf`;
}

export async function generateReceiptPdf(
  rpc: Rpc,
  files: ReceiptFiles,
  fonts: () => Promise<PdfFonts>,
  receiptId: string,
  now: Date = new Date(),
): Promise<ReceiptPdfOutcome> {
  const claim = (await rpc("rpc_claim_receipt_pdf", { p_receipt_id: receiptId, p_now: now.toISOString() })) as ReceiptPdfClaim | null;
  if (!claim) return { status: "SKIPPED" };
  const r = claim.receipt;
  try {
    const doc = buildReceiptDocument(claim);
    const hash = receiptHash(doc);
    const record = (version: number | null, path: string | null, size: number, template: string) =>
      rpc("rpc_record_receipt_pdf", {
        p_receipt_id: r.id,
        p_revision: r.pdf_revision,
        p_version: version,
        p_path: path,
        p_hash: hash,
        p_size: size,
        p_template: template,
      }) as Promise<{ version: number; ready: boolean }>;

    if (claim.latest?.content_hash === hash) {
      const done = await record(null, null, 1, "BUILT_IN");
      return { status: "UNCHANGED", version: done.version, ready: done.ready };
    }
    const [logo, letterhead] = await Promise.all([
      doc.logoPath ? files.readBranding(doc.logoPath) : null,
      doc.letterhead ? files.readBranding(doc.letterhead.path) : null,
    ]);
    const version = (claim.latest?.version ?? 0) + 1;
    const rendered = await renderReceiptPdf(doc, { logo, letterhead }, await fonts(), { version });
    const path = receiptPdfPath(r.owner_id, r.id, version);
    await files.writeReceiptPdf(path, rendered.bytes);
    const done = await record(version, path, rendered.bytes.length, rendered.template);
    return { status: "CREATED", version: done.version, ready: done.ready, path };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await rpc("rpc_mark_receipt_pdf_failed", { p_receipt_id: r.id, p_error: message }).catch(() => undefined);
    throw error;
  }
}
