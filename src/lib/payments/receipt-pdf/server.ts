import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { supabaseRpc } from "@/lib/cron/server";
import { supabaseInvoiceFiles } from "@/lib/invoices/pdf-server";
import { loadInvoiceFonts } from "@/lib/invoices/pdf/fonts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/db";

import { generateReceiptPdf, RECEIPT_BUCKET, type ReceiptFiles, type ReceiptPdfOutcome } from "./job";

/** Storage port of the receipt job: branding reads (as invoices) and receipt PDF writes (service role). */
export function supabaseReceiptFiles(client: SupabaseClient<Database>): ReceiptFiles {
  const invoiceFiles = supabaseInvoiceFiles(client);
  return {
    readBranding: (path) => invoiceFiles.readBranding(path),
    async writeReceiptPdf(path, bytes) {
      const { error } = await client.storage.from(RECEIPT_BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true, cacheControl: "3600" });
      if (error) throw new Error(`receipt pdf upload: ${error.message}`);
    },
  };
}

/** Renders a pending receipt PDF now; failures are recorded and left to the daily job. Never throws. */
export async function renderReceiptPdfNow(receiptId: string | null | undefined): Promise<ReceiptPdfOutcome | null> {
  if (!receiptId) return null;
  const admin = createAdminClient();
  try {
    return await generateReceiptPdf(supabaseRpc(admin), supabaseReceiptFiles(admin), () => loadInvoiceFonts(), receiptId);
  } catch (error) {
    console.error(`[receipt pdf] ${receiptId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
