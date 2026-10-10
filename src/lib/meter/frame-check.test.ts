import { describe, expect, it } from "vitest";

import { assessFrame, FRAME_SAMPLE } from "./frame-check";

const { width, height } = FRAME_SAMPLE;

function frame(pixel: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      data.set([r, g, b, 255], i);
    }
  }
  return data;
}

describe("camera frame check (decision 37)", () => {
  it("refuses a black frame as too dark", () => {
    expect(assessFrame(frame(() => [0, 0, 0]))).toMatchObject({ ok: false, problem: "dark" });
    // Sensor noise on a covered lens is still dark.
    expect(assessFrame(frame((x, y) => [(x * 7 + y) % 12, (x + y * 5) % 12, 4]))).toMatchObject({ ok: false, problem: "dark" });
  });

  it("refuses a white frame as washed out", () => {
    expect(assessFrame(frame(() => [255, 255, 255]))).toMatchObject({ ok: false, problem: "bright" });
  });

  it("refuses a uniform grey frame as blank", () => {
    const check = assessFrame(frame(() => [128, 128, 128]));
    expect(check).toMatchObject({ ok: false, problem: "flat" });
    expect(check.mean).toBeCloseTo(128, 0);
    expect(check.stdDev).toBeCloseTo(0, 5);
  });

  it("accepts a photo-like frame: a lit meter panel with dark digits and a gradient", () => {
    const check = assessFrame(
      frame((x, y) => {
        const digit = y > 16 && y < 32 && x % 10 < 3; // dark segments of the counter
        if (digit) return [30, 30, 35];
        const light = 120 + Math.round((x / width) * 70) - Math.round((y / height) * 30);
        return [light, light + 5, light - 10];
      }),
    );
    expect(check.ok).toBe(true);
    expect(check.problem).toBeNull();
    expect(check.mean).toBeGreaterThan(28);
    expect(check.stdDev).toBeGreaterThan(8);
  });

  it("treats an empty frame as blank", () => {
    expect(assessFrame(new Uint8ClampedArray(0))).toMatchObject({ ok: false, problem: "flat" });
  });
});
