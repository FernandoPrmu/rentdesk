import { randomUUID } from "node:crypto";

import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCorrectedInvoice, creditOnIssuedInvoice, type StoredCalculation } from "../../src/lib/billing/dispute.ts";
import type { Adjustment, AvailableCredit } from "../../src/lib/billing/invoice.ts";
import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";
import type { TicketStatus } from "../../src/lib/tickets/states.ts";
import * as T from "../../src/lib/tickets/transitions.ts";

import { asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { meterContextFromDb } from "./returns";
import { pgRpc } from "./rpc";

/**
 * Section 11 scenarios added in task 8 (docs/scenarios.md), against the linked dev
 * database, rolled back: disputes raised and answered each way (reject, credit,
 * corrected invoice), the fresh meter photo, correction after confirmation (also
 * from a closed ticket, money paid kept as credit), meter baselines with the copies
 * of the replaced meter carried, ticket comments (RLS, 5-minute edits, audit),
 * resending an invoice, admin alerts and the storage rules. Payloads come from the
 * billing engine and the transition functions, as on the server.
 *
 * Fixture: B1 mono Rs. 6,500 awaiting payment (owner B); A2 mono with a slip
 * waiting; A1 colour reading pending review; A1 mono waiting for a reading.
 */

const RS = (rupees: number) => rupees * 100;
const NOW = new Date();

describe.skipIf(!DB_URL)("section 11 scenarios (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  let today: string;
  let rpc: T.Rpc;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
    today = (await db.query("select app.colombo_date(now())::text as d")).rows[0].d;
    rpc = pgRpc(db);
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as R;
  const customerOf = (role: "OWNER" | "CUSTOMER", id: string): T.Actor => ({ kind: "USER", id, role });
  const later = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  async function snapshot(ticketId: string): Promise<T.TicketSnapshot & { current_invoice_id: string; agreement_id: string }> {
    return one(
      `select id, owner_id, customer_id, cycle_no, status, status_before_overdue, current_invoice_id, agreement_id, 'Ricoh MP' as machine_name
       from public.billing_cycle_tickets where id = $1`,
      [ticketId],
    );
  }
  const statusOf = async (ticketId: string) => (await snapshot(ticketId)).status as TicketStatus;
  const invoiceOf = (id: string) =>
    one<{ status: string; invoice_no: string | null; total: number; paid: number; credit: number; due_date: string; revision: number; replaces: string | null; pdf_status: string; pdf_reason: string | null }>(
      `select status, invoice_no, total_cents::int as total, amount_paid_cents::int as paid, credit_applied_cents::int as credit,
              due_date::text, revision, replaces_invoice_id as replaces, pdf_status, pdf_pending_reason as pdf_reason
       from public.invoices where id = $1`,
      [id],
    );
  const disputeOf = (ticketId: string) =>
    one<{ id: string; status: string; kind: string | null; credit_id: string | null; replacement: string | null; new_due_date: string | null }>(
      `select id, status, resolution_kind as kind, credit_id, replacement_invoice_id as replacement, new_due_date::text
       from public.disputes where ticket_id = $1 order by created_at desc limit 1`,
      [ticketId],
    );
  const notified = (userId: string, event: string) => count(db, "select 1 from public.notifications where user_id = $1 and event = $2", [userId, event]);
  const audited = (action: string, entityId: string) => count(db, "select 1 from public.audit_logs where action = $1 and entity_id = $2", [action, entityId]);

  const raise = (ticketId: string, o: { key?: string; attachment?: Parameters<typeof T.raiseDispute>[3]["attachment"] } = {}) =>
    snapshot(ticketId).then((t) =>
      T.raiseDispute(rpc, customerOf("CUSTOMER", t.customer_id), t, { idempotencyKey: o.key ?? randomUUID(), reason: "I did not print that many copies", attachment: o.attachment ?? null }),
    );

  /** Credits as the server loads them for a correction: the old invoice's own credit lines freed. */
  async function creditsFreedFrom(invoiceId: string, customerId: string): Promise<AvailableCredit[]> {
    const { rows } = await db.query<{ id: string; left: string }>(
      `select c.id, (c.amount_cents - c.refunded_cents - app.credit_used(c.id, $2))::text as left
       from public.credits c where c.customer_id = $1 and c.status in ('AVAILABLE', 'APPLIED') order by c.created_at, c.id`,
      [customerId, invoiceId],
    );
    return rows.map((r) => ({ id: r.id, amountCents: Number(r.left) })).filter((c) => c.amountCents > 0);
  }

  /** The owner's correction, built by the engine (buildCorrectedInvoice) and sent through correctInvoice. */
  async function correct(ticketId: string, o: { readings?: Partial<Record<"BW" | "COLOUR", number>> | null; adjustments?: Adjustment[]; reason?: string } = {}) {
    const t = await snapshot(ticketId);
    const inv = await one<{ id: string; invoice_no: string; type: "NORMAL" | "ESTIMATED"; total: number; paid: number; calculation: StoredCalculation }>(
      "select id, invoice_no, type, total_cents::int as total, amount_paid_cents::int as paid, calculation from public.invoices where id = $1",
      [t.current_invoice_id],
    );
    const paidCreditId = inv.paid > 0 ? randomUUID() : null;
    const built = buildCorrectedInvoice(
      { invoiceNo: inv.invoice_no, type: inv.type, totalCents: inv.total, amountPaidCents: inv.paid, calculation: inv.calculation },
      { readings: o.readings ?? null, adjustments: o.adjustments ?? [], credits: await creditsFreedFrom(inv.id, t.customer_id), paidCreditId },
    );
    const result = await T.correctInvoice(rpc, customerOf("OWNER", t.owner_id), t, {
      invoiceId: inv.id,
      reason: o.reason ?? "Reading confirmed by mistake",
      readings: built.readings,
      invoice: built.invoice,
      paidCreditId,
      dueDate: later(7),
      stageDueAt: new Date(`${later(8)}T00:00:00+05:30`),
    });
    return { ...result, built, oldInvoiceId: inv.id };
  }

  // ---------------------------------------------------------------------------
  // Disputes (11.4, CP-06; rules 47-49)
  // ---------------------------------------------------------------------------

  it("11.4 the customer disputes a bill with a file: Disputed, reminders pause, owner told, audited; retries are idempotent; once per bill", async () => {
    await isolated(db, async () => {
      const key = randomUUID();
      const attachment = { storagePath: `${f.ownerB}/${f.custB1}/${randomUUID()}.pdf`, sha256: "b".repeat(64), mimeType: "application/pdf" as const, sizeBytes: 2048 };
      const r = await raise(f.tickets.b1Mono, { key, attachment });
      expect(r.replayed).toBe(false);
      expect(await statusOf(f.tickets.b1Mono)).toBe("DISPUTED");
      expect((await invoiceOf(f.invoices.b1Mono)).status).toBe("DISPUTED");
      expect(await one("select attachment_path, attachment_mime, status from public.disputes where id = $1", [r.dispute_id])).toEqual({
        attachment_path: attachment.storagePath,
        attachment_mime: "application/pdf",
        status: "OPEN",
      });
      expect(await notified(f.ownerB, "dispute.raised")).toBe(1);
      expect(await audited("DISPUTE_RAISED", r.dispute_id)).toBe(1);
      // A retried request (double tap) returns the first dispute.
      const t = await snapshot(f.tickets.b1Mono);
      await expect(
        rpc("rpc_raise_dispute", { p_ticket_id: t.id, p_actor_id: f.custB1, p_idempotency_key: key, p_reason: "again", p_attachment: null }),
      ).resolves.toMatchObject({ dispute_id: r.dispute_id, replayed: true });

      // Rejected: the invoice stands; the same bill cannot be disputed a second time (rule 47).
      await T.rejectDispute(rpc, customerOf("OWNER", f.ownerB), await snapshot(f.tickets.b1Mono), { reason: "Checked against the meter photo", stageDueAt: NOW });
      await expect(raise(f.tickets.b1Mono)).rejects.toThrow(/ALREADY_DISPUTED/);
    });
  });

  it("11.4 a dispute is refused for a slip waiting, a draft, another customer, a bad file or no reason", async () => {
    await isolated(db, async () => {
      const a2 = await snapshot(f.tickets.a2Mono);
      expect(a2.status).toBe("PAYMENT_SUBMITTED");
      await expect(
        rpc("rpc_raise_dispute", { p_ticket_id: a2.id, p_actor_id: f.custA2, p_idempotency_key: randomUUID(), p_reason: "x", p_attachment: null }),
      ).rejects.toMatchObject({ code: "RD409" });
      await expect(
        rpc("rpc_raise_dispute", { p_ticket_id: f.tickets.b1Mono, p_actor_id: f.custA1, p_idempotency_key: randomUUID(), p_reason: "x", p_attachment: null }),
      ).rejects.toMatchObject({ code: "RD403" });
      await expect(
        rpc("rpc_raise_dispute", { p_ticket_id: f.tickets.b1Mono, p_actor_id: f.custB1, p_idempotency_key: randomUUID(), p_reason: "  ", p_attachment: null }),
      ).rejects.toMatchObject({ code: "RD400" });
      const otherFolder = { storage_path: `${f.ownerA}/${f.custA1}/${randomUUID()}.pdf`, sha256: "c".repeat(64), mime_type: "application/pdf", size_bytes: 10 };
      await expect(
        rpc("rpc_raise_dispute", { p_ticket_id: f.tickets.b1Mono, p_actor_id: f.custB1, p_idempotency_key: randomUUID(), p_reason: "x", p_attachment: otherFolder }),
      ).rejects.toThrow(/file is not valid/);
      expect(await statusOf(f.tickets.b1Mono)).toBe("AWAITING_PAYMENT");
    });
  });

  it("reject the dispute with a new due date: Awaiting payment, new due date and PDF version, customer told, audited", async () => {
    await isolated(db, async () => {
      await raise(f.tickets.b1Mono);
      await expect(
        T.rejectDispute(rpc, customerOf("OWNER", f.ownerA), await snapshot(f.tickets.b1Mono), { reason: "x", stageDueAt: NOW }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        rpc("rpc_reject_dispute", { p_ticket_id: f.tickets.b1Mono, p_actor_id: f.ownerB, p_reason: "x", p_due_date: later(-1), p_stage_due_at: NOW.toISOString() }),
      ).rejects.toThrow(/past/);
      await T.rejectDispute(rpc, customerOf("OWNER", f.ownerB), await snapshot(f.tickets.b1Mono), { reason: "The reading matches the photo", dueDate: later(10), stageDueAt: NOW });
      expect(await statusOf(f.tickets.b1Mono)).toBe("AWAITING_PAYMENT");
      expect(await invoiceOf(f.invoices.b1Mono)).toMatchObject({ status: "AWAITING_PAYMENT", due_date: later(10), total: RS(6500), pdf_status: "PENDING" });
      const d = await disputeOf(f.tickets.b1Mono);
      expect(d).toMatchObject({ status: "REJECTED", kind: "REJECTED", new_due_date: later(10) });
      expect(await notified(f.custB1, "dispute.rejected")).toBe(1);
      expect(await audited("DISPUTE_REJECTED", d.id)).toBe(1);
      expect(
        await count(db, "select 1 from public.ticket_events where ticket_id = $1 and from_status = 'DISPUTED' and to_status = 'AWAITING_PAYMENT' and reason = 'The reading matches the photo'", [
          f.tickets.b1Mono,
        ]),
      ).toBe(1);
    });
  });

  it("give a credit: the engine's credit line is taken off the bill (new PDF version); the rest stays a credit; a covered bill closes", async () => {
    await isolated(db, async () => {
      await raise(f.tickets.b1Mono);
      const t = await snapshot(f.tickets.b1Mono);
      const bill = { totalCents: RS(6500), amountPaidCents: 0, creditAppliedCents: 0 };
      const creditId = randomUUID();
      const c = creditOnIssuedInvoice(bill, creditId, RS(1500));
      // A line that does not match the credit is refused.
      await expect(
        T.creditDispute(rpc, customerOf("OWNER", f.ownerB), t, { reason: "Paper jam copies", creditId, amountCents: RS(1500), line: { ...c.line, amount_cents: -1, rate_cents: -1 }, totalCents: c.totalCents, leftOverCents: 0, stageDueAt: NOW }),
      ).rejects.toThrow(/does not match/);
      await T.creditDispute(rpc, customerOf("OWNER", f.ownerB), t, { reason: "Paper jam copies", creditId, amountCents: RS(1500), line: c.line, totalCents: c.totalCents, leftOverCents: c.leftOverCents, stageDueAt: NOW });
      expect(await statusOf(f.tickets.b1Mono)).toBe("AWAITING_PAYMENT");
      expect(await invoiceOf(f.invoices.b1Mono)).toMatchObject({ status: "AWAITING_PAYMENT", total: RS(5000), credit: RS(1500), pdf_status: "PENDING" });
      expect(await one("select kind, status, amount_cents::int as amount from public.credits where id = $1", [creditId])).toEqual({ kind: "DISPUTE", status: "APPLIED", amount: RS(1500) });
      expect(await disputeOf(f.tickets.b1Mono)).toMatchObject({ status: "RESOLVED", kind: "CREDIT", credit_id: creditId });
      expect(await notified(f.custB1, "dispute.credit")).toBe(1);
    });

    await isolated(db, async () => {
      await raise(f.tickets.b1Mono);
      const creditId = randomUUID();
      const c = creditOnIssuedInvoice({ totalCents: RS(6500), amountPaidCents: 0, creditAppliedCents: 0 }, creditId, RS(8000));
      expect(c).toMatchObject({ appliedCents: RS(6500), leftOverCents: RS(1500), settled: true });
      await T.creditDispute(rpc, customerOf("OWNER", f.ownerB), await snapshot(f.tickets.b1Mono), {
        reason: "Machine was broken most of the month",
        creditId,
        amountCents: RS(8000),
        line: c.line,
        totalCents: c.totalCents,
        leftOverCents: c.leftOverCents,
        stageDueAt: NOW,
      });
      // Covered: the ticket closes along the payment edges; the rest is a credit for the next bill.
      expect(await statusOf(f.tickets.b1Mono)).toBe("CLOSED");
      expect(await invoiceOf(f.invoices.b1Mono)).toMatchObject({ status: "PAID", total: 0 });
      const { rows: path } = await db.query("select from_status, to_status from public.ticket_events where ticket_id = $1 and event_type = 'STATUS_CHANGE' order by created_at, id", [f.tickets.b1Mono]);
      expect(path.slice(-3).map((e) => `${e.from_status}>${e.to_status}`)).toEqual(["DISPUTED>AWAITING_PAYMENT", "AWAITING_PAYMENT>PAYMENT_SUBMITTED", "PAYMENT_SUBMITTED>CLOSED"]);
      const credits = (await one<{ c: { id: string; available_cents: number }[] }>("select app.available_credits($1) as c", [f.custB1])).c;
      expect(credits).toEqual([{ id: creditId, available_cents: RS(1500) }]);
    });
  });

  it("correct the invoice from a dispute: cancelled and reissued with a new number (revision 2), corrected reading on record, dispute resolved", async () => {
    await isolated(db, async () => {
      await raise(f.tickets.b1Mono);
      const old = await invoiceOf(f.invoices.b1Mono);
      // MONO case 2 issued at 7,600 from 5,000 (2,600 copies); the meter showed 7,300.
      const r = await correct(f.tickets.b1Mono, { readings: { BW: 7300 }, reason: "Customer was right: the meter shows 7,300" });
      expect(r.built.summary).toMatchObject({ oldTotalCents: RS(6500), newTotalCents: RS(5750), changes: [{ counter: "BW", from: 7600, to: 7300 }] });

      // A new PDF version is due (with the CANCELLED stamp once the first version exists, decision 34).
      expect(await invoiceOf(r.oldInvoiceId)).toMatchObject({ status: "CANCELLED", invoice_no: old.invoice_no, pdf_status: "PENDING" });
      const fresh = await invoiceOf(r.invoice_id);
      expect(fresh).toMatchObject({ status: "AWAITING_PAYMENT", total: RS(5750), revision: 2, replaces: r.oldInvoiceId, due_date: later(7), pdf_status: "PENDING", pdf_reason: "ISSUED" });
      expect(fresh.invoice_no).not.toBe(old.invoice_no);
      const t = await snapshot(f.tickets.b1Mono);
      expect(t).toMatchObject({ status: "AWAITING_PAYMENT", current_invoice_id: r.invoice_id });
      expect(await disputeOf(f.tickets.b1Mono)).toMatchObject({ status: "RESOLVED", kind: "CORRECTED", replacement: r.invoice_id });

      // The old reading is kept (superseded); the corrected one is the confirmed reading the next bill starts from.
      const subs = await db.query(
        `select s.status, s.source, r.current_value::int as current, r.corrected_from_value::int as was
         from public.meter_submissions s join public.meter_readings r on r.submission_id = s.id where s.ticket_id = $1 order by s.attempt_no`,
        [f.tickets.b1Mono],
      );
      expect(subs.rows).toEqual([
        { status: "SUPERSEDED", source: "CUSTOMER", current: 7600, was: null },
        { status: "CONFIRMED", source: "OWNER_MANUAL", current: 7300, was: 7600 },
      ]);
      expect((await one<{ v: string }>("select app.last_known_reading($1, 'BW')::text as v", [t.agreement_id])).v).toBe("7300");
      expect(await count(db, "select 1 from public.ticket_events where ticket_id = $1 and event_type = 'CORRECTION'", [f.tickets.b1Mono])).toBe(1);
      expect(await notified(f.custB1, "invoice.corrected")).toBe(1);
      expect(await audited("INVOICE_CORRECTED", r.invoice_id)).toBe(1);
    });
  });

  it("the fresh meter photo: asked for, sent with the live reading (meter photo of the dispute), deleted when the dispute ends", async () => {
    await isolated(db, async () => {
      await raise(f.tickets.b1Mono);
      const owner = customerOf("OWNER", f.ownerB);
      const cust = customerOf("CUSTOMER", f.custB1);
      const path = `${f.ownerB}/${f.tickets.b1Mono}/${randomUUID()}.jpg`;
      // Not asked for yet: refused.
      await expect(T.sendDisputePhoto(rpc, cust, await snapshot(f.tickets.b1Mono), { storagePath: path, readings: [{ counter_type: "BW", value: 7700 }] })).rejects.toThrow(/No fresh meter photo/);
      // The customer may upload into meter-photos only while the request is open.
      await asUser(db, f.custB1);
      expect((await sqlError(db, "insert into storage.objects (bucket_id, name) values ('meter-photos', $1)", [path]))?.code).toBe("42501");
      await asPostgres(db);

      await T.requestDisputePhoto(rpc, owner, await snapshot(f.tickets.b1Mono), { note: "Please show the counter screen" });
      expect(await notified(f.custB1, "dispute.photo_requested")).toBe(1);
      await expect(T.requestDisputePhoto(rpc, owner, await snapshot(f.tickets.b1Mono), {})).rejects.toThrow(/already asked/);
      await asUser(db, f.custB1);
      expect(await sqlError(db, "insert into storage.objects (bucket_id, name) values ('meter-photos', $1)", [path])).toBeNull();
      await asPostgres(db);

      await expect(T.sendDisputePhoto(rpc, cust, await snapshot(f.tickets.b1Mono), { storagePath: path, readings: [{ counter_type: "COLOUR", value: 1 }] })).rejects.toThrow(/reading/);
      const sent = await T.sendDisputePhoto(rpc, cust, await snapshot(f.tickets.b1Mono), { storagePath: path, readings: [{ counter_type: "BW", value: 7700 }] });
      expect(sent.replayed).toBe(false);
      expect((await T.sendDisputePhoto(rpc, cust, await snapshot(f.tickets.b1Mono), { storagePath: path, readings: [{ counter_type: "BW", value: 7700 }] })).replayed).toBe(true);
      expect(await notified(f.ownerB, "dispute.photo_received")).toBe(1);
      expect(await one("select photo_readings, photo_received_at is not null as received from public.disputes where ticket_id = $1", [f.tickets.b1Mono])).toEqual({
        photo_readings: [{ counter_type: "BW", value: 7700 }],
        received: true,
      });
      // Only the owner (and admin) see the photo row; it is not a meter submission.
      expect(await one("select submission_id, delete_requested_at is null as kept from public.meter_photos where storage_path = $1", [path])).toEqual({ submission_id: null, kept: true });

      await T.rejectDispute(rpc, owner, await snapshot(f.tickets.b1Mono), { reason: "The photo shows the billed reading", stageDueAt: NOW });
      expect(await one("select delete_requested_at is not null as marked from public.meter_photos where storage_path = $1", [path])).toEqual({ marked: true });
      // The daily job removes it with the other meter photos.
      const due = (await one<{ r: { storage_path: string }[] }>("select app.cron_expired_photos(now(), 500) as r")).r;
      expect(due.map((p) => p.storage_path)).toContain(path);
    });
  });

  it("cancelling a disputed ticket ends the dispute as Cancelled", async () => {
    await isolated(db, async () => {
      await raise(f.tickets.b1Mono);
      await T.cancelTicket(rpc, customerOf("OWNER", f.ownerB), await snapshot(f.tickets.b1Mono), { reason: "Billed to the wrong customer" });
      expect(await disputeOf(f.tickets.b1Mono)).toMatchObject({ status: "RESOLVED", kind: "CANCELLED" });
    });
  });

  // ---------------------------------------------------------------------------
  // Correction after confirmation (11.1, 11.3, 11.4; rule 49)
  // ---------------------------------------------------------------------------

  it("wrong reading confirmed and already paid: reopen first, then the corrected invoice; the money paid becomes credit and the surplus stays available", async () => {
    await isolated(db, async () => {
      const owner = customerOf("OWNER", f.ownerB);
      await T.recordPayment(rpc, owner, [await snapshot(f.tickets.b1Mono)], {
        customerId: f.custB1,
        idempotencyKey: randomUUID(),
        invoiceIds: [f.invoices.b1Mono],
        payment: { amountCents: RS(6500), paidOn: today, method: "CASH" },
      });
      expect(await statusOf(f.tickets.b1Mono)).toBe("CLOSED");
      await expect(correct(f.tickets.b1Mono, { readings: { BW: 6000 } })).rejects.toBeInstanceOf(T.TransitionError);
      await expect(
        rpc("rpc_correct_issued_invoice", {
          p_ticket_id: f.tickets.b1Mono, p_actor_id: f.ownerB, p_invoice_id: f.invoices.b1Mono, p_reason: "x", p_readings: null,
          p_invoice: {}, p_paid_credit_id: null, p_due_date: later(7), p_stage_due_at: NOW.toISOString(),
        }),
      ).rejects.toThrow(/REOPEN_FIRST/);

      await T.reopenTicket(rpc, owner, await snapshot(f.tickets.b1Mono), { reason: "Reading 7,600 was typed wrong; meter shows 6,000" });
      // 1,000 copies: within 2,000 included = Rs. 5,000; Rs. 6,500 was paid -> Rs. 1,500 credit left over.
      const r = await correct(f.tickets.b1Mono, { readings: { BW: 6000 } });
      expect(r.built.summary).toMatchObject({ paidCents: RS(6500), newTotalCents: 0 });
      expect(await invoiceOf(r.oldInvoiceId)).toMatchObject({ status: "CANCELLED", paid: RS(6500) });
      expect(await invoiceOf(r.invoice_id)).toMatchObject({ status: "PAID", total: 0, credit: RS(5000), revision: 2 });
      expect(await statusOf(f.tickets.b1Mono)).toBe("CLOSED");
      const credit = await one<{ kind: string; amount: number; status: string; source: string }>(
        "select kind, amount_cents::int as amount, status, source_invoice_id as source from public.credits where customer_id = $1",
        [f.custB1],
      );
      expect(credit).toEqual({ kind: "CANCELLED_INVOICE", amount: RS(6500), status: "AVAILABLE", source: r.oldInvoiceId });
      expect((await one<{ c: { available_cents: number }[] }>("select app.available_credits($1) as c", [f.custB1])).c).toEqual([
        expect.objectContaining({ available_cents: RS(1500) }),
      ]);
      const { rows: path } = await db.query("select event_type, from_status, to_status from public.ticket_events where ticket_id = $1 order by created_at, id", [f.tickets.b1Mono]);
      expect(path.slice(-5).map((e) => `${e.event_type}:${e.from_status}>${e.to_status}`)).toEqual([
        "STATUS_CHANGE:CLOSED>REOPENED",
        "CORRECTION:REOPENED>REOPENED",
        "STATUS_CHANGE:REOPENED>AWAITING_PAYMENT",
        "STATUS_CHANGE:AWAITING_PAYMENT>PAYMENT_SUBMITTED",
        "STATUS_CHANGE:PAYMENT_SUBMITTED>CLOSED",
      ]);
    });
  });

  it("an adjustment line corrects a calculation or rate error; a part payment stays as credit on the corrected bill", async () => {
    await isolated(db, async () => {
      const owner = customerOf("OWNER", f.ownerB);
      await T.recordPayment(rpc, owner, [await snapshot(f.tickets.b1Mono)], {
        customerId: f.custB1,
        idempotencyKey: randomUUID(),
        invoiceIds: [f.invoices.b1Mono],
        payment: { amountCents: RS(2000), paidOn: today, method: "CASH" },
      });
      expect(await statusOf(f.tickets.b1Mono)).toBe("PARTIALLY_PAID");
      const r = await correct(f.tickets.b1Mono, { adjustments: [{ description: "Wrong excess rate (Rs. 2.50 instead of Rs. 2)", amountCents: -RS(300) }], reason: "Rate error" });
      expect(await invoiceOf(r.invoice_id)).toMatchObject({ status: "AWAITING_PAYMENT", total: RS(4200), credit: RS(2000) });
      expect(await statusOf(f.tickets.b1Mono)).toBe("AWAITING_PAYMENT");
      // The reading itself did not change.
      expect(await count(db, "select 1 from public.meter_submissions where ticket_id = $1 and status = 'SUPERSEDED'", [f.tickets.b1Mono])).toBe(0);
      expect(await count(db, "select 1 from public.invoice_lines where invoice_id = $1 and line_type = 'ADJUSTMENT' and amount_cents = $2", [r.invoice_id, -RS(300)])).toBe(1);
    });
  });

  it("a correction is refused while a slip waits, for another owner, and for a stale or tampered calculation", async () => {
    await isolated(db, async () => {
      // A2: slip waiting (spec 8.2: check it first).
      const a2 = await one<{ id: string }>("select current_invoice_id as id from public.billing_cycle_tickets where id = $1", [f.tickets.a2Mono]);
      await expect(
        rpc("rpc_correct_issued_invoice", {
          p_ticket_id: f.tickets.a2Mono, p_actor_id: f.ownerA, p_invoice_id: a2.id, p_reason: "x", p_readings: null,
          p_invoice: {}, p_paid_credit_id: null, p_due_date: later(7), p_stage_due_at: NOW.toISOString(),
        }),
      ).rejects.toThrow(/SLIP_WAITING/);
      // Another owner.
      await expect(
        rpc("rpc_correct_issued_invoice", {
          p_ticket_id: f.tickets.b1Mono, p_actor_id: f.ownerA, p_invoice_id: f.invoices.b1Mono, p_reason: "x", p_readings: null,
          p_invoice: {}, p_paid_credit_id: null, p_due_date: later(7), p_stage_due_at: NOW.toISOString(),
        }),
      ).rejects.toMatchObject({ code: "RD403" });

      // A tampered total, or other terms than the original.
      const t = await snapshot(f.tickets.b1Mono);
      const inv = await one<{ calculation: StoredCalculation }>("select calculation from public.invoices where id = $1", [f.invoices.b1Mono]);
      const built = buildCorrectedInvoice(
        { invoiceNo: "x", type: "NORMAL", totalCents: RS(6500), amountPaidCents: 0, calculation: inv.calculation },
        { readings: { BW: 7300 }, adjustments: [], credits: [], paidCreditId: null },
      );
      const send = (invoice: unknown, readings: unknown = built.readings) =>
        rpc("rpc_correct_issued_invoice", {
          p_ticket_id: t.id, p_actor_id: f.ownerB, p_invoice_id: f.invoices.b1Mono, p_reason: "x", p_readings: readings,
          p_invoice: invoice, p_paid_credit_id: null, p_due_date: later(7), p_stage_due_at: NOW.toISOString(),
        });
      await expect(send({ ...built.invoice, total_cents: 1 })).rejects.toMatchObject({ code: "RD400" });
      const otherTerms = { ...built.invoice, calculation: { ...built.invoice.calculation, terms: { ...(built.invoice.calculation as { terms: object }).terms, bw_rate_cents: 1 } } };
      await expect(send(otherTerms)).rejects.toThrow(/keeps the terms/);
      await expect(send(built.invoice, [{ counter_type: "BW", previous_value: 1, current_value: 7300, rolled_over: false }])).rejects.toThrow(/corrected readings/);
      await expect(send(built.invoice)).resolves.toMatchObject({ status: "AWAITING_PAYMENT" });
    });
  });

  it("a reading can no longer change once a later cycle has a reading (adjustment lines still can)", async () => {
    await isolated(db, async () => {
      // Cycle 2 of B1's agreement opens and its reading arrives.
      const agreement = (await snapshot(f.tickets.b1Mono)).agreement_id;
      const opened = await one<{ r: { ticket_id: string } }>("select app.open_billing_cycle($1, 2, now() + interval '5 days') as r", [agreement]);
      const ctx = await meterContextFromDb(db, opened.r.ticket_id);
      const s = buildMeterSubmission(ctx, { BW: 8000 });
      await db.query(
        `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now() + interval '2 days', null, $6)`,
        [opened.r.ticket_id, f.custB1, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${f.ownerB}/${opened.r.ticket_id}/p.jpg` }), JSON.stringify(s.invoice), s.anomalyFlag],
      );
      await expect(correct(f.tickets.b1Mono, { readings: { BW: 7300 } })).rejects.toThrow(/LATER_READING/);
      await expect(correct(f.tickets.b1Mono, { adjustments: [{ description: "Goodwill", amountCents: -RS(500) }] })).resolves.toMatchObject({ status: "AWAITING_PAYMENT" });
    });
  });

  it("an estimated invoice is corrected with an adjustment line (11.6)", async () => {
    await isolated(db, async () => {
      // A1 mono: no reading by the deadline; the owner bills estimates and confirms the estimate.
      await db.query("insert into public.owner_settings (owner_id, estimated_billing_enabled) values ($1, true) on conflict (owner_id) do update set estimated_billing_enabled = true", [f.ownerA]);
      await db.query("update public.billing_cycle_tickets set status = 'OVERDUE', status_before_overdue = 'METER_REQUESTED' where id = $1", [f.tickets.a1Mono]);
      const est = buildCorrectedInvoice; // engine import keeps the estimate path honest below
      expect(est).toBeTypeOf("function");
      const { calculateInvoice } = await import("../../src/lib/billing/invoice.ts");
      const r = calculateInvoice({
        terms: { machineType: "MONO", commitmentCents: RS(5000), bwIncluded: 2000, bwRateCents: 250, colourIncluded: null, colourRateCents: null },
        kind: "ESTIMATED",
        fullCycles: 1,
      });
      await db.query("select app.create_estimated_invoice($1, $2::jsonb, now() + interval '2 days', now())", [
        f.tickets.a1Mono,
        JSON.stringify({ type: "ESTIMATED", cycles_covered: 1, subtotal_cents: r.subtotalCents, credit_applied_cents: 0, total_cents: r.totalCents, lines: r.lines, calculation: r.calculation }),
      ]);
      await db.query("select app.confirm_meter_submission($1, null, $2, current_date + 7, now() + interval '8 days')", [f.tickets.a1Mono, f.ownerA]);
      expect(await statusOf(f.tickets.a1Mono)).toBe("AWAITING_PAYMENT");
      await expect(correct(f.tickets.a1Mono, { readings: { BW: 6000 } })).rejects.toThrow(/adjustment line/);
      const c = await correct(f.tickets.a1Mono, { adjustments: [{ description: "Machine installed mid-month", amountCents: -RS(2500) }] });
      expect(await one("select type, total_cents::int as total from public.invoices where id = $1", [c.invoice_id])).toEqual({ type: "ESTIMATED", total: RS(2500) });
    });
  });

  // ---------------------------------------------------------------------------
  // Meter baselines (11.2, 11.8; rule 51)
  // ---------------------------------------------------------------------------

  const baseline = (agreementId: string, counters: unknown, reason = "Meter board replaced by the technician") =>
    rpc("rpc_record_meter_baseline", {
      p_agreement_id: agreementId,
      p_actor_id: f.ownerA,
      p_reason: reason,
      p_counters: counters,
      p_notifications: [{ user_id: f.custA1, event: "meter.baseline", title: "New meter" }],
    });

  it("meter replaced: the owner records a new baseline with the old meter's last reading; the next bill starts from it and carries the old copies", async () => {
    await isolated(db, async () => {
      // A1 mono: initial reading 5,000; the old meter reached 6,200 before it was replaced; the new one starts at 0.
      const r = (await baseline(f.agrA1Mono, [{ counter_type: "BW", value: 0, old_meter_reading: 6200 }])) as { ticket_id: string; counters: unknown[] };
      expect(r.ticket_id).toBe(f.tickets.a1Mono);
      expect(await one("select value::int, previous_value::int as previous, old_meter_reading::int as old, carried_copies::int as carried from public.meter_baselines where agreement_id = $1", [f.agrA1Mono])).toEqual({
        value: 0,
        previous: 5000,
        old: 6200,
        carried: 1200,
      });
      expect((await one<{ v: string }>("select app.last_known_reading($1, 'BW')::text as v", [f.agrA1Mono])).v).toBe("0");
      expect((await one<{ v: string }>("select app.carried_copies($1, 'BW')::text as v", [f.agrA1Mono])).v).toBe("1200");
      expect(await count(db, "select 1 from public.ticket_events where ticket_id = $1 and event_type = 'BASELINE'", [f.tickets.a1Mono])).toBe(1);
      expect(await audited("METER_BASELINE_RECORDED", f.agrA1Mono)).toBe(1);
      expect(await notified(f.custA1, "meter.baseline")).toBe(1);

      // The customer reads 1,400 on the new meter: 1,400 + 1,200 = 2,600 copies -> Rs. 6,500 (spec 6.3 mono case 2).
      const ctx = await meterContextFromDb(db, f.tickets.a1Mono);
      expect(ctx.counters.BW!.known).toMatchObject([{ value: 0 }, { value: 0, source: "BASELINE", carried: 1200 }]);
      const s = buildMeterSubmission(ctx, { BW: 1400 });
      expect(s.invoice.total_cents).toBe(RS(6500));
      const send = (invoice: unknown) =>
        db.query(
          `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now() + interval '2 days', null, $6) as r`,
          [f.tickets.a1Mono, f.custA1, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${f.ownerA}/${f.tickets.a1Mono}/p.jpg` }), JSON.stringify(invoice), s.anomalyFlag],
        );
      // Without the carried copies the database refuses the calculation.
      const counters = (s.invoice.calculation.counters as Record<string, unknown>[]).map((c) => ({ ...c, carried_copies: 0 }));
      const tampered = { ...s.invoice, calculation: { ...s.invoice.calculation, counters } };
      expect((await sqlError(db, "select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb, now() + interval '2 days', null, $6)", [
        f.tickets.a1Mono, f.custA1, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${f.ownerA}/${f.tickets.a1Mono}/p.jpg` }), JSON.stringify(tampered), s.anomalyFlag,
      ]))?.message).toMatch(/replaced meter/);
      const { rows } = await send(s.invoice);
      expect(await one("select total_cents::int as total, status from public.invoices where id = $1", [rows[0].r.invoice_id])).toEqual({ total: RS(6500), status: "DRAFT" });
    });
  });

  it("meter reset without the old reading: usage continues from the new baseline (11.2 reading lower than before)", async () => {
    await isolated(db, async () => {
      // Before: a reading of 100 is lower than 5,000 and cannot be billed.
      const before = await meterContextFromDb(db, f.tickets.a1Mono);
      expect(() => buildMeterSubmission(before, { BW: 100 })).toThrow(/lower than the previous/);
      await baseline(f.agrA1Mono, [{ counter_type: "BW", value: 0 }], "Counter reset to zero after a repair");
      const ctx = await meterContextFromDb(db, f.tickets.a1Mono);
      expect(buildMeterSubmission(ctx, { BW: 100 }).result.counters[0]).toMatchObject({ previous: 0, usage: 100, carried: 0 });
    });
  });

  it("a baseline is refused while a reading waits for review, for a counter the machine lacks, below the last reading, or by another owner; owners cannot write baselines directly", async () => {
    await isolated(db, async () => {
      await expect(baseline(f.agrA1Colour, [{ counter_type: "BW", value: 0 }])).rejects.toThrow(/REVIEW_PENDING/);
      await expect(baseline(f.agrA1Mono, [{ counter_type: "COLOUR", value: 0 }])).rejects.toThrow(/mono machine/);
      await expect(baseline(f.agrA1Mono, [{ counter_type: "BW", value: 0, old_meter_reading: 4000 }])).rejects.toThrow(/OLD_BELOW_PREVIOUS/);
      await expect(baseline(f.agrA1Mono, [{ counter_type: "BW", value: 0 }], " ")).rejects.toMatchObject({ code: "RD400" });
      await expect(
        rpc("rpc_record_meter_baseline", { p_agreement_id: f.agrA1Mono, p_actor_id: f.ownerB, p_reason: "x", p_counters: [{ counter_type: "BW", value: 0 }] }),
      ).rejects.toMatchObject({ code: "RD403" });
      await asUser(db, f.ownerA);
      expect((await sqlError(db, "insert into public.meter_baselines (owner_id, agreement_id, counter_type, value, reason) values ($1, $2, 'BW', 0, 'x')", [f.ownerA, f.agrA1Mono]))?.code).toBe("42501");
      await asPostgres(db);
    });
  });

  // ---------------------------------------------------------------------------
  // Ticket comments (TKT-11, CP-06; rule 50)
  // ---------------------------------------------------------------------------

  const comment = (ticketId: string, actorId: string, body: string, key = randomUUID(), notifyId?: string) =>
    rpc("rpc_add_ticket_comment", {
      p_ticket_id: ticketId,
      p_actor_id: actorId,
      p_idempotency_key: key,
      p_body: body,
      p_notifications: notifyId ? [{ user_id: notifyId, event: "comment.added", title: "New message", body }] : [],
    }) as Promise<{ comment_id: string; replayed: boolean }>;

  it("TKT-11 the customer and the owner write on the ticket; the other side is told; retries are idempotent", async () => {
    await isolated(db, async () => {
      const key = randomUUID();
      const c1 = await comment(f.tickets.a1Mono, f.custA1, "  My camera does not open, can you enter the reading?  ", key, f.ownerA);
      expect((await comment(f.tickets.a1Mono, f.custA1, "again", key)).replayed).toBe(true);
      const c2 = await comment(f.tickets.a1Mono, f.ownerA, "Yes, I will enter it today.", undefined, f.custA1);
      const { rows } = await db.query("select author_role, body from public.ticket_comments where ticket_id = $1 and idempotency_key is not null order by author_role desc", [f.tickets.a1Mono]);
      expect(rows).toEqual([
        { author_role: "CUSTOMER", body: "My camera does not open, can you enter the reading?" },
        { author_role: "OWNER", body: "Yes, I will enter it today." },
      ]);
      expect(await notified(f.ownerA, "comment.added")).toBe(1);
      expect(await notified(f.custA1, "comment.added")).toBe(1);
      expect(await count(db, "select 1 from public.audit_logs where entity = 'ticket_comments' and entity_id = any($1::uuid[]) and action = 'INSERT'", [[c1.comment_id, c2.comment_id]])).toBe(2);
    });
  });

  it("only the ticket's customer and owner may write; length is checked; at most 30 an hour", async () => {
    await isolated(db, async () => {
      await expect(comment(f.tickets.a1Mono, f.custA2, "Not my ticket")).rejects.toMatchObject({ code: "RD403" });
      await expect(comment(f.tickets.a1Mono, f.ownerB, "Other tenant")).rejects.toMatchObject({ code: "RD403" });
      await expect(comment(f.tickets.a1Mono, f.admin, "Admins read only")).rejects.toMatchObject({ code: "RD403" });
      await expect(comment(f.tickets.a1Mono, f.custA1, "   ")).rejects.toMatchObject({ code: "RD400" });
      await expect(comment(f.tickets.a1Mono, f.custA1, "x".repeat(1001))).rejects.toMatchObject({ code: "RD400" });
      for (let i = 0; i < 30; i++) await comment(f.tickets.a1Mono, f.custA1, `Message ${i}`);
      await expect(comment(f.tickets.a1Mono, f.custA1, "One too many")).rejects.toThrow(/TOO_MANY_COMMENTS/);
    });
  });

  it("the author may change a message for 5 minutes (audited with the old text), never after, never someone else's", async () => {
    await isolated(db, async () => {
      const c = await comment(f.tickets.a1Mono, f.custA1, "Reading is 12,500");
      await expect(rpc("rpc_edit_ticket_comment", { p_comment_id: c.comment_id, p_actor_id: f.ownerA, p_body: "Hacked" })).rejects.toMatchObject({ code: "RD403" });
      await expect(rpc("rpc_edit_ticket_comment", { p_comment_id: c.comment_id, p_actor_id: f.custA1, p_body: "Reading is 12,050" })).resolves.toMatchObject({ changed: true });
      expect(await one("select body, edited_at is not null as edited from public.ticket_comments where id = $1", [c.comment_id])).toEqual({ body: "Reading is 12,050", edited: true });
      const audit = await one<{ details: { changes: { body: [string, string] } } }>(
        "select details from public.audit_logs where entity = 'ticket_comments' and entity_id = $1 and action = 'UPDATE'",
        [c.comment_id],
      );
      expect(audit.details.changes.body).toEqual(["Reading is 12,500", "Reading is 12,050"]);
      await db.query("update public.ticket_comments set created_at = now() - interval '6 minutes' where id = $1", [c.comment_id]);
      await expect(rpc("rpc_edit_ticket_comment", { p_comment_id: c.comment_id, p_actor_id: f.custA1, p_body: "Too late" })).rejects.toThrow(/EDIT_WINDOW_OVER/);
    });
  });

  it("comment RLS: only the ticket's customer and owner, plus admin, can read; nobody writes directly", async () => {
    await isolated(db, async () => {
      await comment(f.tickets.a1Mono, f.custA1, "Visible to A1, owner A and admin");
      const visible = async (userId: string) => {
        await asUser(db, userId);
        const n = await count(db, "select 1 from public.ticket_comments where ticket_id = $1", [f.tickets.a1Mono]);
        await asPostgres(db);
        return n;
      };
      // The fixture's own comment is on A1's colour ticket; this ticket has one.
      expect(await visible(f.custA1)).toBe(1);
      expect(await visible(f.ownerA)).toBe(1);
      expect(await visible(f.admin)).toBe(1);
      expect(await visible(f.custA2)).toBe(0);
      expect(await visible(f.ownerB)).toBe(0);
      expect(await visible(f.custB1)).toBe(0);
      await asUser(db, f.custA1);
      expect((await sqlError(db, "insert into public.ticket_comments (owner_id, ticket_id, author_id, body) values ($1, $2, $3, 'x')", [f.ownerA, f.tickets.a1Mono, f.custA1]))?.code).toBe("42501");
      await asPostgres(db);
    });
  });

  // ---------------------------------------------------------------------------
  // Files, resend, admin alerts
  // ---------------------------------------------------------------------------

  it("dispute files: the customer uploads only to their own folder; the owner reads only files sent with a dispute", async () => {
    await isolated(db, async () => {
      const mine = `${f.ownerB}/${f.custB1}/${randomUUID()}.pdf`;
      await asUser(db, f.custB1);
      expect(await sqlError(db, "insert into storage.objects (bucket_id, name) values ('dispute-files', $1)", [mine])).toBeNull();
      expect((await sqlError(db, "insert into storage.objects (bucket_id, name) values ('dispute-files', $1)", [`${f.ownerA}/${f.custA1}/x.pdf`]))?.code).toBe("42501");
      await asUser(db, f.ownerB);
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'dispute-files' and name = $1", [mine])).toBe(0);
      await asPostgres(db);
      await raise(f.tickets.b1Mono, { attachment: { storagePath: mine, sha256: "d".repeat(64), mimeType: "application/pdf", sizeBytes: 100 } });
      await asUser(db, f.ownerB);
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'dispute-files' and name = $1", [mine])).toBe(1);
      await asUser(db, f.ownerA);
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'dispute-files' and name = $1", [mine])).toBe(0);
      await asPostgres(db);
      // Files never sent are purged after 2 days.
      await db.query("insert into storage.objects (bucket_id, name, created_at) values ('dispute-files', $1, now() - interval '3 days')", [`${f.ownerB}/${f.custB1}/old.pdf`]);
      const orphans = (await one<{ r: string[] }>("select app.cron_orphan_dispute_files(now(), 500) as r")).r;
      expect(orphans).toContain(`${f.ownerB}/${f.custB1}/old.pdf`);
      expect(orphans).not.toContain(mine);
    });
  });

  it("11.4 the owner resends an invoice notification: customer told, ticket event and audit; not twice within 10 minutes", async () => {
    await isolated(db, async () => {
      const send = () => rpc("rpc_resend_invoice_notification", { p_invoice_id: f.invoices.b1Mono, p_actor_id: f.ownerB, p_notifications: [{ user_id: f.custB1, event: "invoice.resent", title: "Your bill" }] });
      await send();
      await expect(send()).rejects.toThrow(/RESENT_RECENTLY/);
      await expect(rpc("rpc_resend_invoice_notification", { p_invoice_id: f.invoices.b1Mono, p_actor_id: f.ownerA })).rejects.toMatchObject({ code: "RD403" });
      await expect(rpc("rpc_resend_invoice_notification", { p_invoice_id: f.invoices.a1Colour, p_actor_id: f.ownerA })).rejects.toThrow(/issued/);
      expect(await notified(f.custB1, "invoice.resent")).toBe(1);
      expect(await audited("INVOICE_NOTIFICATION_RESENT", f.invoices.b1Mono)).toBe(1);
    });
  });

  it("11.7 admin alerts: sent once per key, to admins only; the last finished run is found", async () => {
    await isolated(db, async () => {
      const alert = (key: string, userId = f.admin) => rpc("rpc_notify_admins_once", { p_dedupe_key: key, p_notifications: [{ user_id: userId, event: "cron.missed", title: "Daily job did not run" }] });
      const key = `cron-missed:test-${randomUUID()}`;
      await expect(alert(key)).resolves.toMatchObject({ sent: 1 });
      await expect(alert(key)).resolves.toMatchObject({ skipped: true });
      await expect(alert(`x-${randomUUID()}`, f.ownerA)).rejects.toThrow(/admins only/);
      await db.query(
        `insert into public.cron_runs (job, trigger, run_now, run_date, status, finished_at) values
           ('daily', 'CRON', '2001-01-01T01:00:00+05:30', '2001-01-01', 'SUCCESS', now()),
           ('daily', 'CRON', '2001-01-03T01:00:00+05:30', '2001-01-03', 'FAILED', now())`,
      );
      expect(new Date((await one<{ t: string }>("select app.cron_last_success('daily', '2001-01-04T01:00:00+05:30', null) as t")).t).toISOString()).toBe("2000-12-31T19:30:00.000Z");
    });
  });

  it("an open dispute is escalated to the admin like the other owner stages (level 2, once)", async () => {
    await isolated(db, async () => {
      await raise(f.tickets.b1Mono);
      const esc = () => db.query("select app.escalate_ticket($1, 'DISPUTED', 2::smallint, now(), 'Dispute not answered for 7 days', $2::jsonb) as r", [f.tickets.b1Mono, JSON.stringify([{ user_id: f.admin, event: "dispute.escalated", title: "Dispute" }])]);
      expect((await esc()).rows[0].r).toMatchObject({ level: 2 });
      expect((await esc()).rows[0].r).toMatchObject({ skipped: "STATE" });
      expect(await notified(f.admin, "dispute.escalated")).toBe(1);
      expect(await one("select escalation_level from public.billing_cycle_tickets where id = $1", [f.tickets.b1Mono])).toEqual({ escalation_level: 2 });
    });
  });

  it("the service role can read and run everything the new services use", async () => {
    await isolated(db, async () => {
      await asService(db);
      for (const table of ["disputes", "ticket_comments", "meter_baselines", "meter_photos", "credits", "owner_settings_effective"]) {
        expect(await sqlError(db, `select 1 from public.${table} limit 1`), table).toBeNull();
      }
      expect(await sqlError(db, "select public.rpc_carried_copies($1, 'BW')", [f.agrA1Mono])).toBeNull();
      expect(await one("select dispute_reminder_days, dispute_escalation_days from public.owner_settings_effective where owner_id = $1", [f.ownerA])).toEqual({
        dispute_reminder_days: [3, 5],
        dispute_escalation_days: 7,
      });
      await asPostgres(db);
    });
  });
});
