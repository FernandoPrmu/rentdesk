import "server-only";

import sharp from "sharp";

import { LOGO_MAX_DIMENSION, validateLogo } from "@/lib/branding/logo";

/**
 * Turns an uploaded logo into the stored PNG (BRD-02): validates it, renders an SVG
 * to pixels (the SVG itself is thrown away), fixes JPEG rotation, and shrinks it to
 * fit LOGO_MAX_DIMENSION. Metadata is not copied to the output.
 */
export async function processLogo(
  bytes: Uint8Array,
): Promise<{ ok: true; png: Buffer; width: number; height: number } | { ok: false; error: string }> {
  const check = validateLogo(bytes);
  if (!check.ok) return check;

  try {
    const input = sharp(bytes, {
      // Render vector logos sharply before downscaling.
      density: check.type === "svg" ? 300 : undefined,
      limitInputPixels: 40_000_000,
      failOn: "error",
    });
    const { data, info } = await input
      .rotate()
      .resize(LOGO_MAX_DIMENSION, LOGO_MAX_DIMENSION, { fit: "inside", withoutEnlargement: check.type !== "svg" })
      .png({ compressionLevel: 9 })
      .toBuffer({ resolveWithObject: true });
    return { ok: true, png: data, width: info.width, height: info.height };
  } catch {
    return { ok: false, error: "This image could not be read. Try another file." };
  }
}
