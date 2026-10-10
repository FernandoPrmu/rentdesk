/**
 * Meter photo compression (CLAUDE.md rule 5, decisions.md rule 30): the live frame is
 * scaled so its longest side is at most 1600 px, then encoded as JPEG with the
 * quality stepped down until it is about 200 KB. The encoder is injected (a canvas
 * in the browser, a fake in unit tests), so the loop is pure.
 */

export interface CompressOptions {
  /** Longest side in pixels. */
  maxSide: number;
  /** Aim for at most this many bytes. */
  targetBytes: number;
  /** Never above this (the meter-photos bucket allows 1 MB). */
  hardLimitBytes: number;
  /** JPEG qualities to try, best first. */
  qualities: number[];
}

export const PHOTO_OPTIONS: CompressOptions = {
  maxSide: 1600,
  targetBytes: 200 * 1024,
  hardLimitBytes: 1024 * 1024,
  qualities: [0.82, 0.72, 0.62, 0.52, 0.42, 0.32],
};

/** Encodes the frame at a size and JPEG quality. */
export type Encoder = (width: number, height: number, quality: number) => Promise<Blob>;

/** Output size keeping the aspect ratio; never upscales. */
export function scaledSize(width: number, height: number, maxSide: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) throw new Error("The camera gave an empty picture");
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The first quality that fits the target; if none does, the picture is made
 * smaller (by 25 % each time) and tried again. Refuses only if nothing fits the
 * hard limit even at a quarter of the size.
 */
export async function compressPhoto(width: number, height: number, encode: Encoder, options: CompressOptions = PHOTO_OPTIONS): Promise<Blob> {
  let size = scaledSize(width, height, options.maxSide);
  let smallest: Blob | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const quality of options.qualities) {
      const blob = await encode(size.width, size.height, quality);
      if (!smallest || blob.size < smallest.size) smallest = blob;
      if (blob.size <= options.targetBytes) return blob;
    }
    size = { width: Math.max(1, Math.round(size.width * 0.75)), height: Math.max(1, Math.round(size.height * 0.75)) };
  }
  if (smallest && smallest.size <= options.hardLimitBytes) return smallest;
  throw new Error("The photo is too large. Please try again.");
}
