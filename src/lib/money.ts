/**
 * Money is entered in rupees and stored as integer cents (bigint in the database).
 * Parsing works on the digits as text, so no floating-point value ever touches an
 * amount: "2.50" is 250 cents, never 249.99999.
 */

/** Rs. 10,000,000,000: far above any rental amount, far below Number.MAX_SAFE_INTEGER cents. */
export const MAX_CENTS = 1_000_000_000_000;

/**
 * "10000", "10,000", "Rs. 10,000.50", "2.5" -> cents. Returns null for anything else
 * (negative, more than 2 decimals, letters, empty, too large).
 */
export function rupeesToCents(input: string): number | null {
  const cleaned = input
    .trim()
    .replace(/^(rs\.?|lkr)\s*/i, "")
    .replace(/[,\s]/g, "");
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(cleaned) ?? /^()\.(\d{1,2})$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1] || "0");
  const fraction = Number((match[2] ?? "").padEnd(2, "0"));
  const cents = whole * 100 + fraction;
  return cents <= MAX_CENTS ? cents : null;
}

/** Cents -> the value for an input box: "10000" or "2.50". */
export function centsToRupeesInput(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = cents % 100;
  return fraction === 0 ? String(whole) : `${whole}.${String(fraction).padStart(2, "0")}`;
}

const grouping = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Cents -> "Rs. 10,000" or "Rs. 2.50". */
export function formatRupees(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = grouping.format(Math.trunc(abs / 100));
  const fraction = abs % 100;
  const text = fraction === 0 ? whole : `${whole}.${String(fraction).padStart(2, "0")}`;
  return `${negative ? "-" : ""}Rs. ${text}`;
}
