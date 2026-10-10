import { describe, expect, it } from "vitest";

import { compressPhoto, type Encoder, PHOTO_OPTIONS, scaledSize } from "./compress";

/** A fake JPEG encoder: size grows with pixels and quality. */
function fakeEncoder(bytesPerPixelAtFull: number, calls: [number, number, number][] = []): Encoder {
  return async (w, h, q) => {
    calls.push([w, h, q]);
    return new Blob([new Uint8Array(Math.round(w * h * bytesPerPixelAtFull * q))], { type: "image/jpeg" });
  };
}

describe("meter photo compression (rule 30)", () => {
  it("scales the longest side down to 1600 px, never up", () => {
    expect(scaledSize(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(1080, 1920, 1600)).toEqual({ width: 900, height: 1600 });
    expect(scaledSize(640, 480, 1600)).toEqual({ width: 640, height: 480 });
    expect(() => scaledSize(0, 480, 1600)).toThrow();
  });

  it("uses the best quality that fits about 200 KB", async () => {
    const calls: [number, number, number][] = [];
    const blob = await compressPhoto(1920, 1080, fakeEncoder(0.15, calls));
    expect(blob.size).toBeLessThanOrEqual(PHOTO_OPTIONS.targetBytes);
    // 1600 x 900 x 0.15 x 0.82 ≈ 177 KB: the first quality already fits.
    expect(calls).toEqual([[1600, 900, 0.82]]);
  });

  it("steps the quality down, then the size, until it fits", async () => {
    const calls: [number, number, number][] = [];
    const blob = await compressPhoto(4000, 3000, fakeEncoder(0.5, calls));
    expect(blob.size).toBeLessThanOrEqual(PHOTO_OPTIONS.targetBytes);
    expect(calls[0]).toEqual([1600, 1200, 0.82]);
    expect(calls.some(([w]) => w < 1600)).toBe(true);
  });

  it("accepts a picture over the target but under the 1 MB hard limit; refuses above it", async () => {
    const tiny = { ...PHOTO_OPTIONS, targetBytes: 10, hardLimitBytes: 1024 * 1024 };
    expect((await compressPhoto(800, 600, fakeEncoder(0.2), tiny)).size).toBeGreaterThan(10);
    const strict = { ...PHOTO_OPTIONS, targetBytes: 10, hardLimitBytes: 20 };
    await expect(compressPhoto(800, 600, fakeEncoder(0.2), strict)).rejects.toThrow(/too large/);
  });
});
