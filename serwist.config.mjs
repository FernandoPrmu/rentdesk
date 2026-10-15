// @ts-check
// Used by `serwist build` (run after `next build`) to bundle src/app/sw.ts with a
// precache manifest. This "config mode" works with Turbopack, the Next.js 16 default.
import { readFileSync } from "node:fs";

import { serwist } from "@serwist/next/config";

import { isPrecacheable, offlineAssetRefs } from "./src/lib/pwa/cache-policy.mts";

// The offline page and only what it needs (decision 88). `next build` ran first.
const offlineRefs = offlineAssetRefs(readFileSync(".next/server/app/offline.html", "utf8"));

export default serwist({
  swSrc: "src/app/sw.ts",
  swDest: "public/sw.js",
  // Prerendered HTML includes the static shells of signed-in pages: never precached.
  // Only the offline page is.
  precachePrerendered: false,
  globPatterns: [
    ".next/static/**/*.{js,css,woff2,png,svg,ico,webp}",
    "public/icons/**/*",
    ".next/server/app/offline.html",
  ],
  manifestTransforms: [
    (entries) => ({ manifest: entries.filter((e) => isPrecacheable(e.url, offlineRefs)), warnings: [] }),
  ],
});
