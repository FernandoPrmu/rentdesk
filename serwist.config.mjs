// @ts-check
// Used by `serwist build` (run after `next build`) to bundle src/app/sw.ts with a
// precache manifest. This "config mode" works with Turbopack, the Next.js 16 default.
import { readFileSync } from "node:fs";

import { serwist } from "@serwist/next/config";

import { isPrecacheable, offlineAssetRefs } from "./src/lib/pwa/cache-policy.mts";
import { findOfflineHtml, offlinePrecacheEntry } from "./src/lib/pwa/offline-page.mts";

export default serwist.withNextConfig((nextConfig) => {
  // The offline page and only what it needs (decision 88). `next build` ran first. The
  // HTML is found wherever this build wrote it (Vercel's adapter uses another layout)
  // and precached by its URL, not globbed by its file path.
  const offlineHtml = readFileSync(findOfflineHtml(nextConfig.distDir || ".next"), "utf8");
  const offlineRefs = offlineAssetRefs(offlineHtml);

  return {
    swSrc: "src/app/sw.ts",
    swDest: "public/sw.js",
    // Prerendered HTML includes the static shells of signed-in pages: never precached.
    // Only the offline page is, through additionalPrecacheEntries.
    precachePrerendered: false,
    globPatterns: [".next/static/**/*.{js,css,woff2,png,svg,ico,webp}", "public/icons/**/*"],
    manifestTransforms: [
      (entries) => ({ manifest: entries.filter((e) => isPrecacheable(e.url, offlineRefs)), warnings: [] }),
    ],
    additionalPrecacheEntries: [offlinePrecacheEntry(offlineHtml)],
  };
});
