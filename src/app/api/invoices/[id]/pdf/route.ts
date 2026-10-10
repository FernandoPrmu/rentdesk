import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { INVOICE_BUCKET } from "@/lib/invoices/bucket";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/invoices/{id}/pdf[?v=n] — "Download PDF" (CP-05; decision 38). The
 * signed-in user's own client finds the file and signs a 60-second URL, so the
 * table and storage RLS decide: the owner's tenant, the invoice's customer, or
 * admin. Redirects to the file (opens in the browser's PDF viewer, or downloads
 * on phones that have none); nothing else is ever exposed.
 */

const SIGNED_SECONDS = 60;

function notFound(message: string, status = 404) {
  return new NextResponse(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) return notFound("Invoice not found.");
  const versionParam = request.nextUrl.searchParams.get("v");
  const version = versionParam === null ? null : Number(versionParam);
  if (version !== null && (!Number.isInteger(version) || version < 1)) return notFound("Invoice PDF not found.");

  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return NextResponse.redirect(new URL("/login", request.url), 303);

  let path: string | null = null;
  let name = "invoice";
  const { data: invoice } = await supabase.from("invoices").select("invoice_no, pdf_path").eq("id", id).not("invoice_no", "is", null).maybeSingle();
  if (!invoice) return notFound("Invoice not found.");
  name = invoice.invoice_no ?? name;
  if (version === null) {
    path = invoice.pdf_path;
  } else {
    const { data: row } = await supabase.from("invoice_pdf_versions").select("storage_path").eq("invoice_id", id).eq("version", version).maybeSingle();
    path = row?.storage_path ?? null;
    name = `${name}-v${version}`;
  }
  if (!path) return notFound("The invoice PDF is being prepared. Please try again in a few minutes.");

  const { data, error } = await supabase.storage.from(INVOICE_BUCKET).createSignedUrl(path, SIGNED_SECONDS, { download: false });
  if (error || !data) {
    console.error("[invoice pdf] signed url:", error?.message);
    return notFound("The invoice PDF could not be opened. Please try again.", 503);
  }
  const response = NextResponse.redirect(data.signedUrl, 303);
  response.headers.set("cache-control", "no-store");
  response.headers.set("x-invoice-file", `${name}.pdf`);
  return response;
}
