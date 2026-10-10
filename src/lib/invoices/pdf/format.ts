/**
 * Formats printed on invoice PDFs. Only relative imports: the seed and the
 * daily job's DB tests load this module outside Next.js.
 */

const grouping = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/** Integer cents -> "Rs. 12,800.00"; negative amounts (credits) -> "-Rs. 2,000.00". */
export function formatInvoiceMoney(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`Amount must be whole cents: ${cents}`);
  const abs = Math.abs(cents);
  const whole = grouping.format(Math.trunc(abs / 100));
  const fraction = String(abs % 100).padStart(2, "0");
  return `${cents < 0 ? "-" : ""}Rs. ${whole}.${fraction}`;
}

const dateOnly = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });

/** "2026-10-08" (a Colombo calendar date) -> "8 Oct 2026". */
export function formatInvoiceDate(isoDate: string): string {
  return dateOnly.format(new Date(`${isoDate.slice(0, 10)}T00:00:00Z`));
}

/** Copies and meter readings: 12500 -> "12,500". */
export function formatInvoiceCount(value: number): string {
  return grouping.format(value);
}
