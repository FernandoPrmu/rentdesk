import { connection } from "next/server";

import { checkHealth } from "@/lib/ops/health";
import { APP_VERSION, BUILD_ID } from "@/lib/pwa/version";

/**
 * Health check for an uptime monitor (decision 99; docs/go-live.md, step k). Public, no
 * secrets, no user data: { ok, version, build, db, checkedAt }. 503 when the database
 * does not answer within 3 seconds. The answer is reused for 15 seconds per server
 * instance, so calling it in a loop cannot load the free-tier database.
 */
const REUSE_MS = 15_000;
let last: { at: number; result: Awaited<ReturnType<typeof checkHealth>> } | null = null;

export async function GET() {
  await connection();
  if (!last || Date.now() - last.at > REUSE_MS) {
    const result = await checkHealth({
      supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      version: APP_VERSION,
      build: BUILD_ID,
    });
    last = { at: Date.now(), result };
  }
  const { status, body } = last.result;
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
