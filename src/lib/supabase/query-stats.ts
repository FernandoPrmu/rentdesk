import { appendFileSync } from "node:fs";

/**
 * QUERY_STATS=1 (non-production measurement, task 11): every Supabase request the
 * server makes is timed and appended as one JSON line to QUERY_STATS_FILE (default
 * `query-stats.log`): { at, ms, client, method, path }. `e2e/measure.spec.ts` opens
 * one page at a time and sums the lines per page. Off by default: no wrapper at all.
 */
export function statsFetch(client: "user" | "service"): typeof fetch | undefined {
  if (process.env.QUERY_STATS !== "1") return undefined;
  const file = process.env.QUERY_STATS_FILE ?? "query-stats.log";
  return async (input, init) => {
    const started = performance.now();
    try {
      return await fetch(input, init);
    } finally {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const line = { at: Date.now(), ms: Math.round(performance.now() - started), client, method: init?.method ?? "GET", path: url.pathname };
      try {
        appendFileSync(file, `${JSON.stringify(line)}\n`);
      } catch {
        // Measurement only.
      }
    }
  };
}
