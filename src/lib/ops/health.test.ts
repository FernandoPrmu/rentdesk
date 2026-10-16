import { describe, expect, it } from "vitest";

import { checkHealth } from "./health";

const NOW = new Date("2026-10-20T00:00:00Z");
const base = { supabaseUrl: "https://abc.supabase.co", anonKey: "sb_publishable_secret", version: "1.0.0", build: "dpl_1", now: NOW };
const answer = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;

describe("/api/health (decision 99)", () => {
  it("200 when the database answers, with version and build only", async () => {
    const r = await checkHealth({ ...base, fetchImpl: answer(200, "production") });
    expect(r).toEqual({ status: 200, body: { ok: true, version: "1.0.0", build: "dpl_1", db: "ok", checkedAt: NOW.toISOString() } });
    // Not even the environment, the URL or the key leaks.
    expect(JSON.stringify(r.body)).not.toMatch(/production|abc\.supabase|sb_publishable|secret/);
  });

  it("503 when the database errors, times out or is not configured", async () => {
    expect(await checkHealth({ ...base, fetchImpl: answer(500, { message: "boom" }) })).toMatchObject({ status: 503, body: { ok: false, db: "down" } });
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("timeout"))))) as typeof fetch;
    expect(await checkHealth({ ...base, fetchImpl: hang, timeoutMs: 20 })).toMatchObject({ status: 503, body: { db: "down" } });
    const network = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await checkHealth({ ...base, fetchImpl: network })).toMatchObject({ status: 503, body: { db: "down" } });
    expect(await checkHealth({ ...base, supabaseUrl: undefined })).toMatchObject({ status: 503, body: { ok: false, db: "not_configured" } });
  });
});
