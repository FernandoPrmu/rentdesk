import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";
import { planAllocation } from "../../src/lib/payments/allocation.ts";
import { findDuplicate } from "../../src/lib/payments/duplicates.ts";
import { formatReceiptNo } from "../../src/lib/payments/receipt-number.ts";

import { APPLY_MIGRATIONS, asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, deleteFixture, type Fixture, slipPath } from "./fixtures";
import { meterContextFromDb, submitReading } from "./returns";

/**
 * Payments (task 7; PAY-01..13, TKT-10, decisions 39-46) against the linked dev
 * database, rolled back: slips for one or several bills, accept / another amount /
 * reject, manual payments and advances, overpayment credits applied to the next
 * invoice, reversal and reallocation, credit refunds, receipts (numbers per owner,
 * gap-free, concurrency-safe), duplicates, orphan slips and RLS.
 *
 * Fixture amounts: A1 colour Rs. 12,800 (pending review), A1 mono and A2 mono
 * Rs. 6,500 each, B1 mono Rs. 6,500 awaiting payment; A2 has a Rs. 6,500 slip waiting.
 */

const RS = (rupees: number) => rupees * 100;

describe.skipIf(!DB_URL)("payments (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  let today: string;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
    today = (await db.query("select app.colombo_date(now())::text as d")).rows[0].d;
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  const one = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as T;
  const call = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await one<{ r: T }>(`select ${sql} as r`, params)).r;

  const ticketOf = async (ticketId: string) =>
    one<{ status: string; status_before_overdue: string | null; invoice_id: string }>(
      "select status, status_before_overdue, current_invoice_id as invoice_id from public.billing_cycle_tickets where id = $1",
      [ticketId],
    );
  const invoiceOf = async (invoiceId: string) =>
    one<{ status: string; paid: number; total: number }>(
      "select status, amount_paid_cents::int as paid, total_cents::int as total from public.invoices where id = $1",
      [invoiceId],
    );
  const paymentOf = async (paymentId: string) =>
    one<{ status: string; accepted: number | null; credit: number; dup: string | null; reasons: string[] }>(
      "select status, accepted_amount_cents::int as accepted, credit_cents::int as credit, duplicate_of_payment_id as dup, duplicate_reasons as reasons from public.payments where id = $1",
      [paymentId],
    );
  const events = async (ticketId: string) =>
    (
      await db.query(
        "select event_type, from_status, to_status, reason from public.ticket_events where ticket_id = $1 and created_at >= (select max(created_at) from public.ticket_events where ticket_id = $1 and to_status = 'AWAITING_PAYMENT' and from_status = 'PENDING_OWNER_REVIEW') order by created_at, id",
        [ticketId],
      )
    ).rows;

  const slip = (owner: string, customer: string, extra: Record<string, unknown> = {}) => ({
    storage_path: `${owner}/${customer}/${randomUUID()}.jpg`,
    sha256: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    mime_type: "image/jpeg",
    size_bytes: 1000,
    ...extra,
  });
  const submit = (customer: string, invoiceIds: string[], amount: number, o: { reference?: string; slip?: object; key?: string; method?: string; owner?: string } = {}) =>
    call<{ payment_id: string; duplicate_of_payment_id: string | null; duplicate_reasons: string[]; replayed: boolean; invoices: number; credit_cents: number }>(
      "app.submit_payment($1, $1, $2, $3::uuid[], $4::jsonb, $5::jsonb, now() + interval '2 days')",
      [
        customer,
        o.key ?? randomUUID(),
        invoiceIds,
        JSON.stringify({ amount_cents: amount, paid_on: today, method: o.method ?? "BANK_TRANSFER", reference: o.reference ?? `R-${randomUUID().slice(0, 8)}` }),
        JSON.stringify(o.slip ?? slip(o.owner ?? f.ownerA, customer)),
      ],
    );
  const verify = (paymentId: string, accept: boolean, amount: number | null = null, reason: string | null = null, actor = f.ownerA) =>
    call<{ status: string; credit_cents: number; receipt_no: string; invoices: { invoice_id: string; ticket_status: string; invoice_status: string; balance_cents: number }[] }>(
      "app.verify_payment($1, $2, $3, $4, $5)",
      [paymentId, actor, accept, amount, reason],
    );
  const manual = (actor: string, customer: string, invoiceIds: string[], amount: number, o: { key?: string; method?: string } = {}) =>
    call<{ payment_id: string; status: string; credit_cents: number; receipt_no: string; replayed: boolean }>(
      "app.record_manual_payment($1, $2, $3, $4::uuid[], $5::jsonb)",
      [actor, customer, o.key ?? randomUUID(), invoiceIds, JSON.stringify({ amount_cents: amount, paid_on: today, method: o.method ?? "CASH", reference: "Receipt book 12" })],
    );
  const reverse = (paymentId: string, reason: string, actor = f.ownerA) =>
    sqlError(db, "select app.reverse_payment($1, $2, $3)", [paymentId, actor, reason]);

  /** Customer A1 gets two issued bills: colour Rs. 12,800 due in 3 days, mono Rs. 6,500 due in 10 days. */
  async function issueA1() {
    await db.query("select app.confirm_meter_submission($1, $2, $3, current_date + 3, now() + interval '3 days')", [f.tickets.a1Colour, f.submissions.a1Colour, f.ownerA]);
    const { submissionId } = await submitReading(db, f.tickets.a1Mono, 2600);
    await db.query("select app.confirm_meter_submission($1, $2, $3, current_date + 10, now() + interval '10 days')", [f.tickets.a1Mono, submissionId, f.ownerA]);
    return { colour: (await ticketOf(f.tickets.a1Colour)).invoice_id, mono: (await ticketOf(f.tickets.a1Mono)).invoice_id };
  }

  /** The fixture's A2 slip is rejected, then A2 pays `amount` with a new slip and the owner accepts it. */
  async function a2Paid(amount: number) {
    await verify(f.payments.a2Mono, false, null, "Wrong amount");
    const { payment_id } = await submit(f.custA2, [f.invoices.a2Mono], amount);
    const result = await verify(payment_id, true);
    return { paymentId: payment_id, result };
  }

  describe("customer slips (PAY-02..06, CP-04)", () => {
    it("one slip for two bills: oldest due first, both close, one receipt; SQL and TypeScript split the same way", async () => {
      await isolated(db, async () => {
        const inv = await issueA1();
        // The split, in SQL and TypeScript, for amounts below, at and above the total.
        const rows = (await db.query(
          "select i.id, i.invoice_no, i.due_date::text as due, i.invoice_seq::int as seq, (i.total_cents - i.amount_paid_cents)::int as balance from public.invoices i where i.id = any($1::uuid[])",
          [[inv.colour, inv.mono]],
        )).rows.map((r) => ({ id: r.id, invoiceNo: r.invoice_no, dueDate: r.due, seq: r.seq, balanceCents: r.balance }));
        for (const amount of [100, RS(12_800), RS(15_000), RS(19_300), RS(20_000)]) {
          const sql = await call<{ allocations: { invoice_id: string; cents: number }[]; credit_cents: number }>("app.plan_allocation($1, $2::uuid[])", [amount, [inv.mono, inv.colour]]);
          const ts = planAllocation(amount, rows);
          expect(sql.allocations.filter((a) => a.cents > 0).map((a) => [a.invoice_id, a.cents]), `amount ${amount}`).toEqual(ts.allocations.map((a) => [a.invoiceId, a.cents]));
          expect(sql.credit_cents).toBe(ts.creditCents);
        }

        const sent = await submit(f.custA1, [inv.mono, inv.colour], RS(19_300));
        expect(sent).toMatchObject({ invoices: 2, credit_cents: 0, replayed: false });
        for (const t of [f.tickets.a1Colour, f.tickets.a1Mono]) expect((await ticketOf(t)).status).toBe("PAYMENT_SUBMITTED");
        expect((await invoiceOf(inv.colour)).status).toBe("PAYMENT_SUBMITTED");
        const planned = (await db.query("select invoice_id, planned_cents::int, waiting from public.payment_allocations where payment_id = $1 order by planned_cents desc", [sent.payment_id])).rows;
        expect(planned).toEqual([
          { invoice_id: inv.colour, planned_cents: RS(12_800), waiting: true },
          { invoice_id: inv.mono, planned_cents: RS(6_500), waiting: true },
        ]);
        // A second slip for a bill whose slip waits is refused.
        expect((await sqlError(db, "select app.submit_payment($1, $1, gen_random_uuid(), $2::uuid[], $3::jsonb, $4::jsonb, now())", [
          f.custA1, [inv.mono], JSON.stringify({ amount_cents: 100, paid_on: today, method: "BANK_TRANSFER" }), JSON.stringify(slip(f.ownerA, f.custA1)),
        ]))?.message).toMatch(/already waiting/);

        const accepted = await verify(sent.payment_id, true);
        expect(accepted).toMatchObject({ status: "ACCEPTED", credit_cents: 0, receipt_no: formatReceiptNo(1) });
        for (const t of [f.tickets.a1Colour, f.tickets.a1Mono]) expect((await ticketOf(t)).status).toBe("CLOSED");
        expect(await invoiceOf(inv.colour)).toEqual({ status: "PAID", paid: RS(12_800), total: RS(12_800) });
        expect(await invoiceOf(inv.mono)).toEqual({ status: "PAID", paid: RS(6_500), total: RS(6_500) });
        expect((await events(f.tickets.a1Mono)).map((e) => `${e.from_status}>${e.to_status}`)).toEqual([
          "PENDING_OWNER_REVIEW>AWAITING_PAYMENT", "AWAITING_PAYMENT>PAYMENT_SUBMITTED", "PAYMENT_SUBMITTED>CLOSED",
        ]);

        const receipt = await one<{ receipt_no: string; status: string; pdf_status: string; content: { allocations: { invoice_id: string; applied_cents: number; balance_after_cents: number }[]; outstanding_after_cents: number } }>(
          "select receipt_no, status, pdf_status, content from public.receipts where payment_id = $1",
          [sent.payment_id],
        );
        expect(receipt).toMatchObject({ receipt_no: formatReceiptNo(1), status: "ISSUED", pdf_status: "PENDING" });
        expect(receipt.content.allocations.map((a) => [a.invoice_id, a.applied_cents, a.balance_after_cents])).toEqual([
          [inv.colour, RS(12_800), 0],
          [inv.mono, RS(6_500), 0],
        ]);
        // A2's Rs. 6,500 slip is still waiting.
        expect(receipt.content.outstanding_after_cents).toBe(0);
      });
    });

    it("accept another amount: the oldest bill is partly paid, the other waits again; the rest is paid later", async () => {
      await isolated(db, async () => {
        const inv = await issueA1();
        const sent = await submit(f.custA1, [inv.colour, inv.mono], RS(19_300));
        expect((await sqlError(db, "select app.verify_payment($1, $2, true, $3)", [sent.payment_id, f.ownerA, RS(20_000)]))?.code).toBe("RD400");
        const partial = await verify(sent.payment_id, true, RS(10_000));
        expect(partial.status).toBe("PARTIAL");
        expect(await invoiceOf(inv.colour)).toEqual({ status: "PARTIALLY_PAID", paid: RS(10_000), total: RS(12_800) });
        expect((await ticketOf(f.tickets.a1Colour)).status).toBe("PARTIALLY_PAID");
        expect(await invoiceOf(inv.mono)).toEqual({ status: "AWAITING_PAYMENT", paid: 0, total: RS(6_500) });
        expect((await ticketOf(f.tickets.a1Mono)).status).toBe("AWAITING_PAYMENT");
        const allocations = (await db.query("select invoice_id, applied_cents::int, balance_after_cents::int as after, waiting from public.payment_allocations where payment_id = $1 order by applied_cents desc", [sent.payment_id])).rows;
        expect(allocations).toEqual([
          { invoice_id: inv.colour, applied_cents: RS(10_000), after: RS(2_800), waiting: false },
          { invoice_id: inv.mono, applied_cents: 0, after: RS(6_500), waiting: false },
        ]);

        // The customer pays what is left on both with one more slip.
        const rest = await submit(f.custA1, [inv.colour, inv.mono], RS(9_300));
        expect((await ticketOf(f.tickets.a1Colour)).status).toBe("PAYMENT_SUBMITTED");
        expect((await verify(rest.payment_id, true)).status).toBe("ACCEPTED");
        expect((await invoiceOf(inv.colour)).status).toBe("PAID");
        expect((await invoiceOf(inv.mono)).status).toBe("PAID");
        expect((await ticketOf(f.tickets.a1Colour)).status).toBe("CLOSED");
        // Two receipts, numbered in order.
        expect((await db.query("select receipt_no from public.receipts where owner_id = $1 order by receipt_seq", [f.ownerA])).rows.map((r) => r.receipt_no)).toEqual([
          formatReceiptNo(1),
          formatReceiptNo(2),
        ]);
      });
    });

    it("reject needs a reason; the bill waits for payment again and the customer can send a new slip", async () => {
      await isolated(db, async () => {
        expect((await sqlError(db, "select app.verify_payment($1, $2, false, null, '  ')", [f.payments.a2Mono, f.ownerA]))?.code).toBe("RD400");
        expect((await sqlError(db, "select app.verify_payment($1, $2, false, null, 'x')", [f.payments.a2Mono, f.ownerB]))?.code).toBe("RD403");
        expect(await verify(f.payments.a2Mono, false, null, "The slip is for another account")).toMatchObject({ status: "REJECTED" });
        expect((await ticketOf(f.tickets.a2Mono)).status).toBe("AWAITING_PAYMENT");
        expect((await invoiceOf(f.invoices.a2Mono)).status).toBe("AWAITING_PAYMENT");
        expect(await count(db, "select 1 from public.receipts where payment_id = $1", [f.payments.a2Mono])).toBe(0);
        const { rows } = await db.query("select reason from public.ticket_events where ticket_id = $1 and from_status = 'PAYMENT_SUBMITTED'", [f.tickets.a2Mono]);
        expect(rows).toEqual([{ reason: "The slip is for another account" }]);
        // Checked once only.
        expect((await sqlError(db, "select app.verify_payment($1, $2, true)", [f.payments.a2Mono, f.ownerA]))?.code).toBe("RD409");
        const again = await submit(f.custA2, [f.invoices.a2Mono], RS(6_500));
        expect((await ticketOf(f.tickets.a2Mono)).status).toBe("PAYMENT_SUBMITTED");
        expect((await paymentOf(again.payment_id)).status).toBe("SUBMITTED");
      });
    });

    it("is idempotent and checks the slip, the bills, the method and the date", async () => {
      await isolated(db, async () => {
        await verify(f.payments.a2Mono, false, null, "Unreadable");
        const key = randomUUID();
        const first = await submit(f.custA2, [f.invoices.a2Mono], RS(6_500), { key });
        const replay = await submit(f.custA2, [f.invoices.a2Mono], RS(6_500), { key });
        expect(replay).toMatchObject({ payment_id: first.payment_id, replayed: true });
        expect(await count(db, "select 1 from public.payments where customer_id = $1 and status = 'SUBMITTED'", [f.custA2])).toBe(1);

        await verify(first.payment_id, false, null, "Again");
        const attempt = (customer: string, invoiceIds: string[], payment: object, slipValue: object) =>
          sqlError(db, "select app.submit_payment($1, $2, gen_random_uuid(), $3::uuid[], $4::jsonb, $5::jsonb, now())", [
            customer, customer, invoiceIds, JSON.stringify(payment), JSON.stringify(slipValue),
          ]);
        const good = { amount_cents: 100, paid_on: today, method: "BANK_TRANSFER" };
        expect((await attempt(f.custA2, [f.invoices.a2Mono], good, slip(f.ownerA, f.custA1)))?.message).toMatch(/customer's folder/);
        expect((await attempt(f.custA2, [f.invoices.a2Mono], good, { ...slip(f.ownerA, f.custA2), storage_path: `${f.ownerA}/${f.custA2}/x.exe` }))?.code).toBe("RD400");
        expect((await attempt(f.custA2, [f.invoices.a2Mono], { ...good, method: "SECURITY_DEPOSIT" }, slip(f.ownerA, f.custA2)))?.message).toMatch(/how it was paid/);
        expect((await attempt(f.custA2, [f.invoices.a2Mono], { ...good, method: "NOPE" }, slip(f.ownerA, f.custA2)))?.code).toBe("RD400");
        expect((await attempt(f.custA2, [f.invoices.a2Mono], { ...good, paid_on: "2999-01-01" }, slip(f.ownerA, f.custA2)))?.message).toMatch(/today or earlier/);
        expect((await attempt(f.custA2, [f.invoices.a2Mono], { ...good, amount_cents: 0 }, slip(f.ownerA, f.custA2)))?.code).toBe("RD400");
        expect((await attempt(f.custA2, [], good, slip(f.ownerA, f.custA2)))?.message).toMatch(/at least one bill/);
        expect((await attempt(f.custA2, [f.invoices.b1Mono], good, slip(f.ownerA, f.custA2)))?.code).toBe("RD404");
        expect((await attempt(f.custA2, [f.invoices.a2Mono], good, null as unknown as object))?.message).toMatch(/slip is required/);
        // Only the customer sends a slip.
        expect((await sqlError(db, "select app.submit_payment($1, $2, gen_random_uuid(), $3::uuid[], $4::jsonb, $5::jsonb, now())", [
          f.ownerA, f.custA2, [f.invoices.a2Mono], JSON.stringify(good), JSON.stringify(slip(f.ownerA, f.custA2)),
        ]))?.code).toBe("RD403");
      });
    });

    it("flags the same file, or the same bank reference and amount, as a possible duplicate (SQL equals TypeScript)", async () => {
      await isolated(db, async () => {
        await verify(f.payments.a2Mono, false, null, "Please send again");
        const fixtureRef = `REF-${f.tag}`;
        const earlier = [{ id: f.payments.a2Mono, submittedAt: "2026-01-01T00:00:00Z", reference: fixtureRef, amountCents: RS(6_500), hashes: ["a".repeat(64)] }];

        // Same file (the fixture's slip hash), as the original fingerprint of a smaller copy.
        const sameFile = await submit(f.custA2, [f.invoices.a2Mono], RS(6_000), { slip: slip(f.ownerA, f.custA2, { original_sha256: "a".repeat(64) }) });
        expect(sameFile).toMatchObject({ duplicate_of_payment_id: f.payments.a2Mono, duplicate_reasons: ["FILE"] });
        expect(findDuplicate({ sha256: "f".repeat(64), originalSha256: "a".repeat(64), reference: null, amountCents: RS(6_000) }, earlier)).toEqual({ paymentId: f.payments.a2Mono, reasons: ["FILE"] });
        await verify(sameFile.payment_id, false, null, "Duplicate");

        // Same reference (other case, spaces) and amount.
        const sameRef = await submit(f.custA2, [f.invoices.a2Mono], RS(6_500), { reference: `  ${fixtureRef.toLowerCase()} ` });
        expect(sameRef.duplicate_reasons).toEqual(["REFERENCE"]);
        expect(await paymentOf(sameRef.payment_id)).toMatchObject({ dup: f.payments.a2Mono, reasons: ["REFERENCE"] });
        expect(findDuplicate({ sha256: "e".repeat(64), originalSha256: null, reference: ` ${fixtureRef.toLowerCase()}`, amountCents: RS(6_500) }, earlier)?.reasons).toEqual(["REFERENCE"]);
        await verify(sameRef.payment_id, false, null, "Duplicate");

        // Same reference, other amount: not a duplicate.
        const otherAmount = await submit(f.custA2, [f.invoices.a2Mono], RS(6_400), { reference: fixtureRef });
        expect(otherAmount).toMatchObject({ duplicate_of_payment_id: null, duplicate_reasons: [] });
        expect(findDuplicate({ sha256: "d".repeat(64), originalSha256: null, reference: fixtureRef, amountCents: RS(6_400) }, earlier)).toBeNull();

        // The pre-check the customer sees before sending.
        const check = await call<{ payment_id: string; reasons: string[] } | null>("app.payment_duplicates($1, $2, null, null, 0)", [f.ownerA, "a".repeat(64)]);
        // The newest match; both were sent in this one test transaction (same time), so either.
        expect(check?.reasons).toEqual(["FILE"]);
        expect([f.payments.a2Mono, sameFile.payment_id]).toContain(check?.payment_id);
        // Another owner's slips never match.
        expect(await call("app.payment_duplicates($1, $2, null, null, 0)", [f.ownerB, "a".repeat(64)])).toBeNull();
      });
    });
  });

  describe("owner records a payment (PAY-07, 11.5)", () => {
    it("cash for one bill closes it in two steps; an advance with no bill becomes a credit; idempotent; receipts per owner", async () => {
      await isolated(db, async () => {
        expect((await sqlError(db, "select app.record_manual_payment($1, $2, gen_random_uuid(), $3::uuid[], $4::jsonb)", [
          f.ownerA, f.custB1, [f.invoices.b1Mono], JSON.stringify({ amount_cents: RS(6_500), paid_on: today, method: "CASH" }),
        ]))?.code).toBe("RD403");
        const key = randomUUID();
        const cash = await manual(f.ownerB, f.custB1, [f.invoices.b1Mono], RS(6_500), { key });
        expect(cash).toMatchObject({ status: "ACCEPTED", credit_cents: 0, receipt_no: formatReceiptNo(1), replayed: false });
        expect((await manual(f.ownerB, f.custB1, [f.invoices.b1Mono], RS(6_500), { key })).replayed).toBe(true);
        expect((await ticketOf(f.tickets.b1Mono)).status).toBe("CLOSED");
        expect((await events(f.tickets.b1Mono)).map((e) => `${e.from_status}>${e.to_status}`)).toEqual([
          "PENDING_OWNER_REVIEW>AWAITING_PAYMENT", "AWAITING_PAYMENT>PAYMENT_SUBMITTED", "PAYMENT_SUBMITTED>CLOSED",
        ]);
        const p = await one("select source, method, submitted_by, verified_by from public.payments where id = $1", [cash.payment_id]);
        expect(p).toEqual({ source: "OWNER_MANUAL", method: "CASH", submitted_by: f.ownerB, verified_by: f.ownerB });
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'PAYMENT_RECORDED' and actor_id = $2", [cash.payment_id, f.ownerB])).toBe(1);

        // Advance: no bill yet (11.5 "pay before the invoice is confirmed").
        const advance = await manual(f.ownerB, f.custB1, [], RS(2_000), { method: "CHEQUE" });
        expect(advance).toMatchObject({ status: "ACCEPTED", credit_cents: RS(2_000), receipt_no: formatReceiptNo(2) });
        const credit = await one("select kind, status, amount_cents::int, method, source_payment_id from public.credits where source_payment_id = $1", [advance.payment_id]);
        expect(credit).toEqual({ kind: "ADVANCE", status: "AVAILABLE", amount_cents: RS(2_000), method: "CHEQUE", source_payment_id: advance.payment_id });

        // Not for a bill whose slip waits; owner A's own receipts start at 1 too.
        expect((await sqlError(db, "select app.record_manual_payment($1, $2, gen_random_uuid(), $3::uuid[], $4::jsonb)", [
          f.ownerA, f.custA2, [f.invoices.a2Mono], JSON.stringify({ amount_cents: 100, paid_on: today, method: "CASH" }),
        ]))?.message).toMatch(/already waiting/);
        expect((await manual(f.ownerA, f.custA1, [], 500)).receipt_no).toBe(formatReceiptNo(1));
      });
    });
  });

  describe("credits (PAY-12, rule 13)", () => {
    it("an overpayment becomes a credit, is taken off the next invoice automatically, and then blocks the reversal", async () => {
      await isolated(db, async () => {
        const { paymentId, result } = await a2Paid(RS(7_000));
        expect(result).toMatchObject({ status: "ACCEPTED", credit_cents: RS(500) });
        const credit = await one<{ id: string; kind: string; amount_cents: number }>("select id, kind, amount_cents::int from public.credits where source_payment_id = $1", [paymentId]);
        expect(credit).toMatchObject({ kind: "OVERPAYMENT", amount_cents: RS(500) });

        // Next cycle: the engine takes the credit off the draft automatically.
        const ticket2 = (await call<{ ticket_id: string }>("app.open_billing_cycle($1, 2, now() + interval '5 days')", [f.agrA2Mono])).ticket_id;
        const context = await meterContextFromDb(db, ticket2);
        expect(context.credits).toEqual([{ id: credit.id, amountCents: RS(500) }]);
        const s = buildMeterSubmission(context, { BW: context.counters.BW!.known[0].value + 1000, COLOUR: null });
        const draft = await call<{ submission_id: string; invoice_id: string }>(
          "app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now() + interval '2 days')",
          [ticket2, f.custA2, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${f.ownerA}/${ticket2}/p.jpg` }), JSON.stringify(s.invoice)],
        );
        expect(await one("select credit_applied_cents::int, total_cents::int from public.invoices where id = $1", [draft.invoice_id])).toEqual({
          credit_applied_cents: RS(500),
          total_cents: RS(5_000) - RS(500),
        });
        // The draft reserves it: reversing the payment is refused with a clear message.
        expect((await reverse(paymentId, "Cheque returned"))?.message).toMatch(/CREDIT_USED: .*draft invoice/);
        await db.query("select app.confirm_meter_submission($1, $2, $3, current_date + 7, now() + interval '7 days')", [ticket2, draft.submission_id, f.ownerA]);
        expect((await one("select status from public.credits where id = $1", [credit.id])).status).toBe("APPLIED");
        const used = (await one<{ invoice_no: string }>("select invoice_no from public.invoices where id = $1", [draft.invoice_id])).invoice_no;
        expect((await reverse(paymentId, "Cheque returned"))?.message).toContain(`already used on invoice ${used}`);
        expect((await paymentOf(paymentId)).status).toBe("ACCEPTED");
      });
    });

    it("refunds: only what is free, in parts, audited; fully refunded = REFUNDED", async () => {
      await isolated(db, async () => {
        const { paymentId } = await a2Paid(RS(8_000)); // Rs. 1,500 credit
        const creditId = (await one<{ id: string }>("select id from public.credits where source_payment_id = $1", [paymentId])).id;
        const refund = (actor: string, amount: number, extra: object = {}) =>
          sqlError(db, "select app.refund_credit($1, $2, $3::jsonb)", [creditId, actor, JSON.stringify({ amount_cents: amount, refunded_on: today, method: "BANK_TRANSFER", reference: "TRX-9", ...extra })]);
        expect((await refund(f.ownerB, 100))?.code).toBe("RD403");
        expect((await refund(f.ownerA, RS(1_600)))?.message).toMatch(/Only Rs\. 1,500 of this credit/);
        expect((await refund(f.ownerA, 100, { method: "SECURITY_DEPOSIT" }))?.code).toBe("RD400");
        expect(await refund(f.ownerA, RS(1_000))).toBeNull();
        expect(await one("select status, refunded_cents::int from public.credits where id = $1", [creditId])).toEqual({ status: "AVAILABLE", refunded_cents: RS(1_000) });
        expect((await call<{ available_cents: number }[]>("app.available_credits($1)", [f.custA2]))[0].available_cents).toBe(RS(500));
        expect(await refund(f.ownerA, RS(500))).toBeNull();
        expect((await one("select status from public.credits where id = $1", [creditId])).status).toBe("REFUNDED");
        expect((await refund(f.ownerA, 1))?.message).toMatch(/Nothing is left/);
        expect((await db.query("select amount_cents::int, method, reference, created_by from public.credit_refunds where credit_id = $1 order by created_at, amount_cents", [creditId])).rows).toEqual([
          { amount_cents: RS(500), method: "BANK_TRANSFER", reference: "TRX-9", created_by: f.ownerA },
          { amount_cents: RS(1_000), method: "BANK_TRANSFER", reference: "TRX-9", created_by: f.ownerA },
        ].sort((a, b) => a.amount_cents - b.amount_cents));
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'CREDIT_REFUNDED' and actor_id = $2", [creditId, f.ownerA])).toBe(2);
        // A refunded credit blocks reversing the payment that made it.
        expect((await reverse(paymentId, "Cheque returned"))?.message).toMatch(/CREDIT_REFUNDED/);
      });
    });
  });

  describe("reversal and reallocation (TKT-10, 11.5)", () => {
    it("reversing reopens the closed ticket, voids the unused credit and marks the receipt REVERSED", async () => {
      await isolated(db, async () => {
        const { paymentId } = await a2Paid(RS(7_000));
        expect((await ticketOf(f.tickets.a2Mono)).status).toBe("CLOSED");
        expect((await reverse(paymentId, " "))?.code).toBe("RD400");
        expect((await reverse(paymentId, "x", f.ownerB))?.code).toBe("RD403");
        expect(await reverse(paymentId, "Cheque returned by the bank")).toBeNull();

        expect(await ticketOf(f.tickets.a2Mono)).toMatchObject({ status: "AWAITING_PAYMENT" });
        expect(await invoiceOf(f.invoices.a2Mono)).toEqual({ status: "AWAITING_PAYMENT", paid: 0, total: RS(6_500) });
        expect((await events(f.tickets.a2Mono)).slice(-2).map((e) => [`${e.from_status}>${e.to_status}`, e.reason])).toEqual([
          ["CLOSED>REOPENED", "Payment reversed: Cheque returned by the bank"],
          ["REOPENED>AWAITING_PAYMENT", "Payment reversed: Cheque returned by the bank"],
        ]);
        expect((await one("select status from public.credits where source_payment_id = $1", [paymentId])).status).toBe("VOID");
        expect(await call("app.available_credits($1)", [f.custA2])).toEqual([]);
        expect(await paymentOf(paymentId)).toMatchObject({ status: "REVERSED" });
        expect(await one("select status, reverse_reason, pdf_status, pdf_pending_reason, pdf_revision from public.receipts where payment_id = $1", [paymentId])).toEqual({
          status: "REVERSED", reverse_reason: "Cheque returned by the bank", pdf_status: "PENDING", pdf_pending_reason: "REVERSED", pdf_revision: 2,
        });
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'PAYMENT_REVERSED' and actor_id = $2", [paymentId, f.ownerA])).toBe(1);
        expect((await reverse(paymentId, "again"))?.message).toMatch(/Only an accepted payment/);
        // The customer can pay again.
        await submit(f.custA2, [f.invoices.a2Mono], RS(6_500));
        expect((await ticketOf(f.tickets.a2Mono)).status).toBe("PAYMENT_SUBMITTED");
      });
    });

    it("reversing the only part payment sends a partly paid ticket back to Awaiting payment", async () => {
      await isolated(db, async () => {
        await verify(f.payments.a2Mono, false, null, "x");
        const { payment_id } = await submit(f.custA2, [f.invoices.a2Mono], RS(4_000));
        await verify(payment_id, true);
        expect((await ticketOf(f.tickets.a2Mono)).status).toBe("PARTIALLY_PAID");
        expect(await reverse(payment_id, "Transfer never arrived")).toBeNull();
        expect((await ticketOf(f.tickets.a2Mono)).status).toBe("AWAITING_PAYMENT");
        expect(await invoiceOf(f.invoices.a2Mono)).toEqual({ status: "AWAITING_PAYMENT", paid: 0, total: RS(6_500) });
      });
    });

    it("moves an accepted payment to another bill: same receipt number, new PDF version, balances corrected, audited", async () => {
      await isolated(db, async () => {
        const inv = await issueA1();
        // Meant for the mono bill, sent for the colour one.
        const sent = await submit(f.custA1, [inv.colour], RS(6_500));
        const accepted = await verify(sent.payment_id, true);
        expect((await ticketOf(f.tickets.a1Colour)).status).toBe("PARTIALLY_PAID");
        const move = (ids: string[], reason: string) => sqlError(db, "select app.reallocate_payment($1, $2, $3::uuid[], $4)", [sent.payment_id, f.ownerA, ids, reason]);
        expect((await move([inv.mono], ""))?.code).toBe("RD400");
        expect((await move([inv.colour], "same"))?.message).toMatch(/other bills/);
        expect((await move([f.invoices.b1Mono], "other tenant"))?.code).toBe("RD404");
        expect(await move([inv.mono], "Customer paid the mono bill")).toBeNull();

        expect(await invoiceOf(inv.colour)).toEqual({ status: "AWAITING_PAYMENT", paid: 0, total: RS(12_800) });
        expect((await ticketOf(f.tickets.a1Colour)).status).toBe("AWAITING_PAYMENT");
        expect(await invoiceOf(inv.mono)).toEqual({ status: "PAID", paid: RS(6_500), total: RS(6_500) });
        expect((await ticketOf(f.tickets.a1Mono)).status).toBe("CLOSED");
        expect(await paymentOf(sent.payment_id)).toMatchObject({ status: "ACCEPTED", credit: 0 });
        const active = (await db.query("select invoice_id, applied_cents::int from public.payment_allocations where payment_id = $1 and released_at is null", [sent.payment_id])).rows;
        expect(active).toEqual([{ invoice_id: inv.mono, applied_cents: RS(6_500) }]);
        expect(await count(db, "select 1 from public.payment_allocations where payment_id = $1 and released_at is not null", [sent.payment_id])).toBe(1);
        const receipt = await one<{ receipt_no: string; pdf_pending_reason: string; pdf_revision: number; content: { allocations: { invoice_id: string }[]; reallocated: { reason: string } } }>(
          "select receipt_no, pdf_pending_reason, pdf_revision, content from public.receipts where payment_id = $1",
          [sent.payment_id],
        );
        expect(receipt).toMatchObject({ receipt_no: accepted.receipt_no, pdf_pending_reason: "REALLOCATED", pdf_revision: 2 });
        expect(receipt.content.allocations.map((a) => a.invoice_id)).toEqual([inv.mono]);
        expect(receipt.content.reallocated.reason).toBe("Customer paid the mono bill");
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'PAYMENT_REALLOCATED'", [sent.payment_id])).toBe(1);

        // Moving it onto both: oldest due first again (colour), nothing left for mono.
        expect(await move([inv.mono, inv.colour], "Split it the usual way")).toBeNull();
        expect(await invoiceOf(inv.colour)).toEqual({ status: "PARTIALLY_PAID", paid: RS(6_500), total: RS(12_800) });
        expect(await invoiceOf(inv.mono)).toEqual({ status: "AWAITING_PAYMENT", paid: 0, total: RS(6_500) });
        expect((await ticketOf(f.tickets.a1Mono)).status).toBe("AWAITING_PAYMENT");
        expect(await paymentOf(sent.payment_id)).toMatchObject({ status: "PARTIAL" });
      });
    });

    it("security deposit payments get receipts and cannot be reversed or moved", async () => {
      await isolated(db, async () => {
        await verify(f.payments.a2Mono, false, null, "x");
        const { rows } = await db.query(
          `insert into public.payments (owner_id, customer_id, source, method, amount_cents, accepted_amount_cents, paid_on, status, submitted_by)
           values ($1, $2, 'OWNER_MANUAL', 'SECURITY_DEPOSIT', 100, 100, current_date, 'ACCEPTED', $1) returning id`,
          [f.ownerA, f.custA2],
        );
        expect((await reverse(rows[0].id, "no"))?.message).toMatch(/security deposit/);
        expect((await sqlError(db, "select app.reallocate_payment($1, $2, $3::uuid[], 'no')", [rows[0].id, f.ownerA, [f.invoices.a2Mono]]))?.message).toMatch(/security deposit/);
      });
    });
  });

  describe("receipts (decision 44)", () => {
    it("numbers are per owner and gap-free: a rolled-back acceptance gives its number back", async () => {
      await isolated(db, async () => {
        await db.query("savepoint undo");
        expect((await verify(f.payments.a2Mono, true)).receipt_no).toBe(formatReceiptNo(1));
        await db.query("rollback to savepoint undo");
        expect((await verify(f.payments.a2Mono, true)).receipt_no).toBe(formatReceiptNo(1));
        expect((await manual(f.ownerB, f.custB1, [f.invoices.b1Mono], RS(6_500))).receipt_no).toBe(formatReceiptNo(1));
        expect((await manual(f.ownerA, f.custA1, [], 100)).receipt_no).toBe(formatReceiptNo(2));
        expect(await one("select last_value::int from public.receipt_counters where owner_id = $1", [f.ownerA])).toEqual({ last_value: 2 });
      });
    });

    it("rendering: claim, record a version, READY; a change while rendering keeps it pending", async () => {
      await isolated(db, async () => {
        await verify(f.payments.a2Mono, true);
        const receipt = await one<{ id: string; pdf_revision: number }>("select id, pdf_revision from public.receipts where payment_id = $1", [f.payments.a2Mono]);
        expect(await call<string[]>("app.cron_pending_receipt_pdfs(now(), 50)")).toContain(receipt.id);
        const claim = await call<{ receipt: { receipt_no: string; content: object } }>("app.claim_receipt_pdf($1, now())", [receipt.id]);
        expect(claim.receipt.receipt_no).toBe(formatReceiptNo(1));
        expect(await call("app.claim_receipt_pdf($1, now())", [receipt.id])).toBeNull(); // claimed for 5 minutes
        const path = `${f.ownerA}/${receipt.id}/v1.pdf`;
        expect(await call("app.record_receipt_pdf($1, $2, 1, $3, $4, 1234, 'BUILT_IN')", [receipt.id, receipt.pdf_revision, path, "b".repeat(64)])).toEqual({ version: 1, ready: true });
        expect(await one("select pdf_status, pdf_path from public.receipts where id = $1", [receipt.id])).toEqual({ pdf_status: "READY", pdf_path: path });
        expect((await sqlError(db, "select app.record_receipt_pdf($1, 1, 3, 'x', $2, 1, 'BUILT_IN')", [receipt.id, "b".repeat(64)]))?.message).toMatch(/PDF_VERSION_CONFLICT/);
      });
    });
  });

  describe("daily job and RLS", () => {
    it("slip files never sent with a payment are purged after 2 days; recorded slips never", async () => {
      await isolated(db, async () => {
        const orphan = `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`;
        await db.query("insert into storage.objects (bucket_id, name, created_at) values ('payment-slips', $1, now() - interval '3 days')", [orphan]);
        await db.query("update storage.objects set created_at = now() - interval '3 days' where bucket_id = 'payment-slips' and name = $1", [slipPath(f)]);
        const fresh = `${f.ownerA}/${f.custA1}/${randomUUID()}.jpg`;
        await db.query("insert into storage.objects (bucket_id, name) values ('payment-slips', $1)", [fresh]);
        const found = await call<string[]>("app.cron_orphan_slips(now(), 500)");
        expect(found).toContain(orphan);
        expect(found).not.toContain(slipPath(f));
        expect(found).not.toContain(fresh);
      });
    });

    it("slips, allocations, receipts and refunds: own customer and own tenant only", async () => {
      await isolated(db, async () => {
        const { paymentId } = await a2Paid(RS(7_000));
        const creditId = (await one<{ id: string }>("select id from public.credits where source_payment_id = $1", [paymentId])).id;
        await db.query("select app.refund_credit($1, $2, $3::jsonb)", [creditId, f.ownerA, JSON.stringify({ amount_cents: 100, refunded_on: today, method: "CASH" })]);
        const receiptId = (await one<{ id: string }>("select id from public.receipts where payment_id = $1", [paymentId])).id;
        const unrecorded = `${f.ownerA}/${f.custA2}/${randomUUID()}.jpg`;
        await db.query(
          "insert into storage.objects (bucket_id, name) values ('receipts', $1), ('payment-slips', $2), ('payment-slips', $3)",
          [`${f.ownerA}/${receiptId}/v1.pdf`, unrecorded, `${f.ownerA}/${f.custA2}/${randomUUID()}.pdf`],
        );
        const recordedSlip = (await one<{ storage_path: string }>("select storage_path from public.payment_slips s join public.payments p on p.id = s.payment_id where p.id = $1", [paymentId])).storage_path;
        await db.query("insert into storage.objects (bucket_id, name) values ('payment-slips', $1) on conflict do nothing", [recordedSlip]);

        const seen = async () => ({
          payments: await count(db, "select 1 from public.payments where customer_id = $1", [f.custA2]),
          allocations: await count(db, "select 1 from public.payment_allocations where customer_id = $1", [f.custA2]),
          receipts: await count(db, "select 1 from public.receipts where customer_id = $1", [f.custA2]),
          refunds: await count(db, "select 1 from public.credit_refunds where customer_id = $1", [f.custA2]),
          slipRows: await count(db, "select 1 from public.payment_slips where owner_id = $1", [f.ownerA]),
          receiptFiles: await count(db, "select 1 from storage.objects where bucket_id = 'receipts' and name like $1", [`${f.ownerA}/%`]),
          unrecordedSlip: await count(db, "select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1", [unrecorded]),
          recordedSlip: await count(db, "select 1 from storage.objects where bucket_id = 'payment-slips' and name = $1", [recordedSlip]),
        });

        await asUser(db, f.custA2);
        expect(await seen()).toEqual({ payments: 2, allocations: 2, receipts: 1, refunds: 1, slipRows: 2, receiptFiles: 1, unrecordedSlip: 1, recordedSlip: 1 });
        await asPostgres(db);
        await asUser(db, f.custA1); // same owner, other customer
        expect(await seen()).toEqual({ payments: 0, allocations: 0, receipts: 0, refunds: 0, slipRows: 0, receiptFiles: 0, unrecordedSlip: 0, recordedSlip: 0 });
        await asPostgres(db);
        await asUser(db, f.ownerA); // the owner sees recorded slips only, never an unchecked upload
        expect(await seen()).toEqual({ payments: 2, allocations: 2, receipts: 1, refunds: 1, slipRows: 2, receiptFiles: 1, unrecordedSlip: 0, recordedSlip: 1 });
        await asPostgres(db);
        await asUser(db, f.ownerB);
        expect(await seen()).toEqual({ payments: 0, allocations: 0, receipts: 0, refunds: 0, slipRows: 0, receiptFiles: 0, unrecordedSlip: 0, recordedSlip: 0 });
        // Nobody writes them directly.
        expect((await sqlError(db, "insert into public.receipts (owner_id, customer_id, payment_id, receipt_seq, receipt_no, content) values ($1, $2, $3, 99, 'X', '{}')", [f.ownerB, f.custB1, paymentId]))?.code).toBe("42501");
        await asPostgres(db);
        await asUser(db, f.custA2);
        expect((await sqlError(db, "insert into storage.objects (bucket_id, name) values ('receipts', $1)", [`${f.ownerA}/${receiptId}/v9.pdf`]))?.code).toBe("42501");
        expect((await sqlError(db, "update public.payment_allocations set applied_cents = 0 where customer_id = $1", [f.custA2]))?.code).toBe("42501");
        await asPostgres(db);
        // The service role reads what the payment screens read.
        await asService(db);
        for (const table of ["payment_allocations", "credit_refunds", "receipts", "receipt_counters", "receipt_pdf_versions"]) {
          expect((await sqlError(db, `select 1 from public.${table} limit 1`))?.code, table).toBeUndefined();
        }
        await asPostgres(db);
      });
    });
  });
});

describe.skipIf(!DB_URL || APPLY_MIGRATIONS)("receipt numbers under concurrency (committed fixture, cleaned up)", () => {
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

  it("two acceptances at the same time get consecutive numbers, never the same one", async () => {
    const fixture = f!;
    const first = await connect();
    const second = await connect();
    try {
      await first.query("begin");
      await asService(first);
      const a = await first.query("select public.rpc_verify_payment($1, $2, true) as r", [fixture.payments.a2Mono, fixture.ownerA]);

      let settled = false;
      const racing = (async () => {
        await second.query("begin");
        await asService(second);
        try {
          const { rows } = await second.query(
            "select public.rpc_record_manual_payment($1, $2, gen_random_uuid(), $3::uuid[], $4::jsonb) as r",
            [fixture.ownerA, fixture.custA1, [], JSON.stringify({ amount_cents: 100, paid_on: new Date().toISOString().slice(0, 10), method: "CASH" })],
          );
          await second.query("commit");
          return rows[0].r.receipt_no as string;
        } catch (error) {
          await second.query("rollback");
          throw error;
        } finally {
          settled = true;
        }
      })();

      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(settled).toBe(false); // waits for the owner's counter row
      await first.query("commit");
      expect(a.rows[0].r.receipt_no).toBe(formatReceiptNo(1));
      expect(await racing).toBe(formatReceiptNo(2));
    } finally {
      await first.end();
      await second.end();
    }
  });
});
