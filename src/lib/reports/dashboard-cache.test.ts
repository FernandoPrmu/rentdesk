import { describe, expect, it, vi } from "vitest";

import { createDashboardCache, DashboardTimeout, withTimeout } from "./dashboard-cache";

function setup(ttlMs = 60_000, maxEntries = 3) {
  let t = 1_000;
  const cache = createDashboardCache<string>({ ttlMs, maxEntries, now: () => t });
  return { cache, advance: (ms: number) => (t += ms) };
}

describe("dashboard cache (task 11 load fix)", () => {
  it("reuses a fresh entry for the same tenant version; loads again after the TTL", async () => {
    const { cache, advance } = setup();
    const load = vi.fn(async () => "a");
    expect(await cache.get("owner:1", "v1", load)).toBe("a");
    advance(59_000);
    expect(await cache.get("owner:1", "v1", load)).toBe("a");
    expect(load).toHaveBeenCalledTimes(1);
    advance(1_000);
    await cache.get("owner:1", "v1", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("a newer change signal (an audited write) loads fresh data at once", async () => {
    const { cache } = setup();
    await cache.get("owner:1", "v1", async () => "old");
    expect(await cache.get("owner:1", "v2", async () => "new")).toBe("new");
    expect(await cache.get("owner:1", "v2", async () => "unused")).toBe("new");
  });

  it("an unknown signal (could not be read) still uses a young entry", async () => {
    const { cache, advance } = setup();
    await cache.get("owner:1", "v1", async () => "a");
    expect(await cache.get("owner:1", undefined, async () => "b")).toBe("a");
    advance(61_000);
    expect(await cache.get("owner:1", undefined, async () => "b")).toBe("b");
  });

  it("concurrent loads of one key share one query; failures are not cached", async () => {
    const { cache } = setup();
    let release!: (v: string) => void;
    const load = vi.fn(() => new Promise<string>((r) => (release = r)));
    const a = cache.get("owner:1", "v1", load);
    const b = cache.get("owner:1", "v1", load);
    release("x");
    expect(await Promise.all([a, b])).toEqual(["x", "x"]);
    expect(load).toHaveBeenCalledTimes(1);
    await expect(cache.get("owner:2", "v1", async () => Promise.reject(new Error("timeout")))).rejects.toThrow("timeout");
    expect(await cache.get("owner:2", "v1", async () => "ok")).toBe("ok");
  });

  it("keys are separate and the oldest entries go first", async () => {
    const { cache } = setup(60_000, 2);
    await cache.get("owner:1", "v", async () => "1");
    await cache.get("customer:9", "v", async () => "9");
    await cache.get("owner:3", "v", async () => "3");
    expect(cache.size).toBe(2);
    const load = vi.fn(async () => "1b");
    expect(await cache.get("owner:1", "v", load)).toBe("1b");
    cache.invalidate("owner:3");
    expect(cache.size).toBe(1);
  });

  it("withTimeout rejects after the limit; the load itself still finishes", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const slow = new Promise<string>((r) => setTimeout(() => ((done = true), r("late")), 5_000));
      const raced = withTimeout(slow, 4_000);
      vi.advanceTimersByTime(4_000);
      await expect(raced).rejects.toBeInstanceOf(DashboardTimeout);
      vi.advanceTimersByTime(1_000);
      expect(await slow).toBe("late");
      expect(done).toBe(true);
      await expect(withTimeout(Promise.resolve("fast"), 4_000)).resolves.toBe("fast");
    } finally {
      vi.useRealTimers();
    }
  });
});
