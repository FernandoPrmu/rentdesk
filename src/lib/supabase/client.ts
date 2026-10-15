import { createBrowserClient } from "@supabase/ssr";

import type { Database } from "@/types/db";

// Read literally so Next.js inlines them. Checked by hand rather than with Zod (src/lib/env.ts):
// this module is in the browser bundle of every portal page (the bell), and Zod would add
// about 30 KB compressed to each of them (task 12). The server validates both with Zod.
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/** Supabase client for Client Components. Uses the anon key; RLS applies. */
export function createClient() {
  if (!SUPABASE_URL || !/^https?:\/\//.test(SUPABASE_URL) || !ANON_KEY) {
    throw new Error("Missing or invalid environment variables: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY. See .env.example.");
  }
  return createBrowserClient<Database>(SUPABASE_URL, ANON_KEY);
}
