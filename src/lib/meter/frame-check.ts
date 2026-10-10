/**
 * Camera capture safety (decision 37): a captured meter photo must show
 * something. A frame that is almost black (camera not ready, lens covered),
 * washed out (pointed at a light) or one flat colour (a blank frame) is refused
 * before it can be sent, and the customer is asked to retake it. Pure: works on
 * RGBA pixels (canvas ImageData), normally a 64 × 48 copy of the frame.
 */

/** Average brightness (0-255) below this: too dark. */
export const MIN_MEAN_LUMA = 28;
/** Average brightness above this: washed out. */
export const MAX_MEAN_LUMA = 235;
/** Spread of brightness below this: one flat colour, nothing readable. */
export const MIN_LUMA_STDDEV = 8;

/** The sample size the camera draws the frame at before checking it. */
export const FRAME_SAMPLE = { width: 64, height: 48 } as const;

export const BAD_PHOTO_MESSAGE = "The photo came out too dark or blank — please retake it.";

export type FrameProblem = "dark" | "bright" | "flat";

export interface FrameCheck {
  ok: boolean;
  problem: FrameProblem | null;
  mean: number;
  stdDev: number;
}

/** RGBA bytes → brightness statistics and a verdict. */
export function assessFrame(rgba: ArrayLike<number>): FrameCheck {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return { ok: false, problem: "flat", mean: 0, stdDev: 0 };
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < pixels * 4; i += 4) {
    // Rec. 601 luma, as the eye weighs red, green and blue.
    const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
    sum += y;
    sumSq += y * y;
  }
  const mean = sum / pixels;
  const stdDev = Math.sqrt(Math.max(0, sumSq / pixels - mean * mean));
  const problem: FrameProblem | null =
    mean < MIN_MEAN_LUMA ? "dark" : mean > MAX_MEAN_LUMA ? "bright" : stdDev < MIN_LUMA_STDDEV ? "flat" : null;
  return { ok: problem === null, problem, mean, stdDev };
}
