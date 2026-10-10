import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";

import { APPLY_MIGRATIONS, asPostgres, asService, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, deleteFixture, type Fixture } from "./fixtures";

// Built by the billing engine, like every invoice (migration 0015): 5,000 -> 6,000 copies.
const MONO_SUBMISSION = buildMeterSubmission(
  {
    terms: {
      machineType: "MONO",
      commitmentCents: 500_000,
      bwIncluded: 2000,
      bwRateCents: 250,
      colourIncluded: null,
      colourRateCents: null,
    },
    cyclesCovered: 1,
    counters: { BW: { known: [{ value: 5000, at: "2026-01-01T00:00:00Z", source: "INITIAL" }], counterMax: null, history: [] } },
    estimateCredits: [],
    credits: [],
  },
  { BW: 6000 },
);
const MONO_INVOICE = JSON.stringify(MONO_SUBMISSION.invoice);
const MONO_READING = JSON.stringify(MONO_SUBMISSION.readings);

async function ticketStatus(db: pg.Client, ticketId: string): Promise<string> {
  const { rows } = await db.query("select status from public.billing_cycle_tickets where id = $1", [ticketId]);
  return rows[0].status;
}

describe.skipIf(!DB_URL)("workflow functions (linked dev database, rolled back)", () => {
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

  it("allows only one ticket per agreement and cycle", async () => {
    await isolated(db, async () => {
      const duplicate = await sqlError(
        db,
        `insert into public.billing_cycle_tickets (owner_id, customer_id, agreement_id, machine_id, cycle_no, cycle_date,
           period_start, period_end, machine_type, cycle_length_days, commitment_cents, bw_included, bw_rate_cents)
         select owner_id, customer_id, agreement_id, machine_id, cycle_no, cycle_date, period_start, period_end,
                machine_type, cycle_length_days, commitment_cents, bw_included, bw_rate_cents
         from public.billing_cycle_tickets where id = $1`,
        [f.tickets.a1Mono],
      );
      expect(duplicate?.code).toBe("23505");

      const replay = await db.query("select app.open_billing_cycle($1, 1, now()) as r", [f.agrA1Mono]);
      expect(replay.rows[0].r).toMatchObject({ ticket_id: f.tickets.a1Mono, replayed: true });

      // The calendar moved on by exactly one cycle (one month), independent of when tickets close.
      const { rows } = await db.query(
        `select next_cycle_no, next_cycle_date::text as next, (first_billing_date + interval '1 month')::date::text as expected
         from public.rental_agreements where id = $1`,
        [f.agrA1Mono],
      );
      expect(rows[0].next_cycle_no).toBe(2);
      expect(rows[0].next).toBe(rows[0].expected);
    });
  });

  it("numbers invoices per owner, in order, without gaps after a rollback", async () => {
    await isolated(db, async () => {
      const numbers = await db.query(
        "select owner_id, invoice_no from public.invoices where id = any($1::uuid[])",
        [[f.invoices.a2Mono, f.invoices.b1Mono]],
      );
      expect(numbers.rows.map((r) => r.invoice_no)).toEqual(["INV-000001", "INV-000001"]);

      const confirm = `select app.confirm_meter_submission($1, $2, $3, current_date + 7, now() + interval '7 days') as r`;
      const params = [f.tickets.a1Colour, f.submissions.a1Colour, f.ownerA];

      await db.query("savepoint numbered");
      const first = await db.query(confirm, params);
      expect(first.rows[0].r.invoice_no).toBe("INV-000002");
      await db.query("rollback to savepoint numbered"); // e.g. a later step failed

      const again = await db.query(confirm, params);
      expect(again.rows[0].r.invoice_no).toBe("INV-000002"); // number was released, not burned
      expect(again.rows[0].r.photo_paths).toEqual([`${f.ownerA}/${f.tickets.a1Colour}/photo-1.jpg`]);

      const photo = await db.query(
        "select delete_requested_at is not null as marked from public.meter_photos where submission_id = $1",
        [f.submissions.a1Colour],
      );
      expect(photo.rows[0].marked).toBe(true);
      expect(await ticketStatus(db, f.tickets.a1Colour)).toBe("AWAITING_PAYMENT");
    });
  });

  it("replays a retried meter submission instead of duplicating it", async () => {
    await isolated(db, async () => {
      const key = "11111111-1111-4111-8111-111111111111";
      const photo = JSON.stringify({ storage_path: `${f.ownerA}/${f.tickets.a1Mono}/p.jpg` });
      const submit = `select app.submit_meter_reading($1, $2, $3, 'CUSTOMER', $4::jsonb, $5::jsonb, $6::jsonb, now()) as r`;
      const params = [f.tickets.a1Mono, f.custA1, key, MONO_READING, photo, MONO_INVOICE];

      const first = await db.query(submit, params);
      const second = await db.query(submit, params);
      expect(first.rows[0].r.replayed).toBe(false);
      expect(second.rows[0].r).toMatchObject({ replayed: true, submission_id: first.rows[0].r.submission_id });
      expect(await count(db, "select 1 from public.meter_submissions where ticket_id = $1", [f.tickets.a1Mono])).toBe(1);
      expect(await count(db, "select 1 from public.invoices where ticket_id = $1", [f.tickets.a1Mono])).toBe(1);
      expect(await ticketStatus(db, f.tickets.a1Mono)).toBe("PENDING_OWNER_REVIEW");
    });
  });

  it("validates submissions: photo, reading count, lines and stage", async () => {
    await isolated(db, async () => {
      const submit = `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now())`;
      const photo = JSON.stringify({ storage_path: `${f.ownerA}/${f.tickets.a1Mono}/p.jpg` });

      expect((await sqlError(db, submit, [f.tickets.a1Mono, f.custA1, MONO_READING, null, MONO_INVOICE]))?.code).toBe("RD400");
      const wrongPath = JSON.stringify({ storage_path: `${f.ownerB}/${f.tickets.a1Mono}/p.jpg` });
      expect((await sqlError(db, submit, [f.tickets.a1Mono, f.custA1, MONO_READING, wrongPath, MONO_INVOICE]))?.code).toBe("RD400");
      const badTotal = JSON.stringify({ ...JSON.parse(MONO_INVOICE), total_cents: 1 });
      expect((await sqlError(db, submit, [f.tickets.a1Mono, f.custA1, MONO_READING, photo, badTotal]))?.code).toBe("RD400");
      // Readings that differ from the engine's calculation are refused before anything is written.
      const lower = JSON.stringify([{ counter_type: "BW", previous_value: 5000, current_value: 4000, rolled_over: false }]);
      expect((await sqlError(db, submit, [f.tickets.a1Mono, f.custA1, lower, photo, MONO_INVOICE]))?.code).toBe("RD400");
      // Another customer, and a ticket not waiting for a reading.
      expect((await sqlError(db, submit, [f.tickets.a1Mono, f.custA2, MONO_READING, photo, MONO_INVOICE]))?.code).toBe("RD403");
      expect((await sqlError(db, submit, [f.tickets.a2Mono, f.custA2, MONO_READING, photo, MONO_INVOICE]))?.code).toBe("RD409");
    });
  });

  it("rejects stale or illegal transitions and wrong actors", async () => {
    await isolated(db, async () => {
      const transition = "select app.transition_ticket($1, $2, $3, $4, $5)";
      // Stale expected status.
      expect((await sqlError(db, transition, [f.tickets.a1Mono, "AWAITING_PAYMENT", "CANCELLED", f.ownerA, "x"]))?.code).toBe("RD409");
      // Not in the spec's transition table.
      expect((await sqlError(db, transition, [f.tickets.a1Mono, "METER_REQUESTED", "CLOSED", f.ownerA, "x"]))?.code).toBe("RD400");
      // Confirm must use its dedicated function.
      expect((await sqlError(db, transition, [f.tickets.a1Colour, "PENDING_OWNER_REVIEW", "AWAITING_PAYMENT", f.ownerA, null]))?.code).toBe("RD400");
      // Cancel needs a reason.
      expect((await sqlError(db, transition, [f.tickets.a1Mono, "METER_REQUESTED", "CANCELLED", f.ownerA, " "]))?.code).toBe("RD400");
      // Customers and other owners may not act on the ticket.
      expect((await sqlError(db, transition, [f.tickets.a1Mono, "METER_REQUESTED", "CANCELLED", f.custA1, "x"]))?.code).toBe("RD403");
      expect((await sqlError(db, transition, [f.tickets.a1Mono, "METER_REQUESTED", "CANCELLED", f.ownerB, "x"]))?.code).toBe("RD403");
      const confirmByCustomer = "select app.confirm_meter_submission($1, $2, $3, current_date, now())";
      expect((await sqlError(db, confirmByCustomer, [f.tickets.a1Colour, f.submissions.a1Colour, f.custA1]))?.code).toBe("RD403");

      // A valid transition writes the event with actor and reason.
      await db.query(transition, [f.tickets.a1Mono, "METER_REQUESTED", "OVERDUE", null, "Deadline missed"]);
      const { rows } = await db.query(
        "select status, status_before_overdue from public.billing_cycle_tickets where id = $1",
        [f.tickets.a1Mono],
      );
      expect(rows[0]).toEqual({ status: "OVERDUE", status_before_overdue: "METER_REQUESTED" });
      const event = await db.query(
        "select from_status, to_status, actor_id, reason from public.ticket_events where ticket_id = $1 order by created_at desc, id limit 1",
        [f.tickets.a1Mono],
      );
      expect(event.rows[0]).toEqual({ from_status: "METER_REQUESTED", to_status: "OVERDUE", actor_id: null, reason: "Deadline missed" });
    });
  });

  it("rejecting a reading returns the ticket to the customer", async () => {
    await isolated(db, async () => {
      const reject = "select app.reject_meter_submission($1, $2, $3, $4, now() + interval '5 days', now() + interval '7 days') as r";
      expect((await sqlError(db, reject, [f.tickets.a1Colour, f.submissions.a1Colour, f.ownerA, ""]))?.code).toBe("RD400");
      const result = await db.query(reject, [f.tickets.a1Colour, f.submissions.a1Colour, f.ownerA, "Photo unreadable"]);
      expect(result.rows[0].r).toMatchObject({ status: "METER_REQUESTED", rejection_count: 1 });
      const invoice = await db.query("select status from public.invoices where id = $1", [f.invoices.a1Colour]);
      expect(invoice.rows[0].status).toBe("REJECTED");
    });
  });

  it("verifying a full payment closes the ticket; a partial one keeps it open", async () => {
    await isolated(db, async () => {
      const verify = "select app.verify_payment($1, $2, $3, $4, $5) as r";

      await db.query("savepoint partial");
      const partial = await db.query(verify, [f.payments.a2Mono, f.ownerA, true, 400_000, null]);
      expect(partial.rows[0].r).toMatchObject({
        status: "PARTIAL",
        invoices: [{ ticket_status: "PARTIALLY_PAID", invoice_status: "PARTIALLY_PAID", balance_cents: 250_000 }],
      });
      await db.query("rollback to savepoint partial");

      expect((await sqlError(db, verify, [f.payments.a2Mono, f.ownerA, false, null, ""]))?.code).toBe("RD400");

      const full = await db.query(verify, [f.payments.a2Mono, f.ownerA, true, null, null]);
      expect(full.rows[0].r).toMatchObject({ status: "ACCEPTED", invoices: [{ ticket_status: "CLOSED", invoice_status: "PAID", balance_cents: 0 }] });
      const { rows } = await db.query(
        "select closed_by, closed_at is not null as closed from public.billing_cycle_tickets where id = $1",
        [f.tickets.a2Mono],
      );
      expect(rows[0]).toEqual({ closed_by: f.ownerA, closed: true });
      // Second verification of the same payment is refused.
      expect((await sqlError(db, verify, [f.payments.a2Mono, f.ownerA, true, null, null]))?.code).toBe("RD409");
    });
  });

  it("flags a reused bank reference and amount as a possible duplicate", async () => {
    await isolated(db, async () => {
      await db.query("select app.verify_payment($1, $2, false, null, 'Amount does not match')", [f.payments.a2Mono, f.ownerA]);
      const resubmit = await db.query(
        `select app.submit_payment($1, $1, gen_random_uuid(), array[$2::uuid], $3::jsonb, $4::jsonb, now()) as r`,
        [
          f.custA2,
          f.invoices.a2Mono,
          JSON.stringify({ amount_cents: 650_000, paid_on: "2026-10-07", method: "BANK_TRANSFER", reference: `ref-${f.tag}` }),
          JSON.stringify({ storage_path: `${f.ownerA}/${f.custA2}/${randomUUID()}.pdf`, sha256: "c".repeat(64), mime_type: "application/pdf", size_bytes: 10 }),
        ],
      );
      expect(resubmit.rows[0].r).toMatchObject({ duplicate_of_payment_id: f.payments.a2Mono, duplicate_reasons: ["REFERENCE"] });
    });
  });

  it("audit logs record the real actor and ignore x-actor-id unless the caller is service_role", async () => {
    await isolated(db, async () => {
      const header = JSON.stringify({ "x-actor-id": f.ownerB });
      const resolve = async (claims: object) => {
        await db.query("select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)", [
          JSON.stringify(claims),
          header,
        ]);
        return (await db.query("select app.resolve_actor() as a")).rows[0].a;
      };
      expect(await resolve({ role: "service_role" })).toBe(f.ownerB);
      expect(await resolve({ role: "authenticated", sub: f.custA1 })).toBe(f.custA1);
      expect(await resolve({ role: "authenticated" })).toBeNull();
      expect(await resolve({ role: "anon" })).toBeNull();
      await asPostgres(db);

      // Through the service role, a workflow function attributes the change to p_actor_id.
      await asService(db);
      await db.query("select public.rpc_transition_ticket($1, 'METER_REQUESTED', 'CANCELLED', $2, 'Created in error')", [
        f.tickets.a1Mono,
        f.ownerA,
      ]);
      await asPostgres(db);
      const { rows } = await db.query(
        `select actor_id, actor_role, details -> 'changes' -> 'status' as status
         from public.audit_logs where entity = 'billing_cycle_tickets' and entity_id = $1 and action = 'STATUS_CHANGE'`,
        [f.tickets.a1Mono],
      );
      expect(rows).toEqual([{ actor_id: f.ownerA, actor_role: "OWNER", status: ["METER_REQUESTED", "CANCELLED"] }]);
    });
  });

  it("provisioning follows the account hierarchy", async () => {
    await isolated(db, async () => {
      const provision = "select app.provision_account(gen_random_uuid(), $1, $2, 'X', $3, $4)";
      expect((await sqlError(db, provision, ["OWNER", `t-o-${f.tag}`, null, f.ownerA]))?.code).toBe("RD403");
      expect((await sqlError(db, provision, ["CUSTOMER", `t-c-${f.tag}`, f.ownerB, f.ownerA]))?.code).toBe("RD403");
      expect((await sqlError(db, provision, ["CUSTOMER", `t-c2-${f.tag}`, f.ownerA, f.admin]))?.code).toBe("RD403");
    });
  });
});

describe.skipIf(!DB_URL || APPLY_MIGRATIONS)("concurrent transitions (committed fixture, cleaned up)", () => {
  let setup: pg.Client;
  let f: Fixture | undefined;

  beforeAll(async () => {
    setup = await connect();
    await setup.query("begin");
    f = await createFixture(setup, { storage: false });
    await setup.query("commit");
  });

  afterAll(async () => {
    if (f) await deleteFixture(setup, f);
    await setup?.end();
  });

  it("the second of two concurrent transitions waits for the lock and then fails the status re-check", async () => {
    const fixture = f!;
    const first = await connect();
    const second = await connect();
    // Same path as server code: the service-role public wrapper around app.transition_ticket.
    const transition = "select public.rpc_transition_ticket($1, 'METER_REQUESTED', 'CANCELLED', $2, $3)";
    try {
      await first.query("begin");
      await asService(first);
      await first.query(transition, [fixture.tickets.a1Mono, fixture.ownerA, "first"]); // holds the row lock

      let settled = false;
      const racing = (async () => {
        await second.query("begin");
        await asService(second);
        try {
          await second.query(transition, [fixture.tickets.a1Mono, fixture.ownerA, "second"]);
          return "succeeded";
        } catch (error) {
          return (error as { code: string }).code;
        } finally {
          settled = true;
          await second.query("rollback");
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(settled).toBe(false); // blocked on SELECT ... FOR UPDATE

      await first.query("commit");
      expect(await racing).toBe("RD409");

      expect(await ticketStatus(setup, fixture.tickets.a1Mono)).toBe("CANCELLED");
      const events = await setup.query(
        "select reason from public.ticket_events where ticket_id = $1 and to_status = 'CANCELLED'",
        [fixture.tickets.a1Mono],
      );
      expect(events.rows).toEqual([{ reason: "first" }]);
    } finally {
      await first.end();
      await second.end();
    }
  });
});
