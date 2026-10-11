import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { generateInvoicePdf } from "@/lib/invoices/pdf-job";
import { supabaseInvoiceFiles } from "@/lib/invoices/pdf-server";
import { loadInvoiceFonts } from "@/lib/invoices/pdf/fonts";
import { generateReceiptPdf } from "@/lib/payments/receipt-pdf/job";
import { supabaseReceiptFiles } from "@/lib/payments/receipt-pdf/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { type Rpc, RpcError } from "@/lib/tickets/transitions";
import type { Database } from "@/types/db";

import { type DailyJobOptions, type DailyJobResult, type PhotoStorage, runDailyJob } from "./daily";

/**
 * Server wiring of the daily job: the service-role client as the rpc port and
 * the meter-photos bucket as the storage port.
 */

export function supabaseRpc(client: SupabaseClient<Database>): Rpc {
  return async (fn, args) => {
    // Generic port: each caller names an rpc_* wrapper and its arguments.
    const { data, error } = await client.rpc(fn as never, args as never);
    if (error) throw new RpcError(error.code, error.message);
    return data;
  };
}

export function meterPhotoStorage(client: SupabaseClient<Database>): PhotoStorage {
  return {
    async removeMeterPhotos(paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from("meter-photos").remove(paths);
      if (error) throw new Error(`meter photos: ${error.message}`);
    },
    async removePaymentSlips(paths) {
      if (paths.length === 0) return;
      const { error } = await client.storage.from("payment-slips").remove(paths);
      if (error) throw new Error(`payment slips: ${error.message}`);
    },
  };
}

export function runDailyJobNow(options: DailyJobOptions): Promise<DailyJobResult> {
  const admin = createAdminClient();
  const rpc = supabaseRpc(admin);
  const files = supabaseInvoiceFiles(admin);
  const receiptFiles = supabaseReceiptFiles(admin);
  return runDailyJob(rpc, meterPhotoStorage(admin), options, {
    generate: (invoiceId, now) => generateInvoicePdf(rpc, files, () => loadInvoiceFonts(), invoiceId, now),
    generateReceipt: (receiptId, now) => generateReceiptPdf(rpc, receiptFiles, () => loadInvoiceFonts(), receiptId, now),
  });
}
