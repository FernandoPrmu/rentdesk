import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { BRANDING_BUCKET } from "@/lib/branding/files";
import { supabaseRpc } from "@/lib/cron/server";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/types/db";

import { INVOICE_BUCKET } from "./bucket";
import { generateInvoicePdf, type InvoiceFiles, type PdfOutcome } from "./pdf-job";
import { loadInvoiceFonts } from "./pdf/fonts";

/** Storage port of the PDF job: branding reads and invoice PDF writes (service role). */
export function supabaseInvoiceFiles(client: SupabaseClient<Database>): InvoiceFiles {
  return {
    async readBranding(path) {
      const { data, error } = await client.storage.from(BRANDING_BUCKET).download(path);
      if (error) {
        // A missing file is drawn without (logged); anything else is retried.
        const status = (error as { status?: number; statusCode?: string }).status ?? Number((error as { statusCode?: string }).statusCode);
        if (status === 404 || status === 400 || /not found/i.test(error.message)) {
          console.warn(`[invoice pdf] branding file missing: ${path}`);
          return null;
        }
        throw new Error(`branding file ${path}: ${error.message}`);
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async writeInvoicePdf(path, bytes) {
      const { error } = await client.storage
        .from(INVOICE_BUCKET)
        .upload(path, bytes, { contentType: "application/pdf", upsert: true, cacheControl: "3600" });
      if (error) throw new Error(`invoice pdf upload: ${error.message}`);
    },
  };
}

/** Renders a pending invoice PDF now; failures are recorded and left to the daily job. */
export async function renderInvoicePdfNow(invoiceId: string): Promise<PdfOutcome | null> {
  const admin = createAdminClient();
  try {
    return await generateInvoicePdf(supabaseRpc(admin), supabaseInvoiceFiles(admin), () => loadInvoiceFonts(), invoiceId);
  } catch (error) {
    console.error(`[invoice pdf] ${invoiceId}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
