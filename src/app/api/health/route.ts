import { connection } from "next/server";

import { checkHealth } from "@/lib/ops/health";
import { APP_VERSION, BUILD_ID } from "@/lib/pwa/version";

/**
 * Health check for an uptime monitor (decision 99; docs/go-live.md, step k). Public, no
 * secrets, no user data: { ok, version, build, db, checkedAt }. 503 when the database
 * does not answer within 3 seconds.
 */
export async function GET() {
  await connection();
  const { status, body } = await checkHealth({
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    version: APP_VERSION,
    build: BUILD_ID,
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
