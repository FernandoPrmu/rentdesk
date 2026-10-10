import type { CompressOptions } from "../meter/compress.ts";

/**
 * What the phone does with a chosen payment slip before uploading it (decision
 * 41). Unlike meter photos, the gallery and files are allowed. A PDF is sent as
 * it is (at most 5 MB). A picture over 2 MB, or in another format the browser
 * can open (HEIC from an iPhone), is made smaller as a JPEG (longest side
 * 2400 px, still easy to read); a small JPG or PNG is sent as it is. The
 * fingerprint of the file as chosen is kept for the duplicate check. Pure.
 */

export const SLIP_LIMIT_BYTES = 5 * 1024 * 1024;
export const SLIP_COMPRESS_ABOVE = 2 * 1024 * 1024;

export const SLIP_PHOTO_OPTIONS: CompressOptions = {
  maxSide: 2400,
  targetBytes: 1536 * 1024,
  hardLimitBytes: SLIP_LIMIT_BYTES,
  qualities: [0.9, 0.82, 0.74, 0.66, 0.58],
};

export type SlipPlan = { action: "UPLOAD"; mimeType: "image/jpeg" | "image/png" | "application/pdf" } | { action: "COMPRESS" } | { action: "REFUSE"; error: string };

export function slipPlan(file: { type: string; size: number; name: string }): SlipPlan {
  const type = file.type.toLowerCase();
  const pdf = type === "application/pdf" || (type === "" && /\.pdf$/i.test(file.name));
  if (file.size === 0) return { action: "REFUSE", error: "The file is empty. Please choose the slip again." };
  if (pdf) {
    return file.size > SLIP_LIMIT_BYTES ? { action: "REFUSE", error: "The PDF is larger than 5 MB. Please take a photo of the slip instead." } : { action: "UPLOAD", mimeType: "application/pdf" };
  }
  if (type.startsWith("image/")) {
    if ((type === "image/jpeg" || type === "image/png") && file.size <= SLIP_COMPRESS_ABOVE) return { action: "UPLOAD", mimeType: type };
    return { action: "COMPRESS" };
  }
  return { action: "REFUSE", error: "Please choose a photo (JPG or PNG) or a PDF of the slip." };
}

export const slipExtension = (mimeType: string) => (mimeType === "application/pdf" ? "pdf" : mimeType === "image/png" ? "png" : "jpg");

/** Hex SHA-256 (Web Crypto in the browser, node:crypto's webcrypto in tests). */
export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
