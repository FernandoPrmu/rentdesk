import { describe, expect, it } from "vitest";

import {
  apiProjectRef,
  dbProjectRef,
  decide,
  isMissingLockError,
  parseEnvironment,
  type Probe,
  readViaRest,
  restHeaders,
  type Target,
  targetsFrom,
} from "./environment";

const REF = "gpviraoifdnakkigrfga";
const pgTarget: Target = { kind: "pg", url: "postgresql://x", label: "SUPABASE_DB_URL (project a)" };
const restTarget: Target = { kind: "rest", url: "https://b.supabase.co", key: "k", label: "NEXT_PUBLIC_SUPABASE_URL (project b)" };

function jsonResponse(status: number, body: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

describe("production lock", () => {
  it("reads only 'production' as production", () => {
    expect(parseEnvironment("production")).toBe("production");
    expect(parseEnvironment("development")).toBe("development");
    expect(parseEnvironment(null)).toBe("development");
    expect(parseEnvironment("PRODUCTION")).toBe("development");
  });

  it("treats a database without migration 0041 as development", () => {
    expect(isMissingLockError("42883")).toBe(true);
    expect(isMissingLockError("PGRST202")).toBe(true);
    expect(isMissingLockError("42501")).toBe(false);
    expect(isMissingLockError(undefined)).toBe(false);
  });

  it("reads project refs from API and database URLs", () => {
    expect(apiProjectRef(`https://${REF}.supabase.co`)).toBe(REF);
    expect(apiProjectRef("http://127.0.0.1:54321")).toBeNull();
    expect(dbProjectRef(`postgresql://postgres.${REF}:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`)).toBe(REF);
    expect(dbProjectRef(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toBe(REF);
    expect(dbProjectRef("postgresql://postgres:pw@localhost:5432/postgres")).toBeNull();
    expect(dbProjectRef("not a url")).toBeNull();
  });

  it("collects every database the env sources reach, once each, without secrets in labels", () => {
    const env = {
      SUPABASE_DB_URL: `postgresql://postgres.${REF}:secret-pw@host:5432/postgres`,
      NEXT_PUBLIC_SUPABASE_URL: `https://${REF}.supabase.co/`,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key",
    };
    const targets = targetsFrom([env, { ...env }, { NEXT_PUBLIC_SUPABASE_URL: "https://other.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "svc" }]);
    expect(targets.map((t) => t.kind)).toEqual(["pg", "rest", "rest"]);
    expect(targets[1]).toMatchObject({ url: `https://${REF}.supabase.co`, key: "anon-key" });
    expect(targets[2]).toMatchObject({ key: "svc" });
    for (const t of targets) expect(t.label).not.toMatch(/secret-pw|anon-key|svc/);
    expect(targetsFrom([{ NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co" }])).toEqual([]); // no key: nothing reachable
    expect(targetsFrom([{}])).toEqual([]);
  });

  it("sends new keys as apikey only and legacy JWT keys also as the bearer", () => {
    expect(restHeaders("sb_publishable_abc")).not.toHaveProperty("Authorization");
    expect(restHeaders("aaa.bbb.ccc").Authorization).toBe("Bearer aaa.bbb.ccc");
  });

  it("reads the flag through the Data API", async () => {
    await expect(readViaRest("https://x.supabase.co", "k", jsonResponse(200, "production"))).resolves.toBe("production");
    await expect(readViaRest("https://x.supabase.co", "k", jsonResponse(200, "development"))).resolves.toBe("development");
    await expect(readViaRest("https://x.supabase.co", "k", jsonResponse(404, { code: "PGRST202" }))).resolves.toBe("development");
    await expect(readViaRest("https://x.supabase.co", "k", jsonResponse(401, { message: "Invalid API key" }))).rejects.toThrow("401");
  });

  it("refuses when any database is production, naming it", () => {
    const probes: Probe[] = [
      { target: pgTarget, ok: true, environment: "development" },
      { target: restTarget, ok: true, environment: "production" },
    ];
    const d = decide("npm run test:db", probes);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.message).toContain("Refusing to run npm run test:db");
      expect(d.message).toContain("PRODUCTION");
      expect(d.message).toContain("project b");
      expect(d.message).not.toContain("project a");
    }
  });

  it("fails closed when a configured database cannot be checked", () => {
    const d = decide("npm run dev", [{ target: pgTarget, ok: false, error: "timeout" }]);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.message).toMatch(/could not confirm.*\n.*timeout/);
  });

  it("allows development databases, and nothing configured", () => {
    expect(decide("x", [{ target: pgTarget, ok: true, environment: "development" }])).toEqual({ allowed: true, checked: 1 });
    expect(decide("x", [])).toEqual({ allowed: true, checked: 0 });
  });
});
