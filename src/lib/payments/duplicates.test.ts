import { describe, expect, it } from "vitest";

import { duplicateReasons, duplicateText, type EarlierPayment, findDuplicate } from "./duplicates";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);

const earlier: EarlierPayment[] = [
  { id: "old", submittedAt: "2026-10-01T10:00:00Z", reference: "TRX-555", amountCents: 650_000, hashes: [A] },
  { id: "new", submittedAt: "2026-10-05T10:00:00Z", reference: "TRX-777", amountCents: 100_000, hashes: [B, C] },
];

describe("duplicate slips (PAY-11, decision 40)", () => {
  it("the same file, stored or as first chosen, is a duplicate", () => {
    expect(duplicateReasons({ sha256: A, originalSha256: null, reference: null, amountCents: 1 }, earlier[0])).toEqual(["FILE"]);
    expect(duplicateReasons({ sha256: "f".repeat(64), originalSha256: C, reference: null, amountCents: 1 }, earlier[1])).toEqual(["FILE"]);
  });

  it("the same bank reference (case and spaces ignored) and amount is a duplicate; another amount is not", () => {
    expect(duplicateReasons({ sha256: "f".repeat(64), originalSha256: null, reference: "  trx-555 ", amountCents: 650_000 }, earlier[0])).toEqual(["REFERENCE"]);
    expect(duplicateReasons({ sha256: "f".repeat(64), originalSha256: null, reference: "TRX-555", amountCents: 650_001 }, earlier[0])).toEqual([]);
    expect(duplicateReasons({ sha256: "f".repeat(64), originalSha256: null, reference: "  ", amountCents: 650_000 }, { ...earlier[0], reference: null })).toEqual([]);
  });

  it("both reasons at once", () => {
    expect(duplicateReasons({ sha256: A, originalSha256: null, reference: "TRX-555", amountCents: 650_000 }, earlier[0])).toEqual(["FILE", "REFERENCE"]);
  });

  it("returns the newest matching payment, or null", () => {
    expect(findDuplicate({ sha256: C, originalSha256: A, reference: null, amountCents: 1 }, earlier)).toEqual({ paymentId: "new", reasons: ["FILE"] });
    expect(findDuplicate({ sha256: "f".repeat(64), originalSha256: null, reference: "TRX-555", amountCents: 650_000 }, earlier)).toEqual({ paymentId: "old", reasons: ["REFERENCE"] });
    expect(findDuplicate({ sha256: "f".repeat(64), originalSha256: null, reference: "OTHER", amountCents: 650_000 }, earlier)).toBeNull();
  });

  it("explains it in plain words", () => {
    expect(duplicateText(["FILE"])).toBe("Possible duplicate: the same slip file as an earlier payment.");
    expect(duplicateText(["FILE", "REFERENCE"])).toBe("Possible duplicate: the same slip file and the same bank reference and amount as an earlier payment.");
  });
});
