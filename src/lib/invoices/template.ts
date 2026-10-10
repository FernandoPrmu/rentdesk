import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { todayInColombo } from "@/lib/agreements/cycle-calendar";
import type { CurrentUser } from "@/lib/auth/current-user";
import { BRANDING_BUCKET, isOwnLetterheadPath, letterheadFilePath, letterheadKind } from "@/lib/branding/files";
import { checkLetterhead } from "@/lib/branding/letterhead";
import { dbErrorMessage } from "@/lib/db-errors";
import { BRANDING_SNAPSHOT_COLUMNS } from "@/lib/invoices/branding-snapshot";
import { INVOICE_BUCKET } from "@/lib/invoices/pdf-job";
import { supabaseInvoiceFiles } from "@/lib/invoices/pdf-server";
import { brandingFromSnapshot, sampleInvoiceDocument } from "@/lib/invoices/pdf/document";
import { loadInvoiceFonts } from "@/lib/invoices/pdf/fonts";
import { type LetterheadLayout, parseLayout } from "@/lib/invoices/pdf/layout";
import { renderInvoicePdf } from "@/lib/invoices/pdf/render";
import type { InvoiceTemplateInput } from "@/lib/invoices/template-schema";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/types/db";

/**
 * Settings › Invoice template (BRD-04..07). The letterhead is checked and stored
 * on upload (content-hash path, decision 35) but only used once the owner saves;
 * the sample preview uses the template as it is on screen. Files and the profile
 * are written with the service role after the owner was checked (migration 0022).
 */

const FILE_URL_SECONDS = 10 * 60;
const PREVIEW_URL_SECONDS = 5 * 60;

export interface LetterheadFile {
  path: string;
  kind: "PDF" | "IMAGE";
  url: string | null;
}

export interface InvoiceTemplate {
  letterhead: LetterheadFile | null;
  layout: LetterheadLayout;
  paymentInstructions: string | null;
}

async function signedBrandingUrl(path: string): Promise<string | null> {
  const { data, error } = await createAdminClient().storage.from(BRANDING_BUCKET).createSignedUrl(path, FILE_URL_SECONDS);
  if (error) console.error("[invoice template] signed url:", error.message);
  return data?.signedUrl ?? null;
}

export async function getInvoiceTemplate(owner: CurrentUser): Promise<InvoiceTemplate | null> {
  const { data, error } = await createAdminClient()
    .from("owner_company_profiles")
    .select("letterhead_path, letterhead_layout, payment_instructions")
    .eq("owner_id", owner.id)
    .maybeSingle();
  if (error) throw new Error(`invoice template: ${error.message}`);
  if (!data) return null;
  const path = data.letterhead_path;
  return {
    letterhead: path ? { path, kind: letterheadKind(path), url: await signedBrandingUrl(path) } : null,
    layout: parseLayout(data.letterhead_layout),
    paymentInstructions: data.payment_instructions,
  };
}

/** Checks and stores a letterhead file; it is used only after Save. */
export async function uploadLetterhead(owner: CurrentUser, file: File | null): Promise<ActionResult<LetterheadFile & { warning: string | null }>> {
  if (!file || file.size === 0) return fail("Choose a file.", { letterhead: "Choose a file." });
  const checked = await checkLetterhead(new Uint8Array(await file.arrayBuffer()));
  if (!checked.ok) return fail(checked.error, { letterhead: checked.error });
  const path = letterheadFilePath(owner.id, checked.bytes, checked.ext);
  const { error } = await createAdminClient()
    .storage.from(BRANDING_BUCKET)
    .upload(path, checked.bytes, { contentType: checked.kind === "PDF" ? "application/pdf" : checked.ext === "png" ? "image/png" : "image/jpeg", upsert: true });
  if (error) {
    console.error("[invoice template] upload:", error.message);
    return fail("The letterhead could not be uploaded. Please try again.", { letterhead: "Upload failed." });
  }
  return ok({ path, kind: checked.kind, url: await signedBrandingUrl(path), warning: checked.warning });
}

function checkPath(owner: CurrentUser, path: string | null): ActionResult {
  if (path !== null && !isOwnLetterheadPath(owner.id, path)) return fail("Upload the letterhead again.", { letterhead: "Upload the letterhead again." });
  return ok(undefined);
}

export async function saveInvoiceTemplate(owner: CurrentUser, input: InvoiceTemplateInput): Promise<ActionResult> {
  const pathOk = checkPath(owner, input.letterheadPath);
  if (!pathOk.ok) return pathOk;
  const { error } = await createAdminClient().rpc("rpc_save_invoice_template", {
    p_owner_id: owner.id,
    p_template: {
      letterhead_path: input.letterheadPath,
      letterhead_layout: input.letterheadPath ? input.layout : {},
      payment_instructions: input.paymentInstructions,
    } as unknown as Json,
  });
  return error ? fail(dbErrorMessage(error, "invoice template")) : ok(undefined);
}

/** BRD-07: a sample invoice with demo data and the template on screen; returns a short-lived URL. */
export async function previewSampleInvoice(owner: CurrentUser, input: InvoiceTemplateInput): Promise<ActionResult<{ url: string }>> {
  const pathOk = checkPath(owner, input.letterheadPath);
  if (!pathOk.ok) return pathOk;
  const admin = createAdminClient();
  const { data: profile } = await admin.from("owner_company_profiles").select(BRANDING_SNAPSHOT_COLUMNS).eq("owner_id", owner.id).maybeSingle();
  if (!profile) return fail("Complete the company details first.");
  const branding = brandingFromSnapshot({
    ...profile,
    letterhead_path: input.letterheadPath,
    letterhead_layout: input.layout,
    payment_instructions: input.paymentInstructions,
  });
  const files = supabaseInvoiceFiles(admin);
  try {
    const [logo, letterhead] = await Promise.all([
      branding.logoPath ? files.readBranding(branding.logoPath) : null,
      branding.letterhead ? files.readBranding(branding.letterhead.path) : null,
    ]);
    const rendered = await renderInvoicePdf(sampleInvoiceDocument(branding, todayInColombo()), { logo, letterhead }, await loadInvoiceFonts(), {
      version: null,
      sample: true,
    });
    // The owner's own prefix of the invoices bucket (storage RLS: the owner reads it; customers never do).
    const path = `${owner.id}/preview/sample.pdf`;
    const { error } = await admin.storage.from(INVOICE_BUCKET).upload(path, rendered.bytes, { contentType: "application/pdf", upsert: true, cacheControl: "0" });
    if (error) throw new Error(error.message);
    const { data, error: urlError } = await admin.storage.from(INVOICE_BUCKET).createSignedUrl(path, PREVIEW_URL_SECONDS);
    if (urlError || !data) throw new Error(urlError?.message ?? "no url");
    return ok({ url: data.signedUrl });
  } catch (error) {
    console.error("[invoice template] preview:", error instanceof Error ? error.message : error);
    return fail("The sample invoice could not be made. Please try again.");
  }
}
