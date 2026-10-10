import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAnon, asPostgres, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";

/** Every relation in the public schema that a client could try to read. */
const ALL_RELATIONS = [
  "profiles", "owners", "owner_company_profiles", "customers", "subscription_plans",
  "platform_settings", "owner_settings", "owner_settings_effective", "login_attempts",
  "machines", "rental_agreements", "meter_baselines", "billing_cycle_tickets", "ticket_events",
  "ticket_comments", "meter_submissions", "meter_readings", "meter_photos", "invoices",
  "invoice_lines", "invoice_counters", "payments", "payment_slips", "disputes", "credits",
  "service_requests", "service_request_history", "notifications", "notification_templates",
  "idempotency_keys", "audit_logs", "agreement_terms_history", "customer_balances",
  "deposit_transactions", "agreement_deposit_balances",
];

/** Relations with an owner_id column that authenticated users may read. */
const TENANT_RELATIONS = [
  "profiles", "owner_company_profiles", "customers", "owner_settings", "owner_settings_effective",
  "machines", "rental_agreements", "meter_baselines", "billing_cycle_tickets", "ticket_events",
  "ticket_comments", "meter_submissions", "meter_readings", "meter_photos", "invoices",
  "invoice_lines", "invoice_counters", "payments", "payment_slips", "disputes", "credits",
  "service_requests", "service_request_history", "notifications", "notification_templates", "audit_logs",
  "agreement_terms_history", "customer_balances", "deposit_transactions", "agreement_deposit_balances",
];

/** Rows visible to the current role; 0 when the relation is not granted at all. */
async function visible(db: pg.Client, relation: string): Promise<number> {
  const { rows } = await db.query("select has_table_privilege($1, 'select') as granted", [relation]);
  return rows[0].granted ? count(db, `select 1 from ${relation}`) : 0;
}

async function visibleObjects(db: pg.Client): Promise<number> {
  return count(db, "select 1 from storage.objects where bucket_id in ('meter-photos', 'payment-slips', 'branding')");
}

describe.skipIf(!DB_URL)("RLS (linked dev database, rolled back)", () => {
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

  it("anon can read nothing and cannot call the helpers", async () => {
    await isolated(db, async () => {
      await asAnon(db);
      for (const relation of ALL_RELATIONS) {
        const error = await sqlError(db, `select 1 from public.${relation} limit 1`);
        expect(error?.code, relation).toBe("42501");
      }
      expect((await sqlError(db, "select app.current_user_role()"))?.code).toBe("42501");
      expect((await sqlError(db, "select app.transition_ticket(gen_random_uuid(), 'METER_REQUESTED', 'CANCELLED', null, 'x')"))?.code).toBe("42501");
      expect(await visibleObjects(db)).toBe(0);
    });
  });

  it("an owner reads only their own tenant", async () => {
    await isolated(db, async () => {
      // Sanity: the other tenant really has rows.
      expect(await count(db, "select 1 from public.billing_cycle_tickets where owner_id = $1", [f.ownerB])).toBeGreaterThan(0);

      await asUser(db, f.ownerA);
      for (const relation of TENANT_RELATIONS) {
        const foreign = await count(db, `select 1 from public.${relation} where owner_id is not null and owner_id <> $1`, [f.ownerA]);
        expect(foreign, relation).toBe(0);
      }
      expect(await count(db, "select 1 from public.owners where id <> $1", [f.ownerA])).toBe(0);
      expect(await count(db, "select 1 from public.profiles where role = 'ADMIN'")).toBe(0);
      expect(await visible(db, "public.billing_cycle_tickets")).toBe(3);
      expect(await visible(db, "public.customers")).toBe(2);
      expect(await visible(db, "public.invoices")).toBe(2); // includes A1's draft
      expect(await visible(db, "public.payments")).toBe(1);
      expect(await visible(db, "public.meter_photos")).toBe(2);

      // Storage: own branding + own photos + own slip; nothing of owner B.
      expect(await count(db, "select 1 from storage.objects where name like $1", [`${f.ownerB}/%`])).toBe(0);
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'meter-photos'")).toBe(1);
    });
  });

  it("an owner cannot write another owner's data", async () => {
    await isolated(db, async () => {
      await asUser(db, f.ownerA);

      const insertMachine = await sqlError(
        db,
        "insert into public.machines (owner_id, brand, model, serial_no, type) values ($1, 'X', 'Y', 'Z-1', 'MONO')",
        [f.ownerB],
      );
      expect(insertMachine?.code).toBe("42501");

      const updateMachine = await db.query("update public.machines set notes = 'hacked' where id = $1", [f.machineBMono]);
      expect(updateMachine.rowCount).toBe(0);
      const updateCustomer = await db.query("update public.customers set name = 'hacked' where id = $1", [f.custB1]);
      expect(updateCustomer.rowCount).toBe(0);
      const updateBranding = await db.query(
        "update public.owner_company_profiles set company_name = 'hacked' where owner_id = $1",
        [f.ownerB],
      );
      expect(updateBranding.rowCount).toBe(0);

      // Agreements are written only through rpc_assign_machine (cross-tenant links: machines.db.test.ts).
      const crossLink = await sqlError(
        db,
        `insert into public.rental_agreements (owner_id, customer_id, machine_id, start_date, monthly_commitment_cents, bw_rate_cents)
         values ($1, $2, $3, current_date, 100, 1)`,
        [f.ownerA, f.custB1, f.machineASpare],
      );
      expect(crossLink?.code).toBe("42501");

      const template = await sqlError(
        db,
        "insert into public.notification_templates (owner_id, event, channel, body) values ($1, 'x.y', 'EMAIL', 'b')",
        [f.ownerB],
      );
      expect(template?.code).toBe("42501");

      const upload = await sqlError(db, "insert into storage.objects (bucket_id, name) values ('branding', $1)", [
        `${f.ownerB}/evil.png`,
      ]);
      expect(upload?.code).toBe("42501");

      // No direct writes to server-only tables either.
      const ticket = await sqlError(db, "update public.billing_cycle_tickets set status = 'CLOSED' where id = $1", [
        f.tickets.a2Mono,
      ]);
      expect(ticket?.code).toBe("42501");
      const invoice = await sqlError(db, "update public.invoices set total_cents = 0 where id = $1", [f.invoices.a2Mono]);
      expect(invoice?.code).toBe("42501");

      await asPostgres(db);
      expect(await count(db, "select 1 from public.machines where notes = 'hacked'")).toBe(0);
    });
  });

  it("an owner edits their own machine details and branding; agreements and machine status go through rpc", async () => {
    await isolated(db, async () => {
      await asUser(db, f.ownerA);
      expect(await sqlError(db, "update public.machines set notes = 'serviced' where id = $1", [f.machineASpare])).toBeNull();
      expect(
        await sqlError(db, "insert into public.machines (owner_id, brand, model, serial_no, type) values ($1, 'X', 'Y', $2, 'MONO')", [
          f.ownerA,
          `NEW-${f.tag}`,
        ]),
      ).toBeNull();
      expect(
        await sqlError(db, "update public.owner_company_profiles set phone = '011' where owner_id = $1", [f.ownerA]),
      ).toBeNull();
      // Migration 0014: no direct agreement writes, no hand-set machine status.
      for (const [sql, params] of [
        [
          `insert into public.rental_agreements (owner_id, customer_id, machine_id, start_date, monthly_commitment_cents, bw_rate_cents)
           values ($1, $2, $3, current_date, 100, 1)`,
          [f.ownerA, f.custA2, f.machineASpare],
        ],
        ["update public.rental_agreements set next_cycle_no = 99 where id = $1", [f.agrA1Mono]],
        ["update public.rental_agreements set monthly_commitment_cents = 1 where id = $1", [f.agrA1Mono]],
        ["update public.machines set status = 'RETIRED' where id = $1", [f.machineASpare]],
        ["insert into public.machines (owner_id, brand, model, serial_no, type, status) values ($1, 'X', 'Y', 'Z-9', 'MONO', 'RENTED')", [f.ownerA]],
        ["insert into public.agreement_terms_history (owner_id, agreement_id, version, effective_from_cycle_no, monthly_commitment_cents, bw_included, bw_rate_cents, due_days) values ($1, $2, 9, 1, 0, 0, 0, 7)", [f.ownerA, f.agrA1Mono]],
      ] as const) {
        expect((await sqlError(db, sql, [...params]))?.code, sql).toBe("42501");
      }
    });
  });

  it("a customer sees only their own records", async () => {
    await isolated(db, async () => {
      await asUser(db, f.custA1);
      expect(await visible(db, "public.profiles")).toBe(1);
      expect(await visible(db, "public.customers")).toBe(1);
      expect(await count(db, "select 1 from public.owners where id = $1", [f.ownerA])).toBe(1);
      expect(await visible(db, "public.owners")).toBe(1);
      expect(await visible(db, "public.rental_agreements")).toBe(2);
      expect(await visible(db, "public.machines")).toBe(2);
      expect(await visible(db, "public.billing_cycle_tickets")).toBe(2);
      expect(await count(db, "select 1 from public.billing_cycle_tickets where customer_id <> $1", [f.custA1])).toBe(0);
      expect(await visible(db, "public.meter_submissions")).toBe(1);
      expect(await visible(db, "public.meter_readings")).toBe(2);
      expect(await visible(db, "public.service_requests")).toBe(1);
      expect(await visible(db, "public.ticket_comments")).toBe(1);

      // Draft invoices are hidden from the customer (spec 6.6), and photos are owner-only.
      expect(await visible(db, "public.invoices")).toBe(0);
      expect(await visible(db, "public.invoice_lines")).toBe(0);
      expect(await visible(db, "public.meter_photos")).toBe(0);
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'meter-photos'")).toBe(0);

      // Owner-only and admin-only data.
      for (const relation of ["owner_settings", "invoice_counters", "audit_logs", "meter_baselines", "login_attempts", "idempotency_keys"]) {
        expect(await visible(db, `public.${relation}`), relation).toBe(0);
      }
      expect(await count(db, "select 1 from public.notification_templates")).toBe(0);

      // Nothing from the other customer of the same owner, or from the other tenant.
      expect(await count(db, "select 1 from public.payments")).toBe(0);
      expect(await count(db, "select 1 from public.notifications where user_id <> $1", [f.custA1])).toBe(0);
      expect(await count(db, "select 1 from storage.objects where name like $1", [`${f.ownerB}/%`])).toBe(0);

      await asPostgres(db);
      await asUser(db, f.custA2);
      expect(await visible(db, "public.invoices")).toBe(1);
      expect(await visible(db, "public.invoice_lines")).toBe(2);
      expect(await visible(db, "public.payments")).toBe(1);
      expect(await visible(db, "public.payment_slips")).toBe(1);
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'payment-slips'")).toBe(1);
      expect(await count(db, "select 1 from public.billing_cycle_tickets where id = $1", [f.tickets.a1Colour])).toBe(0);
    });
  });

  it("a customer cannot write billing data directly", async () => {
    await isolated(db, async () => {
      await asUser(db, f.custA1);
      const attempts: Array<[string, string, unknown[]]> = [
        [
          "meter_submissions",
          `insert into public.meter_submissions (owner_id, ticket_id, customer_id, attempt_no, source, idempotency_key, submitted_by)
           values ($1, $2, $3, 9, 'CUSTOMER', gen_random_uuid(), $3)`,
          [f.ownerA, f.tickets.a1Mono, f.custA1],
        ],
        [
          "meter_readings",
          `insert into public.meter_readings (owner_id, submission_id, counter_type, previous_value, current_value)
           values ($1, $2, 'BW', 0, 1)`,
          [f.ownerA, f.submissions.a1Colour],
        ],
        [
          "meter_photos",
          "insert into public.meter_photos (owner_id, submission_id, storage_path) values ($1, $2, $3)",
          [f.ownerA, f.submissions.a1Colour, `${f.ownerA}/x.jpg`],
        ],
        [
          "payments",
          `insert into public.payments (owner_id, invoice_id, ticket_id, customer_id, source, method, amount_cents, paid_on, submitted_by)
           values ($1, $2, $3, $4, 'CUSTOMER_SLIP', 'BANK_TRANSFER', 100, current_date, $4)`,
          [f.ownerA, f.invoices.a1Colour, f.tickets.a1Colour, f.custA1],
        ],
        [
          "payment_slips",
          `insert into public.payment_slips (owner_id, payment_id, storage_path, sha256, mime_type, size_bytes, uploaded_by)
           values ($1, $2, $3, repeat('b', 64), 'application/pdf', 10, $4)`,
          [f.ownerA, f.payments.a2Mono, `${f.ownerA}/y.pdf`, f.custA1],
        ],
        [
          "service_requests",
          `insert into public.service_requests (owner_id, customer_id, machine_id, type, description, created_by)
           values ($1, $2, $3, 'OTHER', 'x', $2)`,
          [f.ownerA, f.custA1, f.machineAMono1],
        ],
        [
          "ticket_comments",
          "insert into public.ticket_comments (owner_id, ticket_id, author_id, body) values ($1, $2, $3, 'hi')",
          [f.ownerA, f.tickets.a1Mono, f.custA1],
        ],
        ["billing_cycle_tickets", "update public.billing_cycle_tickets set status = 'CLOSED' where id = $1", [f.tickets.a1Mono]],
        ["invoices", "update public.invoices set status = 'PAID' where id = $1", [f.invoices.a1Colour]],
      ];
      for (const [table, sql, params] of attempts) {
        expect((await sqlError(db, sql, params))?.code, table).toBe("42501");
      }

      // Own contact details are owner-managed: the update matches no rows.
      expect((await db.query("update public.customers set name = 'me' where id = $1", [f.custA1])).rowCount).toBe(0);

      // Own notifications can be marked read; others cannot.
      expect((await db.query("update public.notifications set read_at = now() where user_id = $1", [f.custA1])).rowCount).toBe(2);
      expect((await db.query("update public.notifications set read_at = now() where user_id <> $1", [f.custA1])).rowCount).toBe(0);
    });
  });

  it("a customer can upload files only to their own ticket at the right stage", async () => {
    await isolated(db, async () => {
      await asUser(db, f.custA1);
      const upload = (bucket: string, name: string) =>
        sqlError(db, "insert into storage.objects (bucket_id, name) values ($1, $2)", [bucket, name]);

      // Meter photo: own ticket in METER_REQUESTED -> allowed.
      expect(await upload("meter-photos", `${f.ownerA}/${f.tickets.a1Mono}/live.jpg`)).toBeNull();
      // Own ticket already under review -> denied.
      expect((await upload("meter-photos", `${f.ownerA}/${f.tickets.a1Colour}/again.jpg`))?.code).toBe("42501");
      // Another customer's ticket -> denied.
      expect((await upload("meter-photos", `${f.ownerA}/${f.tickets.a2Mono}/x.jpg`))?.code).toBe("42501");
      // Slip while no payment is expected -> denied.
      expect((await upload("payment-slips", `${f.ownerA}/${f.tickets.a1Mono}/slip.pdf`))?.code).toBe("42501");
      // Branding is owner-only.
      expect((await upload("branding", `${f.ownerA}/logo2.png`))?.code).toBe("42501");

      await asPostgres(db);
      await asUser(db, f.custB1);
      // B1's invoice is awaiting payment -> slip allowed.
      expect(await upload("payment-slips", `${f.ownerB}/${f.tickets.b1Mono}/slip.pdf`)).toBeNull();
    });
  });

  it("a suspended owner and all of their customers see nothing", async () => {
    await isolated(db, async () => {
      await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.ownerA]);

      for (const user of [f.ownerA, f.custA1, f.custA2]) {
        await asUser(db, user);
        for (const relation of ALL_RELATIONS) {
          expect(await visible(db, `public.${relation}`), `${relation} as ${user}`).toBe(0);
        }
        expect(await visibleObjects(db)).toBe(0);
        expect((await db.query("select app.current_user_role() as r")).rows[0].r).toBeNull();
        await asPostgres(db);
      }

      // The other tenant is unaffected.
      await asUser(db, f.custB1);
      expect(await visible(db, "public.billing_cycle_tickets")).toBe(1);
    });
  });

  it("a suspended or deactivated customer sees nothing while their owner still works", async () => {
    for (const status of ["SUSPENDED", "DEACTIVATED"]) {
      await isolated(db, async () => {
        await db.query("update public.profiles set status = $2 where id = $1", [f.custA1, status]);
        await asUser(db, f.custA1);
        for (const relation of ALL_RELATIONS) {
          expect(await visible(db, `public.${relation}`), `${relation} (${status})`).toBe(0);
        }
        expect(await visibleObjects(db)).toBe(0);

        await asPostgres(db);
        await asUser(db, f.ownerA);
        expect(await visible(db, "public.billing_cycle_tickets")).toBe(3);
      });
    }
  });

  it("admin reads every tenant but cannot write tenant data", async () => {
    await isolated(db, async () => {
      await asUser(db, f.admin);
      expect(await count(db, "select 1 from public.billing_cycle_tickets where owner_id = any($1::uuid[])", [[f.ownerA, f.ownerB]])).toBe(4);
      expect(await count(db, "select 1 from public.owners where id = any($1::uuid[])", [[f.ownerA, f.ownerB]])).toBe(2);
      // Spec 6.5: meter photo files are owner-only, even for admin.
      expect(await count(db, "select 1 from storage.objects where bucket_id = 'meter-photos' and name like $1", [`${f.ownerA}/%`])).toBe(0);
      const write = await sqlError(db, "insert into public.machines (owner_id, brand, model, serial_no, type) values ($1, 'X', 'Y', 'Z-2', 'MONO')", [f.ownerA]);
      expect(write?.code).toBe("42501");
    });
  });

  it("anon and authenticated cannot execute any public function, including the rpc_* wrappers", async () => {
    await isolated(db, async () => {
      const { rows } = await db.query<{
        name: string;
        signature: string;
        args: string;
        anon: boolean;
        authenticated: boolean;
        service: boolean;
      }>(
        `select p.proname as name, p.oid::regprocedure::text as signature, oidvectortypes(p.proargtypes) as args,
                has_function_privilege('anon', p.oid, 'execute') as anon,
                has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
                has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p
         where p.pronamespace = 'public'::regnamespace
           -- Trigger / event-trigger functions cannot be called directly (e.g. Supabase's
           -- own public.rls_auto_enable() behind "Automatic RLS"), so they are not an API.
           and p.prorettype not in ('trigger'::regtype, 'event_trigger'::regtype)`,
      );
      const wrappers = rows.filter((r) => r.name.startsWith("rpc_"));
      expect(wrappers.map((r) => r.name).sort()).toEqual([
        "rpc_assign_invoice_number",
        "rpc_assign_machine",
        "rpc_complete_password_change",
        "rpc_confirm_meter_submission",
        "rpc_login_gate_state",
        "rpc_open_billing_cycle",
        "rpc_provision_account",
        "rpc_reassign_machine",
        "rpc_record_login_attempt",
        "rpc_reject_meter_submission",
        "rpc_reset_account_password",
        "rpc_return_machine",
        "rpc_save_company_profile",
        "rpc_session_state",
        "rpc_set_account_status",
        "rpc_set_invoice_credit",
        "rpc_set_machine_status",
        "rpc_settle_deposit",
        "rpc_submit_meter_reading",
        "rpc_submit_payment",
        "rpc_transition_ticket",
        "rpc_update_agreement_terms",
        "rpc_update_customer",
        "rpc_update_owner",
        "rpc_verify_payment",
        "rpc_write_audit",
      ]);
      for (const r of rows) {
        expect(r.anon, `anon: ${r.signature}`).toBe(false);
        expect(r.authenticated, `authenticated: ${r.signature}`).toBe(false);
      }
      for (const r of wrappers) expect(r.service, `service_role: ${r.signature}`).toBe(true);

      // An actual call is refused before the function body runs.
      for (const actAs of [() => asAnon(db), () => asUser(db, f.ownerA), () => asUser(db, f.custA1), () => asUser(db, f.admin)]) {
        await actAs();
        for (const r of wrappers) {
          const nulls = r.args.split(", ").map((type) => `null::${type}`).join(", ");
          expect((await sqlError(db, `select public.${r.name}(${nulls})`))?.code, r.signature).toBe("42501");
        }
        await asPostgres(db);
      }
    });
  });

  it("authenticated users cannot execute workflow functions", async () => {
    await isolated(db, async () => {
      await asUser(db, f.ownerA);
      expect((await db.query("select app.current_user_role() as r")).rows[0].r).toBe("OWNER");
      expect((await db.query("select app.current_owner_id() as o")).rows[0].o).toBe(f.ownerA);
      for (const sql of [
        `select app.transition_ticket('${f.tickets.a1Mono}', 'METER_REQUESTED', 'CANCELLED', '${f.ownerA}', 'x')`,
        `select app.assign_invoice_number('${f.invoices.a1Colour}')`,
        `select app.confirm_meter_submission('${f.tickets.a1Colour}', '${f.submissions.a1Colour}', '${f.ownerA}', current_date, now())`,
        `select app.provision_account(gen_random_uuid(), 'CUSTOMER', 'zz-test', 'x', '${f.ownerA}', '${f.ownerA}')`,
        "select app.resolve_actor()",
      ]) {
        expect((await sqlError(db, sql))?.code, sql).toBe("42501");
      }
    });
  });
});
