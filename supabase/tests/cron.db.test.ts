import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";
import { type DailyJobResult, runDailyJob } from "../../src/lib/cron/daily.ts";
import { TICKET_STATUSES, transitionAllowed } from "../../src/lib/tickets/states.ts";

import { asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { meterContextFromDb, submitReading } from "./returns";
import { pgRpc } from "./rpc";

/**
 * Billing cycle tickets and the daily job with simulated dates (TKT-01..13,
 * PAY-10, PAY-13, LATE-01; rules 20-25). The job is the real src/lib/cron code,
 * talking to the real rpc functions inside the test transaction (rolled back).
 *
 * Simulated dates are in 2024-2025: the seed's and fixture's own agreements are
 * not due then, so every ticket the job opens or changes here is one this test
 * created. 2024 is a leap year (Feb 29).
 */
describe.skipIf(!DB_URL)("tickets and the daily job (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  const removed: string[] = [];
  const storage = {
    async removeMeterPhotos(paths: string[]) {
      removed.push(...paths);
    },
  };

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  /** A moment in Sri Lanka time; the daily run is at ~01:00. */
  const at = (date: string, time = "01:00:00") => new Date(`${date}T${time}+05:30`);

  async function job(date: string, time?: string): Promise<DailyJobResult> {
    await asService(db);
    try {
      return await runDailyJob(pgRpc(db), storage, { now: at(date, time), simulated: true, trigger: "LOCAL", budgetMs: 600_000 });
    } finally {
      await asPostgres(db);
    }
  }

  /** The run handled these agreements (and their tickets) without an error. */
  async function clean(result: DailyJobResult, ids: string[]) {
    const { rows } = await db.query<{ id: string }>("select id from public.billing_cycle_tickets where agreement_id = any($1::uuid[])", [ids]);
    const mine = new Set([...ids, ...rows.map((r) => r.id)]);
    expect(result.errors.filter((e) => e.step === "run" || (e.id && mine.has(e.id)))).toEqual([]);
  }

  async function agreement(o: { first: string; start?: string; customer?: string; lateFee?: [string, number | null]; status?: "TERMINATED" }) {
    const machine = randomUUID();
    const id = randomUUID();
    await db.query("insert into public.machines (id, owner_id, brand, model, serial_no, type) values ($1, $2, 'Ricoh', 'MP 2014', $3, 'MONO')", [
      machine,
      f.ownerA,
      `CRON-${machine.slice(0, 8)}`,
    ]);
    await db.query(
      `insert into public.rental_agreements (id, owner_id, customer_id, machine_id, start_date, first_billing_date,
         monthly_commitment_cents, bw_included, bw_rate_cents, initial_bw_reading, late_fee_mode, late_fee_cents)
       values ($1, $2, $3, $4, $5, $6, 500000, 2000, 250, 1000, $7, $8)`,
      [id, f.ownerA, o.customer ?? f.custA2, machine, o.start ?? "2023-12-01", o.first, o.lateFee?.[0] ?? "OWNER_DEFAULT", o.lateFee?.[1] ?? null],
    );
    if (o.status === "TERMINATED") {
      await db.query("update public.rental_agreements set status = 'TERMINATED', termination_reason = 'Returned' where id = $1", [id]);
    }
    return id;
  }

  async function tickets(agreementId: string) {
    const { rows } = await db.query(
      `select id, cycle_no, cycle_date::text, period_start::text, period_end::text, cycle_length_days, status, status_before_overdue,
              stage_due_at, stage_entered_at, escalation_level, reminder_count, paused_at, current_invoice_id
       from public.billing_cycle_tickets where agreement_id = $1 order by cycle_no`,
      [agreementId],
    );
    return rows;
  }

  async function events(ticketId: string) {
    const { rows } = await db.query<{ event_type: string; from_status: string | null; to_status: string | null; reason: string | null; metadata: Record<string, unknown> }>(
      "select event_type, from_status, to_status, reason, metadata from public.ticket_events where ticket_id = $1 order by created_at, id",
      [ticketId],
    );
    return rows;
  }

  /** Notifications of a ticket, sorted (rows written in one transaction share created_at). */
  async function notes(ticketId: string) {
    const { rows } = await db.query<{ event: string; user_id: string }>(
      "select event, user_id from public.notifications where entity_id = $1 order by created_at, event",
      [ticketId],
    );
    return rows.map((r) => `${r.event}:${r.user_id === f.ownerA ? "owner" : r.user_id === f.admin ? "admin" : r.user_id === f.custA2 ? "customer" : "other"}`).sort();
  }

  async function confirm(ticketId: string, submissionId: string | null, dueDate: string) {
    const { rows } = await db.query("select owner_id from public.billing_cycle_tickets where id = $1", [ticketId]);
    await db.query("select app.confirm_meter_submission($1, $2, $3, $4::date, $5::timestamptz)", [
      ticketId,
      submissionId,
      rows[0].owner_id,
      dueDate,
      `${dueDate}T23:59:59+05:30`,
    ]);
  }

  /** Opens cycle 1, reads it and confirms it with `dueDate`: an issued invoice of Rs. 6,500. */
  async function issued(agreementId: string, openOn: string, dueDate: string) {
    await job(openOn);
    const [t] = await tickets(agreementId);
    const { submissionId, invoiceId } = await submitReading(db, t.id, 2600);
    await confirm(t.id, submissionId, dueDate);
    return { ticketId: t.id as string, invoiceId };
  }

  it("the TypeScript state machine is exactly app.ticket_transition_allowed (spec 5.3, 11)", async () => {
    const { rows } = await db.query<{ f: string; t: string; ok: boolean }>(
      `select f::text as f, t::text as t, app.ticket_transition_allowed(f, t) as ok
       from unnest(enum_range(null::public.ticket_status)) f cross join unnest(enum_range(null::public.ticket_status)) t`,
    );
    expect(rows).toHaveLength(TICKET_STATUSES.length ** 2);
    for (const r of rows) expect(r.ok, `${r.f} -> ${r.t}`).toBe(transitionAllowed(r.f as never, r.t as never));
  });

  describe("opening cycles (TKT-01, TKT-07, TKT-08; rules 1, 2)", () => {
    it("opens on the first billing date and not before, then monthly on month ends (31st -> Feb 29 -> Mar 31 -> Apr 30)", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-01-31" });
        await clean(await job("2024-01-30"), [a]);
        expect(await tickets(a)).toEqual([]);

        await clean(await job("2024-01-31"), [a]);
        let t = await tickets(a);
        expect(t).toHaveLength(1);
        expect(t[0]).toMatchObject({ cycle_no: 1, cycle_date: "2024-01-31", period_start: "2023-12-31", period_end: "2024-01-30", status: "METER_REQUESTED" });
        // Meter deadline (5.4): 00:00 on day 5, Colombo.
        expect(new Date(t[0].stage_due_at)).toEqual(at("2024-02-05", "00:00:00"));
        expect(new Date(t[0].stage_entered_at)).toEqual(at("2024-01-31"));
        expect(await notes(t[0].id)).toEqual(["ticket.opened:customer"]);
        expect((await events(t[0].id)).map((e) => e.event_type)).toEqual(["CREATED"]);

        await clean(await job("2024-02-28"), [a]);
        expect(await tickets(a)).toHaveLength(1);
        await clean(await job("2024-02-29"), [a]);
        await clean(await job("2024-03-31"), [a]);
        await clean(await job("2024-04-30"), [a]);
        t = await tickets(a);
        expect(t.map((x) => [x.cycle_no, x.cycle_date, x.cycle_length_days])).toEqual([
          [1, "2024-01-31", 31],
          [2, "2024-02-29", 29],
          [3, "2024-03-31", 31],
          [4, "2024-04-30", 30],
        ]);
        const { rows } = await db.query("select next_cycle_no, next_cycle_date::text as d from public.rental_agreements where id = $1", [a]);
        expect(rows[0]).toEqual({ next_cycle_no: 5, d: "2024-05-31" });
      });
    });

    it("February 28 in a common year, and back to the 31st", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2025-01-31", start: "2025-01-01" });
        await clean(await job("2025-02-27"), [a]);
        await clean(await job("2025-02-28"), [a]);
        await clean(await job("2025-03-31"), [a]);
        expect((await tickets(a)).map((x) => x.cycle_date)).toEqual(["2025-01-31", "2025-02-28", "2025-03-31"]);
      });
    });

    it("running twice the same day creates nothing (tickets, events, notifications, reminders)", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-05-01" });
        await job("2024-05-01");
        await job("2024-05-03");
        const snapshot = async () => {
          const [t] = await tickets(a);
          return {
            tickets: (await tickets(a)).length,
            events: await count(db, "select 1 from public.ticket_events where ticket_id = $1", [t.id]),
            notes: await count(db, "select 1 from public.notifications where entity_id = $1", [t.id]),
            reminders: t.reminder_count,
          };
        };
        const before = await snapshot();
        const again = await job("2024-05-03");
        await clean(again, [a]);
        expect(await snapshot()).toEqual(before);
        expect(before.reminders).toBe(1);
      });
    });

    it("catches up after three missed days: one ticket, deadline counted from the day it opens", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-03-10" });
        await clean(await job("2024-03-13"), [a]);
        const t = await tickets(a);
        expect(t.map((x) => [x.cycle_no, x.cycle_date, x.status])).toEqual([[1, "2024-03-10", "METER_REQUESTED"]]);
        expect(new Date(t[0].stage_due_at)).toEqual(at("2024-03-18", "00:00:00"));
      });
    });

    it("catches up a whole missed month: both cycles open, the older one is flagged Overdue (11.6)", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-03-10" });
        const result = await job("2024-04-12");
        await clean(result, [a]);
        const t = await tickets(a);
        expect(t.map((x) => [x.cycle_no, x.cycle_date, x.status, x.status_before_overdue, x.escalation_level])).toEqual([
          [1, "2024-03-10", "OVERDUE", "METER_REQUESTED", 1],
          [2, "2024-04-10", "METER_REQUESTED", null, 0],
        ]);
        expect(await notes(t[0].id)).toEqual(["ticket.opened:customer", "ticket.previous_overdue:owner"]);
        const { rows } = await db.query("select next_cycle_no, next_cycle_date::text as d from public.rental_agreements where id = $1", [a]);
        expect(rows[0]).toEqual({ next_cycle_no: 3, d: "2024-05-10" });
        // Nothing new the next day.
        await clean(await job("2024-04-13"), [a]);
        expect(await tickets(a)).toHaveLength(2);
      });
    });

    it("no ticket for a terminated agreement (11.7)", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-06-01", status: "TERMINATED" });
        await clean(await job("2024-06-03"), [a]);
        expect(await tickets(a)).toEqual([]);
      });
    });
  });

  describe("one reading for several cycles (rule 12, rule 25)", () => {
    it("three missed cycles then one reading: one invoice for 3 cycles, the two older tickets closed", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-11-01" });
        await clean(await job("2025-01-02"), [a]);
        let t = await tickets(a);
        expect(t.map((x) => [x.cycle_no, x.status])).toEqual([
          [1, "OVERDUE"],
          [2, "OVERDUE"],
          [3, "METER_REQUESTED"],
        ]);

        const { submission, invoiceId } = await submitReading(db, t[2].id, 7000);
        expect(submission.invoice.cycles_covered).toBe(3);
        const { rows: inv } = await db.query("select cycles_covered, subtotal_cents::int as s from public.invoices where id = $1", [invoiceId]);
        // 3 x Rs. 5,000 commitment, 6,000 copies included, 1,000 excess x Rs. 2.50.
        expect(inv[0]).toEqual({ cycles_covered: 3, s: 1_500_000 + 250_000 });

        t = await tickets(a);
        expect(t.map((x) => [x.cycle_no, x.status])).toEqual([
          [1, "CANCELLED"],
          [2, "CANCELLED"],
          [3, "PENDING_OWNER_REVIEW"],
        ]);
        for (const older of t.slice(0, 2)) {
          const e = (await events(older.id)).at(-1)!;
          expect(e).toMatchObject({ event_type: "STATUS_CHANGE", from_status: "OVERDUE", to_status: "CANCELLED", reason: "Billed in the cycle 3 invoice" });
          expect(e.metadata).toMatchObject({ billed_in_cycle_no: 3, invoice_id: invoiceId });
        }
        expect((await events(t[2].id)).at(-1)!.metadata).toMatchObject({ cycles_covered: 3, closed_cycles: [1, 2] });

        // A second reading on an older ticket is refused: its cycle is already billed.
        const context = await meterContextFromDb(db, t[0].id);
        const again = buildMeterSubmission(context, { BW: 9000 });
        const refused = await sqlError(
          db,
          `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now(), null, $6)`,
          [t[0].id, f.custA2, JSON.stringify(again.readings), JSON.stringify({ storage_path: `${f.ownerA}/${t[0].id}/p.jpg` }), JSON.stringify(again.invoice), again.anomalyFlag],
        );
        expect(refused?.code).toBe("RD409");
        expect(refused?.message).toMatch(/CANCELLED/);
        expect(await count(db, "select 1 from public.invoices where agreement_id = $1 and status <> 'REJECTED'", [a])).toBe(1);
      });
    });

    it("a reading is refused while an older reading of the agreement waits for the owner's review", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-11-01" });
        await job("2024-12-02");
        const t = await tickets(a);
        await submitReading(db, t[0].id, 1000);
        const context = await meterContextFromDb(db, t[1].id);
        const s = buildMeterSubmission(context, { BW: 5000 });
        const refused = await sqlError(
          db,
          `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now(), null, $6)`,
          [t[1].id, f.custA2, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${f.ownerA}/${t[1].id}/p.jpg` }), JSON.stringify(s.invoice), s.anomalyFlag],
        );
        expect(refused).toMatchObject({ code: "RD409", message: expect.stringMatching(/PREVIOUS_REVIEW_PENDING/) });
      });
    });
  });

  describe("deadlines, reminders and escalation (TKT-05, spec 5.4)", () => {
    it("meter stage: reminder day 2, reminder day 4, overdue + owner alerted day 5", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-05-01" });
        await job("2024-05-01");
        const [{ id }] = await tickets(a);
        const state = async () => {
          const [t] = await tickets(a);
          return [t.status, t.reminder_count, t.escalation_level];
        };
        await clean(await job("2024-05-02"), [a, id]);
        expect(await state()).toEqual(["METER_REQUESTED", 0, 0]);
        await clean(await job("2024-05-03"), [a, id]);
        expect(await state()).toEqual(["METER_REQUESTED", 1, 0]);
        await clean(await job("2024-05-05"), [a, id]);
        expect(await state()).toEqual(["METER_REQUESTED", 2, 0]);
        await clean(await job("2024-05-06"), [a, id]);
        expect(await state()).toEqual(["OVERDUE", 0, 1]);
        await clean(await job("2024-05-07"), [a, id]);
        expect(await notes(id)).toEqual(
          ["ticket.opened:customer", "ticket.meter_reminder:customer", "ticket.meter_reminder:customer", "ticket.meter_missed:owner", "ticket.meter_overdue:customer"].sort(),
        );
        expect((await events(id)).map((e) => `${e.event_type}:${e.to_status}`)).toEqual([
          "CREATED:METER_REQUESTED",
          "REMINDER:METER_REQUESTED",
          "REMINDER:METER_REQUESTED",
          "STATUS_CHANGE:OVERDUE",
        ]);
      });
    });

    it("owner review: reminders at 24 h and 48 h, admin alerted after 72 h, never confirmed automatically", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-05-01" });
        await job("2024-05-01");
        const [{ id }] = await tickets(a);
        await submitReading(db, id, 500);
        await db.query("update public.billing_cycle_tickets set stage_entered_at = $2 where id = $1", [id, at("2024-05-02", "10:00:00")]);
        const state = async () => {
          const [t] = await tickets(a);
          return [t.status, t.reminder_count, t.escalation_level];
        };
        await job("2024-05-03"); // 15 h
        expect(await state()).toEqual(["PENDING_OWNER_REVIEW", 0, 0]);
        await job("2024-05-04"); // 39 h
        expect(await state()).toEqual(["PENDING_OWNER_REVIEW", 1, 0]);
        await job("2024-05-05"); // 63 h
        expect(await state()).toEqual(["PENDING_OWNER_REVIEW", 2, 0]);
        await job("2024-05-06"); // 87 h
        expect(await state()).toEqual(["PENDING_OWNER_REVIEW", 2, 2]);
        await job("2024-06-30");
        expect(await state()).toEqual(["PENDING_OWNER_REVIEW", 2, 2]);
        const n = await notes(id);
        expect(n.filter((x) => x.startsWith("ticket.review_reminder"))).toEqual(["ticket.review_reminder:owner", "ticket.review_reminder:owner"]);
        expect(n).toContain("ticket.escalated:admin");
        expect((await events(id)).at(-1)).toMatchObject({ event_type: "ESCALATION", reason: "Owner has not acted for 72 hours" });
      });
    });

    it("payment: due soon, due today, overdue (invoice too) with the owner alerted, then day 7", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-07-01" });
        const { ticketId, invoiceId } = await issued(a, "2024-07-01", "2024-07-08");
        await job("2024-07-05");
        await job("2024-07-08");
        await job("2024-07-09");
        await job("2024-07-15");
        const [t] = await tickets(a);
        expect([t.status, t.status_before_overdue, t.reminder_count, t.escalation_level]).toEqual(["OVERDUE", "AWAITING_PAYMENT", 2, 1]);
        expect((await db.query("select status from public.invoices where id = $1", [invoiceId])).rows[0].status).toBe("OVERDUE");
        expect((await notes(ticketId)).filter((x) => x.startsWith("payment."))).toEqual(
          ["payment.due_soon:customer", "payment.due_today:customer", "payment.overdue:customer", "payment.overdue_owner:owner", "payment.overdue:customer"].sort(),
        );
      });
    });

    it("8.2: never overdue while a slip waits for verification", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-07-01" });
        const { ticketId } = await issued(a, "2024-07-01", "2024-07-08");
        await db.query(
          `select app.submit_payment($1, $1, gen_random_uuid(), array[(select current_invoice_id from public.billing_cycle_tickets where id = $2)], $3::jsonb, $4::jsonb, now())`,
          [f.custA2, ticketId, JSON.stringify({ amount_cents: 650000, paid_on: "2024-07-07", method: "BANK_TRANSFER" }), JSON.stringify({ storage_path: `${f.ownerA}/${f.custA2}/${randomUUID()}.pdf`, sha256: "c".repeat(64), mime_type: "application/pdf", size_bytes: 10 })],
        );
        await job("2024-07-20");
        expect((await tickets(a))[0].status).toBe("PAYMENT_SUBMITTED");
      });
    });
  });

  describe("estimated invoice (spec 11.6, rule 22)", () => {
    it("when the owner bills estimates: overdue, then a draft for the owner with credits taken off; once only", async () => {
      await isolated(db, async () => {
        await db.query("update public.owner_settings set estimated_billing_enabled = true where owner_id = $1", [f.ownerA]);
        await db.query(
          "insert into public.credits (owner_id, customer_id, kind, amount_cents, reason, created_by) values ($1, $2, 'ADVANCE', 100000, 'Advance', $1)",
          [f.ownerA, f.custA2],
        );
        const a = await agreement({ first: "2024-06-01" });
        await job("2024-06-01");
        const [{ id }] = await tickets(a);
        await clean(await job("2024-06-06"), [a, id]);
        const [t] = await tickets(a);
        expect(t.status).toBe("PENDING_OWNER_REVIEW");
        const { rows: inv } = await db.query(
          "select type, status, cycles_covered, subtotal_cents::int as s, credit_applied_cents::int as c, total_cents::int as total from public.invoices where id = $1",
          [t.current_invoice_id],
        );
        expect(inv[0]).toEqual({ type: "ESTIMATED", status: "DRAFT", cycles_covered: 1, s: 500_000, c: 100_000, total: 400_000 });
        expect(await count(db, "select 1 from public.invoice_lines where invoice_id = $1 and line_type = 'CREDIT' and credit_id is not null", [t.current_invoice_id])).toBe(1);
        expect(await notes(id)).toContain("ticket.estimate_ready:owner");
        expect((await events(id)).map((e) => e.to_status)).toEqual(["METER_REQUESTED", "OVERDUE", "PENDING_OWNER_REVIEW"]);

        await clean(await job("2024-06-07"), [a, id]);
        expect(await count(db, "select 1 from public.invoices where ticket_id = $1", [id])).toBe(1);

        // The owner confirms it like a reading (11.1: never automatic).
        await confirm(id, null, "2024-06-14");
        const { rows: issuedInv } = await db.query("select status, invoice_no from public.invoices where id = $1", [t.current_invoice_id]);
        expect(issuedInv[0].status).toBe("AWAITING_PAYMENT");
        expect(issuedInv[0].invoice_no).toMatch(/^INV-/);
      });
    });

    it("an owner who rejects the estimate gets no second one for that ticket", async () => {
      await isolated(db, async () => {
        await db.query("update public.owner_settings set estimated_billing_enabled = true where owner_id = $1", [f.ownerA]);
        const a = await agreement({ first: "2024-06-01" });
        await job("2024-06-01");
        await job("2024-06-06");
        const [{ id }] = await tickets(a);
        await db.query("select app.reject_meter_submission($1, null, $2, 'Wait for the customer', $3, $3)", [id, f.ownerA, at("2024-06-10", "00:00:00")]);
        await job("2024-06-11");
        const [t] = await tickets(a);
        expect(t.status).toBe("OVERDUE");
        expect(await count(db, "select 1 from public.invoices where ticket_id = $1", [id])).toBe(1);
      });
    });

    it("off by default: the ticket only becomes overdue", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-06-01" });
        await job("2024-06-01");
        await job("2024-06-06");
        const [t] = await tickets(a);
        expect([t.status, t.current_invoice_id]).toEqual(["OVERDUE", null]);
      });
    });
  });

  describe("late fee (PAY-13, LATE-01, rule 7)", () => {
    const feeOf = async (invoiceId: string) =>
      (await db.query("select late_fee_cents::int as fee, total_cents::int as total, status from public.invoices where id = $1", [invoiceId])).rows[0];

    it("charged once after due date + grace, with the agreement override; none with NONE", async () => {
      await isolated(db, async () => {
        await db.query("update public.owner_settings set late_fee_enabled = true, late_fee_cents = 50000, grace_period_days = 7 where owner_id = $1", [f.ownerA]);
        const owner = await agreement({ first: "2024-07-01" });
        const custom = await agreement({ first: "2024-07-01", lateFee: ["CUSTOM", 75000] });
        const none = await agreement({ first: "2024-07-01", lateFee: ["NONE", null] });
        const inv: Record<string, string> = {};
        for (const [k, a] of Object.entries({ owner, custom, none })) inv[k] = (await issued(a, "2024-07-01", "2024-07-08")).invoiceId;

        await job("2024-07-15"); // due + 7: still in the grace period
        expect((await feeOf(inv.owner)).fee).toBe(0);
        const result = await job("2024-07-16");
        await clean(result, [owner, custom, none]);
        expect(await feeOf(inv.owner)).toEqual({ fee: 50_000, total: 700_000, status: "OVERDUE" });
        expect(await feeOf(inv.custom)).toEqual({ fee: 75_000, total: 725_000, status: "OVERDUE" });
        expect(await feeOf(inv.none)).toEqual({ fee: 0, total: 650_000, status: "OVERDUE" });
        expect(await count(db, "select 1 from public.invoice_lines where invoice_id = $1 and line_type = 'LATE_FEE'", [inv.custom])).toBe(1);
        const [t] = await tickets(custom);
        expect((await events(t.id)).at(-1)).toMatchObject({ event_type: "LATE_FEE", metadata: expect.objectContaining({ late_fee_cents: 75000 }) });
        expect(await notes(t.id)).toEqual(expect.arrayContaining(["invoice.late_fee:customer", "invoice.late_fee:owner"]));

        await job("2024-07-16");
        await job("2024-08-30");
        expect((await feeOf(inv.custom)).fee).toBe(75_000);
        expect(await count(db, "select 1 from public.invoice_lines where invoice_id = $1 and line_type = 'LATE_FEE'", [inv.custom])).toBe(1);
      });
    });

    it("not while the invoice is disputed", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-07-01", lateFee: ["CUSTOM", 75000] });
        const { ticketId, invoiceId } = await issued(a, "2024-07-01", "2024-07-08");
        await db.query("select app.raise_dispute($1, $2, 'Too many copies')", [ticketId, f.custA2]);
        await job("2024-08-30");
        expect(await feeOf(invoiceId)).toEqual({ fee: 0, total: 650_000, status: "DISPUTED" });
        expect((await tickets(a))[0].status).toBe("DISPUTED");
      });
    });

    it("the database refuses a wrong amount or an early charge", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-07-01", lateFee: ["CUSTOM", 75000] });
        const { ticketId, invoiceId } = await issued(a, "2024-07-01", "2024-07-08");
        const line = (fee: number) => JSON.stringify({ line_type: "LATE_FEE", description: "Late payment fee", quantity: 1, rate_cents: fee, amount_cents: fee });
        await asService(db);
        expect(await sqlError(db, "select public.rpc_apply_late_fee($1, $2, $3::jsonb, 700000, $4)", [ticketId, invoiceId, line(50000), at("2024-08-01")])).toMatchObject({ code: "RD409" });
        expect(await sqlError(db, "select public.rpc_apply_late_fee($1, $2, $3::jsonb, 725000, $4)", [ticketId, invoiceId, line(75000), at("2024-07-12")])).toMatchObject({
          code: "RD409",
          message: expect.stringMatching(/grace/),
        });
        await asPostgres(db);
      });
    });
  });

  describe("suspended accounts (TKT-12, spec 11.8, rule 24)", () => {
    it("pauses open tickets, opens nothing new, and resumes with the deadline moved forward", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-08-01" });
        const later = await agreement({ first: "2024-08-05" });
        await job("2024-08-01");
        const [{ id }] = await tickets(a);
        await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.custA2]);

        await clean(await job("2024-08-03"), [a, id]);
        let [t] = await tickets(a);
        expect(new Date(t.paused_at)).toEqual(at("2024-08-03"));
        expect([t.status, t.reminder_count]).toEqual(["METER_REQUESTED", 0]);
        expect((await events(id)).at(-1)).toMatchObject({ event_type: "PAUSED", reason: "Customer account suspended" });

        await job("2024-08-10");
        [t] = await tickets(a);
        expect([t.status, t.reminder_count]).toEqual(["METER_REQUESTED", 0]);
        expect(await tickets(later)).toEqual([]);

        await db.query("update public.profiles set status = 'ACTIVE' where id = $1", [f.custA2]);
        await clean(await job("2024-08-12"), [a, id, later]);
        [t] = await tickets(a);
        expect(t.paused_at).toBeNull();
        // Due 6 Aug 00:00, paused for 9 days -> 15 Aug 00:00.
        expect(new Date(t.stage_due_at)).toEqual(at("2024-08-15", "00:00:00"));
        expect(await events(id)).toContainEqual(expect.objectContaining({ event_type: "RESUMED", metadata: expect.objectContaining({ paused_days: 9 }) }));
        expect(await notes(id)).toContain("ticket.resumed:customer");
        // The cycle due while suspended opens after reactivation.
        expect((await tickets(later)).map((x) => x.cycle_date)).toEqual(["2024-08-05"]);
      });
    });

    it("a suspended owner pauses the tickets of all their customers", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-08-01" });
        await job("2024-08-01");
        await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.ownerA]);
        await job("2024-08-02");
        const [t] = await tickets(a);
        expect(t.paused_at).not.toBeNull();
        expect((await events(t.id)).at(-1)).toMatchObject({ event_type: "PAUSED", reason: "Owner account suspended" });
      });
    });

    it("an unpaid invoice's due date moves forward by the paused days", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-07-01" });
        const { invoiceId } = await issued(a, "2024-07-01", "2024-07-08");
        await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.custA2]);
        await job("2024-07-03");
        await db.query("update public.profiles set status = 'ACTIVE' where id = $1", [f.custA2]);
        await job("2024-07-07");
        expect((await db.query("select due_date::text as d, status from public.invoices where id = $1", [invoiceId])).rows[0]).toEqual({ d: "2024-07-12", status: "AWAITING_PAYMENT" });
      });
    });
  });

  describe("meter photos (INV-09, spec 6.5)", () => {
    it("deletes confirmed and expired photos from storage and marks the rows; keeps the others", async () => {
      await isolated(db, async () => {
        removed.length = 0;
        // Fixture: B1's reading was confirmed (photo marked for deletion); A1 colour waits for review.
        const sub = (await db.query("select id from public.meter_submissions where ticket_id = $1", [f.tickets.a1Colour])).rows[0].id;
        await db.query("update public.meter_photos set expires_at = $2 where submission_id = $1", [sub, at("2024-09-01", "00:00:00")]);
        await job("2024-08-31");
        expect(removed).toContain(`${f.ownerB}/${f.tickets.b1Mono}/photo-3.jpg`);
        expect(removed).not.toContain(`${f.ownerA}/${f.tickets.a1Colour}/photo-1.jpg`);
        const { rows } = await db.query(
          "select storage_path, deleted_at from public.meter_photos where storage_path = any($1)",
          [[`${f.ownerB}/${f.tickets.b1Mono}/photo-3.jpg`, `${f.ownerA}/${f.tickets.a1Colour}/photo-1.jpg`]],
        );
        const deleted = Object.fromEntries(rows.map((r) => [r.storage_path, r.deleted_at]));
        expect(new Date(deleted[`${f.ownerB}/${f.tickets.b1Mono}/photo-3.jpg`])).toEqual(at("2024-08-31"));
        expect(deleted[`${f.ownerA}/${f.tickets.a1Colour}/photo-1.jpg`]).toBeNull();

        await job("2024-09-02");
        expect(removed).toContain(`${f.ownerA}/${f.tickets.a1Colour}/photo-1.jpg`);
      });
    });
  });

  describe("cron runs (admin log)", () => {
    it("each run is recorded with its counts; a second run during a running one is skipped", async () => {
      await isolated(db, async () => {
        const a = await agreement({ first: "2024-10-01" });
        const result = await job("2024-10-01");
        const { rows } = await db.query("select status, trigger, simulated, run_date::text as d, counts, finished_at from public.cron_runs where id = $1", [result.runId]);
        expect(rows[0]).toMatchObject({ trigger: "LOCAL", simulated: true, d: "2024-10-01" });
        expect(rows[0].counts.opened).toBeGreaterThanOrEqual(1);
        expect(rows[0].finished_at).not.toBeNull();
        expect(await tickets(a)).toHaveLength(1);

        await asService(db);
        const first = (await db.query("select public.rpc_cron_begin_run('daily', 'CRON', null, now(), false) as r")).rows[0].r;
        const second = (await db.query("select public.rpc_cron_begin_run('daily', 'CRON', null, now(), false) as r")).rows[0].r;
        await asPostgres(db);
        expect(first.skipped).toBe(false);
        expect(second).toMatchObject({ skipped: true, busy_run_id: first.run_id });
      });
    });

    it("only admins can read the log", async () => {
      await isolated(db, async () => {
        await job("2024-10-02");
        await asUser(db, f.admin);
        expect(await count(db, "select 1 from public.cron_runs")).toBeGreaterThan(0);
        await asUser(db, f.ownerA);
        expect(await count(db, "select 1 from public.cron_runs")).toBe(0);
        await asUser(db, f.custA1);
        expect(await count(db, "select 1 from public.cron_runs")).toBe(0);
        expect((await sqlError(db, "insert into public.cron_runs (trigger, run_now, run_date) values ('CRON', now(), current_date)"))?.code).toBe("42501");
        await asPostgres(db);
      });
    });
  });
});
