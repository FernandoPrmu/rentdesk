/**
 * BRD-03 / decision 35: what an issued invoice keeps of the owner's branding. The
 * logo and letterhead are content-hash paths (never overwritten), so the snapshot
 * pins the exact files and the layout. Used by every place that issues an
 * invoice (meter confirm, machine return, seed). Only relative imports.
 */

export const BRANDING_SNAPSHOT_COLUMNS =
  "company_name, address, phone, email, logo_path, bank_name, bank_branch, bank_account_name, bank_account_no, letterhead_path, letterhead_layout, payment_instructions";

export function brandingSnapshot(profile: Record<string, unknown> | null | undefined, now: Date): Record<string, unknown> | null {
  if (!profile) return null;
  const keys = BRANDING_SNAPSHOT_COLUMNS.split(", ");
  return { ...Object.fromEntries(keys.map((k) => [k, profile[k] ?? null])), snapshot_at: now.toISOString() };
}
