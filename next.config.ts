import { execSync } from "node:child_process";

import type { NextConfig } from "next";

import { resolveBuildId } from "./src/lib/pwa/version";
import { securityHeaders } from "./src/lib/security/headers";

// One ID per deployment, inlined into the page and /api/version (decision 89). Locally
// the commit; without git the banner stays off ("dev").
const buildId = resolveBuildId(process.env, () => {
  try {
    return execSync("git rev-parse --short=12 HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || "dev";
  } catch {
    return "dev";
  }
});

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  env: { NEXT_PUBLIC_BUILD_ID: buildId },
  experimental: {
    // Letterhead uploads (5 MB limit, checked again on the server) plus multipart overhead.
    serverActions: { bodySizeLimit: "6mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders({
          supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
          dev: isDev,
          https: process.env.VERCEL === "1",
        }),
      },
      // The browser must always see a new service worker as soon as it is deployed.
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] },
    ];
  },
  // Invoice PDFs are rendered on the server (confirm, return, daily job, preview, seed)
  // with the embedded Noto Sans fonts, read from disk (src/lib/invoices/pdf/fonts.ts).
  outputFileTracingIncludes: {
    "/*": ["./assets/fonts/*"],
    "/**/*": ["./assets/fonts/*"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
