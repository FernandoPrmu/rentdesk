/**
 * Usernames and the synthetic Supabase Auth email (docs/database.md: Identity).
 * Users sign in with a username; Supabase Auth needs an email, so the server maps
 * `{username}` to `{username}@users.rentdesk.invalid`. The `.invalid` TLD can never
 * receive mail. Real contact emails live in `owners` / `customers`.
 */

export const LOGIN_EMAIL_DOMAIN = "users.rentdesk.invalid";

/** Same rule as the `profiles_username_format` check constraint. */
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,39}$/;
export const USERNAME_MAX_LENGTH = 40;

/** Trim and lowercase what the user typed. */
export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function isValidUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

/** `owner.lanka` -> `owner.lanka@users.rentdesk.invalid`. Throws on an invalid username. */
export function usernameToEmail(input: string): string {
  const username = normalizeUsername(input);
  if (!isValidUsername(username)) {
    throw new Error("Invalid username");
  }
  return `${username}@${LOGIN_EMAIL_DOMAIN}`;
}

/** Inverse of usernameToEmail; null for any other email. */
export function emailToUsername(email: string): string | null {
  const suffix = `@${LOGIN_EMAIL_DOMAIN}`;
  if (!email.toLowerCase().endsWith(suffix)) return null;
  const username = email.slice(0, -suffix.length).toLowerCase();
  return isValidUsername(username) ? username : null;
}

export type UsernamePrefix = "owner" | "cust";

/** Common company suffixes that make usernames long without helping anyone. */
const NOISE_WORDS = new Set(["pvt", "ltd", "private", "limited", "the", "and", "co", "company", "plc", "inc"]);

/**
 * A readable username slug from a business or person name:
 * "Perera Printers (Pvt) Ltd" -> "perera-printers".
 */
export function slugifyName(name: string): string {
  const words = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !NOISE_WORDS.has(w));
  return words.join("-").slice(0, 24).replace(/-+$/, "");
}

/**
 * Candidate usernames in order of preference: `cust.perera-printers`,
 * then `cust.perera-printers2`, `...3`, ... Falls back to `cust.user` when the
 * name has no usable characters. Every candidate matches USERNAME_PATTERN.
 */
export function usernameCandidates(prefix: UsernamePrefix, name: string, count = 50): string[] {
  const base = `${prefix}.${slugifyName(name) || "user"}`;
  const out: string[] = [];
  for (let i = 1; out.length < count; i++) {
    const suffix = i === 1 ? "" : String(i);
    out.push(`${base.slice(0, USERNAME_MAX_LENGTH - suffix.length)}${suffix}`);
  }
  return out;
}
