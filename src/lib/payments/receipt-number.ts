/**
 * Receipt numbers (decision 44): the owner's prefix ("RCT-" by default) and a
 * per-owner sequence padded to 6 digits, like invoice numbers. The database
 * assigns them (app.issue_receipt, receipt_counters); this mirrors the format
 * for tests and previews. Only relative imports.
 */

export const DEFAULT_RECEIPT_PREFIX = "RCT-";

export function formatReceiptNo(seq: number, prefix: string = DEFAULT_RECEIPT_PREFIX): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("receipt sequence must be a whole number from 1");
  if (!/^[A-Za-z0-9/_-]{0,12}$/.test(prefix)) throw new Error("receipt prefix: up to 12 letters, digits, / _ -");
  return `${prefix}${String(seq).padStart(6, "0")}`;
}

/** The sequence of a receipt number with the given prefix, or null. */
export function receiptSeq(receiptNo: string, prefix: string = DEFAULT_RECEIPT_PREFIX): number | null {
  if (!receiptNo.startsWith(prefix)) return null;
  const digits = receiptNo.slice(prefix.length);
  return /^\d{6,}$/.test(digits) ? Number(digits) : null;
}
