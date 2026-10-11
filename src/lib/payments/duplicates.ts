/**
 * PAY-11 (decision 40): a slip is a possible duplicate of an earlier payment of
 * the same owner when its file is the same (SHA-256 of the stored file or of the
 * file as the customer chose it) or when the bank reference (ignoring case and
 * spaces around it) and the amount are both the same. It is a flag for the owner
 * and a warning for the customer, never a block. Mirrors app.payment_duplicates
 * (migration 0025; DB test). Pure. Only relative imports.
 */

export type DuplicateReason = "FILE" | "REFERENCE";

export interface SlipFingerprint {
  sha256: string;
  originalSha256: string | null;
  reference: string | null;
  amountCents: number;
}

export interface EarlierPayment {
  id: string;
  submittedAt: string;
  reference: string | null;
  amountCents: number;
  /** Fingerprints of its slip files (stored and original). */
  hashes: string[];
}

export interface DuplicateMatch {
  paymentId: string;
  reasons: DuplicateReason[];
}

const cleanReference = (r: string | null) => {
  const t = r?.trim() ?? "";
  return t === "" ? null : t.toLowerCase();
};

export function duplicateReasons(slip: SlipFingerprint, earlier: EarlierPayment): DuplicateReason[] {
  const hashes = [slip.sha256, slip.originalSha256].filter((h): h is string => Boolean(h));
  const reasons: DuplicateReason[] = [];
  if (earlier.hashes.some((h) => hashes.includes(h))) reasons.push("FILE");
  const ref = cleanReference(slip.reference);
  if (ref !== null && cleanReference(earlier.reference) === ref && earlier.amountCents === slip.amountCents) reasons.push("REFERENCE");
  return reasons;
}

/** The newest earlier payment that matches, or null. */
export function findDuplicate(slip: SlipFingerprint, earlier: EarlierPayment[]): DuplicateMatch | null {
  const newestFirst = [...earlier].sort((a, b) => (a.submittedAt === b.submittedAt ? a.id.localeCompare(b.id) : a.submittedAt < b.submittedAt ? 1 : -1));
  for (const p of newestFirst) {
    const reasons = duplicateReasons(slip, p);
    if (reasons.length > 0) return { paymentId: p.id, reasons };
  }
  return null;
}

const REASON_TEXT: Record<DuplicateReason, string> = {
  FILE: "the same slip file",
  REFERENCE: "the same bank reference and amount",
};

/** "Possible duplicate: the same slip file as an earlier payment." */
export function duplicateText(reasons: readonly string[]): string {
  const known = reasons.filter((r): r is DuplicateReason => r === "FILE" || r === "REFERENCE");
  const what = known.length > 0 ? known.map((r) => REASON_TEXT[r]).join(" and ") : "the same details";
  return `Possible duplicate: ${what} as an earlier payment.`;
}
