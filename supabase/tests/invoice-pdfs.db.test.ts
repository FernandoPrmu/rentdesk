import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runDailyJob } from "../../src/lib/cron/daily.ts";
import { generateInvoicePdf, type InvoiceFiles } from "../../src/lib/invoices/pdf-job.ts";
import { loadInvoiceFonts } from "../../src/lib/invoices/pdf/fonts.ts";

import { asAnon, asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { pgRpc } from "./rpc";

/**
 * Invoice PDFs (migration 0022; INV-09, BRD-03/04, CP-05; decisions 34-36): the
 * `invoices` bucket and version table RLS, the trigger that marks a PDF pending,
 * versions and stale renders, the daily job retrying a failed PDF, the template
 * rpc and the server-only branding writes. Storage rows are inserted inside the
 * transaction and rolled back; the job writes to an in-memory store.
 */
describe.skipIf(!DB_URL)("invoice PDFs (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  const path = (owner: string, invoice: string, v = 1) => `${owner}/${invoice}/v${v}.pdf`;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  const invoice = async (id: string) =>
    (
      await db.query(
        "select status, pdf_status, pdf_revision, pdf_pending_reason, pdf_path, pdf_attempts, pdf_last_error, pdf_claimed_at from public.invoices where id = $1",
        [id],
      )
    ).rows[0];

  /** In-memory storage for the job: what it wrote, and an optional failure. */
  function memoryFiles(fail = false) {
    const written = new Map<string, Uint8Array>();
    const files: InvoiceFiles = {
      readBranding: async () => null,
      writeInvoicePdf: async (p, bytes) => {
        if (fail) throw new Error("storage down");
        written.set(p, bytes);
      },
    };
    return { files, written };
  }

  async function asServiceRun<T>(fn: () => Promise<T>): Promise<T> {
    await asService(db);
    try {
      return await fn();
    } finally {
      await asPostgres(db);
    }
  }

  it("issuing marks the PDF pending; drafts never are (decision 34)", async () => {
    // Issuing updates the invoice twice (number, then status and due date): the reason stays ISSUED (migration 0023).
    expect(await invoice(f.invoices.a2Mono)).toMatchObject({ pdf_status: "PENDING", pdf_pending_reason: "ISSUED", pdf_path: null });
    expect((await invoice(f.invoices.a2Mono)).pdf_revision).toBeGreaterThanOrEqual(1);
    expect(await invoice(f.invoices.a1Colour)).toMatchObject({ pdf_status: "NONE", pdf_revision: 0 });
  });

  it("the job makes v1; a late fee, a due date change and a cancellation each make the next version; old versions stay", async () => {
    await isolated(db, async () => {
      const store = memoryFiles();
      const make = () => asServiceRun(() => generateInvoicePdf(pgRpc(db), store.files, () => loadInvoiceFonts(), f.invoices.b1Mono));

      expect(await make()).toMatchObject({ status: "CREATED", version: 1, ready: true });
      expect(await invoice(f.invoices.b1Mono)).toMatchObject({ pdf_status: "READY", pdf_path: path(f.ownerB, f.invoices.b1Mono, 1), pdf_pending_reason: null });
      expect(await make()).toEqual({ status: "SKIPPED" }); // nothing pending: a retry makes nothing

      // Payment status changes are not printed: no new version.
      await db.query("update public.invoices set amount_paid_cents = 100 where id = $1", [f.invoices.b1Mono]);
      expect((await invoice(f.invoices.b1Mono)).pdf_status).toBe("READY");

      const before = (await invoice(f.invoices.b1Mono)).pdf_revision as number;
      await db.query("update public.invoices set late_fee_cents = 50000, total_cents = total_cents + 50000 where id = $1", [f.invoices.b1Mono]);
      expect(await invoice(f.invoices.b1Mono)).toMatchObject({ pdf_status: "PENDING", pdf_revision: before + 1, pdf_pending_reason: "LATE_FEE" });
      expect(await make()).toMatchObject({ status: "CREATED", version: 2 });

      await db.query("update public.invoices set due_date = due_date + 14 where id = $1", [f.invoices.b1Mono]);
      expect(await make()).toMatchObject({ status: "CREATED", version: 3 });

      await db.query("update public.invoices set status = 'CANCELLED', cancel_reason = 'Wrong rate', cancelled_at = now() where id = $1", [f.invoices.b1Mono]);
      expect(await make()).toMatchObject({ status: "CREATED", version: 4 });

      const { rows } = await db.query("select version, reason, storage_path from public.invoice_pdf_versions where invoice_id = $1 order by version", [f.invoices.b1Mono]);
      expect(rows.map((r) => [r.version, r.reason])).toEqual([[1, "ISSUED"], [2, "LATE_FEE"], [3, "DUE_DATE"], [4, "CANCELLED"]]);
      expect(rows.map((r) => r.storage_path)).toEqual([1, 2, 3, 4].map((v) => path(f.ownerB, f.invoices.b1Mono, v)));
      expect([...store.written.keys()]).toHaveLength(4);
      expect((await invoice(f.invoices.b1Mono)).pdf_path).toBe(path(f.ownerB, f.invoices.b1Mono, 4));
      expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'INVOICE_PDF_CREATED'", [f.invoices.b1Mono])).toBe(4);
    });
  });

  it("a render that raced with a change is stored but not marked READY; a second claim waits for the first", async () => {
    await isolated(db, async () => {
      const rpc = pgRpc(db);
      await asService(db);
      const claim = (await rpc("rpc_claim_invoice_pdf", { p_invoice_id: f.invoices.b1Mono, p_now: new Date().toISOString() })) as { invoice: { pdf_revision: number } };
      const revision = claim.invoice.pdf_revision;
      // Another renderer (e.g. the daily job) gets nothing while the claim is fresh.
      expect(await rpc("rpc_claim_invoice_pdf", { p_invoice_id: f.invoices.b1Mono, p_now: new Date().toISOString() })).toBeNull();
      await asPostgres(db);
      await db.query("update public.invoices set late_fee_cents = 1000, total_cents = total_cents + 1000 where id = $1", [f.invoices.b1Mono]);
      await asService(db);
      const recorded = await rpc("rpc_record_invoice_pdf", {
        p_invoice_id: f.invoices.b1Mono,
        p_revision: revision,
        p_version: 1,
        p_path: path(f.ownerB, f.invoices.b1Mono, 1),
        p_hash: "a".repeat(64),
        p_size: 1000,
        p_template: "BUILT_IN",
        p_parties: { customer: { name: "B1" } },
      });
      expect(recorded).toEqual({ version: 1, ready: false });
      // Version numbers only go up by one.
      const conflict = await rpc("rpc_record_invoice_pdf", {
        p_invoice_id: f.invoices.b1Mono,
        p_revision: revision + 1,
        p_version: 3,
        p_path: path(f.ownerB, f.invoices.b1Mono, 3),
        p_hash: "b".repeat(64),
        p_size: 1000,
        p_template: "BUILT_IN",
        p_parties: {},
      }).catch((e: Error) => e);
      expect(String(conflict)).toMatch(/PDF_VERSION_CONFLICT/);
      await asPostgres(db);
      expect(await invoice(f.invoices.b1Mono)).toMatchObject({ pdf_status: "PENDING", pdf_revision: revision + 1, pdf_claimed_at: null });
    });
  });

  it("a failed PDF stays pending with the error; the daily job retries it and the invoice gets its PDF", async () => {
    await isolated(db, async () => {
      const broken = memoryFiles(true);
      await expect(asServiceRun(() => generateInvoicePdf(pgRpc(db), broken.files, () => loadInvoiceFonts(), f.invoices.a2Mono))).rejects.toThrow("storage down");
      expect(await invoice(f.invoices.a2Mono)).toMatchObject({ pdf_status: "PENDING", pdf_attempts: 1, pdf_last_error: "storage down", pdf_claimed_at: null });
      expect(await count(db, "select 1 from public.invoice_pdf_versions where invoice_id = $1", [f.invoices.a2Mono])).toBe(0);

      const store = memoryFiles();
      await asService(db);
      const pending = (await pgRpc(db)("rpc_cron_pending_invoice_pdfs", { p_now: new Date().toISOString(), p_limit: 500 })) as string[];
      expect(pending).toContain(f.invoices.a2Mono);
      const result = await runDailyJob(
        pgRpc(db),
        { removeMeterPhotos: async () => {} },
        { now: new Date("2024-06-01T01:00:00+05:30"), simulated: true, trigger: "LOCAL", budgetMs: 600_000 },
        { generate: (id, now) => generateInvoicePdf(pgRpc(db), store.files, () => loadInvoiceFonts(), id, now) },
      );
      await asPostgres(db);
      expect(result.counts.pdfs).toBeGreaterThanOrEqual(1);
      expect(result.errors.filter((e) => e.id === f.invoices.a2Mono)).toEqual([]);
      expect(await invoice(f.invoices.a2Mono)).toMatchObject({ pdf_status: "READY", pdf_attempts: 0, pdf_last_error: null, pdf_path: path(f.ownerA, f.invoices.a2Mono, 1) });
      expect(store.written.has(path(f.ownerA, f.invoices.a2Mono, 1))).toBe(true);
    });
  });

  it("invoices bucket: the owner reads their tenant, the customer their own issued invoices, admin all; nobody writes", async () => {
    await isolated(db, async () => {
      await db.query(
        `insert into storage.objects (bucket_id, name) values ('invoices', $1), ('invoices', $2), ('invoices', $3), ('invoices', $4)`,
        [
          path(f.ownerA, f.invoices.a2Mono),
          path(f.ownerB, f.invoices.b1Mono),
          path(f.ownerA, f.invoices.a1Colour), // a draft: never the customer's to read
          `${f.ownerA}/preview/sample.pdf`,
        ],
      );
      const visible = async (user: string) => {
        await asUser(db, user);
        const { rows } = await db.query("select name from storage.objects where bucket_id = 'invoices' order by name");
        await asPostgres(db);
        return rows.map((r) => r.name as string);
      };
      expect(await visible(f.custA2)).toEqual([path(f.ownerA, f.invoices.a2Mono)]);
      expect(await visible(f.custA1)).toEqual([]); // not A2's invoice, and A1's own invoice is a draft
      expect(await visible(f.custB1)).toEqual([path(f.ownerB, f.invoices.b1Mono)]);
      expect((await visible(f.ownerA)).sort()).toEqual([path(f.ownerA, f.invoices.a1Colour), path(f.ownerA, f.invoices.a2Mono), `${f.ownerA}/preview/sample.pdf`].sort());
      expect(await visible(f.ownerB)).toEqual([path(f.ownerB, f.invoices.b1Mono)]);
      // Admin reads every tenant (the dev database also holds the seed's PDFs).
      expect(await visible(f.admin)).toEqual(expect.arrayContaining([path(f.ownerA, f.invoices.a2Mono), path(f.ownerB, f.invoices.b1Mono), `${f.ownerA}/preview/sample.pdf`]));

      await asAnon(db);
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'invoices'")).toBe(0);
      await asPostgres(db);

      for (const user of [f.ownerA, f.custA2, f.admin]) {
        await asUser(db, user);
        expect((await sqlError(db, "insert into storage.objects (bucket_id, name) values ('invoices', $1)", [path(f.ownerA, f.invoices.a2Mono, 9)]))?.code, user).toBe("42501");
        const updated = await db.query("update storage.objects set name = name where bucket_id = 'invoices'");
        expect(updated.rowCount, user).toBe(0);
        await asPostgres(db);
      }
    });
  });

  it("PDF versions: same visibility as the invoice; append-only even for the service role", async () => {
    await isolated(db, async () => {
      for (const [owner, inv, cust] of [
        [f.ownerA, f.invoices.a2Mono, f.custA2],
        [f.ownerB, f.invoices.b1Mono, f.custB1],
      ]) {
        await db.query(
          `insert into public.invoice_pdf_versions (owner_id, invoice_id, customer_id, version, storage_path, reason, template, content_hash, byte_size, parties)
           values ($1, $2, $3, 1, $4, 'ISSUED', 'BUILT_IN', $5, 1000, '{}')`,
          [owner, inv, cust, path(owner, inv), "c".repeat(64)],
        );
      }
      const seen = async (user: string) => {
        await asUser(db, user);
        const n = await count(db, "select 1 from public.invoice_pdf_versions");
        await asPostgres(db);
        return n;
      };
      expect(await seen(f.custA2)).toBe(1);
      expect(await seen(f.custA1)).toBe(0);
      expect(await seen(f.ownerA)).toBe(1);
      expect(await seen(f.ownerB)).toBe(1);
      expect(await seen(f.admin)).toBeGreaterThanOrEqual(2);

      await asUser(db, f.ownerA);
      expect((await sqlError(db, "delete from public.invoice_pdf_versions where invoice_id = $1", [f.invoices.a2Mono]))?.code).toBe("42501");
      await asService(db);
      expect((await sqlError(db, "update public.invoice_pdf_versions set byte_size = 1 where invoice_id = $1", [f.invoices.a2Mono]))?.code).toBe("42501");
      expect((await sqlError(db, "delete from public.invoice_pdf_versions where invoice_id = $1", [f.invoices.a2Mono]))?.code).toBe("42501");
      await asPostgres(db);
    });
  });

  it("the invoice template: own content-hash letterhead and a valid layout only; owners no longer write branding directly", async () => {
    await isolated(db, async () => {
      const own = `${f.ownerA}/letterheads/${"d".repeat(64)}.pdf`;
      const save = (owner: string, template: unknown) =>
        sqlError(db, "select public.rpc_save_invoice_template($1, $2::jsonb)", [owner, JSON.stringify(template)]);
      await asService(db);
      expect(await save(f.ownerA, { letterhead_path: own, letterhead_layout: { preset: "HEADER_ONLY", area: { x: 7, y: 20, w: 86, h: 76 } }, payment_instructions: "Cheques to A" })).toBeNull();
      expect((await save(f.ownerA, { letterhead_path: `${f.ownerB}/letterheads/${"d".repeat(64)}.pdf`, letterhead_layout: { preset: "HEADER_ONLY", area: { x: 7, y: 20, w: 86, h: 76 } } }))?.code).toBe("RD400");
      expect((await save(f.ownerA, { letterhead_path: `${f.ownerA}/logo.png`, letterhead_layout: { preset: "HEADER_ONLY", area: { x: 7, y: 20, w: 86, h: 76 } } }))?.code).toBe("RD400");
      expect((await save(f.ownerA, { letterhead_path: own, letterhead_layout: { preset: "HEADER_ONLY", area: { x: 60, y: 20, w: 50, h: 76 } } }))?.code).toBe("RD400");
      expect((await save(f.custA1, { letterhead_path: null }))?.code).toBe("RD403");
      await asPostgres(db);
      const { rows } = await db.query("select letterhead_path, letterhead_layout, payment_instructions from public.owner_company_profiles where owner_id = $1", [f.ownerA]);
      expect(rows[0]).toMatchObject({ letterhead_path: own, letterhead_layout: { preset: "HEADER_ONLY" }, payment_instructions: "Cheques to A" });

      // Removing the letterhead clears the layout too (back to the built-in template).
      await asService(db);
      expect(await save(f.ownerA, { letterhead_path: null, letterhead_layout: { preset: "FULL_PAGE" } })).toBeNull();
      await asPostgres(db);
      const { rows: removed } = await db.query("select letterhead_path, letterhead_layout from public.owner_company_profiles where owner_id = $1", [f.ownerA]);
      expect(removed[0]).toEqual({ letterhead_path: null, letterhead_layout: {} });

      // Logos: the legacy path or a content-hash path only.
      await asService(db);
      const details = { company_name: "A", logo_path: `${f.ownerA}/logos/${"e".repeat(64)}.png` };
      expect(await sqlError(db, "select public.rpc_save_company_profile($1, $2::jsonb)", [f.ownerA, JSON.stringify(details)])).toBeNull();
      expect((await sqlError(db, "select public.rpc_save_company_profile($1, $2::jsonb)", [f.ownerA, JSON.stringify({ ...details, logo_path: `${f.ownerA}/evil.png` })]))?.code).toBe("RD400");
      await asPostgres(db);

      // Company profile and branding files are written by the server only (validation cannot be skipped).
      await asUser(db, f.ownerA);
      expect((await sqlError(db, "update public.owner_company_profiles set company_name = 'x' where owner_id = $1", [f.ownerA]))?.code).toBe("42501");
      expect((await sqlError(db, "insert into storage.objects (bucket_id, name) values ('branding', $1)", [`${f.ownerA}/letterheads/x.pdf`]))?.code).toBe("42501");
      await asPostgres(db);
    });
  });
});
