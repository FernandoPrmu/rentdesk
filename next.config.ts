import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: {
    // Letterhead uploads (5 MB limit, checked again on the server) plus multipart overhead.
    serverActions: { bodySizeLimit: "6mb" },
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
