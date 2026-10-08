import "server-only";

import { randomInt } from "node:crypto";

/**
 * Temporary passwords (AUTH-02/04). Generated on the server, shown once, never
 * stored by RentDesk (Supabase Auth keeps only a bcrypt hash).
 */

// No look-alikes (0/O, 1/l/I) so a password read aloud or copied by hand works.
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnopqrstuvwxyz";
const DIGITS = "23456789";

/**
 * 14 characters in groups, e.g. `Kx7m-Pq4r-Zt9w` (12 random characters, about
 * 69 bits). Always contains upper case, lower case and a digit.
 */
export function generateTemporaryPassword(): string {
  const all = UPPER + LOWER + DIGITS;
  const pick = (set: string) => set[randomInt(set.length)];
  for (;;) {
    const chars = Array.from({ length: 12 }, () => pick(all));
    const s = chars.join("");
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s)) {
      return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
    }
  }
}
