import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, cycleInProgress } from "@/lib/agreements/cycle-calendar";

import { asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";

/** Machines and agreements workflow from migration 0014 (MAC-01..04, AGR-01..03). */
describe.skipIf(!DB_URL)("machines and agreements (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  let today: string;
  let colourSpare: string;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
    today = (await db.query<{ d: string }>("select current_date::text as d")).rows[0].d;
    const { rows } = await db.query<{ id: string }>(
      "insert into public.machines (owner_id, brand, model, serial_no, type, colour_counter_max) values ($1, 'Canon', 'C5', $2, 'COLOUR', 999999) returning id",
      [f.ownerA, `A-COL2-${f.tag}`],
    );
    colourSpare = rows[0].id;
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  const monoTerms = (overrides: Record<string, unknown> = {}) => ({
    start_date: addDays(today, -100),
    first_billing_date: addDays(today, 5),
    cycle_length_days: 30,
    due_days: 7,
    monthly_commitment_cents: 500_000,
    bw_included: 2000,
    bw_rate_cents: 250,
    installation_location: "Front office",
    initial_bw_reading: 1000,
    ...overrides,
  });

  async function rpc<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await db.query(`select ${sql} as r`, params);
    return rows[0].r as T;
  }

  const assign = (actor: string, machine: string, customer: string, terms: object, day = today) =>
    rpc<{ agreement_id: string; next_cycle_date: string }>("public.rpc_assign_machine($1, $2, $3, $4::jsonb, $5::date)", [
      actor,
      machine,
      customer,
      JSON.stringify(terms),
      day,
    ]);
  const assignError = (actor: string, machine: string, customer: string, terms: object) =>
    sqlError(db, "select public.rpc_assign_machine($1, $2, $3, $4::jsonb, $5::date)", [
      actor,
      machine,
      customer,
      JSON.stringify(terms),
      today,
    ]);
  const returnError = (actor: string, agreement: string, closing: object, reason = "Customer closed the branch") =>
    sqlError(db, "select public.rpc_return_machine($1, $2, $3::jsonb, $4, $5::date)", [
      actor,
      agreement,
      JSON.stringify(closing),
      reason,
      today,
    ]);

  async function agreement(id: string) {
    const { rows } = await db.query(
      `select status, next_cycle_no, next_cycle_date::text, first_billing_date::text, start_date::text, end_date::text,
              monthly_commitment_cents::int, closing_bw_reading::int, closing_colour_reading::int, termination_reason
       from public.rental_agreements where id = $1`,
      [id],
    );
    return rows[0];
  }
  const machineStatus = async (id: string) =>
    (await db.query<{ status: string }>("select status from public.machines where id = $1", [id])).rows[0].status;

  describe("assign (MAC-02, AGR-01)", () => {
    it("creates the agreement, rents the machine, sets the calendar, writes terms v1, audit and a notification", async () => {
      await isolated(db, async () => {
        await asService(db);
        const r = await assign(f.ownerA, f.machineASpare, f.custA2, monoTerms());
        expect(r.next_cycle_date).toBe(addDays(today, 5));

        await asPostgres(db);
        const a = await agreement(r.agreement_id);
        expect(a).toMatchObject({
          status: "ACTIVE",
          next_cycle_no: 1,
          next_cycle_date: addDays(today, 5),
          first_billing_date: addDays(today, 5),
          start_date: addDays(today, -100), // a past start date is allowed (migrated rental)
        });
        expect(await machineStatus(f.machineASpare)).toBe("RENTED");

        const { rows: history } = await db.query(
          "select version, effective_from_cycle_no, monthly_commitment_cents::int, changed_by from public.agreement_terms_history where agreement_id = $1",
          [r.agreement_id],
        );
        expect(history).toEqual([{ version: 1, effective_from_cycle_no: 1, monthly_commitment_cents: 500_000, changed_by: f.ownerA }]);
        expect(
          await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'MACHINE_ASSIGNED' and actor_id = $2", [
            r.agreement_id,
            f.ownerA,
          ]),
        ).toBe(1);
        expect(
          await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'STATUS_CHANGE' and actor_id = $2", [
            f.machineASpare,
            f.ownerA,
          ]),
        ).toBe(1);
        expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'machine.assigned'", [f.custA2])).toBe(1);

        // The customer sees their new machine and agreement.
        await asUser(db, f.custA2);
        expect(await count(db, "select 1 from public.machines where id = $1", [f.machineASpare])).toBe(1);
        expect(await count(db, "select 1 from public.rental_agreements where id = $1", [r.agreement_id])).toBe(1);
        expect(await count(db, "select 1 from public.agreement_terms_history")).toBe(0); // owner-only
        await asUser(db, f.custA1);
        expect(await count(db, "select 1 from public.machines where id = $1", [f.machineASpare])).toBe(0);
      });
    });

    it("checks the first billing date, colour terms and machine state", async () => {
      await isolated(db, async () => {
        await asService(db);
        const cases: Array<[object, string, string]> = [
          [monoTerms({ first_billing_date: addDays(today, -1) }), "RD400", "past first billing date"],
          [monoTerms({ start_date: addDays(today, 5) }), "RD400", "first billing date not after start"],
          [monoTerms({ initial_bw_reading: -1 }), "RD400", "negative reading"],
          [monoTerms({ initial_bw_reading: 12.5 }), "RD400", "fractional reading"],
          [monoTerms({ colour_included: 100, colour_rate_cents: 1000 }), "RD400", "colour terms on mono"],
        ];
        for (const [terms, code, label] of cases) {
          expect((await assignError(f.ownerA, f.machineASpare, f.custA2, terms))?.code, label).toBe(code);
        }
        // Colour machine without colour terms.
        expect((await assignError(f.ownerA, colourSpare, f.custA2, monoTerms()))?.code).toBe("RD400");
        // First billing date today is fine.
        await assign(f.ownerA, colourSpare, f.custA2, monoTerms({ first_billing_date: today, colour_included: 500, colour_rate_cents: 1000, initial_colour_reading: 200 }));

        // Nothing was left behind by the failed attempts.
        await asPostgres(db);
        expect(await machineStatus(f.machineASpare)).toBe("AVAILABLE");
        expect(await count(db, "select 1 from public.rental_agreements where machine_id = $1", [f.machineASpare])).toBe(0);

        // Only an available machine can be assigned; only one live agreement per machine.
        await asService(db);
        expect((await assignError(f.ownerA, colourSpare, f.custA1, monoTerms({ colour_included: 1, colour_rate_cents: 1 })))?.code).toBe("RD409");
        await asPostgres(db);
        await db.query("update public.machines set status = 'UNDER_REPAIR' where id = $1", [f.machineASpare]);
        await asService(db);
        expect((await assignError(f.ownerA, f.machineASpare, f.custA2, monoTerms()))?.code).toBe("RD409");

        // A suspended customer cannot get a machine.
        await asPostgres(db);
        await db.query("update public.machines set status = 'AVAILABLE' where id = $1", [f.machineASpare]);
        await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.custA2]);
        await asService(db);
        expect((await assignError(f.ownerA, f.machineASpare, f.custA2, monoTerms()))?.code).toBe("RD409");
      });
    });

    it("makes cross-tenant links impossible", async () => {
      await isolated(db, async () => {
        await asService(db);
        expect((await assignError(f.ownerB, f.machineASpare, f.custB1, monoTerms()))?.code, "B assigns A's machine").toBe("RD403");
        expect((await assignError(f.ownerA, f.machineASpare, f.custB1, monoTerms()))?.code, "A assigns to B's customer").toBe("RD404");
        expect((await assignError(f.custA2, f.machineASpare, f.custA2, monoTerms()))?.code, "a customer").toBe("RD403");
        expect((await assignError(f.admin, f.machineASpare, f.custA2, monoTerms()))?.code, "admin").toBe("RD403");

        // Even the privileged role cannot write a cross-tenant agreement (composite FK).
        await asPostgres(db);
        const crossLink = await sqlError(
          db,
          `insert into public.rental_agreements (owner_id, customer_id, machine_id, start_date, monthly_commitment_cents, bw_rate_cents)
           values ($1, $2, $3, current_date, 100, 1)`,
          [f.ownerA, f.custB1, f.machineASpare],
        );
        expect(crossLink?.code).toBe("23503");
      });
    });
  });

  describe("machine status (MAC-03)", () => {
    it("changes between available, under repair and retired with a reason; RENTED only by assignment", async () => {
      await isolated(db, async () => {
        await asService(db);
        const status = (actor: string, machine: string, to: string, reason = "Drum unit replaced") =>
          sqlError(db, "select public.rpc_set_machine_status($1, $2, $3, $4)", [actor, machine, to, reason]);

        expect(await status(f.ownerA, f.machineASpare, "UNDER_REPAIR")).toBeNull();
        expect((await status(f.ownerA, f.machineASpare, "UNDER_REPAIR"))?.code).toBe("RD409");
        expect((await status(f.ownerA, f.machineASpare, "RETIRED", "  "))?.code).toBe("RD400");
        expect((await status(f.ownerA, f.machineASpare, "RENTED"))?.code).toBe("RD400");
        expect((await status(f.ownerB, f.machineASpare, "RETIRED"))?.code).toBe("RD403");
        expect((await status(f.ownerA, f.machineAMono1, "UNDER_REPAIR"))?.code, "rented machine").toBe("RD409");

        await asPostgres(db);
        const { rows } = await db.query(
          "select actor_id, details from public.audit_logs where entity_id = $1 and action = 'STATUS_CHANGE'",
          [f.machineASpare],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].actor_id).toBe(f.ownerA);
        expect(rows[0].details.reason).toBe("Drum unit replaced");

        // The guard holds for every writer, not just the rpc.
        expect((await sqlError(db, "update public.machines set status = 'RENTED' where id = $1", [f.machineASpare]))?.code).toBe("RD400");
        expect((await sqlError(db, "update public.machines set status = 'AVAILABLE' where id = $1", [f.machineAMono1]))?.code).toBe("RD409");
        expect((await sqlError(db, "update public.machines set type = 'COLOUR' where id = $1", [f.machineAMono1]))?.code).toBe("RD400");
      });
    });
  });

  describe("return and reassign (MAC-04)", () => {
    it("is blocked while a ticket is open or an invoice is unpaid", async () => {
      await isolated(db, async () => {
        await asService(db);
        const open = await returnError(f.ownerA, f.agrA1Mono, { bw: 9000 });
        expect(open?.code).toBe("RD409");
        expect(open?.message).toMatch(/^RETURN_BLOCKED:/);
        const blockers = JSON.parse(open!.message.slice("RETURN_BLOCKED:".length));
        expect(blockers).toEqual([expect.objectContaining({ kind: "ticket", cycle_no: 1, status: "METER_REQUESTED" })]);

        const unpaid = await returnError(f.ownerA, f.agrA2Mono, { bw: 9000 });
        const kinds = JSON.parse(unpaid!.message.slice("RETURN_BLOCKED:".length)).map((b: { kind: string }) => b.kind);
        expect(kinds.sort()).toEqual(["invoice", "ticket"]);

        await asPostgres(db);
        expect((await agreement(f.agrA1Mono)).status).toBe("ACTIVE");
        expect(await machineStatus(f.machineAMono1)).toBe("RENTED");
      });
    });

    it("terminates the agreement with closing readings and frees the machine", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(f.ownerA, f.machineASpare, f.custA2, monoTerms());

        expect((await returnError(f.ownerA, id, { bw: 999 }))?.code, "below the initial reading").toBe("RD400");
        expect((await returnError(f.ownerA, id, {}))?.code, "missing reading").toBe("RD400");
        expect((await returnError(f.ownerA, id, { bw: 1500 }, " "))?.code, "missing reason").toBe("RD400");
        expect((await returnError(f.ownerB, id, { bw: 1500 }))?.code, "other owner").toBe("RD403");
        expect(await returnError(f.ownerA, id, { bw: 1500 })).toBeNull();
        expect((await returnError(f.ownerA, id, { bw: 1600 }))?.code, "already returned").toBe("RD409");

        await asPostgres(db);
        expect(await agreement(id)).toMatchObject({
          status: "TERMINATED",
          closing_bw_reading: 1500,
          closing_colour_reading: null,
          termination_reason: "Customer closed the branch",
          end_date: today,
        });
        expect(await machineStatus(f.machineASpare)).toBe("AVAILABLE");
        const { rows } = await db.query("select details from public.audit_logs where entity_id = $1 and action = 'MACHINE_RETURNED'", [id]);
        expect(rows[0].details).toMatchObject({ closing_bw_reading: 1500, reason: "Customer closed the branch" });

        // A terminated agreement stays terminated.
        expect((await sqlError(db, "update public.rental_agreements set status = 'ACTIVE' where id = $1", [id]))?.code).toBe("RD409");
      });
    });

    it("accepts a lower closing reading only as a rollover on a counter with a maximum", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(
          f.ownerA,
          colourSpare,
          f.custA2,
          monoTerms({ colour_included: 500, colour_rate_cents: 1000, initial_bw_reading: 5000, initial_colour_reading: 990_000 }),
        );
        // B&W has no maximum: lower is refused. Colour has 999,999: lower is a rollover.
        expect((await returnError(f.ownerA, id, { bw: 4000, colour: 1000 }))?.code).toBe("RD400");
        expect((await returnError(f.ownerA, id, { bw: 6000 }))?.code, "colour reading required").toBe("RD400");
        expect(await returnError(f.ownerA, id, { bw: 6000, colour: 1000 })).toBeNull();
      });
    });

    it("reassigns atomically: if the new assignment fails, the return is undone", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(f.ownerA, f.machineASpare, f.custA2, monoTerms());
        const reassign = (customer: string) =>
          sqlError(db, "select public.rpc_reassign_machine($1, $2, $3::jsonb, $4, $5, $6::jsonb, $7::date)", [
            f.ownerA,
            id,
            JSON.stringify({ bw: 1200 }),
            "Moved to another customer",
            customer,
            JSON.stringify(monoTerms({ initial_bw_reading: 1200 })),
            today,
          ]);

        expect((await reassign(f.custB1))?.code).toBe("RD404"); // another tenant's customer
        await asPostgres(db);
        expect((await agreement(id)).status).toBe("ACTIVE");
        expect(await machineStatus(f.machineASpare)).toBe("RENTED");

        await asService(db);
        expect(await reassign(f.custA1)).toBeNull();
        await asPostgres(db);
        expect((await agreement(id)).status).toBe("TERMINATED");
        expect(await machineStatus(f.machineASpare)).toBe("RENTED");
        expect(
          await count(db, "select 1 from public.rental_agreements where machine_id = $1 and customer_id = $2 and status = 'ACTIVE'", [
            f.machineASpare,
            f.custA1,
          ]),
        ).toBe(1);
      });
    });
  });

  describe("terms changes (AGR-02)", () => {
    it("apply from the next cycle only; open tickets keep their terms; history is kept", async () => {
      await isolated(db, async () => {
        // Fixture: agrA1Mono started 31 days ago, cycle 1 is open (next_cycle_no = 2).
        await asService(db);
        const r = await rpc<{ version: number; effective_from_cycle_no: number; effective_from_date: string }>(
          "public.rpc_update_agreement_terms($1, $2, $3::jsonb, $4, $5::date)",
          [f.ownerA, f.agrA1Mono, JSON.stringify({ monthly_commitment_cents: 600_000, bw_rate_cents: 300 }), "New price list", today],
        );
        // Cycle 1 was due yesterday; cycle 2's period runs now, so the change starts at cycle 3.
        expect(r.version).toBe(2);
        expect(r.effective_from_cycle_no).toBe(3);

        await asPostgres(db);
        const a = await db.query("select first_billing_date::text as fbd, cycle_length_days as len from public.rental_agreements where id = $1", [
          f.agrA1Mono,
        ]);
        // Same answer as the TypeScript calendar.
        expect(cycleInProgress(a.rows[0].fbd, a.rows[0].len, today) + 1).toBe(3);
        expect((await agreement(f.agrA1Mono)).monthly_commitment_cents).toBe(500_000); // current terms unchanged
        expect(
          (await db.query("select commitment_cents::int as c from public.billing_cycle_tickets where id = $1", [f.tickets.a1Mono])).rows[0].c,
        ).toBe(500_000);

        const { rows: history } = await db.query(
          "select version, effective_from_cycle_no, monthly_commitment_cents::int, bw_rate_cents::int, note, changed_by from public.agreement_terms_history where agreement_id = $1 order by version",
          [f.agrA1Mono],
        );
        expect(history).toEqual([
          expect.objectContaining({ version: 1, effective_from_cycle_no: 1, monthly_commitment_cents: 500_000, bw_rate_cents: 250 }),
          { version: 2, effective_from_cycle_no: 3, monthly_commitment_cents: 600_000, bw_rate_cents: 300, note: "New price list", changed_by: f.ownerA },
        ]);
        expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'agreement.terms_changed'", [f.custA1])).toBe(1);

        // Cycle 2 keeps the old terms, cycle 3 gets the new ones.
        await db.query("select app.open_billing_cycle($1, 2, now())", [f.agrA1Mono]);
        await db.query("select app.open_billing_cycle($1, 3, now())", [f.agrA1Mono]);
        const { rows: tickets } = await db.query(
          "select cycle_no, commitment_cents::int, bw_rate_cents::int, due_days from public.billing_cycle_tickets where agreement_id = $1 order by cycle_no",
          [f.agrA1Mono],
        );
        expect(tickets.map((t) => [t.cycle_no, t.commitment_cents, t.bw_rate_cents, t.due_days])).toEqual([
          [1, 500_000, 250, 7],
          [2, 500_000, 250, 7],
          [3, 600_000, 300, 7],
        ]);
        expect((await agreement(f.agrA1Mono)).monthly_commitment_cents).toBe(600_000);
      });
    });

    it("validates edits and changes the location at once", async () => {
      await isolated(db, async () => {
        await asService(db);
        const edit = (actor: string, agreementId: string, terms: object) =>
          sqlError(db, "select public.rpc_update_agreement_terms($1, $2, $3::jsonb, null, $4::date)", [
            actor,
            agreementId,
            JSON.stringify(terms),
            today,
          ]);
        expect((await edit(f.ownerA, f.agrA1Mono, {}))?.code, "nothing changed").toBe("RD400");
        expect((await edit(f.ownerA, f.agrA1Mono, { colour_rate_cents: 100, colour_included: 1 }))?.code, "colour on mono").toBe("RD400");
        expect((await edit(f.ownerA, f.agrA1Colour, { colour_rate_cents: null }))?.code, "colour removed").toBe("RD400");
        expect((await edit(f.ownerA, f.agrA1Mono, { bw_rate_cents: -1 }))?.code, "negative").toBe("RD400");
        expect((await edit(f.ownerB, f.agrA1Mono, { bw_rate_cents: 1 }))?.code, "other owner").toBe("RD403");

        expect(await edit(f.ownerA, f.agrA1Mono, { installation_location: "Back office" })).toBeNull();
        await asPostgres(db);
        expect(
          (await db.query("select installation_location from public.rental_agreements where id = $1", [f.agrA1Mono])).rows[0]
            .installation_location,
        ).toBe("Back office");
        expect(await count(db, "select 1 from public.agreement_terms_history where agreement_id = $1", [f.agrA1Mono])).toBe(1);

        // History is append-only, even for server code.
        await asService(db);
        expect((await sqlError(db, "delete from public.agreement_terms_history where agreement_id = $1", [f.agrA1Mono]))?.code).toBe("42501");
      });
    });
  });

  describe("customer balances (CUS-04/05)", () => {
    it("sum issued, unpaid invoices per customer, inside the tenant", async () => {
      await isolated(db, async () => {
        await asUser(db, f.ownerA);
        const { rows } = await db.query("select customer_id, outstanding_cents::int, unpaid_invoices from public.customer_balances");
        // A1's invoice is still a draft; A2's slip is waiting for verification.
        expect(rows).toEqual([{ customer_id: f.custA2, outstanding_cents: 650_000, unpaid_invoices: 1 }]);

        await asUser(db, f.custA1);
        expect(await count(db, "select 1 from public.customer_balances")).toBe(0);
        await asUser(db, f.ownerB);
        expect(await count(db, "select 1 from public.customer_balances where owner_id <> $1", [f.ownerB])).toBe(0);
      });
    });
  });
});
