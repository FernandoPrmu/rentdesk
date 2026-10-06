import "server-only";

import { z } from "zod";

const serverEnvSchemas = {
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  CRON_SECRET: z.string().min(16),
  RESEND_API_KEY: z.string().min(1),
  APP_URL: z.url(),
} as const;

export type ServerEnvKey = keyof typeof serverEnvSchemas;

/**
 * Reads one server-only secret. Each call validates just the variable it needs,
 * so a missing RESEND_API_KEY does not break, say, the cron route.
 */
export function serverEnv(key: ServerEnvKey): string {
  const result = serverEnvSchemas[key].safeParse(process.env[key]);
  if (!result.success) {
    throw new Error(`Missing or invalid environment variable: ${key}. See .env.example.`);
  }
  return result.data;
}
