import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";

import { asPostgres, asService, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { meterContextFromDb } from "./returns";

/**
 * Meter reading and the owner's review (INV-01..14, DEP-02; rules 28-32): submit →
 * confirm, reject → resubmit, the rejection limit, corrections, manual entry,
 * idempotent submits, photo deletion on confirm, credits on the draft, orphan photos.
 * Payloads come from the billing engine, as on the server. Rolled back.
 */
describe.skipIf(!DB_URL)("meter review (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  const json = (v: unknown) => JSON.stringify(v);
  const notify = (userId: string, event: string) => json([{ user_id: userId, event, title: event }]);

  /** The customer submits `used` copies since the last known reading; returns ids. */
  async function submit(ticketId: string, used: number, o: { key?: string; source?: "CUSTOMER" | "OWNER_MANUAL"; note?: string } = {}) {
    const context = await meterContextFromDb(db, ticketId);
    const s = buildMeterSubmission(context, { BW: context.counters.BW!.known[0].value + used });
    const { rows: who } = await db.query("select owner_id, customer_id from public.billing_cycle_tickets where id = $1", [ticketId]);
    const source = o.source ?? "CUSTOMER";
    const actor = source === "CUSTOMER" ? who[0].customer_id : who[0].owner_id;
    const photo = source === "CUSTOMER" ? json({ storage_path: `${who[0].owner_id}/${ticketId}/${randomUUID()}.jpg`, captured_at: new Date().toISOString() }) : null;
    const { rows } = await db.query(
      `select app.submit_meter_reading($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, now() + interval '2 days', $8, $9, $10::jsonb) as r`,
      [ticketId, actor, o.key ?? randomUUID(), source, json(s.readings), photo, json(s.invoice), o.note ?? null, s.anomalyFlag, notify(who[0].owner_id, "meter.submitted")],
    );
    return { ...(rows[0].r as { submission_id: string; invoice_id: string; replayed: boolean }), submission: s };
  }

  const ticketOf = async (id: string) => (await db.query("select * from public.billing_cycle_tickets where id = $1", [id])).rows[0];
  const invoiceOf = async (id: string) =>
    (await db.query("select status, invoice_no, total_cents::int as total, credit_applied_cents::int as credit, confirmed_by from public.invoices where id = $1", [id])).rows[0];

  it("the service role can read everything the meter service reads (new objects get no automatic grants)", async () => {
    await isolated(db, async () => {
      await asService(db);
      for (const table of [
        "owner_settings_effective",
        "billing_cycle_tickets",
        "machines",
        "customers",
        "meter_submissions",
        "meter_readings",
        "meter_photos",
        "invoices",
        "invoice_lines",
        "credits",
        "owner_company_profiles",
        "meter_baselines",
        "rental_agreements",
      ]) {
        expect(await sqlError(db, `select 1 from public.${table} limit 1`), table).toBeNull();
      }
      await asPostgres(db);
    });
  });

  it("submit → confirm: invoice numbered and issued, photo marked and reported for deletion, readings kept (INV-06, INV-09, INV-10)", async () => {
    await isolated(db, async () => {
      const t = f.tickets.a1Mono;
      const { submission_id, invoice_id } = await submit(t, 2600);
      expect((await ticketOf(t)).status).toBe("PENDING_OWNER_REVIEW");
      expect(await invoiceOf(invoice_id)).toMatchObject({ status: "DRAFT", invoice_no: null, total: 650_000 });
      expect(await count(db, "select 1 from public.notifications where entity_id = $1 and event = 'meter.submitted' and user_id = $2", [t, f.ownerA])).toBe(1);

      await asService(db);
      const { rows } = await db.query(
        "select public.rpc_confirm_meter_submission($1, $2, $3, current_date + 7, now() + interval '8 days', null, $4::jsonb) as r",
        [t, submission_id, f.ownerA, notify(f.custA1, "invoice.issued")],
      );
      const r = rows[0].r as { invoice_no: string; photo_paths: string[]; photo_ids: string[] };
      expect(r.invoice_no).toMatch(/^INV-/);
      expect(r.photo_paths).toHaveLength(1);
      expect(r.photo_ids).toHaveLength(1);
      // Server code removes the file, then marks the row (the row stays as the record).
      await db.query("select public.rpc_mark_photos_deleted($1::jsonb, now())", [json(r.photo_ids)]);
      await asPostgres(db);

      expect(await invoiceOf(invoice_id)).toMatchObject({ status: "AWAITING_PAYMENT", invoice_no: r.invoice_no, confirmed_by: f.ownerA });
      expect((await ticketOf(t)).status).toBe("AWAITING_PAYMENT");
      const photo = (await db.query("select storage_path, delete_requested_at, deleted_at from public.meter_photos where submission_id = $1", [submission_id])).rows[0];
      expect(photo.storage_path).toBe(r.photo_paths[0]);
      expect(photo.deleted_at).not.toBeNull();
      const sub = (await db.query("select status, reviewed_by, submitted_at from public.meter_submissions where id = $1", [submission_id])).rows[0];
      expect(sub).toMatchObject({ status: "CONFIRMED", reviewed_by: f.ownerA });
      expect(await count(db, "select 1 from public.meter_readings where submission_id = $1 and current_value = 7600", [submission_id])).toBe(1);
      expect(await count(db, "select 1 from public.notifications where entity_id = $1 and event = 'invoice.issued' and user_id = $2", [t, f.custA1])).toBe(1);
    });
  });

  it("a double tap or a retry with the same key creates one submission (INV-13)", async () => {
    await isolated(db, async () => {
      const key = randomUUID();
      const first = await submit(f.tickets.a1Mono, 2600, { key });
      const again = await submit(f.tickets.a1Mono, 2600, { key });
      expect(again).toMatchObject({ submission_id: first.submission_id, invoice_id: first.invoice_id, replayed: true });
      expect(await count(db, "select 1 from public.meter_submissions where ticket_id = $1", [f.tickets.a1Mono])).toBe(1);
      expect(await count(db, "select 1 from public.invoices where ticket_id = $1", [f.tickets.a1Mono])).toBe(1);
    });
  });

  it("reject → resubmit: reason stored, customer asked again, the old photo purged on resubmission (INV-07, spec 6.1)", async () => {
    await isolated(db, async () => {
      const t = f.tickets.a1Mono;
      const first = await submit(t, 2600);
      await db.query("select app.reject_meter_submission($1, $2, $3, 'The photo is blurry', now() + interval '5 days', now() + interval '8 days', $4::jsonb)", [
        t,
        first.submission_id,
        f.ownerA,
        notify(f.custA1, "meter.rejected"),
      ]);
      const ticket = await ticketOf(t);
      expect([ticket.status, ticket.rejection_count, ticket.current_invoice_id]).toEqual(["METER_REQUESTED", 1, null]);
      expect((await invoiceOf(first.invoice_id)).status).toBe("REJECTED");
      const sub = (await db.query("select status, reject_reason from public.meter_submissions where id = $1", [first.submission_id])).rows[0];
      expect(sub).toEqual({ status: "REJECTED", reject_reason: "The photo is blurry" });
      expect((await db.query("select expires_at from public.meter_photos where submission_id = $1", [first.submission_id])).rows[0].expires_at).not.toBeNull();

      const second = await submit(t, 2500);
      expect((await db.query("select attempt_no from public.meter_submissions where id = $1", [second.submission_id])).rows[0].attempt_no).toBe(2);
      expect((await db.query("select delete_requested_at from public.meter_photos where submission_id = $1", [first.submission_id])).rows[0].delete_requested_at).not.toBeNull();
      expect((await ticketOf(t)).status).toBe("PENDING_OWNER_REVIEW");
    });
  });

  it("after the rejection limit the customer cannot resubmit; the owner enters it manually (spec 11.3, rule 28, INV-12)", async () => {
    await isolated(db, async () => {
      await db.query("update public.owner_settings set max_meter_rejections = 2 where owner_id = $1", [f.ownerA]);
      const t = f.tickets.a1Mono;
      for (let i = 0; i < 2; i++) {
        const s = await submit(t, 2600);
        await db.query("select app.reject_meter_submission($1, $2, $3, 'Wrong counter', now() + interval '5 days', now() + interval '8 days')", [t, s.submission_id, f.ownerA]);
      }
      await db.query("savepoint third");
      const refused = await submit(t, 2600).catch((e: { code: string; message: string }) => e);
      await db.query("rollback to savepoint third");
      expect(refused).toMatchObject({ code: "RD409", message: expect.stringMatching(/^TOO_MANY_REJECTIONS/) });

      // The owner's manual entry: no photo, a note is required, audited.
      const manual = await submit(t, 2600, { source: "OWNER_MANUAL", note: "Customer read it out on the phone" });
      expect((await ticketOf(t)).status).toBe("PENDING_OWNER_REVIEW");
      const sub = (await db.query("select source, note, submitted_by from public.meter_submissions where id = $1", [manual.submission_id])).rows[0];
      expect(sub).toEqual({ source: "OWNER_MANUAL", note: "Customer read it out on the phone", submitted_by: f.ownerA });
      expect(await count(db, "select 1 from public.meter_photos where submission_id = $1", [manual.submission_id])).toBe(0);
      const ev = (await db.query("select event_type, actor_id, reason from public.ticket_events where ticket_id = $1 order by created_at desc limit 1", [t])).rows[0];
      expect(ev).toEqual({ event_type: "MANUAL_ENTRY", actor_id: f.ownerA, reason: "Customer read it out on the phone" });
      expect(await count(db, "select 1 from public.audit_logs where entity = 'meter_submissions' and entity_id = $1", [manual.submission_id])).toBeGreaterThan(0);
    });
  });

  it("a manual entry needs a note and the owner of the ticket", async () => {
    await isolated(db, async () => {
      const t = f.tickets.a1Mono;
      await db.query("savepoint s1");
      expect(await submit(t, 2600, { source: "OWNER_MANUAL" }).catch((e: { code: string }) => e.code)).toBe("23514");
      await db.query("rollback to savepoint s1");
      const context = await meterContextFromDb(db, t);
      const s = buildMeterSubmission(context, { BW: 7600 });
      expect(
        (await sqlError(db, "select app.submit_meter_reading($1, $2, gen_random_uuid(), 'OWNER_MANUAL', $3::jsonb, null, $4::jsonb, now(), 'note', null)", [
          t,
          f.ownerB,
          json(s.readings),
          json(s.invoice),
        ]))?.code,
      ).toBe("RD403");
    });
  });

  describe("correcting a reading (INV-08, rule 29)", () => {
    async function corrected(ticketId: string, invoiceId: string, used: number) {
      const context = await meterContextFromDb(db, ticketId, { excludeInvoiceId: invoiceId });
      return buildMeterSubmission(context, { BW: context.counters.BW!.known[0].value + used });
    }
    const correct = (ticketId: string, submissionId: string, actor: string, s: ReturnType<typeof buildMeterSubmission>, note: string | null) =>
      sqlError(db, "select app.correct_meter_reading($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8::jsonb)", [
        ticketId,
        submissionId,
        actor,
        json(s.readings),
        json(s.invoice),
        s.anomalyFlag,
        note,
        notify(f.custA1, "meter.corrected"),
      ]);

    it("recalculates the draft, keeps the customer's value, writes the event and the audit log, tells the customer", async () => {
      await isolated(db, async () => {
        const t = f.tickets.a1Mono;
        const { submission_id, invoice_id } = await submit(t, 2600);
        const fixed = await corrected(t, invoice_id, 2100);
        expect(await correct(t, submission_id, f.ownerA, fixed, "The photo shows 7,100")).toBeNull();

        expect((await invoiceOf(invoice_id)).total).toBe(525_000);
        expect(await count(db, "select 1 from public.invoice_lines where invoice_id = $1 and line_type = 'BW_EXCESS' and quantity = 100", [invoice_id])).toBe(1);
        const r = (await db.query("select current_value::int, corrected_from_value::int, correction_note, corrected_by from public.meter_readings where submission_id = $1", [submission_id])).rows[0];
        expect(r).toEqual({ current_value: 7100, corrected_from_value: 7600, correction_note: "The photo shows 7,100", corrected_by: f.ownerA });
        const ev = (await db.query("select event_type, reason, metadata from public.ticket_events where ticket_id = $1 order by created_at desc limit 1", [t])).rows[0];
        expect(ev).toMatchObject({ event_type: "CORRECTION", reason: "The photo shows 7,100", metadata: { changes: [{ counter_type: "BW", from: 7600, to: 7100 }], total_after_cents: 525000 } });
        expect(await count(db, "select 1 from public.audit_logs where action = 'METER_READING_CORRECTED' and entity_id = $1", [submission_id])).toBe(1);
        expect(await count(db, "select 1 from public.notifications where entity_id = $1 and event = 'meter.corrected' and user_id = $2", [t, f.custA1])).toBe(1);
        expect((await ticketOf(t)).status).toBe("PENDING_OWNER_REVIEW");

        // A second correction keeps the customer's original value.
        expect(await correct(t, submission_id, f.ownerA, await corrected(t, invoice_id, 2200), "Second look")).toBeNull();
        const again = (await db.query("select current_value::int, corrected_from_value::int from public.meter_readings where submission_id = $1", [submission_id])).rows[0];
        expect(again).toEqual({ current_value: 7200, corrected_from_value: 7600 });
      });
    });

    it("is refused without a note, by anyone but the owner, unchanged, or with a tampered amount", async () => {
      await isolated(db, async () => {
        const t = f.tickets.a1Mono;
        const { submission_id, invoice_id } = await submit(t, 2600);
        const fixed = await corrected(t, invoice_id, 2100);
        expect((await correct(t, submission_id, f.ownerA, fixed, " "))?.code).toBe("RD400");
        expect((await correct(t, submission_id, f.custA1, fixed, "x"))?.code).toBe("RD403");
        expect((await correct(t, submission_id, f.ownerB, fixed, "x"))?.code).toBe("RD403");
        expect((await correct(t, submission_id, f.ownerA, await corrected(t, invoice_id, 2600), "Same"))?.code).toBe("RD400");
        const tampered = { ...fixed, invoice: { ...fixed.invoice, total_cents: 1, subtotal_cents: 1 } };
        expect((await correct(t, submission_id, f.ownerA, tampered, "x"))?.code).toMatch(/^RD4/);
        expect((await invoiceOf(invoice_id)).total).toBe(650_000);
      });
    });
  });

  it("removing a credit from the draft changes the total; it stays available and can be added back (DEP-02, rule 13)", async () => {
    await isolated(db, async () => {
      const { rows } = await db.query(
        "insert into public.credits (owner_id, customer_id, kind, amount_cents, reason, created_by) values ($1, $2, 'ADVANCE', 100000, 'Advance', $1) returning id",
        [f.ownerA, f.custA1],
      );
      const creditId = rows[0].id as string;
      const t = f.tickets.a1Mono;
      const { invoice_id } = await submit(t, 2600);
      expect(await invoiceOf(invoice_id)).toMatchObject({ total: 550_000, credit: 100_000 });

      const toggle = async (include: boolean, excluded: string[]) => {
        const context = await meterContextFromDb(db, t, { excludeInvoiceId: invoice_id, creditsExcluded: excluded });
        const s = buildMeterSubmission(context, { BW: 7600 });
        await db.query("select app.set_invoice_credit($1, $2, $3, $4, 'Customer asked for a refund', $5::jsonb)", [f.ownerA, invoice_id, creditId, include, json(s.invoice)]);
      };
      await toggle(false, [creditId]);
      expect(await invoiceOf(invoice_id)).toMatchObject({ total: 650_000, credit: 0 });
      expect((await db.query("select app.available_credits($1) as c", [f.custA1])).rows[0].c).toEqual([{ id: creditId, available_cents: 100000 }]);
      expect(await count(db, "select 1 from public.audit_logs where action = 'INVOICE_CREDIT_REMOVED' and entity_id = $1", [invoice_id])).toBe(1);

      await toggle(true, []);
      expect(await invoiceOf(invoice_id)).toMatchObject({ total: 550_000, credit: 100_000 });
    });
  });

  it("orphan photos: uploads older than 2 days that no submission recorded (rule 30)", async () => {
    await isolated(db, async () => {
      const orphan = `${f.ownerA}/${f.tickets.a1Mono}/${randomUUID()}.jpg`;
      const recent = `${f.ownerA}/${f.tickets.a1Mono}/${randomUUID()}.jpg`;
      await db.query("insert into storage.objects (bucket_id, name, created_at) values ('meter-photos', $1, now() - interval '3 days'), ('meter-photos', $2, now())", [
        orphan,
        recent,
      ]);
      await asService(db);
      const { rows } = await db.query("select public.rpc_cron_orphan_photos(now(), 1000) as o");
      await asPostgres(db);
      const names = rows[0].o as string[];
      expect(names).toContain(orphan);
      expect(names).not.toContain(recent);
      // The fixture's recorded photo (A1 colour, waiting for review) is never an orphan.
      expect(names).not.toContain(`${f.ownerA}/${f.tickets.a1Colour}/photo-1.jpg`);
    });
  });
});
