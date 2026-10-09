import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { Terms } from "../../src/lib/billing/invoice.ts";
import { buildMeterSubmission } from "../../src/lib/billing/meter-invoice.ts";

/**
 * Two-tenant fixture built through the real workflow functions (as `postgres`).
 *
 *   Owner A                                   Owner B
 *     customer A1                               customer B1
 *       colour agreement  PENDING_OWNER_REVIEW    mono agreement  AWAITING_PAYMENT
 *       mono agreement    METER_REQUESTED
 *     customer A2
 *       mono agreement    PAYMENT_SUBMITTED
 *     spare machine (AVAILABLE)
 *
 * All ids are random so the fixture never collides with seed data.
 */
export function newFixtureIds() {
  const tag = randomUUID().slice(0, 8);
  const id = () => randomUUID();
  return {
    tag,
    admin: id(),
    ownerA: id(),
    ownerB: id(),
    custA1: id(),
    custA2: id(),
    custB1: id(),
    machineAColour: id(),
    machineAMono1: id(),
    machineAMono2: id(),
    machineASpare: id(),
    machineBMono: id(),
    agrA1Colour: id(),
    agrA1Mono: id(),
    agrA2Mono: id(),
    agrB1Mono: id(),
    keyA1Colour: id(),
    keyA2Mono: id(),
    keyB1Mono: id(),
    keyA2Payment: id(),
  };
}

export type FixtureIds = ReturnType<typeof newFixtureIds>;

export interface Fixture extends FixtureIds {
  tickets: { a1Colour: string; a1Mono: string; a2Mono: string; b1Mono: string };
  invoices: { a1Colour: string; a2Mono: string; b1Mono: string };
  submissions: { a1Colour: string };
  payments: { a2Mono: string };
  users: string[];
}

const SHA = "a".repeat(64);

/**
 * Invoices are built by the billing engine (the only place amounts are calculated);
 * migration 0015 refuses anything else. Spec 6.3 colour case 2 (Rs. 12,800) and
 * mono case 2 (Rs. 6,500), from the initial readings of the fixture agreements.
 */
const COLOUR_TERMS: Terms = {
  machineType: "COLOUR",
  commitmentCents: 1_000_000,
  bwIncluded: 3000,
  bwRateCents: 200,
  colourIncluded: 500,
  colourRateCents: 1000,
};
const MONO_TERMS: Terms = { ...COLOUR_TERMS, machineType: "MONO", commitmentCents: 500_000, bwIncluded: 2000, bwRateCents: 250, colourIncluded: null, colourRateCents: null };

const firstReading = (value: number) => ({ known: [{ value, at: "2026-01-01T00:00:00Z", source: "INITIAL" as const }], counterMax: null, history: [] });

export const COLOUR_SUBMISSION = buildMeterSubmission(
  { terms: COLOUR_TERMS, cyclesCovered: 1, counters: { BW: firstReading(1000), COLOUR: firstReading(200) }, estimateCredits: [], credits: [] },
  { BW: 4400, COLOUR: 900 },
);
export const MONO_SUBMISSION = buildMeterSubmission(
  { terms: MONO_TERMS, cyclesCovered: 1, counters: { BW: firstReading(5000) }, estimateCredits: [], credits: [] },
  { BW: 7600 },
);

const json = (value: unknown) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;

export async function createFixture(db: pg.Client, options: { storage?: boolean } = {}): Promise<Fixture> {
  const f = newFixtureIds();
  const { tag } = f;
  const users = [f.admin, f.ownerA, f.ownerB, f.custA1, f.custA2, f.custB1];
  const email = (name: string) => `t-${name}-${tag}@users.rentdesk.invalid`;

  await db.query(`
    insert into auth.users (id, aud, role, email) values
      ('${f.admin}', 'authenticated', 'authenticated', '${email("admin")}'),
      ('${f.ownerA}', 'authenticated', 'authenticated', '${email("owner-a")}'),
      ('${f.ownerB}', 'authenticated', 'authenticated', '${email("owner-b")}'),
      ('${f.custA1}', 'authenticated', 'authenticated', '${email("cust-a1")}'),
      ('${f.custA2}', 'authenticated', 'authenticated', '${email("cust-a2")}'),
      ('${f.custB1}', 'authenticated', 'authenticated', '${email("cust-b1")}');

    select app.provision_account('${f.admin}', 'ADMIN', 't-admin-${tag}', 'Test Admin', null, null, false);
    select app.provision_account('${f.ownerA}', 'OWNER', 't-owner-a-${tag}', 'Owner A', null, '${f.admin}', false,
      ${json({ business_name: "Owner A Copiers" })});
    select app.provision_account('${f.ownerB}', 'OWNER', 't-owner-b-${tag}', 'Owner B', null, '${f.admin}', false,
      ${json({ business_name: "Owner B Copiers" })});
    select app.provision_account('${f.custA1}', 'CUSTOMER', 't-cust-a1-${tag}', 'Customer A1', '${f.ownerA}', '${f.ownerA}', false);
    select app.provision_account('${f.custA2}', 'CUSTOMER', 't-cust-a2-${tag}', 'Customer A2', '${f.ownerA}', '${f.ownerA}', false);
    select app.provision_account('${f.custB1}', 'CUSTOMER', 't-cust-b1-${tag}', 'Customer B1', '${f.ownerB}', '${f.ownerB}', false);

    insert into public.owner_company_profiles (owner_id, company_name, logo_path) values
      ('${f.ownerA}', 'Owner A Copiers', '${f.ownerA}/logo.png'),
      ('${f.ownerB}', 'Owner B Copiers', null);

    insert into public.machines (id, owner_id, brand, model, serial_no, type) values
      ('${f.machineAColour}', '${f.ownerA}', 'Canon', 'iR C3226', 'A-COL-${tag}', 'COLOUR'),
      ('${f.machineAMono1}', '${f.ownerA}', 'Ricoh', 'MP 2014', 'A-MON1-${tag}', 'MONO'),
      ('${f.machineAMono2}', '${f.ownerA}', 'Ricoh', 'MP 2014', 'A-MON2-${tag}', 'MONO'),
      ('${f.machineASpare}', '${f.ownerA}', 'Kyocera', 'TASKalfa', 'A-SPARE-${tag}', 'MONO'),
      ('${f.machineBMono}', '${f.ownerB}', 'Sharp', 'AR-6020', 'B-MON-${tag}', 'MONO');

    insert into public.rental_agreements (id, owner_id, customer_id, machine_id, start_date,
      monthly_commitment_cents, bw_included, bw_rate_cents, colour_included, colour_rate_cents,
      initial_bw_reading, initial_colour_reading) values
      ('${f.agrA1Colour}', '${f.ownerA}', '${f.custA1}', '${f.machineAColour}', current_date - 31, 1000000, 3000, 200, 500, 1000, 1000, 200),
      ('${f.agrA1Mono}', '${f.ownerA}', '${f.custA1}', '${f.machineAMono1}', current_date - 31, 500000, 2000, 250, null, null, 5000, null),
      ('${f.agrA2Mono}', '${f.ownerA}', '${f.custA2}', '${f.machineAMono2}', current_date - 31, 500000, 2000, 250, null, null, 5000, null),
      ('${f.agrB1Mono}', '${f.ownerB}', '${f.custB1}', '${f.machineBMono}', current_date - 31, 500000, 2000, 250, null, null, 5000, null);

    select app.open_billing_cycle('${f.agrA1Colour}', 1, now() + interval '5 days',
      ${json([{ user_id: f.custA1, event: "ticket.created", title: "Meter reading needed", link: "/tickets/{entity_id}" }])});
    select app.open_billing_cycle('${f.agrA1Mono}', 1, now() + interval '5 days',
      ${json([{ user_id: f.custA1, event: "ticket.created", title: "Meter reading needed" }])});
    select app.open_billing_cycle('${f.agrA2Mono}', 1, now() + interval '5 days',
      ${json([{ user_id: f.custA2, event: "ticket.created", title: "Meter reading needed" }])});
    select app.open_billing_cycle('${f.agrB1Mono}', 1, now() + interval '5 days',
      ${json([{ user_id: f.custB1, event: "ticket.created", title: "Meter reading needed" }])});
  `);

  const { rows: ticketRows } = await db.query<{ agreement_id: string; id: string }>(
    "select agreement_id, id from public.billing_cycle_tickets where agreement_id = any($1::uuid[])",
    [[f.agrA1Colour, f.agrA1Mono, f.agrA2Mono, f.agrB1Mono]],
  );
  const ticketOf = (agreementId: string) => ticketRows.find((r) => r.agreement_id === agreementId)!.id;
  const tickets = {
    a1Colour: ticketOf(f.agrA1Colour),
    a1Mono: ticketOf(f.agrA1Mono),
    a2Mono: ticketOf(f.agrA2Mono),
    b1Mono: ticketOf(f.agrB1Mono),
  };

  const monoReading = json(MONO_SUBMISSION.readings);
  const colourReading = json(COLOUR_SUBMISSION.readings);
  const photo = (owner: string, ticket: string, n: number) =>
    json({ storage_path: `${owner}/${ticket}/photo-${n}.jpg`, captured_at: new Date().toISOString() });

  await db.query(`
    select app.submit_meter_reading('${tickets.a1Colour}', '${f.custA1}', '${f.keyA1Colour}', 'CUSTOMER',
      ${colourReading}, ${photo(f.ownerA, tickets.a1Colour, 1)}, ${json(COLOUR_SUBMISSION.invoice)}, now() + interval '2 days', null, null,
      ${json([{ user_id: f.ownerA, event: "meter.submitted", title: "Meter submitted" }])});

    select app.submit_meter_reading('${tickets.a2Mono}', '${f.custA2}', '${f.keyA2Mono}', 'CUSTOMER',
      ${monoReading}, ${photo(f.ownerA, tickets.a2Mono, 2)}, ${json(MONO_SUBMISSION.invoice)}, now() + interval '2 days');
    select app.confirm_meter_submission('${tickets.a2Mono}',
      (select id from public.meter_submissions where idempotency_key = '${f.keyA2Mono}'),
      '${f.ownerA}', current_date + 7, now() + interval '7 days', null,
      ${json([{ user_id: f.custA2, event: "invoice.issued", title: "Invoice issued" }])});
    select app.submit_payment('${tickets.a2Mono}', '${f.custA2}', '${f.keyA2Payment}', 'CUSTOMER_SLIP',
      ${json({ amount_cents: 650_000, paid_on: new Date().toISOString().slice(0, 10), reference: `REF-${tag}` })},
      ${json({ storage_path: `${f.ownerA}/${tickets.a2Mono}/slip.pdf`, sha256: SHA, mime_type: "application/pdf", size_bytes: 1200 })},
      now() + interval '2 days');

    select app.submit_meter_reading('${tickets.b1Mono}', '${f.custB1}', '${f.keyB1Mono}', 'CUSTOMER',
      ${monoReading}, ${photo(f.ownerB, tickets.b1Mono, 3)}, ${json(MONO_SUBMISSION.invoice)}, now() + interval '2 days');
    select app.confirm_meter_submission('${tickets.b1Mono}',
      (select id from public.meter_submissions where idempotency_key = '${f.keyB1Mono}'),
      '${f.ownerB}', current_date + 7, now() + interval '7 days');

    insert into public.service_requests (owner_id, customer_id, machine_id, agreement_id, type, description, created_by) values
      ('${f.ownerA}', '${f.custA1}', '${f.machineAColour}', '${f.agrA1Colour}', 'TONER', 'Toner low', '${f.custA1}'),
      ('${f.ownerB}', '${f.custB1}', '${f.machineBMono}', '${f.agrB1Mono}', 'BREAKDOWN', 'Paper jam', '${f.custB1}');

    insert into public.ticket_comments (owner_id, ticket_id, author_id, body) values
      ('${f.ownerA}', '${tickets.a1Colour}', '${f.custA1}', 'Photo is a bit dark, sorry');

    insert into public.notification_templates (owner_id, event, channel, subject, body) values
      ('${f.ownerA}', 'test.${tag}', 'EMAIL', 'A subject', 'A body'),
      ('${f.ownerB}', 'test.${tag}', 'EMAIL', 'B subject', 'B body');
  `);

  if (options.storage !== false) {
    await db.query(`
      insert into storage.objects (bucket_id, name) values
        ('meter-photos', '${f.ownerA}/${tickets.a1Colour}/photo-1.jpg'),
        ('meter-photos', '${f.ownerB}/${tickets.b1Mono}/photo-3.jpg'),
        ('payment-slips', '${f.ownerA}/${tickets.a2Mono}/slip.pdf'),
        ('branding', '${f.ownerA}/logo.png'),
        ('branding', '${f.ownerB}/logo.png');
    `);
  }

  const { rows: invoiceRows } = await db.query<{ ticket_id: string; id: string }>(
    "select ticket_id, id from public.invoices where ticket_id = any($1::uuid[])",
    [[tickets.a1Colour, tickets.a2Mono, tickets.b1Mono]],
  );
  const invoiceOf = (ticketId: string) => invoiceRows.find((r) => r.ticket_id === ticketId)!.id;
  const { rows: subRows } = await db.query<{ id: string }>(
    "select id from public.meter_submissions where idempotency_key = $1",
    [f.keyA1Colour],
  );
  const { rows: payRows } = await db.query<{ id: string }>(
    "select id from public.payments where idempotency_key = $1",
    [f.keyA2Payment],
  );

  return {
    ...f,
    tickets,
    invoices: { a1Colour: invoiceOf(tickets.a1Colour), a2Mono: invoiceOf(tickets.a2Mono), b1Mono: invoiceOf(tickets.b1Mono) },
    submissions: { a1Colour: subRows[0].id },
    payments: { a2Mono: payRows[0].id },
    users,
  };
}

/**
 * Deletes a committed fixture (used only by the concurrency test, which needs two
 * connections to see the same rows). Child rows first; audit rows last because
 * the deletes themselves are audited.
 */
export async function deleteFixture(db: pg.Client, f: Fixture) {
  const owners = [f.ownerA, f.ownerB];
  await db.query("begin");
  try {
    for (const table of [
      "notifications",
      "notification_templates",
      "ticket_comments",
      "ticket_events",
      "payment_slips",
      "deposit_transactions",
      "invoice_lines",
      "credits",
      "disputes",
      "payments",
      "meter_readings",
      "meter_photos",
    ]) {
      await db.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [owners]);
    }
    await db.query("update public.billing_cycle_tickets set current_invoice_id = null where owner_id = any($1::uuid[])", [owners]);
    await db.query("update public.meter_submissions set invoice_id = null where owner_id = any($1::uuid[])", [owners]);
    for (const table of [
      "meter_submissions",
      "invoices",
      "billing_cycle_tickets",
      "service_request_history",
      "service_requests",
      "meter_baselines",
      "agreement_terms_history",
      "rental_agreements",
      "machines",
      "owner_settings",
      "invoice_counters",
      "owner_company_profiles",
      "customers",
    ]) {
      await db.query(`delete from public.${table} where owner_id = any($1::uuid[])`, [owners]);
    }
    await db.query("delete from public.owners where id = any($1::uuid[])", [owners]);
    await db.query("delete from auth.users where id = any($1::uuid[])", [f.users]); // cascades to profiles
    await db.query(
      "delete from public.audit_logs where owner_id = any($1::uuid[]) or actor_id = any($2::uuid[]) or entity_id = any($2::uuid[])",
      [owners, f.users],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}
