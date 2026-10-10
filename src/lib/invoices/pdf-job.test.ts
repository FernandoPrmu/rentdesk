import { describe, expect, it, vi } from "vitest";

import type { Rpc } from "../tickets/transitions";

import { generateInvoicePdf, invoicePdfPath } from "./pdf-job";
import { buildInvoiceDocument, documentHash, type InvoicePdfClaim } from "./pdf/document";
import { loadInvoiceFonts } from "./pdf/fonts";

/**
 * The PDF job with a fake database and storage (decision 34): claim → render →
 * upload v{n} → record; same content → no new version; a failure is recorded
 * and rethrown (the daily job retries). DB behaviour: invoice-pdfs.db.test.ts.
 */

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const INVOICE = "00000000-0000-4000-8000-0000000000b1";

function claim(overrides: Partial<InvoicePdfClaim> = {}): InvoicePdfClaim {
  return {
    invoice: {
      id: INVOICE,
      owner_id: OWNER,
      customer_id: "00000000-0000-4000-8000-0000000000c1",
      invoice_no: "INV-000007",
      type: "NORMAL",
      status: "AWAITING_PAYMENT",
      period_start: "2026-09-10",
      period_end: "2026-10-09",
      cycles_covered: 1,
      total_cents: 650_000,
      due_date: "2026-10-17",
      issued_at: "2026-10-10T04:00:00Z",
      cancelled_at: null,
      cancel_reason: null,
      calculation: {
        counters: [{ counter_type: "BW", previous_value: 10_000, current_value: 12_600, usage: 2_600, included: 2_000, rolled_over: false }],
        partial: null,
      },
      branding_snapshot: { company_name: "Lanka Copy Solutions", bank_name: "Bank of Ceylon", logo_path: `${OWNER}/logos/${"a".repeat(64)}.png` },
      pdf_revision: 3,
    },
    lines: [
      { line_type: "COMMITMENT", description: "Monthly commitment", quantity: 1, rate_cents: 500_000, amount_cents: 500_000 },
      { line_type: "BW_EXCESS", description: "B&W copies above 2,000 included", quantity: 600, rate_cents: 250, amount_cents: 150_000 },
    ],
    customer: { name: "Silva Stationers", business_name: null, address: "Maharagama" },
    machine: { brand: "Kyocera", model: "ECOSYS M2040dn", serial_no: "LCS-M-003", type: "MONO" },
    location: "Front office",
    cycle_no: 4,
    latest: null,
    parties: null,
    ...overrides,
  };
}

function harness(c: InvoicePdfClaim | null, opts: { failUpload?: boolean } = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  const rpc: Rpc = async (fn, args) => {
    calls.push([fn, args]);
    if (fn === "rpc_claim_invoice_pdf") return c;
    if (fn === "rpc_record_invoice_pdf") return { version: args.p_version ?? c?.latest?.version, ready: true };
    if (fn === "rpc_mark_invoice_pdf_failed") return 1;
    throw new Error(`unexpected ${fn}`);
  };
  const written = new Map<string, Uint8Array>();
  const files = {
    readBranding: vi.fn(async () => null),
    writeInvoicePdf: vi.fn(async (path: string, bytes: Uint8Array) => {
      if (opts.failUpload) throw new Error("storage down");
      written.set(path, bytes);
    }),
  };
  return { rpc, calls, files, written };
}

describe("generateInvoicePdf", () => {
  it("does nothing when nothing is pending (or another renderer holds the claim)", async () => {
    const h = harness(null);
    expect(await generateInvoicePdf(h.rpc, h.files, loadInvoiceFonts, INVOICE)).toEqual({ status: "SKIPPED" });
    expect(h.calls.map(([fn]) => fn)).toEqual(["rpc_claim_invoice_pdf"]);
  });

  it("renders version 1 from the stored data, uploads it and records it for the claimed revision", async () => {
    const h = harness(claim());
    const r = await generateInvoicePdf(h.rpc, h.files, loadInvoiceFonts, INVOICE);
    expect(r).toEqual({ status: "CREATED", version: 1, ready: true, path: invoicePdfPath(OWNER, INVOICE, 1) });
    expect(invoicePdfPath(OWNER, INVOICE, 1)).toBe(`${OWNER}/${INVOICE}/v1.pdf`);
    expect(h.files.readBranding).toHaveBeenCalledWith(`${OWNER}/logos/${"a".repeat(64)}.png`);
    const bytes = h.written.get(`${OWNER}/${INVOICE}/v1.pdf`);
    expect(new TextDecoder().decode(bytes?.slice(0, 5))).toBe("%PDF-");
    const record = h.calls.find(([fn]) => fn === "rpc_record_invoice_pdf")?.[1];
    expect(record).toMatchObject({
      p_invoice_id: INVOICE,
      p_revision: 3,
      p_version: 1,
      p_path: `${OWNER}/${INVOICE}/v1.pdf`,
      p_hash: documentHash(buildInvoiceDocument(claim())),
      p_size: bytes?.length,
      p_template: "BUILT_IN",
      p_parties: { customer: { name: "Silva Stationers" }, machine: { serialNo: "LCS-M-003", location: "Front office" } },
    });
  });

  it("makes the next version when the content changed (e.g. a late fee)", async () => {
    const h = harness(claim({ latest: { version: 2, content_hash: "0".repeat(64) } }));
    const r = await generateInvoicePdf(h.rpc, h.files, loadInvoiceFonts, INVOICE);
    expect(r).toMatchObject({ status: "CREATED", version: 3, path: `${OWNER}/${INVOICE}/v3.pdf` });
  });

  it("keeps the newest version when the content is the same (no duplicate PDF)", async () => {
    const same = documentHash(buildInvoiceDocument(claim()));
    const h = harness(claim({ latest: { version: 2, content_hash: same } }));
    expect(await generateInvoicePdf(h.rpc, h.files, loadInvoiceFonts, INVOICE)).toEqual({ status: "UNCHANGED", version: 2, ready: true });
    expect(h.files.writeInvoicePdf).not.toHaveBeenCalled();
    expect(h.calls.find(([fn]) => fn === "rpc_record_invoice_pdf")?.[1]).toMatchObject({ p_version: null, p_path: null });
  });

  it("customer and machine come from version 1 once it exists (an issued PDF never changes its parties)", async () => {
    const parties = {
      customer: { name: "Old Name Stores", businessName: null, address: null },
      machine: { brand: "Kyocera", model: "ECOSYS M2040dn", serialNo: "LCS-M-003", type: "MONO" as const, location: "Back office" },
    };
    const doc = buildInvoiceDocument(claim({ parties }));
    expect(doc.parties).toEqual(parties);
  });

  it("a failure is recorded on the invoice and rethrown; nothing is recorded as a version", async () => {
    const h = harness(claim(), { failUpload: true });
    await expect(generateInvoicePdf(h.rpc, h.files, loadInvoiceFonts, INVOICE)).rejects.toThrow("storage down");
    expect(h.calls.map(([fn]) => fn)).toEqual(["rpc_claim_invoice_pdf", "rpc_mark_invoice_pdf_failed"]);
    expect(h.calls[1][1]).toEqual({ p_invoice_id: INVOICE, p_error: "storage down" });
  });
});

describe("buildInvoiceDocument", () => {
  it("knows estimated, final and cancelled invoices", () => {
    expect(buildInvoiceDocument(claim({ invoice: { ...claim().invoice, type: "ESTIMATED" } }))).toMatchObject({ kind: "ESTIMATED", counters: [] });
    const final = buildInvoiceDocument(claim({ invoice: { ...claim().invoice, calculation: { partial: { days_used: 12, days_in_cycle: 31, rule: "PRORATED" } } } }));
    expect(final).toMatchObject({ kind: "FINAL", partial: { daysUsed: 12, daysInCycle: 31, rule: "PRORATED" } });
    const cancelled = buildInvoiceDocument(claim({ invoice: { ...claim().invoice, status: "CANCELLED", cancelled_at: "2026-10-12T20:00:00Z", cancel_reason: "Wrong rate" } }));
    // 20:00 UTC is already the 13th in Colombo.
    expect(cancelled.cancelled).toEqual({ date: "2026-10-13", reason: "Wrong rate" });
  });

  it("uses the branding snapshot only (BRD-03), with the letterhead and its layout", () => {
    const doc = buildInvoiceDocument(
      claim({
        invoice: {
          ...claim().invoice,
          branding_snapshot: {
            company_name: "Lanka Copy Solutions",
            letterhead_path: `${OWNER}/letterheads/${"b".repeat(64)}.pdf`,
            letterhead_layout: { preset: "FULL_PAGE", area: { x: 12, y: 24, w: 76, h: 56 } },
          },
        },
      }),
    );
    expect(doc.company.name).toBe("Lanka Copy Solutions");
    expect(doc.bank).toBeNull();
    expect(doc.letterhead).toEqual({ path: `${OWNER}/letterheads/${"b".repeat(64)}.pdf`, kind: "PDF", layout: { preset: "FULL_PAGE", area: { x: 12, y: 24, w: 76, h: 56 } } });
    expect(doc.issueDate).toBe("2026-10-10");
  });
});
