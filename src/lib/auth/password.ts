/**
 * Password strength rules (AUTH-03). Pure and client-safe: the change-password
 * screen shows them live, and the server action checks them again.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 72; // bcrypt ignores bytes after 72

// The most common passwords and patterns people try first.
const COMMON_PASSWORDS = new Set([
  "password", "password1", "password12", "password123", "password1234", "passw0rd", "p@ssw0rd",
  "1234567890", "12345678910", "0123456789", "1q2w3e4r5t", "qwertyuiop", "qwerty1234", "qwerty12345",
  "iloveyou123", "welcome123", "welcome1234", "letmein123", "admin12345", "abc1234567", "abcd123456",
  "rentdesk123", "rentdesk2026", "srilanka123", "colombo123", "changeme123", "asdfghjkl1",
]);

export type PasswordRuleId = "length" | "letter" | "number" | "username" | "common" | "max";

export interface PasswordRule {
  id: PasswordRuleId;
  label: string;
}

/** Shown on the change-password screen, in this order. */
export const PASSWORD_RULES: PasswordRule[] = [
  { id: "length", label: `At least ${PASSWORD_MIN_LENGTH} characters` },
  { id: "letter", label: "At least one letter" },
  { id: "number", label: "At least one number" },
  { id: "username", label: "Does not contain your username" },
  { id: "common", label: "Not a common password" },
];

export interface PasswordCheck {
  ok: boolean;
  /** Rules that pass, for the live checklist. */
  passed: Record<PasswordRuleId, boolean>;
}

export function checkPassword(password: string, context: { username?: string } = {}): PasswordCheck {
  const lower = password.toLowerCase();
  const username = context.username?.toLowerCase().trim();
  // `owner.lanka` should also block "lanka": check each part of 3+ characters.
  const usernameParts = username ? [username, ...username.split(/[._-]/)].filter((p) => p.length >= 3 && p !== "cust" && p !== "owner") : [];

  const passed: Record<PasswordRuleId, boolean> = {
    length: password.length >= PASSWORD_MIN_LENGTH,
    letter: /\p{L}/u.test(password),
    number: /\p{N}/u.test(password),
    username: !usernameParts.some((part) => lower.includes(part)),
    common: !COMMON_PASSWORDS.has(lower) && !/^(.)\1+$/.test(password),
    max: new TextEncoder().encode(password).length <= PASSWORD_MAX_LENGTH,
  };
  return { ok: Object.values(passed).every(Boolean), passed };
}
