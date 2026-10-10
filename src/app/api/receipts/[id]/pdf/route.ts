import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { RECEIPT_BUCKET } from "@/lib/payments/receipt-pdf/job";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/receipts/{id}/pdf[?v=n] — "Download receipt" (CP-05; decision 44), like
 * invoice PDFs (decision 38): the signed-in user's own client finds the file and
 * signs a 60-second URL, so the table and storage RLS decide (the owner's tenant,
 * the payment's customer, or admin).
 */

const SIGNED_SECONDS = 60;

function notFound(message: string, status = 404) {
  return new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("Receipt not found.");
  const versionParam = request.nextUrl.searchParams.get("v");
  const version = versionParam === null ? null : Number(versionParam);
  if (version !== null && (!Number.isInteger(version) || version < 1)) return notFound("Receipt PDF not found.");

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.redirect(new URL("/login", request.url), 303);

  const { data: receipt } = await supabase.from("receipts").select("receipt_no, pdf_path").eq("id", id).maybeSingle();
  if (!receipt) return notFound("Receipt not found.");
  let path = receipt.pdf_path;
  let name = receipt.receipt_no;
  if (version !== null) {
    const { data: row } = await supabase.from("receipt_pdf_versions").select("storage_path").eq("receipt_id", id).eq("version", version).maybeSingle();
    path = row?.storage_path ?? null;
    name = `${name}-v${version}`;
  }
  if (!path) return notFound("The receipt is being prepared. Please try again in a few minutes.");

  const { data, error } = await supabase.storage.from(RECEIPT_BUCKET).createSignedUrl(path, SIGNED_SECONDS, { download: false });
  if (error || !data) {
    console.error("[receipt pdf] signed url:", error?.message);
    return notFound("The receipt could not be opened. Please try again.", 503);
  }
  const response = NextResponse.redirect(data.signedUrl, 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-receipt-file", `${name}.pdf`);
  return response;
}
