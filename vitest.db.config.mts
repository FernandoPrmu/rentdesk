import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Database tests (RLS, workflow functions) against the linked Supabase dev project.
// They need SUPABASE_DB_URL in .env.local and roll back everything they create.
// Kept out of `npm test` so unit tests stay fast and offline.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local: the suites skip themselves when SUPABASE_DB_URL is missing.
}

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["supabase/tests/**/*.db.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    // One remote connection per file at a time keeps the free-tier pooler happy.
    fileParallelism: false,
  },
});
