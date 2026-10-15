/// <reference lib="webworker" />
// Service worker source. Bundled to public/sw.js by `serwist build` after `next build`
// (see serwist.config.mjs). Not registered in `next dev`.
//
// Static files only (decision 88): hashed build assets, icons and the offline page.
// Pages, RSC payloads, API answers, signed URLs, PDFs and other origins always go to
// the network and are never stored. A page that cannot load offline shows /offline.
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { CacheFirst, ExpirationPlugin, NetworkOnly, Serwist } from "serwist";

import { isKeptCache, isStaticAsset, OFFLINE_URL, STATIC_CACHE } from "../lib/pwa/cache-policy.mts";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // A new version waits until the user taps "New version available" (decision 89), so
  // an open page keeps the assets it was built with until then.
  skipWaiting: false,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: [
    {
      matcher: ({ url, request, sameOrigin }) => sameOrigin && isStaticAsset(url, self.location.origin, request.method),
      handler: new CacheFirst({
        cacheName: STATIC_CACHE,
        plugins: [new ExpirationPlugin({ maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 30 })],
      }),
    },
    // Pages: always the network; only the offline fallback below when it fails.
    { matcher: ({ request }) => request.mode === "navigate", handler: new NetworkOnly() },
  ],
  fallbacks: {
    entries: [{ url: OFFLINE_URL, matcher: ({ request }) => request.mode === "navigate" }],
  },
});

// Remove every cache this worker does not own, including the page and API caches an
// earlier version (Serwist's defaultCache) may have left on a phone.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((n) => !isKeptCache(n)).map((n) => caches.delete(n)))),
  );
});

serwist.addEventListeners();
