import { createHash } from "node:crypto";

/**
 * Branding files are immutable (decision 35): a logo or letterhead is stored at a
 * path made from its SHA-256, never overwritten and never deleted, so an old
 * invoice's branding snapshot still finds its files when a later PDF version is
 * made. "Remove" only clears the company profile. Only the server writes the
 * bucket (migration 0022). Pure; only relative imports.
 */

export const BRANDING_BUCKET = "branding";

export type LetterheadExt = "pdf" | "jpg" | "png";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function logoFilePath(ownerId: string, png: Uint8Array): string {
  return `${ownerId}/logos/${sha256Hex(png)}.png`;
}

export function letterheadFilePath(ownerId: string, bytes: Uint8Array, ext: LetterheadExt): string {
  return `${ownerId}/letterheads/${sha256Hex(bytes)}.${ext}`;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

/** A letterhead path of this owner (as the database checks it, app.valid_letterhead_path). */
export function isOwnLetterheadPath(ownerId: string, path: string): boolean {
  return new RegExp(`^${UUID}/letterheads/[0-9a-f]{64}\\.(pdf|jpg|png)$`).test(path) && path.startsWith(`${ownerId}/`);
}

export function letterheadKind(path: string): "PDF" | "IMAGE" {
  return path.endsWith(".pdf") ? "PDF" : "IMAGE";
}
