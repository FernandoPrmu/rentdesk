import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assertNotProduction, nextEnv, ProductionLockError } from "./production-lock";

/** A stand-in for the Data API's rentdesk_environment(). */
let server: Server;
let base = "";
let answer: { status: number; body: unknown } = { status: 200, body: "development" };

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url !== "/rest/v1/rpc/rentdesk_environment" || !req.headers.apikey) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(answer.status, { "Content-Type": "application/json" }).end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("assertNotProduction", () => {
  const env = () => ({ NEXT_PUBLIC_SUPABASE_URL: base, NEXT_PUBLIC_SUPABASE_ANON_KEY: "sb_publishable_test" });

  it("lets a development database through", async () => {
    answer = { status: 200, body: "development" };
    await expect(assertNotProduction("npm run dev", [env()])).resolves.toBeUndefined();
  });

  it("refuses a production database, whatever else is set", async () => {
    answer = { status: 200, body: "production" };
    const withOverrides = { ...env(), ALLOW_PRODUCTION: "1", FORCE: "true", APP_ENV: "development", NODE_ENV: "test" };
    await expect(assertNotProduction("npm run dev", [withOverrides])).rejects.toBeInstanceOf(ProductionLockError);
    await expect(assertNotProduction("npm run dev", [withOverrides])).rejects.toThrow(/PRODUCTION/);
  });

  it("refuses when the database cannot be reached", async () => {
    answer = { status: 503, body: { message: "down" } };
    await expect(assertNotProduction("npm run test:db", [env()])).rejects.toThrow(/could not confirm/);
  });
});

describe("nextEnv", () => {
  it("sees what next dev and next start would load, and leaves process.env alone", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "rentdesk-env-"));
    const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_DB_URL"] as const;
    const saved = keys.map((k) => process.env[k]);
    for (const k of keys) delete process.env[k]; // Next never overrides variables already set
    try {
      writeFileSync(path.join(dir, ".env.local"), "NEXT_PUBLIC_SUPABASE_URL=https://dev.supabase.co\n");
      writeFileSync(path.join(dir, ".env.production.local"), "SUPABASE_DB_URL=postgresql://postgres.prod:x@h/postgres\n");
      const before = { ...process.env };
      const dev = nextEnv(true, dir);
      const start = nextEnv(false, dir);
      expect(dev.NEXT_PUBLIC_SUPABASE_URL).toBe("https://dev.supabase.co");
      expect(dev.SUPABASE_DB_URL).toBeUndefined();
      // next build / next start load .env.production.local: the guard checks that too.
      expect(start.SUPABASE_DB_URL).toBe("postgresql://postgres.prod:x@h/postgres");
      expect(start.NEXT_PUBLIC_SUPABASE_URL).toBe("https://dev.supabase.co");
      expect(process.env).toEqual(before);
    } finally {
      keys.forEach((k, i) => {
        if (saved[i] === undefined) delete process.env[k];
        else process.env[k] = saved[i];
      });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
