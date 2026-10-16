import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { asAnon, asPostgres, asService, asUser, begin, connect, DB_URL, isolated, sqlError } from "./db";
import { createFixture, type Fixture } from "./fixtures";
import { pgRpc } from "./rpc";

/**
 * Task 13: the production lock (migration 0041, decision 95), against the linked dev
 * database inside a throwaway transaction. Setting the flag here is never committed, so
 * no other connection ever sees it.
 */
describe.skipIf(!DB_URL)("production lock (linked dev database, rolled back)", () => {
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

  const env = async () => (await db.query<{ e: string }>("select public.rentdesk_environment() as e")).rows[0].e;
  const setFlag = (value: string) => sqlError(db, "update public.platform_settings set environment = $1", [value]);

  it("a database built from the migrations is development, and only two values exist", async () => {
    await isolated(db, async () => {
      const { rows } = await db.query("select column_default from information_schema.columns where table_schema = 'public' and table_name = 'platform_settings' and column_name = 'environment'");
      expect(rows[0].column_default).toBe("'development'::text");
      expect(await env()).toBe("development");
      expect((await setFlag("staging"))?.code).toBe("23514");
    });
  });

  it("anon, signed-in users and the service role can read the flag, nothing else", async () => {
    await isolated(db, async () => {
      for (const actAs of [() => asAnon(db), () => asUser(db, f.custA1), () => asService(db)]) {
        await actAs();
        expect(await env()).toBe("development");
        await asPostgres(db);
      }
      const { rows } = await db.query(
        "select prosecdef, provolatile, proconfig from pg_proc where oid = 'public.rentdesk_environment()'::regprocedure",
      );
      expect(rows[0]).toMatchObject({ prosecdef: true, provolatile: "s", proconfig: ["search_path=\"\""] });
    });
  });

  it("the go-live script's direct postgres session sets production; every reader then sees it", async () => {
    await isolated(db, async () => {
      expect(await setFlag("production")).toBeNull();
      expect(await env()).toBe("production");
      await asAnon(db);
      expect(await env()).toBe("production");
      await asPostgres(db);
    });
  });

  it("production never goes back to development", async () => {
    await isolated(db, async () => {
      expect(await setFlag("production")).toBeNull();
      const back = await setFlag("development");
      expect(back).toMatchObject({ code: "RD403", message: expect.stringContaining("cannot be changed back") });
      expect(await env()).toBe("production");
      // Other settings still save in production.
      expect(await sqlError(db, "update public.platform_settings set meter_deadline_days = meter_deadline_days")).toBeNull();
    });
  });

  it("the service role and the admin's settings function cannot set it", async () => {
    await isolated(db, async () => {
      await asService(db);
      expect(await setFlag("production")).toMatchObject({ code: "RD403", message: expect.stringContaining("go-live script") });
      await asPostgres(db);
      const rpc = pgRpc(db);
      await expect(rpc("rpc_update_platform_settings", { p_actor_id: f.admin, p_changes: { environment: "production" } })).rejects.toMatchObject({
        code: "RD400",
        message: "Unknown setting: environment",
      });
      expect(await env()).toBe("development");
    });
  });

  it("the trigger checks both the session user and the current role", async () => {
    await isolated(db, async () => {
      const { rows } = await db.query<{ src: string }>("select prosrc as src from pg_proc where oid = 'app.guard_platform_environment'::regproc");
      expect(rows[0].src).toContain("session_user <> 'postgres' or current_user <> 'postgres'");
    });
  });
});
