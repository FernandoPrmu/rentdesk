import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asPostgres, asService, begin, connect, count, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";

/** Account functions from migration 0013, called as server code (service role). */
describe.skipIf(!DB_URL)("account functions (linked dev database, rolled back)", () => {
  let db: pg.Client;
  let f: Fixture;
  let ownerAName: string;

  beforeAll(async () => {
    db = await connect();
    await begin(db);
    f = await createFixture(db);
    ownerAName = `t-owner-a-${f.tag}`;
  });

  afterAll(async () => {
    await db?.query("rollback");
    await db?.end();
  });

  async function rpc<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    const { rows } = await db.query(`select ${sql} as r`, params);
    return rows[0].r as T;
  }

  async function profile(id: string) {
    const { rows } = await db.query(
      "select status, must_change_password, failed_login_count, locked_until, last_login_at from public.profiles where id = $1",
      [id],
    );
    return rows[0];
  }

  const fail = (username: string, ip = "203.0.113.7") =>
    rpc<{ failures: number; locked_until: string | null }>(
      "public.rpc_record_login_attempt($1, $2::inet, false, 'invalid_credentials')",
      [username, ip],
    );

  describe("login lockout (AUTH-08)", () => {
    it("locks an account after 5 failures, and a success clears it", async () => {
      await isolated(db, async () => {
        await asService(db);
        for (let i = 1; i <= 4; i++) {
          const r = await fail(ownerAName);
          expect(r.failures).toBe(i);
          expect(r.locked_until).toBeNull();
        }
        expect((await profile(f.ownerA)).failed_login_count).toBe(4);

        const fifth = await fail(ownerAName);
        expect(fifth.locked_until).not.toBeNull();
        const p = await profile(f.ownerA);
        expect(p.locked_until).not.toBeNull();
        expect(p.failed_login_count).toBe(0);

        const gate = await rpc<{ locked_until: string; username_failures: number; policy: { max_failures: number } }>(
          "public.rpc_login_gate_state($1, $2::inet)",
          [ownerAName, "203.0.113.7"],
        );
        expect(gate.locked_until).not.toBeNull();
        expect(gate.username_failures).toBe(5);
        expect(gate.policy.max_failures).toBe(5);

        await asPostgres(db);
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'LOCKOUT'", [f.ownerA])).toBe(1);
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'LOGIN_FAILED'", [f.ownerA])).toBe(5);

        await asService(db);
        await rpc("public.rpc_record_login_attempt($1, $2::inet, true)", [ownerAName, "203.0.113.7"]);
        const after = await profile(f.ownerA);
        expect(after.locked_until).toBeNull();
        expect(after.last_login_at).not.toBeNull();
        const reset = await rpc<{ username_failures: number }>("public.rpc_login_gate_state($1, null)", [ownerAName]);
        expect(reset.username_failures).toBe(0);

        await asPostgres(db);
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'LOGIN'", [f.ownerA])).toBe(1);
      });
    });

    it("locks unknown usernames the same way, and counts failures per IP", async () => {
      await isolated(db, async () => {
        await asService(db);
        const ghost = `nobody-${f.tag}`;
        let last;
        for (let i = 0; i < 5; i++) last = await fail(ghost, "198.51.100.9");
        expect(last!.locked_until).not.toBeNull();

        const gate = await rpc<{ locked_until: string | null; username_failures: number; ip_failures: number }>(
          "public.rpc_login_gate_state($1, $2::inet)",
          [ghost, "198.51.100.9"],
        );
        expect(gate.locked_until).toBeNull(); // no profile
        expect(gate.username_failures).toBe(5);
        expect(gate.ip_failures).toBe(5);
      });
    });

    it("does not count attempts refused by the gate", async () => {
      await isolated(db, async () => {
        await asService(db);
        await rpc("public.rpc_record_login_attempt($1, null, false, 'locked')", [ownerAName]);
        await rpc("public.rpc_record_login_attempt($1, null, false, 'ip_limited')", [ownerAName]);
        const gate = await rpc<{ username_failures: number }>("public.rpc_login_gate_state($1, null)", [ownerAName]);
        expect(gate.username_failures).toBe(0);
        expect((await sqlError(db, "select public.rpc_record_login_attempt('x', null, false, null)"))?.code).toBe("RD400");
      });
    });
  });

  describe("status changes (ADM-02, CUS-03, AUTH-10)", () => {
    it("admin suspends an owner; the reason is audited and the owner notified", async () => {
      await isolated(db, async () => {
        await asService(db);
        const r = await rpc<{ from: string; to: string }>(
          "public.rpc_set_account_status($1, $2, 'SUSPENDED', 'Unpaid subscription')",
          [f.admin, f.ownerA],
        );
        expect(r).toMatchObject({ from: "ACTIVE", to: "SUSPENDED" });

        const state = await rpc<{ owner_status: string }>("public.rpc_session_state($1)", [f.custA1]);
        expect(state.owner_status).toBe("SUSPENDED");

        await asPostgres(db);
        const { rows } = await db.query(
          "select actor_id, details from public.audit_logs where entity_id = $1 and action = 'STATUS_CHANGE'",
          [f.ownerA],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].actor_id).toBe(f.admin);
        expect(rows[0].details.reason).toBe("Unpaid subscription");
        expect(await count(db, "select 1 from public.notifications where user_id = $1 and event = 'account.suspended'", [f.ownerA])).toBe(1);

        // A suspended owner can no longer manage their customers.
        await asService(db);
        expect((await sqlError(db, "select public.rpc_set_account_status($1, $2, 'SUSPENDED', 'x')", [f.ownerA, f.custA1]))?.code).toBe("RD403");
        // Reactivation.
        await rpc("public.rpc_set_account_status($1, $2, 'ACTIVE', 'Paid')", [f.admin, f.ownerA]);
        expect((await profile(f.ownerA)).status).toBe("ACTIVE");
      });
    });

    it("an owner manages only their own customers; nobody else may", async () => {
      await isolated(db, async () => {
        await asService(db);
        await rpc("public.rpc_set_account_status($1, $2, 'SUSPENDED', 'Late payments')", [f.ownerA, f.custA1]);
        expect((await profile(f.custA1)).status).toBe("SUSPENDED");

        const denied: [string, string][] = [
          [f.ownerB, f.custA1], // another tenant's customer
          [f.ownerA, f.ownerB], // an owner
          [f.ownerA, f.ownerA], // themself
          [f.admin, f.custA1], // admin manages owners, not customers
          [f.custA2, f.custA1], // a customer
          [f.ownerA, f.admin], // an admin
        ];
        for (const [actor, target] of denied) {
          const err = await sqlError(db, "select public.rpc_set_account_status($1, $2, 'DEACTIVATED', 'x')", [actor, target]);
          expect(err?.code, `${actor} -> ${target}`).toBe("RD403");
        }
        expect((await sqlError(db, "select public.rpc_set_account_status($1, $2, 'ACTIVE', '  ')", [f.ownerA, f.custA1]))?.code).toBe("RD400");
        expect((await sqlError(db, "select public.rpc_set_account_status($1, $2, 'SUSPENDED', 'again')", [f.ownerA, f.custA1]))?.code).toBe("RD409");
      });
    });
  });

  describe("passwords (AUTH-03, AUTH-05)", () => {
    it("reset forces a change and clears a lockout; only the parent may reset", async () => {
      await isolated(db, async () => {
        await asService(db);
        await db.query("update public.profiles set locked_until = now() + interval '10 minutes' where id = $1", [f.custA1]);
        await rpc("public.rpc_reset_account_password($1, $2)", [f.ownerA, f.custA1]);
        const p = await profile(f.custA1);
        expect(p.must_change_password).toBe(true);
        expect(p.locked_until).toBeNull();

        // Already flagged: still audited explicitly.
        await rpc("public.rpc_reset_account_password($1, $2)", [f.ownerA, f.custA1]);
        await asPostgres(db);
        expect(await count(db, "select 1 from public.audit_logs where entity_id = $1 and action = 'PASSWORD_RESET'", [f.custA1])).toBe(2);

        await asService(db);
        expect((await sqlError(db, "select public.rpc_reset_account_password($1, $2)", [f.ownerB, f.custA1]))?.code).toBe("RD403");
        expect((await sqlError(db, "select public.rpc_reset_account_password($1, $2)", [f.ownerA, f.ownerB]))?.code).toBe("RD403");
        await rpc("public.rpc_reset_account_password($1, $2)", [f.admin, f.ownerB]);

        await rpc("public.rpc_complete_password_change($1)", [f.custA1]);
        expect((await profile(f.custA1)).must_change_password).toBe(false);
        await asPostgres(db);
        const { rows } = await db.query(
          "select actor_id from public.audit_logs where entity_id = $1 and action = 'PASSWORD_CHANGED'",
          [f.custA1],
        );
        expect(rows.map((r) => r.actor_id)).toEqual([f.custA1]);
      });
    });
  });

  describe("account details (ADM-01, CUS-01)", () => {
    it("admin edits owners and owners edit their own customers", async () => {
      await isolated(db, async () => {
        await asService(db);
        await rpc("public.rpc_update_owner($1, $2, $3::jsonb)", [
          f.admin, f.ownerA, JSON.stringify({ business_name: "Renamed Copiers", contact_person: "New Contact", phone: null }),
        ]);
        const { rows: owners } = await db.query("select business_name, contact_person, phone from public.owners where id = $1", [f.ownerA]);
        expect(owners[0]).toEqual({ business_name: "Renamed Copiers", contact_person: "New Contact", phone: null });

        await rpc("public.rpc_update_customer($1, $2, $3::jsonb)", [f.ownerA, f.custA1, JSON.stringify({ name: "A1 Renamed", phone: "0770000000" })]);
        const { rows: customers } = await db.query("select name, phone from public.customers where id = $1", [f.custA1]);
        expect(customers[0]).toEqual({ name: "A1 Renamed", phone: "0770000000" });
        const { rows: names } = await db.query("select full_name from public.profiles where id = $1", [f.custA1]);
        expect(names[0].full_name).toBe("A1 Renamed");

        expect((await sqlError(db, "select public.rpc_update_owner($1, $2, '{}'::jsonb)", [f.ownerA, f.ownerA]))?.code).toBe("RD403");
        expect((await sqlError(db, "select public.rpc_update_customer($1, $2, '{}'::jsonb)", [f.ownerB, f.custA1]))?.code).toBe("RD403");
        expect((await sqlError(db, "select public.rpc_update_customer($1, $2, '{}'::jsonb)", [f.admin, f.custA1]))?.code).toBe("RD403");
      });
    });
  });

  describe("company setup (BRD-01, BRD-03)", () => {
    const details = (logo?: string | null) => JSON.stringify({
      company_name: "Owner B Copiers Ltd",
      address: "1 Main Street",
      phone: "0811234567",
      email: "b@example.com",
      bank_name: "BOC",
      bank_branch: null,
      bank_account_name: "Owner B",
      bank_account_no: "123",
      ...(logo !== undefined ? { logo_path: logo } : {}),
    });

    it("the first save completes onboarding; later saves keep the date and the logo", async () => {
      await isolated(db, async () => {
        await asService(db);
        expect((await rpc<{ onboarded: boolean }>("public.rpc_session_state($1)", [f.ownerB])).onboarded).toBe(false);
        expect((await rpc<{ onboarded: boolean }>("public.rpc_session_state($1)", [f.custB1])).onboarded).toBe(true);

        const first = await rpc<{ onboarding_completed_at: string }>("public.rpc_save_company_profile($1, $2::jsonb)", [
          f.ownerB, details(`${f.ownerB}/logo.png`),
        ]);
        expect(first.onboarding_completed_at).not.toBeNull();
        expect((await rpc<{ onboarded: boolean }>("public.rpc_session_state($1)", [f.ownerB])).onboarded).toBe(true);

        const second = await rpc<{ onboarding_completed_at: string }>("public.rpc_save_company_profile($1, $2::jsonb)", [f.ownerB, details()]);
        expect(second.onboarding_completed_at).toBe(first.onboarding_completed_at);
        const { rows } = await db.query("select company_name, logo_path from public.owner_company_profiles where owner_id = $1", [f.ownerB]);
        expect(rows[0]).toEqual({ company_name: "Owner B Copiers Ltd", logo_path: `${f.ownerB}/logo.png` });

        await rpc("public.rpc_save_company_profile($1, $2::jsonb)", [f.ownerB, details(null)]);
        const { rows: removed } = await db.query("select logo_path from public.owner_company_profiles where owner_id = $1", [f.ownerB]);
        expect(removed[0].logo_path).toBeNull();

        expect((await sqlError(db, "select public.rpc_save_company_profile($1, $2::jsonb)", [f.ownerB, details(`${f.ownerA}/logo.png`)]))?.code).toBe("RD400");
        expect((await sqlError(db, "select public.rpc_save_company_profile($1, $2::jsonb)", [f.custB1, details()]))?.code).toBe("RD403");
        expect((await sqlError(db, "select public.rpc_save_company_profile($1, $2::jsonb)", [f.admin, details()]))?.code).toBe("RD403");
      });
    });
  });

  describe("custom access token hook", () => {
    const event = (userId: string, method = "password") =>
      JSON.stringify({ user_id: userId, authentication_method: method, claims: { sub: userId, role: "authenticated" } });

    async function hook(userId: string, method?: string) {
      return rpc<{ claims?: { sub: string }; error?: { http_code: number; message: string } }>(
        "public.custom_access_token_hook($1::jsonb)",
        [event(userId, method)],
      );
    }

    it("is executable only by supabase_auth_admin", async () => {
      const { rows } = await db.query(`
        select has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'execute') as auth_admin,
               has_function_privilege('anon', 'public.custom_access_token_hook(jsonb)', 'execute') as anon,
               has_function_privilege('authenticated', 'public.custom_access_token_hook(jsonb)', 'execute') as authenticated`);
      expect(rows[0]).toEqual({ auth_admin: true, anon: false, authenticated: false });
    });

    it("passes active users and refuses blocked or locked ones", async () => {
      await isolated(db, async () => {
        await asPostgres(db);
        expect((await hook(f.custA1)).claims?.sub).toBe(f.custA1);
        expect((await hook("00000000-0000-4000-8000-000000000000")).error?.message).toBe("RD_BLOCKED:NO_PROFILE");

        await db.query("update public.profiles set locked_until = now() + interval '5 minutes' where id = $1", [f.custA2]);
        expect((await hook(f.custA2, "password")).error).toEqual({ http_code: 403, message: "RD_BLOCKED:LOCKED" });
        expect((await hook(f.custA2, "token_refresh")).claims?.sub).toBe(f.custA2);

        await db.query("update public.profiles set status = 'SUSPENDED' where id = $1", [f.ownerA]);
        expect((await hook(f.ownerA)).error?.message).toBe("RD_BLOCKED:SUSPENDED");
        expect((await hook(f.custA1, "token_refresh")).error?.message).toBe("RD_BLOCKED:OWNER_INACTIVE");
        expect((await hook(f.custB1)).claims?.sub).toBe(f.custB1);

        await db.query("update public.profiles set status = 'DEACTIVATED' where id = $1", [f.custB1]);
        expect((await hook(f.custB1)).error?.message).toBe("RD_BLOCKED:DEACTIVATED");
      });
    });
  });
});
