/**
 * Short-lived dashboard cache (task 11 load fix, decision 84). Home pages are opened
 * far more often than a tenant's data changes, and each dashboard runs a query whose
 * cost is mostly RLS evaluation. An entry is reused while
 *   - it is younger than `ttlMs` (60 s), and
 *   - the tenant's change signal (`version`: the newest audit entry of that owner) is
 *     the same; any audited write for the owner makes the next Home read fresh data.
 * When the signal could not be read (`version` undefined) a young entry is still used.
 * Concurrent loads of the same key share one query. In memory, per server instance.
 * Pure: the clock is injectable; the server module wires the database.
 */

export interface DashboardCacheOptions {
  ttlMs: number;
  maxEntries: number;
  now?: () => number;
}

interface Entry<T> {
  version: string | null;
  at: number;
  value: T;
}

export interface DashboardCache<T> {
  /**
   * The cached value for `key` when it is fresh for `version`, otherwise `load()`
   * (shared with any load of the same key and version already running).
   */
  get(key: string, version: string | null | undefined, load: () => Promise<T>): Promise<T>;
  invalidate(key: string): void;
  readonly size: number;
}

export function createDashboardCache<T>(options: DashboardCacheOptions): DashboardCache<T> {
  const now = options.now ?? (() => Date.now());
  const entries = new Map<string, Entry<T>>();
  const inflight = new Map<string, Promise<T>>();

  const fresh = (e: Entry<T> | undefined, version: string | null | undefined): boolean =>
    !!e && now() - e.at < options.ttlMs && (version === undefined || e.version === version);

  return {
    get(key, version, load) {
      const entry = entries.get(key);
      if (entry && fresh(entry, version)) return Promise.resolve(entry.value);
      const flight = `${key}\u0000${version ?? "?"}`;
      const running = inflight.get(flight);
      if (running) return running;
      const started = now();
      const promise = load()
        .then((value) => {
          // Re-insert so the Map's order is least recently written first.
          entries.delete(key);
          entries.set(key, { version: version ?? entry?.version ?? null, at: started, value });
          while (entries.size > options.maxEntries) entries.delete(entries.keys().next().value as string);
          return value;
        })
        .finally(() => inflight.delete(flight));
      inflight.set(flight, promise);
      return promise;
    },
    invalidate(key) {
      entries.delete(key);
    },
    get size() {
      return entries.size;
    },
  };
}

export class DashboardTimeout extends Error {
  constructor(ms: number) {
    super(`dashboard took longer than ${ms} ms`);
    this.name = "DashboardTimeout";
  }
}

/**
 * Rejects with DashboardTimeout after `ms`. The underlying load keeps running and, when
 * it finishes, fills the cache, so "Try again" usually gets the answer at once.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DashboardTimeout(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
