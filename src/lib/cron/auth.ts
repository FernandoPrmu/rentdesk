import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Checks the `Authorization: Bearer <CRON_SECRET>` header that Vercel Cron sends.
 * Compares SHA-256 digests in constant time so the secret length does not leak.
 */
export function isAuthorizedCronRequest(
  authorizationHeader: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !authorizationHeader) return false;
  const expected = createHash("sha256").update(`Bearer ${secret}`).digest();
  const actual = createHash("sha256").update(authorizationHeader).digest();
  return timingSafeEqual(expected, actual);
}
