import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { remindEndingAgreements } from "../../src/lib/cron/daily.ts";
import { incomeMonth, incomeTotals } from "../../src/lib/reports/maths.ts";
import type { IncomeMonthRow } from "../../src/lib/reports/types.ts";
import { type SettingsValues, settingsProblems } from "../../src/lib/settings/rules.ts";

import { asAnon, asPostgres, asService, asUser, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { pgRpc } from "./rpc";

/**
 * Task 11 (RPT-01..08, CP-01, ADM-04..08, AGR-03; decisions 77-86) against the linked
 * dev database, rolled back:
 *   - the report functions see only the caller's tenant (owner, admin, customer, anon);
 *   - known totals: income (payments, advances, deposit kept, refunds), machines
 *     (revenue, copies, service cost), customers (payment behaviour), the dashboards;
 *   - the support view writes its access log and an admin cannot write tenant data;
 *   - settings: validation in SQL = TS, audit old -> new, owner overrides and reset;
 *   - agreement end reminders: once per end date, essential email.
 *
 * Fixture (fixtures.ts): owner A's customer A2 has an issued bill of Rs. 6,500
 * (commitment 5,000 + 600 excess copies at Rs. 2.50) with a payment slip waiting; A1 has a
 * colour reading waiting for review and a toner request; owner B's B1 has an issued
 * Rs. 6,500 bill.
 */

const RS = (rupees: number) => rupees * 100;

describe.skipIf(!DB_URL)("reports, dashboards, settings and support view (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  let today: string;
  let from: string;
  let to: string;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
    const { rows } = await db.query("select app.colombo_date(now())::text as d, (app.colombo_date(now()) - 40)::text as f, (app.colombo_date(now()) + 40)::text as t");
    ({ d: today, f: from, t: to } = rows[0]);
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  const one = async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows[0] as R;
  /** A report function's jsonb result as `user`. */
  const report = async <R = Record<string, unknown>>(user: string | "anon", sql: string, params: unknown[] = []): Promise<R> => {
    if (user === "anon") await asAnon(db);
    else await asUser(db, user);
    try {
      return (await db.query(`select ${sql} as r`, params)).rows[0].r as R;
    } finally {
      await asPostgres(db);
    }
  };

  /** A1's advance, a deposit kept on return, an overpayment credit partly refunded; A2's slip accepted. */
  async function moneyIn() {
    await one("select app.verify_payment($1, $2, true)", [f.payments.a2Mono, f.ownerA]);
    await db.query(
      `insert into public.credits (owner_id, customer_id, agreement_id, kind, amount_cents, reason, received_on, method)
       values ($1, $2, $3, 'ADVANCE', $4, 'Advance payment', $5, 'CASH')`,
      [f.ownerA, f.custA1, f.agrA1Mono, RS(2000), today],
    );
    await db.query(
      `insert into public.deposit_transactions (owner_id, agreement_id, customer_id, kind, amount_cents, occurred_on, method, note)
       values ($1, $2, $3, 'RECEIVED', $4, $5, 'CASH', 'Deposit'), ($1, $2, $3, 'RETAINED', $6, $5, null, 'Toner tray damaged')`,
      [f.ownerA, f.agrA1Mono, f.custA1, RS(1000), today, RS(300)],
    );
    const { id: creditId } = await one<{ id: string }>(
      `insert into public.credits (owner_id, customer_id, kind, amount_cents, reason) values ($1, $2, 'OVERPAYMENT', $3, 'Paid twice') returning id`,
      [f.ownerA, f.custA2, RS(200)],
    );
    await one("select app.refund_credit($1, $2, $3::jsonb)", [creditId, f.ownerA, JSON.stringify({ amount_cents: RS(50), refunded_on: today, method: "CASH", reference: "Cash 1" })]);
  }

  describe("tenant isolation (RLS through security-invoker functions)", () => {
    it("an owner's reports show only their tenant; another owner's id returns nothing", async () => {
      await isolated(db, async () => {
        const own = await report<{ months: IncomeMonthRow[] }>(f.ownerA, "public.report_income($1, $2, $3)", [f.ownerA, from, to]);
        expect(incomeTotals(own.months.map(incomeMonth)).invoiced_cents).toBe(RS(6500));
        for (const fn of ["report_income", "report_machines", "report_customers", "report_service_demand", "report_usage", "report_cycle_status"]) {
          expect(await report(f.ownerA, `public.${fn}($1, $2, $3)`, [f.ownerB, from, to]), fn).toBeNull();
        }
        expect(await report(f.ownerA, "public.report_owner_dashboard($1, $2)", [f.ownerB, today])).toBeNull();
        expect(await report(f.ownerA, "public.report_rental($1, $2)", [f.ownerB, today])).toBeNull();
        expect(await report(f.ownerA, "public.report_ageing_invoices($1)", [f.ownerB])).toBeNull();
        await asUser(db, f.ownerA);
        for (const fn of ["report_invoice_lines", "report_collected", "report_service_costs"]) {
          expect(await count(db, `select * from app.${fn}($1, $2, $3)`, [f.ownerB, from, to]), fn).toBe(0);
        }
        await asPostgres(db);
        // Owner B sees their own bill only.
        const b = await report<{ months: IncomeMonthRow[] }>(f.ownerB, "public.report_income($1, $2, $3)", [f.ownerB, from, to]);
        expect(incomeTotals(b.months.map(incomeMonth)).invoiced_cents).toBe(RS(6500));
        const bMachines = await report<{ machines: { serial_no: string }[] }>(f.ownerB, "public.report_machines($1, $2, $3)", [f.ownerB, from, to]);
        expect(bMachines.machines.map((m) => m.serial_no)).toEqual([`B-MON-${f.tag}`]);
      });
    });

    it("customers get nothing from owner reports, only their own dashboard; anon cannot call them", async () => {
      await isolated(db, async () => {
        expect(await report(f.custA2, "public.report_income($1, $2, $3)", [f.ownerA, from, to])).toBeNull();
        expect(await report(f.custA2, "public.report_owner_dashboard($1, $2)", [f.ownerA, today])).toBeNull();
        const mine = await report<{ outstanding_cents: number; machines: unknown[]; latest_invoice: { total_cents: number } | null }>(f.custA2, "public.report_customer_dashboard()");
        expect(mine.outstanding_cents).toBe(RS(6500));
        expect(mine.machines).toHaveLength(1);
        expect(mine.latest_invoice?.total_cents).toBe(RS(6500));
        const a1 = await report<{ outstanding_cents: number; machines: unknown[]; latest_invoice: unknown; open_requests: unknown[] }>(f.custA1, "public.report_customer_dashboard()");
        expect(a1).toMatchObject({ outstanding_cents: 0, latest_invoice: null });
        expect(a1.machines).toHaveLength(2);
        expect(a1.open_requests).toHaveLength(1);
        expect(await report(f.custA1, "public.report_admin_dashboard($1, now())", [today])).toBeNull();
        expect((await sqlError(db, "set local role anon; select public.report_income(gen_random_uuid(), current_date, current_date)"))?.code).toBe("42501");
      });
    });

    it("an admin reads any owner's reports (support view) and the platform dashboard", async () => {
      await isolated(db, async () => {
        const b = await report<{ months: IncomeMonthRow[] }>(f.admin, "public.report_income($1, $2, $3)", [f.ownerB, from, to]);
        expect(incomeTotals(b.months.map(incomeMonth)).invoiced_cents).toBe(RS(6500));
        const d = await report<{ owners: Record<string, number>; open_tickets: number }>(f.admin, "public.report_admin_dashboard($1, now())", [today]);
        expect(d.owners.ACTIVE).toBeGreaterThanOrEqual(2);
        expect(d.open_tickets).toBeGreaterThanOrEqual(4);
        expect(await report(f.ownerA, "public.report_admin_activity($1, $2)", [from, to])).toBeNull();
        const act = await report<{ owners: { id: string; invoices: number }[] }>(f.admin, "public.report_admin_activity($1, $2)", [from, to]);
        expect(act.owners.find((o) => o.id === f.ownerA)?.invoices).toBe(1);
      });
    });
  });

  describe("totals against known data", () => {
    it("income: invoiced by issue date; collected = payments + advances + deposit kept - refunds (decision 77)", async () => {
      await isolated(db, async () => {
        await moneyIn();
        const r = await report<{ months: IncomeMonthRow[] }>(f.ownerA, "public.report_income($1, $2, $3)", [f.ownerA, from, to]);
        const t = incomeTotals(r.months.map(incomeMonth));
        expect(t).toMatchObject({
          commitment_cents: RS(5000),
          excess_cents: RS(1500),
          invoiced_cents: RS(6500),
          invoices: 1,
          payments_cents: RS(6500),
          advances_cents: RS(2000),
          deposits_kept_cents: RS(300),
          refunds_cents: -RS(50),
          collected_cents: RS(6500 + 2000 + 300 - 50),
        });
        // A deposit received is not income; only what was kept counts.
        expect(t.collected_cents).not.toBe(RS(6500 + 2000 + 1000 + 300 - 50));
      });
    });

    it("machines: revenue, copies and the owner's service cost; customers: payment behaviour", async () => {
      await isolated(db, async () => {
        await moneyIn();
        await db.query("update public.service_requests set cost_cents = $2, resolved_at = now() where owner_id = $1", [f.ownerA, RS(3000)]);
        const m = await report<{ machines: { id: string; revenue_cents: number; commitment_cents: number; bw_excess_cents: number; bw_copies: number; service_cost_cents: number; toner_cost_cents: number }[] }>(
          f.ownerA,
          "public.report_machines($1, $2, $3)",
          [f.ownerA, from, to],
        );
        expect(m.machines.find((x) => x.id === f.machineAMono2)).toMatchObject({ revenue_cents: RS(6500), commitment_cents: RS(5000), bw_excess_cents: RS(1500), bw_copies: 2600 });
        expect(m.machines.find((x) => x.id === f.machineAColour)).toMatchObject({ revenue_cents: 0, service_cost_cents: RS(3000), toner_cost_cents: RS(3000) });
        expect(m.machines.find((x) => x.id === f.machineASpare)).toBeDefined();

        const c = await report<{ customers: { id: string; invoiced_cents: number; collected_cents: number; outstanding_cents: number; paid_bills: number; paid_on_time: number; credit_cents: number }[] }>(
          f.ownerA,
          "public.report_customers($1, $2, $3)",
          [f.ownerA, from, to],
        );
        expect(c.customers.find((x) => x.id === f.custA2)).toMatchObject({ invoiced_cents: RS(6500), collected_cents: RS(6450), outstanding_cents: 0, paid_bills: 1, paid_on_time: 1, credit_cents: RS(150) });
        expect(c.customers.find((x) => x.id === f.custA1)).toMatchObject({ invoiced_cents: 0, collected_cents: RS(2300), credit_cents: RS(2000) });
      });
    });

    it("the owner dashboard in one call", async () => {
      await isolated(db, async () => {
        const before = await report<Record<string, unknown>>(f.ownerA, "public.report_owner_dashboard($1, $2)", [f.ownerA, today]);
        expect(before).toMatchObject({ readings_to_review: 1, slips_to_verify: 1, outstanding_cents: RS(6500), overdue_cents: 0, invoiced_this_month: RS(6500), collected_this_month: 0 });
        expect(before.machines).toEqual({ RENTED: 3, AVAILABLE: 1 });
        expect((before.service as { total: number; by_type: Record<string, number> }).by_type).toEqual({ TONER: 1 });
        await moneyIn();
        const after = await report<Record<string, unknown>>(f.ownerA, "public.report_owner_dashboard($1, $2)", [f.ownerA, today]);
        expect(after).toMatchObject({ slips_to_verify: 0, outstanding_cents: 0, collected_this_month: RS(6500 + 2000 + 300 - 50) });
        expect((after.recent_payments as { amount_cents: number }[])[0].amount_cents).toBe(RS(6500));
        expect((after.top_machines as { id: string }[])[0].id).toBe(f.machineAMono2);
      });
    });

    it("cycle status, ageing rows, rental and service demand", async () => {
      await isolated(db, async () => {
        const cycles = await report<{ tickets: number; by_status: Record<string, number> }>(f.ownerA, "public.report_cycle_status($1, $2, $3)", [f.ownerA, from, to]);
        expect(cycles.tickets).toBe(3);
        expect(cycles.by_status).toMatchObject({ PENDING_OWNER_REVIEW: 1, METER_REQUESTED: 1, PAYMENT_SUBMITTED: 1 });
        const ageing = await report<{ invoice_no: string; balance_cents: number }[]>(f.ownerA, "public.report_ageing_invoices($1)", [f.ownerA]);
        expect(ageing.map((a) => a.balance_cents)).toEqual([RS(6500)]);
        await db.query("update public.rental_agreements set end_date = $2::date + 10 where id = $1", [f.agrA1Mono, today]);
        const rental = await report<{ machines: Record<string, number>; agreements: { id: string; days_left: number | null }[]; notice_days: number }>(f.ownerA, "public.report_rental($1, $2)", [f.ownerA, today]);
        expect(rental.notice_days).toBe(30);
        expect(rental.agreements.find((a) => a.id === f.agrA1Mono)?.days_left).toBe(10);
        const service = await report<{ total: number; by_type: Record<string, number>; toner_history: unknown[] }>(f.ownerA, "public.report_service_demand($1, $2, $3)", [f.ownerA, from, to]);
        expect(service).toMatchObject({ total: 1, by_type: { TONER: 1 } });
        expect(service.toner_history).toHaveLength(1);
      });
    });
  });

  describe("support view (ADM-08, decision 81)", () => {
    it("writes the access log: who, when, which owner, which page, reason", async () => {
      await isolated(db, async () => {
        const rpc = pgRpc(db);
        await asService(db);
        const id = await rpc("rpc_log_support_view", { p_admin_id: f.admin, p_owner_id: f.ownerA, p_path: `/admin/owners/${f.ownerA}/support`, p_reason: "Owner asked about the income report" });
        await asPostgres(db);
        const row = await one<{ actor_id: string; actor_role: string; owner_id: string; action: string; entity_id: string; details: Record<string, string>; created_at: Date }>(
          "select * from public.audit_logs where id = $1",
          [id],
        );
        expect(row).toMatchObject({ actor_id: f.admin, actor_role: "ADMIN", owner_id: f.ownerA, action: "SUPPORT_VIEW", entity_id: f.ownerA });
        expect(row.details).toEqual({ path: `/admin/owners/${f.ownerA}/support`, reason: "Owner asked about the income report" });
        // Only an active admin, only an owner, only support paths.
        await asService(db);
        await expect(rpc("rpc_log_support_view", { p_admin_id: f.ownerA, p_owner_id: f.ownerB, p_path: `/admin/owners/${f.ownerB}/support` })).rejects.toMatchObject({ code: "RD403" });
        await expect(rpc("rpc_log_support_view", { p_admin_id: f.admin, p_owner_id: f.custA1, p_path: "/admin/owners/x/support" })).rejects.toMatchObject({ code: "RD404" });
        await expect(rpc("rpc_log_support_view", { p_admin_id: f.admin, p_owner_id: f.ownerA, p_path: "/owner" })).rejects.toMatchObject({ code: "RD400" });
        await asPostgres(db);
        // The admin's own role cannot write the log either.
        await asUser(db, f.admin);
        expect((await sqlError(db, "select public.rpc_log_support_view($1, $2, '/admin/owners/x/support', null)", [f.admin, f.ownerA]))?.code).toBe("42501");
      });
    });

    it("an admin cannot write the owner's data: no table writes, no workflow functions", async () => {
      await isolated(db, async () => {
        await asUser(db, f.admin);
        // Updates match no row (no admin write policies) or are refused outright.
        for (const sql of [
          `update public.machines set notes = 'support' where id = '${f.machineASpare}'`,
          `update public.customers set phone = '000' where id = '${f.custA1}'`,
          `update public.service_requests set description = 'x' where owner_id = '${f.ownerA}'`,
        ]) {
          const error = await sqlError(db, sql);
          if (error) expect(error.code, sql).toBe("42501");
        }
        for (const sql of [
          `insert into public.machines (owner_id, brand, model, serial_no, type) values ('${f.ownerA}', 'X', 'Y', 'SUP-${f.tag}', 'MONO')`,
          `update public.invoices set total_cents = 0 where id = '${f.invoices.a2Mono}'`,
          `update public.owner_settings set meter_deadline_days = 9 where owner_id = '${f.ownerA}'`,
          `update public.platform_settings set meter_deadline_days = 9 where id`,
          `select public.rpc_verify_payment('${f.payments.a2Mono}', '${f.admin}', true, null, null)`,
        ]) {
          expect((await sqlError(db, sql))?.code, sql).toBe("42501");
        }
        await asPostgres(db);
        expect(await count(db, "select 1 from public.machines where notes = 'support' or serial_no = $1", [`SUP-${f.tag}`])).toBe(0);
        expect(await count(db, "select 1 from public.customers where phone = '000'")).toBe(0);
        // A workflow function called with the admin as actor refuses: the owner must act.
        expect((await sqlError(db, "select app.verify_payment($1, $2, true)", [f.payments.a2Mono, f.admin]))?.code).toBe("RD403");
        expect((await sqlError(db, "select app.update_owner_settings($1, '{\"meter_deadline_days\": 9}')", [f.admin]))?.code).toBe("RD403");
      });
    });
  });

  describe("settings (ADM-06, decision 82)", () => {
    const platformNow = async () => (await one<{ s: SettingsValues }>("select to_jsonb(p) - 'id' - 'updated_at' - 'sms_enabled' - 'whatsapp_enabled' as s from public.platform_settings p")).s;
    const dbProblems = async (s: SettingsValues) => (await one<{ p: string[] }>("select app.settings_problems($1::jsonb) as p", [JSON.stringify(s)])).p.map((x) => x.split(": ")[0]);

    it("the database rules = the TS rules", async () => {
      const base = await platformNow();
      expect(await dbProblems(base)).toEqual([]);
      const cases: SettingsValues[] = [
        { meter_deadline_days: 0 },
        { meter_reminder_days: [4, 2] },
        { meter_reminder_days: [2, 5] },
        { review_escalation_hours: 40 },
        { review_reminder_hours: [24, 72] },
        { payment_due_days: 91 },
        { payment_overdue_reminder_days: [1, 2, 3, 4, 5, 6, 7] },
        { service_admin_escalation_hours_urgent: 4 },
        { service_ack_hours_urgent: 30, service_admin_escalation_hours_urgent: 40 },
        { late_fee_enabled: true, late_fee_cents: 0 },
        { login_ip_max_failures: 4 },
        { session_idle_minutes: 800 },
        { email_monthly_limit: 50 },
        { email_essential_reserve: 101 },
        { agreement_end_notice_days: 181 },
        { weekly_summary_dow: 7 },
        { dispute_reminder_days: [3, 7] },
        { session_idle_minutes: 2.5 },
      ];
      for (const c of cases) {
        const s = { ...base, ...c };
        const ts = [...new Set(settingsProblems(s).map((p) => p.key))].sort();
        expect([...new Set(await dbProblems(s))].sort(), JSON.stringify(c)).toEqual(ts);
        expect(ts.length, JSON.stringify(c)).toBeGreaterThan(0);
      }
    });

    it("an admin change is validated and audited old -> new; anyone else is refused", async () => {
      await isolated(db, async () => {
        const rpc = pgRpc(db);
        const before = await one<{ meter_deadline_days: number }>("select meter_deadline_days from public.platform_settings");
        await asService(db);
        const r = await rpc("rpc_update_platform_settings", { p_actor_id: f.admin, p_changes: { meter_deadline_days: before.meter_deadline_days + 1, email_max_attempts: 5 } });
        expect(r).toEqual({ changed: ["meter_deadline_days"] });
        await expect(rpc("rpc_update_platform_settings", { p_actor_id: f.admin, p_changes: { meter_reminder_days: [2, 40] } })).rejects.toMatchObject({ code: "RD400", message: expect.stringContaining("meter_reminder_days") });
        await expect(rpc("rpc_update_platform_settings", { p_actor_id: f.admin, p_changes: { favourite_colour: 1 } })).rejects.toMatchObject({ code: "RD400", message: "Unknown setting: favourite_colour" });
        await expect(rpc("rpc_update_platform_settings", { p_actor_id: f.admin, p_changes: { meter_deadline_days: null } })).rejects.toMatchObject({ code: "RD400" });
        await expect(rpc("rpc_update_platform_settings", { p_actor_id: f.ownerA, p_changes: { meter_deadline_days: 6 } })).rejects.toMatchObject({ code: "RD403" });
        await asPostgres(db);
        const audit = await one<{ actor_id: string; action: string; details: { changes: Record<string, unknown[]> } }>(
          "select actor_id, action, details from public.audit_logs where entity = 'platform_settings' order by id desc limit 1",
        );
        expect(audit).toMatchObject({ actor_id: f.admin, action: "UPDATE" });
        expect(audit.details.changes.meter_deadline_days).toEqual([before.meter_deadline_days, before.meter_deadline_days + 1]);
        expect(Object.keys(audit.details.changes)).toEqual(["meter_deadline_days"]);
      });
    });

    it("owner overrides: validated against the defaults, audited, reset to default; only their own row", async () => {
      await isolated(db, async () => {
        const rpc = pgRpc(db);
        await asService(db);
        await rpc("rpc_update_owner_settings", { p_actor_id: f.ownerA, p_changes: { meter_deadline_days: 10, meter_reminder_days: [3, 6, 9], agreement_end_notice_days: 45 } });
        await asPostgres(db);
        expect(await one("select meter_deadline_days, meter_reminder_days, agreement_end_notice_days from public.owner_settings_effective where owner_id = $1", [f.ownerA])).toEqual({
          meter_deadline_days: 10,
          meter_reminder_days: [3, 6, 9],
          agreement_end_notice_days: 45,
        });
        expect(await one("select meter_deadline_days from public.owner_settings_effective where owner_id = $1", [f.ownerB])).not.toEqual({ meter_deadline_days: 10 });
        const audit = await one<{ actor_id: string; owner_id: string }>("select actor_id, owner_id from public.audit_logs where entity = 'owner_settings' order by id desc limit 1");
        expect(audit).toEqual({ actor_id: f.ownerA, owner_id: f.ownerA });
        await asService(db);
        // Reminders must stay before the (now default) deadline.
        await expect(rpc("rpc_update_owner_settings", { p_actor_id: f.ownerA, p_changes: { meter_deadline_days: null } })).rejects.toMatchObject({ code: "RD400" });
        await rpc("rpc_update_owner_settings", { p_actor_id: f.ownerA, p_changes: { meter_deadline_days: null, meter_reminder_days: null } });
        await expect(rpc("rpc_update_owner_settings", { p_actor_id: f.ownerA, p_changes: { login_max_failures: 3 } })).rejects.toMatchObject({ code: "RD400" });
        await expect(rpc("rpc_update_owner_settings", { p_actor_id: f.custA1, p_changes: { meter_deadline_days: 6 } })).rejects.toMatchObject({ code: "RD403" });
        await asPostgres(db);
        const eff = await one<{ meter_deadline_days: number }>("select meter_deadline_days from public.owner_settings_effective where owner_id = $1", [f.ownerA]);
        const platform = await one<{ meter_deadline_days: number }>("select meter_deadline_days from public.platform_settings");
        expect(eff.meter_deadline_days).toBe(platform.meter_deadline_days);
        // No direct client writes any more (migration 0034).
        await asUser(db, f.ownerA);
        expect((await sqlError(db, "update public.owner_settings set meter_deadline_days = 6 where owner_id = $1", [f.ownerA]))?.code).toBe("42501");
        expect((await sqlError(db, "insert into public.owner_settings (owner_id) values ($1)", [f.ownerB]))?.code).toBe("42501");
      });
    });
  });

  describe("agreement end reminder (AGR-03, decision 86)", () => {
    it("once per end date, within the owner's notice, with an essential email; a new end date reminds again", async () => {
      await isolated(db, async () => {
        const rpc = pgRpc(db);
        const run = async () => {
          const counts = { agreementsEnding: 0, skipped: 0 };
          await asService(db);
          try {
            await remindEndingAgreements(rpc, today, 50, counts);
          } finally {
            await asPostgres(db);
          }
          return counts;
        };
        await db.query("update public.rental_agreements set end_date = $2::date + 31 where id = $1", [f.agrA1Mono, today]);
        expect((await run()).agreementsEnding).toBe(0);
        await db.query("update public.rental_agreements set end_date = $2::date + 30 where id = $1", [f.agrA1Mono, today]);
        expect((await run()).agreementsEnding).toBe(1);
        expect((await run()).agreementsEnding).toBe(0);
        const n = await one<{ id: string; link: string; title: string }>("select id, link, title from public.notifications where user_id = $1 and event = 'agreement.ending'", [f.ownerA]);
        expect(n.link).toBe(`/owner/agreements/${f.agrA1Mono}`);
        expect(n.title).toBe("Agreement ending soon: Customer A1");
        expect(await count(db, "select 1 from public.notification_deliveries where notification_id = $1 and channel = 'EMAIL' and category = 'ESSENTIAL'", [n.id])).toBe(1);
        // A changed end date gets its own reminder; another owner's notice is their own.
        await db.query("update public.rental_agreements set end_date = $2::date + 5 where id = $1", [f.agrA1Mono, today]);
        expect((await run()).agreementsEnding).toBe(1);
        await db.query("update public.rental_agreements set end_date = $2::date + 40 where id = $1", [f.agrB1Mono, today]);
        await db.query("insert into public.owner_settings (owner_id, agreement_end_notice_days) values ($1, 60) on conflict (owner_id) do update set agreement_end_notice_days = 60", [f.ownerB]);
        expect((await run()).agreementsEnding).toBe(1);
        expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'agreement.ending'", [f.ownerB])).toBe(1);
      });
    });

    it("a terminated agreement or a suspended owner is not reminded", async () => {
      await isolated(db, async () => {
        await db.query("update public.rental_agreements set end_date = $2::date + 3 where id = any($1::uuid[])", [[f.agrA1Mono, f.agrB1Mono], today]);
        await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.ownerB]);
        const rows = (await one<{ r: { agreement_id: string }[] }>("select app.cron_ending_agreements($1::date) as r", [today])).r.map((x) => x.agreement_id);
        expect(rows).toContain(f.agrA1Mono);
        expect(rows).not.toContain(f.agrB1Mono);
      });
    });
  });

  it("the report and settings functions are where they should be (grants)", async () => {
    const { rows } = await db.query<{ name: string; definer: boolean; volatile: string; auth: boolean }>(
      `select p.proname as name, p.prosecdef as definer, p.provolatile as volatile,
              has_function_privilege('authenticated', p.oid, 'execute') as auth
       from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'report\\_%'`,
    );
    expect(rows.length).toBe(12);
    for (const r of rows) expect(r, r.name).toMatchObject({ definer: false, volatile: "s", auth: true });
  });
});
