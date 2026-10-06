// @ts-check
// Used by `serwist build` (run after `next build`) to bundle src/app/sw.ts with a
// precache manifest. This "config mode" works with Turbopack, the Next.js 16 default.
import { serwist } from "@serwist/next/config";

export default serwist({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
});
