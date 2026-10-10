import "server-only";

import { cacheLife } from "next/cache";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { BRANDING_BUCKET, logoFilePath } from "@/lib/branding/files";
import { processLogo } from "@/lib/branding/logo-image";
import type { CompanyInput } from "@/lib/branding/schemas";
import { dbErrorMessage } from "@/lib/db-errors";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/db";

/**
 * Owner company profile and logo (BRD-01..03). The logo is stored as a PNG at
 * `branding/{owner_id}/logos/{sha256}.png` (private bucket, decision 35: never
 * overwritten or deleted) and shown through short-lived signed URLs. Issued
 * invoices keep their own branding_snapshot, so editing here changes only new
 * invoices, and their later PDF versions still find the old logo.
 */

export const LOGO_BUCKET = BRANDING_BUCKET;
const SIGNED_URL_SECONDS = 60 * 60;

/** The company profile of an owner, as the signed-in user may see it (RLS). */
export async function getCompanyProfile(ownerId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("owner_company_profiles")
    .select(
      "owner_id, company_name, logo_path, address, phone, email, bank_name, bank_branch, bank_account_name, bank_account_no, letterhead_path, letterhead_layout, payment_instructions, onboarding_completed_at, updated_at",
    )
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (error) throw new Error(`company profile: ${error.message}`);
  return data;
}

export type CompanyProfile = NonNullable<Awaited<ReturnType<typeof getCompanyProfile>>>;

/**
 * A signed URL for a logo. Cached on the server for 30 minutes per path and version
 * (the profile's updated_at), well inside the URL's 1-hour lifetime. Callers must
 * have checked that the user may see this owner's branding.
 */
export async function signedLogoUrl(path: string, version: string): Promise<string | null> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 1800, expire: 2700 });
  void version; // part of the cache key only
  const { data, error } = await createAdminClient().storage.from(LOGO_BUCKET).createSignedUrl(path, SIGNED_URL_SECONDS);
  if (error) {
    console.error("[branding] signed url:", error.message);
    return null;
  }
  return data.signedUrl;
}

/** What a portal header shows: company name and logo URL (or initials). */
export async function getBranding(ownerId: string): Promise<{ companyName: string; logoUrl: string | null } | null> {
  const profile = await getCompanyProfile(ownerId);
  if (!profile) return null;
  const logoUrl = profile.logo_path ? await signedLogoUrl(profile.logo_path, profile.updated_at) : null;
  return { companyName: profile.company_name, logoUrl };
}

/**
 * Saves company details (and completes onboarding on the first save). A new logo
 * is validated, converted to PNG and uploaded before the details are saved;
 * `remove` clears it from the profile (the file stays for old invoices).
 */
export async function saveCompanyProfile(
  owner: CurrentUser,
  input: CompanyInput,
  logo: { file: File | null; remove: boolean },
): Promise<ActionResult> {
  const admin = createAdminClient();
  const details: Record<string, unknown> = { ...input };
  if (logo.file && logo.file.size > 0) {
    const processed = await processLogo(new Uint8Array(await logo.file.arrayBuffer()));
    if (!processed.ok) return fail(processed.error, { logo: processed.error });
    const path = logoFilePath(owner.id, processed.png);
    // Same bytes, same path: overwriting an existing copy changes nothing.
    const { error } = await admin.storage
      .from(LOGO_BUCKET)
      .upload(path, processed.png, { contentType: "image/png", upsert: true, cacheControl: "3600" });
    if (error) {
      console.error("[branding] upload:", error.message);
      return fail("The logo could not be uploaded. Please try again.", { logo: "Upload failed." });
    }
    details.logo_path = path;
  } else if (logo.remove) {
    details.logo_path = null;
  }

  const { error } = await admin.rpc("rpc_save_company_profile", { p_owner_id: owner.id, p_details: details as Json });
  return error ? fail(dbErrorMessage(error, "branding")) : ok(undefined);
}
