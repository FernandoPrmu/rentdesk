import { expect, test } from "@playwright/test";

import packageJson from "../package.json" with { type: "json" };

/** /api/health for the uptime monitor (decision 99): public, no secrets, never cached. */
test("health check answers with the version and a working database", async ({ request }) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toContain("no-store");
  const body = await res.json();
  expect(body).toEqual({ ok: true, version: packageJson.version, build: expect.any(String), db: "ok", checkedAt: expect.any(String) });
  expect(Object.keys(body).sort()).toEqual(["build", "checkedAt", "db", "ok", "version"]);
});
