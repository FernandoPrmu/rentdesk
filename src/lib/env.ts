import { z } from "zod";

// Public env vars. Next.js inlines NEXT_PUBLIC_* into client bundles only when
// they are referenced literally (process.env.NEXT_PUBLIC_X), so keep them spelled out.
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

let cached: PublicEnv | undefined;

/** Parsed lazily so that builds without a configured .env.local still succeed. */
export function publicEnv(): PublicEnv {
  cached ??= parseEnv(publicEnvSchema, {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  });
  return cached;
}

/**
 * Whether this deployment has a database. Vercel Preview deployments get no Supabase
 * variables (docs/go-live.md, step c): they must never reach production (decision 98).
 */
export function isSupabaseConfigured(): boolean {
  return publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  }).success;
}

/** The page every request gets when the deployment has no database (a preview). */
export const NO_DATABASE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RentDesk preview</title></head><body style="font-family:system-ui,sans-serif;margin:2rem;line-height:1.5;max-width:32rem"><h1 style="font-size:1.25rem">This deployment has no database</h1><p>It is a preview build: it is not connected to RentDesk's data, so nobody can sign in here.</p><p>Use the production address instead.</p></body></html>`;

export function parseEnv<T extends z.ZodType>(schema: T, values: unknown): z.infer<T> {
  const result = schema.safeParse(values);
  if (!result.success) {
    const keys = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Missing or invalid environment variables: ${keys}. See .env.example.`);
  }
  return result.data;
}
