import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Terms } from "../../src/lib/billing/invoice.ts";
import { buildMeterSubmission, type MeterContext } from "../../src/lib/billing/meter-invoice.ts";

import { asPostgres, asService, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";

/**
 * Billing engine wiring (migration 0015, INV-04/05). The TypeScript engine is the
 * only place amounts are calculated; the database stores its result only when the
 * inputs are this ticket's facts and the arithmetic is consistent.
 */
describe.skipIf(!DB_URL)("billing engine wiring (linked dev database, rolled back)", () => {
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

  // Fixture agreement A1 mono: Rs. 5,000, 2,000 included, Rs. 2.50; initial reading 5,000; cycle 1 open.
  const MONO: Terms = {
    machineType: "MONO",
    commitmentCents: 500_000,
    bwIncluded: 2000,
    bwRateCents: 250,
    colourIncluded: null,
    colourRateCents: null,
    cycleLengthDays: 30,
  };
  const context = (overrides: Partial<MeterContext> = {}, previous = 5000, counterMax: number | null = null): MeterContext => ({
    terms: MONO,
    cyclesCovered: 1,
    counters: { BW: { known: [{ value: previous, at: "2026-01-01T00:00:00Z", source: "INITIAL" }], counterMax, history: [] } },
    estimateCredits: [],
    ...overrides,
  });

  const SUBMIT = `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb,
                    now() + interval '2 days', null, $6) as r`;
  const submitParams = (readings: unknown, invoice: unknown, anomaly: string | null) => [
    f.tickets.a1Mono,
    f.custA1,
    JSON.stringify(readings),
    JSON.stringify({ storage_path: `${f.ownerA}/${f.tickets.a1Mono}/p.jpg` }),
    JSON.stringify(invoice),
    anomaly,
  ];
  const submit = (s: ReturnType<typeof buildMeterSubmission>) => db.query(SUBMIT, submitParams(s.readings, s.invoice, s.anomalyFlag));
  const submitError = (readings: unknown, invoice: unknown, anomaly: string | null = null) =>
    sqlError(db, SUBMIT, submitParams(readings, invoice, anomaly));

  it("stores an engine-built invoice with its calculation record", async () => {
    await isolated(db, async () => {
      await asService(db);
      const s = buildMeterSubmission(context(), { BW: 7600 }); // spec 6.3 mono case 2
      const { rows } = await submit(s);
      await asPostgres(db);
      const inv = await db.query("select total_cents::int, cycles_covered, calculation from public.invoices where id = $1", [rows[0].r.invoice_id]);
      expect(inv.rows[0]).toMatchObject({ total_cents: 650_000, cycles_covered: 1 });
      expect(inv.rows[0].calculation).toMatchObject({ engine: "rentdesk-billing-1", counters: [{ usage: 2600, excess: 600 }] });
      expect(await count(db, "select 1 from public.invoice_lines where invoice_id = $1", [rows[0].r.invoice_id])).toBe(2);
    });
  });

  it("refuses invoices that were not calculated from this ticket's facts", async () => {
    await isolated(db, async () => {
      await asService(db);
      const s = buildMeterSubmission(context(), { BW: 7600 });

      // No calculation record (an invoice typed by hand).
      const { calculation: _omit, ...handMade } = s.invoice;
      void _omit;
      expect((await submitError(s.readings, handMade))?.code).toBe("RD400");

      // An amount that is not quantity x rate, even when the totals were adjusted to match.
      const lines = s.invoice.lines.map((l) => (l.line_type === "BW_EXCESS" ? { ...l, amount_cents: l.amount_cents - 100 } : l));
      const tampered = { ...s.invoice, lines, subtotal_cents: s.invoice.subtotal_cents - 100, total_cents: s.invoice.total_cents - 100 };
      expect((await submitError(s.readings, tampered))?.message).toMatch(/quantity x rate/);

      // Other terms than the ticket snapshot (e.g. a cheaper rate).
      const cheaper = buildMeterSubmission(context({ terms: { ...MONO, bwRateCents: 100 } }), { BW: 7600 });
      expect((await submitError(cheaper.readings, cheaper.invoice))?.code).toBe("RD409");

      // Two cycles claimed when only one has passed since the last confirmed reading.
      const twoCycles = buildMeterSubmission(context({ cyclesCovered: 2 }), { BW: 7600 });
      expect((await submitError(twoCycles.readings, twoCycles.invoice))?.message).toMatch(/covers 1 cycle/);

      // Readings that differ from the calculation.
      expect((await submitError([{ ...s.readings[0], current_value: 9000 }], s.invoice))?.code).toBe("RD400");

      // An anomaly flag the engine did not produce.
      expect((await submitError(s.readings, s.invoice, "HIGH"))?.code).toBe("RD400");
    });
  });

  it("refuses an invoice calculated from a previous reading that has changed (new baseline)", async () => {
    await isolated(db, async () => {
      const stale = buildMeterSubmission(context(), { BW: 7600 });
      // The owner records a meter replacement after the customer's screen loaded.
      await db.query(
        // One transaction gives every row the same now(): record the baseline as later.
        "insert into public.meter_baselines (owner_id, agreement_id, counter_type, value, reason, recorded_by, recorded_at) values ($1, $2, 'BW', 0, 'Meter replaced', $1, now() + interval '1 minute')",
        [f.ownerA, f.agrA1Mono],
      );
      await asService(db);
      expect((await submitError(stale.readings, stale.invoice))?.message).toMatch(/previous meter reading has changed/);

      // Recalculated from the baseline, it is accepted: usage continues from 0.
      const fresh = buildMeterSubmission(context({}, 0), { BW: 1800 });
      expect(fresh.result.counters[0]).toMatchObject({ previous: 0, usage: 1800, excess: 0 });
      await submit(fresh);
    });
  });

  it("issues an invoice with a counter rollover only after the owner confirms it", async () => {
    await isolated(db, async () => {
      // Counter maximum 9,999 and a baseline near the top, so the next reading rolls over.
      await db.query("update public.machines set bw_counter_max = 9999 where id = $1", [f.machineAMono1]);
      await db.query(
        "insert into public.meter_baselines (owner_id, agreement_id, counter_type, value, reason, recorded_by, recorded_at) values ($1, $2, 'BW', 9900, 'Counter set', $1, now() + interval '1 minute')",
        [f.ownerA, f.agrA1Mono],
      );
      const s = buildMeterSubmission(context({}, 9900, 9999), { BW: 50 });
      expect(s.result.counters[0]).toMatchObject({ usage: 150, rolledOver: true });
      expect(s.result.rolloverToConfirm).toBe(true);

      await asService(db);
      const { rows } = await submit(s);
      const confirm = "select app.confirm_meter_submission($1, $2, $3, current_date + 7, now() + interval '7 days', null, '[]'::jsonb, $4) as r";
      const unconfirmed = await sqlError(db, confirm, [f.tickets.a1Mono, rows[0].r.submission_id, f.ownerA, false]);
      expect(unconfirmed?.code).toBe("RD409");
      expect(unconfirmed?.message).toMatch(/^ROLLOVER_UNCONFIRMED/);

      await db.query(confirm, [f.tickets.a1Mono, rows[0].r.submission_id, f.ownerA, true]);
      await asPostgres(db);
      const reading = await db.query(
        "select rolled_over, rollover_confirmed_by, rollover_confirmed_at from public.meter_readings where submission_id = $1",
        [rows[0].r.submission_id],
      );
      expect(reading.rows[0]).toMatchObject({ rolled_over: true, rollover_confirmed_by: f.ownerA });
      expect(reading.rows[0].rollover_confirmed_at).not.toBeNull();
      // A reading that did not roll over cannot carry a confirmation.
      expect(
        (await sqlError(db, "update public.meter_readings set rollover_confirmed_at = now() where submission_id = $1", [f.submissions.a1Colour]))?.code,
      ).toBe("23514");
    });
  });
});
