import { randomUUID } from "node:crypto";

import type pg from "pg";

import { addDays, type FinalCycle } from "../../src/lib/agreements/cycle-calendar.ts";
import type { Terms } from "../../src/lib/billing/invoice.ts";
import { buildMeterSubmission, type MeterContext } from "../../src/lib/billing/meter-invoice.ts";
import { buildReturnInvoice, type ReturnContext } from "../../src/lib/billing/return-invoice.ts";
import type { CounterType } from "../../src/lib/billing/usage.ts";

/**
 * Builds rpc_return_machine payloads in the database tests: the facts come from
 * the database (app.final_cycle, app.last_known_reading, app.available_credits),
 * the amounts from the TypeScript billing engine, exactly as the server does.
 */

interface SqlFacts {
  cycle_no: number;
  full_cycles: number;
  period_start: string;
  days_used: number;
  days_in_cycle: number;
  billable: boolean;
}

export async function finalFacts(db: pg.Client, agreementId: string, today: string): Promise<FinalCycle> {
  const { rows } = await db.query<{ f: SqlFacts }>("select app.final_cycle($1, $2::date) as f", [agreementId, today]);
  const f = rows[0].f;
  return {
    cycleNo: f.cycle_no,
    fullCycles: f.full_cycles,
    periodStart: f.period_start,
    daysUsed: f.days_used,
    daysInCycle: f.days_in_cycle,
    billable: f.billable,
  };
}

export async function returnContextFromDb(db: pg.Client, agreementId: string, today: string): Promise<ReturnContext> {
  const final = await finalFacts(db, agreementId, today);
  const { rows: info } = await db.query(
    `select a.customer_id, m.type, m.bw_counter_max::int as bw_max, m.colour_counter_max::int as colour_max
     from public.rental_agreements a join public.machines m on m.id = a.machine_id where a.id = $1`,
    [agreementId],
  );
  const { rows: terms } = await db.query(
    `select monthly_commitment_cents::int as c, bw_included::int as bi, bw_rate_cents::int as br,
            colour_included::int as ci, colour_rate_cents::int as cr, due_days
     from public.agreement_terms_history where agreement_id = $1 and effective_from_cycle_no <= $2
     order by effective_from_cycle_no desc, version desc limit 1`,
    [agreementId, final.cycleNo],
  );
  const t = terms[0];
  const machineType = info[0].type as Terms["machineType"];
  const counters: ReturnContext["counters"] = {};
  for (const counter of (machineType === "COLOUR" ? ["BW", "COLOUR"] : ["BW"]) as CounterType[]) {
    const { rows } = await db.query<{ v: string }>("select app.last_known_reading($1, $2)::text as v", [agreementId, counter]);
    counters[counter] = {
      known: [{ value: Number(rows[0].v), at: "2026-01-01T00:00:00Z", source: "READING" }],
      counterMax: counter === "BW" ? info[0].bw_max : info[0].colour_max,
      history: [],
    };
  }
  const { rows: credits } = await db.query<{ c: { id: string; available_cents: number }[] }>("select app.available_credits($1) as c", [
    info[0].customer_id,
  ]);
  return {
    terms: { machineType, commitmentCents: t.c, bwIncluded: t.bi, bwRateCents: t.br, colourIncluded: t.ci, colourRateCents: t.cr },
    dueDays: t.due_days,
    final,
    counters,
    estimateCredits: [],
    credits: credits[0].c.map((c) => ({ id: c.id, amountCents: Number(c.available_cents) })),
  };
}

/** Engine context for a ticket's meter reading, from the database (like loadMeterContext). */
export async function meterContextFromDb(
  db: pg.Client,
  ticketId: string,
  options: { excludeInvoiceId?: string | null; creditsExcluded?: string[] } = {},
): Promise<MeterContext> {
  const { rows } = await db.query(
    `select t.agreement_id, t.customer_id, t.cycle_no, t.machine_type, t.commitment_cents::int as c, t.bw_included::int as bi,
            t.bw_rate_cents::int as br, t.colour_included::int as ci, t.colour_rate_cents::int as cr,
            (select coalesce(max(tt.cycle_no), 0) from public.meter_submissions s
             join public.billing_cycle_tickets tt on tt.id = s.ticket_id
             where tt.agreement_id = t.agreement_id and s.status = 'CONFIRMED') as last_confirmed
     from public.billing_cycle_tickets t where t.id = $1`,
    [ticketId],
  );
  const t = rows[0];
  const counters: MeterContext["counters"] = {};
  for (const counter of (t.machine_type === "COLOUR" ? ["BW", "COLOUR"] : ["BW"]) as CounterType[]) {
    const { rows: r } = await db.query<{ v: string }>("select app.last_known_reading($1, $2)::text as v", [t.agreement_id, counter]);
    counters[counter] = { known: [{ value: Number(r[0].v), at: "2026-01-01T00:00:00Z", source: "READING" }], counterMax: null, history: [] };
  }
  const excluded = options.creditsExcluded ?? [];
  const { rows: credits } = await db.query<{ c: { id: string; available_cents: number }[] }>("select app.available_credits($1, $2) as c", [
    t.customer_id,
    options.excludeInvoiceId ?? null,
  ]);
  return {
    terms: { machineType: t.machine_type, commitmentCents: t.c, bwIncluded: t.bi, bwRateCents: t.br, colourIncluded: t.ci, colourRateCents: t.cr },
    cyclesCovered: t.cycle_no - t.last_confirmed,
    counters,
    estimateCredits: [],
    credits: credits[0].c.filter((c) => !excluded.includes(c.id)).map((c) => ({ id: c.id, amountCents: Number(c.available_cents) })),
    creditsExcluded: excluded,
  };
}

/** Customer submits a reading of `used` copies (B&W only); returns the submission and invoice ids. */
export async function submitReading(db: pg.Client, ticketId: string, used: number) {
  const context = await meterContextFromDb(db, ticketId);
  const previous = context.counters.BW!.known[0].value;
  const s = buildMeterSubmission(context, { BW: previous + used, COLOUR: context.terms.machineType === "COLOUR" ? context.counters.COLOUR!.known[0].value : null });
  const { rows: who } = await db.query("select owner_id, customer_id from public.billing_cycle_tickets where id = $1", [ticketId]);
  const { rows } = await db.query(
    `select app.submit_meter_reading($1, $2, gen_random_uuid(), 'CUSTOMER', $3::jsonb, $4::jsonb, $5::jsonb,
            now() + interval '2 days', null, $6) as r`,
    [ticketId, who[0].customer_id, JSON.stringify(s.readings), JSON.stringify({ storage_path: `${who[0].owner_id}/${ticketId}/p.jpg` }), JSON.stringify(s.invoice), s.anomalyFlag],
  );
  return { submission: s, submissionId: rows[0].r.submission_id as string, invoiceId: rows[0].r.invoice_id as string };
}

export async function confirmReading(db: pg.Client, ticketId: string, submissionId: string) {
  const { rows } = await db.query("select owner_id from public.billing_cycle_tickets where id = $1", [ticketId]);
  await db.query("select app.confirm_meter_submission($1, $2, $3, current_date + 7, now() + interval '7 days')", [
    ticketId,
    submissionId,
    rows[0].owner_id,
  ]);
}

export interface ReturnOptions {
  closing: { bw: number; colour?: number | null };
  reason?: string;
  rule?: "PRORATED" | "FULL";
  creditsExcluded?: string[];
  deposit?: Record<string, unknown> | null;
  key?: string;
}

/** p_return for rpc_return_machine / rpc_reassign_machine. */
export async function returnPayload(db: pg.Client, agreementId: string, today: string, o: ReturnOptions) {
  const context = await returnContextFromDb(db, agreementId, today);
  const rule = o.rule ?? "PRORATED";
  const s = buildReturnInvoice(context, {
    closing: { BW: o.closing.bw, COLOUR: o.closing.colour ?? null },
    rule,
    creditsExcluded: o.creditsExcluded,
  });
  return {
    context,
    submission: s,
    payload: {
      idempotency_key: o.key ?? randomUUID(),
      reason: o.reason ?? "Customer closed the branch",
      closing: { bw: o.closing.bw, colour: o.closing.colour ?? null },
      final: s && {
        rule,
        readings: s.readings,
        invoice: s.invoice,
        anomaly_flag: s.anomalyFlag,
        due_date: addDays(today, 7),
        stage_due_at: `${addDays(today, 7)}T23:59:59+05:30`,
      },
      deposit: o.deposit ?? null,
    },
  };
}
