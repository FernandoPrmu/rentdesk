import { describe, expect, it } from "vitest";

import { cronNow, NOW_HEADER, timeOverrideAllowed } from "./time";

const REAL = new Date("2026-10-10T19:30:00Z");

describe("time override for testing (never in production)", () => {
  it("is allowed only outside production", () => {
    expect(timeOverrideAllowed("development", undefined)).toBe(true);
    expect(timeOverrideAllowed("test", "preview")).toBe(true);
    expect(timeOverrideAllowed("production", undefined)).toBe(false);
    expect(timeOverrideAllowed("development", "production")).toBe(false);
  });

  it("uses the real clock when nothing is asked", () => {
    expect(cronNow(new Request("http://x/api/cron/daily"), true, REAL)).toEqual({ ok: true, now: REAL, simulated: false });
  });

  it("reads the header or the query parameter", () => {
    const header = new Request("http://x/api/cron/daily", { headers: { [NOW_HEADER]: "2026-11-01T01:00:00+05:30" } });
    expect(cronNow(header, true, REAL)).toEqual({ ok: true, now: new Date("2026-10-31T19:30:00Z"), simulated: true });
    const query = new Request("http://x/api/cron/daily?now=2026-11-01T01:00:00Z");
    expect(cronNow(query, true, REAL)).toMatchObject({ ok: true, simulated: true });
  });

  it("is refused in production, even with a valid date", () => {
    const req = new Request("http://x/api/cron/daily?now=2026-11-01T01:00:00Z");
    expect(cronNow(req, false, REAL)).toEqual({ ok: false, error: expect.stringMatching(/not available in production/) });
  });

  it("needs a full date-time with a zone", () => {
    for (const bad of ["2026-11-01", "tomorrow", "2026-11-01T01:00", "2026-13-01T01:00:00Z"]) {
      expect(cronNow(new Request(`http://x/?now=${encodeURIComponent(bad)}`), true, REAL).ok, bad).toBe(false);
    }
  });
});
