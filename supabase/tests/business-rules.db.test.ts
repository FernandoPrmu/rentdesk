import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { addDays, addMonths, cycleDate, cycleInProgress, daysInCycle, finalCycle } from "../../src/lib/agreements/cycle-calendar.ts";
import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";

import { asAnon, asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { confirmReading, finalFacts, meterContextFromDb, returnPayload, submitReading } from "./returns";

/**
 * Client business-rule decisions (migration 0017, spec section 18): monthly cycles,
 * return with unpaid invoices (RET-01), credits added automatically (rule 13), late
 * fee per agreement (LATE-01), advances and security deposits (DEP-01..04).
 */
describe.skipIf(!DB_URL)("client business rules (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  let today: string;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
    today = (await db.query<{ d: string }>("select current_date::text as d")).rows[0].d;
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  async function rpc<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await db.query(`select ${sql} as r`, params);
    return rows[0].r as T;
  }

  const RS = (rupees: number) => rupees * 100;
  const monoTerms = (overrides: Record<string, unknown> = {}) => ({
    start_date: addDays(today, -10),
    first_billing_date: today,
    due_days: 7,
    monthly_commitment_cents: RS(5000),
    bw_included: 2000,
    bw_rate_cents: 250,
    installation_location: "Front office",
    initial_bw_reading: 1000,
    ...overrides,
  });
  const upfront = (type: "SECURITY_DEPOSIT" | "ADVANCE_PAYMENT", amount: number, extra: Record<string, unknown> = {}) => ({
    type,
    amount_cents: amount,
    received_on: addDays(today, -3),
    method: "CASH",
    reference: `${type}-REF`,
    ...extra,
  });

  const assign = (customer: string, terms: object, machine = f.machineASpare) =>
    rpc<{ agreement_id: string }>("public.rpc_assign_machine($1, $2, $3, $4::jsonb, $5::date)", [
      f.ownerA,
      machine,
      customer,
      JSON.stringify(terms),
      today,
    ]);
  const doReturn = (actor: string, agreementId: string, payload: object) =>
    sqlError(db, "select public.rpc_return_machine($1, $2, $3::jsonb, $4::date)", [actor, agreementId, JSON.stringify(payload), today]);
  const settle = (actor: string, agreementId: string, settlement: object) =>
    sqlError(db, "select public.rpc_settle_deposit($1, $2, $3::jsonb, $4::date)", [actor, agreementId, JSON.stringify(settlement), today]);
  const openCycle = async (agreementId: string, cycleNo: number) =>
    (await rpc<{ ticket_id: string }>("app.open_billing_cycle($1, $2, now() + interval '5 days')", [agreementId, cycleNo])).ticket_id;
  const held = async (agreementId: string) =>
    Number((await db.query<{ v: string }>("select app.deposit_held($1)::text as v", [agreementId])).rows[0].v);
  const available = async (customerId: string) =>
    (await db.query<{ c: { id: string; available_cents: number }[] }>("select app.available_credits($1) as c", [customerId])).rows[0].c;

  describe("monthly cycle calendar (rule 1)", () => {
    it("SQL and TypeScript agree on cycle dates, days and the cycle in progress", async () => {
      for (const first of ["2026-01-31", "2028-01-29", "2028-02-29", "2026-12-31", "2026-10-08", "2026-11-30"]) {
        const { rows: dates } = await db.query<{ n: number; d: string; days: number }>(
          "select n, app.cycle_date($1::date, n)::text as d, app.cycle_days($1::date, n) as days from generate_series(0, 30) n",
          [first],
        );
        for (const r of dates) {
          expect(r.d, `${first} #${r.n}`).toBe(cycleDate(first, r.n));
          if (r.n >= 1) expect(r.days, `${first} #${r.n} days`).toBe(daysInCycle(first, r.n));
        }
        const { rows: progress } = await db.query<{ t: string; k: number }>(
          "select d::date::text as t, app.cycle_in_progress($1::date, d::date) as k from generate_series($1::date - 40, $1::date + 420, interval '1 day') d",
          [first],
        );
        for (const r of progress) expect(r.k, `${first} on ${r.t}`).toBe(cycleInProgress(first, r.t));
      }
    });

    it("final cycle facts match the TypeScript calendar", async () => {
      // Fixture A1 mono: started 31 days ago, cycle 1 open (no confirmed reading yet).
      const { rows } = await db.query("select start_date::text as s, first_billing_date::text as fb from public.rental_agreements where id = $1", [f.agrA1Mono]);
      for (const day of [today, addDays(today, 9), addDays(today, 40)]) {
        expect(await finalFacts(db, f.agrA1Mono, day)).toEqual(
          finalCycle({ startDate: rows[0].s, firstBillingDate: rows[0].fb, today: day, lastConfirmedCycle: 0 }),
        );
      }
    });

    it("tickets follow the month: real days, billing day, next cycle one month later", async () => {
      await isolated(db, async () => {
        await asService(db);
        const first = addDays(today, 0);
        const { agreement_id: id } = await assign(f.custA2, monoTerms({ first_billing_date: first }));
        await asPostgres(db);
        const ticket = await openCycle(id, 1);
        const { rows } = await db.query(
          `select a.billing_day, a.next_cycle_no, a.next_cycle_date::text as next, t.cycle_date::text as due,
                  t.period_start::text as ps, t.cycle_length_days
           from public.rental_agreements a join public.billing_cycle_tickets t on t.agreement_id = a.id where t.id = $1`,
          [ticket],
        );
        expect(rows[0]).toEqual({
          billing_day: Number(first.slice(8, 10)),
          next_cycle_no: 2,
          next: addMonths(first, 1),
          due: first,
          ps: addDays(today, -10), // cycle 1 starts on the start date
          cycle_length_days: daysInCycle(first, 1),
        });
      });
    });
  });

  describe("late fee per agreement (LATE-01)", () => {
    it("is set on assignment, versioned like the prices, and snapshot on tickets", async () => {
      await isolated(db, async () => {
        await asService(db);
        expect(
          (await sqlError(db, "select public.rpc_assign_machine($1, $2, $3, $4::jsonb, $5::date)", [
            f.ownerA, f.machineASpare, f.custA2, JSON.stringify(monoTerms({ late_fee_mode: "CUSTOM" })), today,
          ]))?.message,
        ).toMatch(/custom late fee needs an amount/);
        // First billing in 5 days: cycle 1 is in progress, so a change applies from cycle 2.
        const { agreement_id: id } = await assign(
          f.custA2,
          monoTerms({ first_billing_date: addDays(today, 5), late_fee_mode: "CUSTOM", late_fee_cents: RS(500) }),
        );

        // NONE from the next cycle; the amount is dropped.
        await rpc("public.rpc_update_agreement_terms($1, $2, $3::jsonb, $4, $5::date)", [
          f.ownerA, id, JSON.stringify({ late_fee_mode: "NONE", late_fee_cents: RS(100) }), "No late fee for this customer", today,
        ]);
        await asPostgres(db);
        const { rows: history } = await db.query(
          "select version, effective_from_cycle_no, late_fee_mode, late_fee_cents::int from public.agreement_terms_history where agreement_id = $1 order by version",
          [id],
        );
        expect(history).toEqual([
          { version: 1, effective_from_cycle_no: 1, late_fee_mode: "CUSTOM", late_fee_cents: RS(500) },
          { version: 2, effective_from_cycle_no: 2, late_fee_mode: "NONE", late_fee_cents: null },
        ]);
        // Cycle 1 keeps the custom fee; cycle 2 has none.
        const t1 = await openCycle(id, 1);
        const t2 = await openCycle(id, 2);
        const { rows } = await db.query(
          "select id, late_fee_mode, late_fee_cents::int from public.billing_cycle_tickets where id = any($1::uuid[])",
          [[t1, t2]],
        );
        expect(rows.find((r) => r.id === t1)).toMatchObject({ late_fee_mode: "CUSTOM", late_fee_cents: RS(500) });
        expect(rows.find((r) => r.id === t2)).toMatchObject({ late_fee_mode: "NONE", late_fee_cents: null });
        expect((await sqlError(db, "update public.rental_agreements set late_fee_mode = 'CUSTOM' where id = $1", [id]))?.code).toBe("23514");
      });
    });
  });

  describe("advance payments and credits (DEP-02, rule 13)", () => {
    it("an advance becomes a credit and is applied automatically to the next invoice", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(f.custA2, monoTerms({ upfront: [upfront("ADVANCE_PAYMENT", RS(2000), { note: "Paid with the contract" })] }));
        await asPostgres(db);
        const { rows: credits } = await db.query(
          "select id, kind, status, amount_cents::int, agreement_id, method, reason, received_on::text from public.credits where customer_id = $1",
          [f.custA2],
        );
        expect(credits).toEqual([
          expect.objectContaining({ kind: "ADVANCE", status: "AVAILABLE", amount_cents: RS(2000), agreement_id: id, method: "CASH", reason: "Paid with the contract", received_on: addDays(today, -3) }),
        ]);
        const advance = credits[0].id as string;
        // It is a credit, never part of a deposit.
        expect(await held(id)).toBe(0);

        const ticket = await openCycle(id, 1);
        await asService(db);
        const { invoiceId, submissionId } = await submitReading(db, ticket, 100);
        await asPostgres(db);
        const { rows: lines } = await db.query(
          "select line_type, amount_cents::int, credit_id from public.invoice_lines where invoice_id = $1 order by sort_order",
          [invoiceId],
        );
        expect(lines).toEqual([
          { line_type: "COMMITMENT", amount_cents: RS(5000), credit_id: null },
          { line_type: "CREDIT", amount_cents: -RS(2000), credit_id: advance },
        ]);
        expect((await db.query("select total_cents::int from public.invoices where id = $1", [invoiceId])).rows[0].total_cents).toBe(RS(3000));
        // The draft reserves it: nothing is left for another invoice, but it is not used up yet.
        expect(await available(f.custA2)).toEqual([]);
        expect((await db.query("select status from public.credits where id = $1", [advance])).rows[0].status).toBe("AVAILABLE");

        await confirmReading(db, ticket, submissionId);
        const { rows: after } = await db.query("select status, applied_to_invoice_id from public.credits where id = $1", [advance]);
        expect(after[0]).toEqual({ status: "APPLIED", applied_to_invoice_id: invoiceId });
      });
    });

    it("the owner can remove a credit from a draft: it stays available; adding it back restores it; audited", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(f.custA2, monoTerms({ upfront: [upfront("ADVANCE_PAYMENT", RS(2000))] }));
        await asPostgres(db);
        const advance = (await db.query("select id from public.credits where agreement_id = $1", [id])).rows[0].id as string;
        const ticket = await openCycle(id, 1);
        await asService(db);
        const { invoiceId } = await submitReading(db, ticket, 100);

        const recalculated = async (excluded: string[]) => {
          const context = await meterContextFromDb(db, ticket, { excludeInvoiceId: invoiceId, creditsExcluded: excluded });
          return buildMeterSubmission(context, { BW: 1100 }).invoice;
        };
        const setCredit = (actor: string, include: boolean, invoice: object, note: string | null = "Refund it instead") =>
          sqlError(db, "select public.rpc_set_invoice_credit($1, $2, $3, $4, $5, $6::jsonb)", [actor, invoiceId, advance, include, note, JSON.stringify(invoice)]);

        const without = await recalculated([advance]);
        expect(without.total_cents).toBe(RS(5000));
        expect((await setCredit(f.custA2, false, without))?.code, "a customer").toBe("RD403");
        expect((await setCredit(f.ownerB, false, without))?.code, "another owner").toBe("RD403");
        // The recalculated invoice must reflect exactly this change.
        expect((await setCredit(f.ownerA, false, await recalculated([])))?.code).toBe("RD400");
        expect(await setCredit(f.ownerA, false, without)).toBeNull();
        expect((await setCredit(f.ownerA, false, without))?.message).toMatch(/already removed/);

        await asPostgres(db);
        const invoice = async () =>
          (await db.query("select total_cents::int, credit_applied_cents::int, calculation -> 'credits_excluded' as ex from public.invoices where id = $1", [invoiceId])).rows[0];
        expect(await invoice()).toEqual({ total_cents: RS(5000), credit_applied_cents: 0, ex: [advance] });
        expect(await count(db, "select 1 from public.invoice_lines where invoice_id = $1 and line_type = 'CREDIT'", [invoiceId])).toBe(0);
        // Removed credits stay available (e.g. to refund, or for the next invoice).
        expect(await available(f.custA2)).toEqual([{ id: advance, available_cents: RS(2000) }]);
        const { rows: audit } = await db.query(
          "select action, actor_id, details from public.audit_logs where entity_id = $1 and action like 'INVOICE_CREDIT_%' order by created_at",
          [invoiceId],
        );
        expect(audit).toEqual([
          expect.objectContaining({ action: "INVOICE_CREDIT_REMOVED", actor_id: f.ownerA, details: expect.objectContaining({ credit_id: advance, note: "Refund it instead", total_after_cents: RS(5000) }) }),
        ]);

        await asService(db);
        expect(await setCredit(f.ownerA, true, await recalculated([]), null)).toBeNull();
        await asPostgres(db);
        expect(await invoice()).toEqual({ total_cents: RS(3000), credit_applied_cents: RS(2000), ex: [] });
        expect(await available(f.custA2)).toEqual([]);
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'INVOICE_CREDIT_RESTORED'", [invoiceId])).toBe(1);
      });
    });

    it("refuses a calculation made with a stale list of credits", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(f.custA2, monoTerms());
        await asPostgres(db);
        const ticket = await openCycle(id, 1);
        const stale = buildMeterSubmission(await meterContextFromDb(db, ticket), { BW: 1100 });
        // A credit appears after the customer's screen loaded (e.g. an overpayment was accepted).
        await db.query(
          "insert into public.credits (owner_id, customer_id, kind, amount_cents, reason) values ($1, $2, 'MANUAL', 1000, 'Goodwill')",
          [f.ownerA, f.custA2],
        );
        await asService(db);
        const error = await sqlError(
          db,
          `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now(), null, $6)`,
          [ticket, f.custA2, JSON.stringify(stale.readings), JSON.stringify({ storage_path: `${f.ownerA}/${ticket}/p.jpg` }), JSON.stringify(stale.invoice), stale.anomalyFlag],
        );
        expect(error?.code).toBe("RD409");
        expect(error?.message).toMatch(/credits have changed/);
        // Recalculated, the new credit is applied.
        const { invoiceId } = await submitReading(db, ticket, 100);
        await asPostgres(db);
        expect((await db.query("select credit_applied_cents::int from public.invoices where id = $1", [invoiceId])).rows[0].credit_applied_cents).toBe(1000);
      });
    });
  });

  describe("return with an outstanding balance (RET-01, rule 4)", () => {
    it("works with an unpaid invoice, which stays payable by the customer", async () => {
      await isolated(db, async () => {
        // Owner B: B1's invoice is awaiting payment.
        await asService(db);
        const { payload, submission } = await returnPayload(db, f.agrB1Mono, today, { closing: { bw: 7700 } });
        expect(await doReturn(f.ownerB, f.agrB1Mono, payload)).toBeNull();

        await asPostgres(db);
        expect((await db.query("select status from public.rental_agreements where id = $1", [f.agrB1Mono])).rows[0].status).toBe("TERMINATED");
        expect((await db.query("select status from public.machines where id = $1", [f.machineBMono])).rows[0].status).toBe("AVAILABLE");
        const { rows: invoices } = await db.query(
          "select id, status, total_cents::int from public.invoices where agreement_id = $1 order by created_at",
          [f.agrB1Mono],
        );
        expect(invoices.map((i) => i.status)).toEqual(["AWAITING_PAYMENT", "AWAITING_PAYMENT"]);
        expect(invoices[0].id).toBe(f.invoices.b1Mono);
        expect(invoices[1].total_cents).toBe(submission!.invoice.total_cents);

        // The customer can still sign in (account untouched), sees both invoices and the balance.
        expect((await db.query("select status from public.profiles where id = $1", [f.custB1])).rows[0].status).toBe("ACTIVE");
        await asUser(db, f.custB1);
        expect(await count(db, "select 1 from public.invoices where agreement_id = $1", [f.agrB1Mono])).toBe(2);
        const { rows: balance } = await db.query("select outstanding_cents::int, unpaid_invoices from public.customer_balances");
        expect(balance).toEqual([{ outstanding_cents: RS(6500) + submission!.invoice.total_cents, unpaid_invoices: 2 }]);

        // ...and can still send a payment slip for the earlier invoice.
        await asService(db);
        const slip = await sqlError(
          db,
          `select app.submit_payment($1, $2, gen_random_uuid(), 'CUSTOMER_SLIP', $3::jsonb, $4::jsonb, now() + interval '2 days')`,
          [
            f.tickets.b1Mono,
            f.custB1,
            JSON.stringify({ amount_cents: RS(6500), paid_on: today, reference: `AFTER-RETURN-${f.tag}` }),
            JSON.stringify({ storage_path: `${f.ownerB}/${f.tickets.b1Mono}/slip-after.pdf`, sha256: "b".repeat(64), mime_type: "application/pdf", size_bytes: 900 }),
          ],
        );
        expect(slip).toBeNull();
        await asPostgres(db);
        expect((await db.query("select status from public.billing_cycle_tickets where id = $1", [f.tickets.b1Mono])).rows[0].status).toBe("PAYMENT_SUBMITTED");
      });
    });

    it("is blocked while a meter reading waits for review, with a clear reason", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { payload } = await returnPayload(db, f.agrA1Colour, today, { closing: { bw: 5000, colour: 1000 } });
        const error = await doReturn(f.ownerA, f.agrA1Colour, payload);
        expect(error?.code).toBe("RD409");
        expect(JSON.parse(error!.message.slice("RETURN_BLOCKED:".length))).toEqual([
          expect.objectContaining({ kind: "ticket", cycle_no: 1, status: "PENDING_OWNER_REVIEW" }),
        ]);
      });
    });

    it("bills an open meter request in the final invoice and cancels that ticket", async () => {
      await isolated(db, async () => {
        // A1 mono: cycle 1 is waiting for the meter reading.
        await asService(db);
        const { payload, submission } = await returnPayload(db, f.agrA1Mono, today, { closing: { bw: 9000 } });
        expect(submission!.result.cyclesCovered).toBe(2); // cycle 1 in full + the cycle in progress
        expect(await doReturn(f.ownerA, f.agrA1Mono, payload)).toBeNull();
        await asPostgres(db);
        const { rows } = await db.query(
          "select status from public.billing_cycle_tickets where id = $1",
          [f.tickets.a1Mono],
        );
        expect(rows[0].status).toBe("CANCELLED");
        const { rows: events } = await db.query(
          "select reason, actor_id from public.ticket_events where ticket_id = $1 and to_status = 'CANCELLED'",
          [f.tickets.a1Mono],
        );
        expect(events).toEqual([{ reason: "Billed in the final invoice when the machine was returned", actor_id: f.ownerA }]);
        expect((await db.query("select cycles_covered from public.invoices where agreement_id = $1", [f.agrA1Mono])).rows[0].cycles_covered).toBe(2);
      });
    });
  });

  describe("security deposits (DEP-01, DEP-03, DEP-04)", () => {
    /** Assign with a deposit, issue cycle 1's invoice (Rs. 5,000, unpaid). */
    async function rentalWithDeposit(depositCents: number, extra: Record<string, unknown>[] = []) {
      await asService(db);
      const { agreement_id: id } = await assign(f.custA2, monoTerms({ upfront: [upfront("SECURITY_DEPOSIT", depositCents), ...extra] }));
      await asPostgres(db);
      const ticket = await openCycle(id, 1);
      await asService(db);
      const { submissionId, invoiceId } = await submitReading(db, ticket, 100);
      await confirmReading(db, ticket, submissionId);
      await asPostgres(db);
      return { id, ticket, invoiceId };
    }

    it("is held separately, never as a credit, and shows on the agreement", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(
          f.custA2,
          monoTerms({ upfront: [upfront("SECURITY_DEPOSIT", RS(10_000)), upfront("SECURITY_DEPOSIT", RS(2_500), { method: "BANK_TRANSFER" })] }),
        );
        await asPostgres(db);
        expect(await held(id)).toBe(RS(12_500));
        expect(await count(db, "select 1 from public.credits where customer_id = $1", [f.custA2])).toBe(0);
        const { rows } = await db.query("select held_cents::int, received_cents::int from public.agreement_deposit_balances where agreement_id = $1", [id]);
        expect(rows).toEqual([{ held_cents: RS(12_500), received_cents: RS(12_500) }]);

        // Upfront money is validated: future dates, bad types, zero amounts, too many entries.
        const { rows: spare } = await db.query(
          "insert into public.machines (owner_id, brand, model, serial_no, type) values ($1, 'Ricoh', 'X', $2, 'MONO') returning id",
          [f.ownerA, `DEP-${f.tag}`],
        );
        await asService(db);
        const badOn = async (entries: object[]) =>
          (await sqlError(db, "select public.rpc_assign_machine($1, $2, $3, $4::jsonb, $5::date)", [
            f.ownerA, spare[0].id, f.custA1, JSON.stringify(monoTerms({ upfront: entries })), today,
          ]))?.message;
        expect(await badOn([upfront("SECURITY_DEPOSIT", RS(1), { received_on: addDays(today, 1) })])).toMatch(/future/);
        expect(await badOn([upfront("SECURITY_DEPOSIT", 0)])).toMatch(/more than 0/);
        expect(await badOn([{ ...upfront("SECURITY_DEPOSIT", RS(1)), type: "LOAN" }])).toMatch(/SECURITY_DEPOSIT or ADVANCE_PAYMENT/);
        expect(await badOn([upfront("SECURITY_DEPOSIT", RS(1), { method: "SECURITY_DEPOSIT" })])).toMatch(/how the money was paid/);
        expect(await badOn(Array.from({ length: 11 }, () => upfront("SECURITY_DEPOSIT", RS(1))))).toMatch(/At most 10/);
        // Nothing was left behind by the failed attempts.
        await asPostgres(db);
        expect(await count(db, "select 1 from public.rental_agreements where machine_id = $1", [spare[0].id])).toBe(0);

        // The ledger is append-only and never goes below zero.
        await asService(db);
        expect((await sqlError(db, "update public.deposit_transactions set amount_cents = 1 where agreement_id = $1", [id]))?.code).toBe("42501");
        expect((await sqlError(db, "delete from public.deposit_transactions where agreement_id = $1", [id]))?.code).toBe("42501");
        await asPostgres(db);
        const overdraw = await sqlError(
          db,
          "insert into public.deposit_transactions (owner_id, customer_id, agreement_id, kind, amount_cents, occurred_on, method) values ($1, $2, $3, 'REFUNDED', $4, current_date, 'CASH')",
          [f.ownerA, f.custA2, id, RS(12_500) + 1],
        );
        expect(overdraw?.code).toBe("RD400");
      });
    });

    it("on return: deduct from unpaid invoices, refund, retain; always balances, atomically", async () => {
      await isolated(db, async () => {
        const { id, ticket, invoiceId } = await rentalWithDeposit(RS(10_000));
        await asService(db);
        const base = await returnPayload(db, id, today, { closing: { bw: 1150 } });
        const finalTotal = base.submission!.invoice.total_cents;
        const deduct = RS(5000) + finalTotal;
        const settlement = {
          deduct_cents: deduct,
          refund_cents: RS(10_000) - deduct - RS(1000),
          refunded_on: today,
          refund_method: "BANK_TRANSFER",
          refund_reference: "RF-1",
          retain_cents: RS(1000),
          retain_reason: "Cracked paper tray",
        };
        const tryReturn = async (deposit: object) => doReturn(f.ownerA, id, { ...base.payload, deposit });

        expect((await tryReturn({ ...settlement, refund_cents: settlement.refund_cents - 1 }))?.message).toMatch(/must equal the deposit held \(Rs\. 10,000\)/);
        expect((await tryReturn({ ...settlement, deduct_cents: deduct + 1, refund_cents: settlement.refund_cents - 1 }))?.message).toMatch(/At most/);
        expect((await tryReturn({ ...settlement, retain_reason: " " }))?.message).toMatch(/reason/);
        expect((await tryReturn({ ...settlement, refund_method: null }))?.message).toMatch(/refund was paid/);
        // Every failure rolled back the whole return.
        await asPostgres(db);
        expect((await db.query("select status from public.rental_agreements where id = $1", [id])).rows[0].status).toBe("ACTIVE");
        expect(await held(id)).toBe(RS(10_000));

        await asService(db);
        expect(await tryReturn(settlement)).toBeNull();
        await asPostgres(db);
        expect(await held(id)).toBe(0);
        const { rows: ledger } = await db.query(
          "select kind, amount_cents::int, method, invoice_id, note from public.deposit_transactions where agreement_id = $1 order by created_at",
          [id],
        );
        expect(ledger.map((l) => [l.kind, l.amount_cents])).toEqual([
          ["RECEIVED", RS(10_000)],
          ["DEDUCTED", RS(5000)],
          ["DEDUCTED", finalTotal],
          ["REFUNDED", settlement.refund_cents],
          ["RETAINED", RS(1000)],
        ]);
        expect(ledger[4].note).toBe("Cracked paper tray");
        const { rows: balance } = await db.query(
          "select received_cents::int, deducted_cents::int, refunded_cents::int, retained_cents::int, held_cents::int from public.agreement_deposit_balances where agreement_id = $1",
          [id],
        );
        expect(balance[0]).toEqual({
          received_cents: RS(10_000),
          deducted_cents: deduct,
          refunded_cents: settlement.refund_cents,
          retained_cents: RS(1000),
          held_cents: 0,
        });

        // Deductions are payments of method SECURITY_DEPOSIT; both invoices are paid and closed.
        const { rows: payments } = await db.query(
          "select method, status, amount_cents::int from public.payments where invoice_id in (select id from public.invoices where agreement_id = $1) order by amount_cents desc",
          [id],
        );
        expect(payments).toEqual([
          { method: "SECURITY_DEPOSIT", status: "ACCEPTED", amount_cents: RS(5000) },
          { method: "SECURITY_DEPOSIT", status: "ACCEPTED", amount_cents: finalTotal },
        ]);
        expect(await count(db, "select 1 from public.invoices where agreement_id = $1 and status = 'PAID'", [id])).toBe(2);
        expect((await db.query("select status from public.billing_cycle_tickets where id = $1", [ticket])).rows[0].status).toBe("CLOSED");
        expect((await db.query("select amount_paid_cents::int from public.invoices where id = $1", [invoiceId])).rows[0].amount_paid_cents).toBe(RS(5000));
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'DEPOSIT_SETTLED' and actor_id = $2", [id, f.ownerA])).toBe(1);
        expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'deposit.settled'", [f.custA2])).toBe(1);
      });
    });

    it("can be kept and settled later on the returned agreement (partial deduction)", async () => {
      await isolated(db, async () => {
        const { id, ticket } = await rentalWithDeposit(RS(3000));
        await asService(db);
        // Settling needs a returned agreement.
        expect((await settle(f.ownerA, id, { refund_cents: RS(3000), refunded_on: today, refund_method: "CASH" }))?.message).toMatch(/when the machine is returned/);
        const { payload } = await returnPayload(db, id, today, { closing: { bw: 1150 } });
        expect(await doReturn(f.ownerA, id, { ...payload, deposit: null })).toBeNull();
        await asPostgres(db);
        expect(await held(id)).toBe(RS(3000));
        const { rows } = await db.query("select details from public.audit_logs where entity_id = $1 and action = 'MACHINE_RETURNED'", [id]);
        expect(rows[0].details).toMatchObject({ deposit_settled: false, deposit_held_cents: RS(3000) });

        await asService(db);
        expect((await settle(f.ownerB, id, { refund_cents: RS(3000), refunded_on: today, refund_method: "CASH" }))?.code).toBe("RD403");
        // Rs. 3,000 pays part of the Rs. 5,000 invoice (oldest first); nothing to refund.
        expect(await settle(f.ownerA, id, { deduct_cents: RS(3000) })).toBeNull();
        await asPostgres(db);
        expect(await held(id)).toBe(0);
        const { rows: first } = await db.query(
          "select i.status, i.amount_paid_cents::int, t.status as ticket_status from public.invoices i join public.billing_cycle_tickets t on t.id = i.ticket_id where t.id = $1",
          [ticket],
        );
        expect(first[0]).toEqual({ status: "PARTIALLY_PAID", amount_paid_cents: RS(3000), ticket_status: "PARTIALLY_PAID" });
        expect(await count(db, "select 1 from public.payments where method = 'SECURITY_DEPOSIT' and status = 'PARTIAL' and ticket_id = $1", [ticket])).toBe(1);

        // Nothing left to settle.
        await asService(db);
        expect((await settle(f.ownerA, id, { refund_cents: 0 }))?.message).toMatch(/No deposit is held/);
      });
    });

    it("reassign follows the same rules: final invoice, deposit settled, new money received", async () => {
      await isolated(db, async () => {
        const { id } = await rentalWithDeposit(RS(10_000));
        await asService(db);
        const { payload } = await returnPayload(db, id, today, { closing: { bw: 1150 }, reason: "Moved to the branch" });
        const result = await rpc<{ agreement_id: string; previous_agreement_id: string }>(
          "public.rpc_reassign_machine($1, $2, $3::jsonb, $4, $5::jsonb, $6::date)",
          [
            f.ownerA,
            id,
            JSON.stringify({ ...payload, deposit: { refund_cents: RS(10_000), refunded_on: today, refund_method: "CASH" } }),
            f.custA1,
            JSON.stringify(monoTerms({ initial_bw_reading: 1150, upfront: [upfront("SECURITY_DEPOSIT", RS(4000))] })),
            today,
          ],
        );
        await asPostgres(db);
        expect(result.previous_agreement_id).toBe(id);
        expect(await held(id)).toBe(0);
        expect(await held(result.agreement_id)).toBe(RS(4000));
        // Refunded in full: the unpaid invoices stay on A2's account.
        expect(await count(db, "select 1 from public.invoices where agreement_id = $1 and status = 'AWAITING_PAYMENT'", [id])).toBe(2);
      });
    });
  });

  describe("RLS on deposits", () => {
    it("owner reads their tenant, the customer their own, admin all; nobody writes directly", async () => {
      await isolated(db, async () => {
        await asService(db);
        const { agreement_id: id } = await assign(f.custA2, monoTerms({ upfront: [upfront("SECURITY_DEPOSIT", RS(1000))] }));

        const visible = async () => ({
          rows: await count(db, "select 1 from public.deposit_transactions where agreement_id = $1", [id]),
          balances: await count(db, "select 1 from public.agreement_deposit_balances where agreement_id = $1", [id]),
        });
        await asUser(db, f.ownerA);
        expect(await visible()).toEqual({ rows: 1, balances: 1 });
        await asUser(db, f.custA2);
        expect(await visible()).toEqual({ rows: 1, balances: 1 });
        await asUser(db, f.admin);
        expect(await visible()).toEqual({ rows: 1, balances: 1 });
        await asUser(db, f.ownerB);
        expect(await visible()).toEqual({ rows: 0, balances: 0 });
        await asUser(db, f.custA1);
        expect(await visible()).toEqual({ rows: 0, balances: 0 });

        await asUser(db, f.ownerA);
        expect(
          (await sqlError(
            db,
            "insert into public.deposit_transactions (owner_id, customer_id, agreement_id, kind, amount_cents, occurred_on, method) values ($1, $2, $3, 'RECEIVED', 100, current_date, 'CASH')",
            [f.ownerA, f.custA2, id],
          ))?.code,
        ).toBe("42501");
        expect((await sqlError(db, "select public.rpc_settle_deposit($1, $2, '{}'::jsonb, current_date)", [f.ownerA, id]))?.code).toBe("42501");
        await asAnon(db);
        expect((await sqlError(db, "select 1 from public.deposit_transactions"))?.code).toBe("42501");
        expect((await sqlError(db, "select 1 from public.agreement_deposit_balances"))?.code).toBe("42501");
      });
    });
  });
});
