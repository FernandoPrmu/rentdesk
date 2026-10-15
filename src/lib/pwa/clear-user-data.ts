import { isKeptCache } from "./cache-policy.ts";
import { INSTALL_PROMPT_KEY } from "./install.ts";

/**
 * Clears what a signed-in user may have left in this browser (decision 88): every
 * cache except the static ones, device drafts (meter readings, payment details and
 * their idempotency keys) and session storage. Runs when /login opens, which every
 * sign-out ends on (by choice, idle timeout, blocked account), so it also covers a
 * sign-out the server forced. Keeps only whether the install card was dismissed.
 */
export type ClearTargets = {
  caches?: Pick<CacheStorage, "keys" | "delete"> | null;
  local?: Pick<Storage, "length" | "key" | "removeItem"> | null;
  session?: Pick<Storage, "clear"> | null;
};

export async function clearUserData(targets: ClearTargets): Promise<{ caches: string[]; keys: string[] }> {
  const removedCaches: string[] = [];
  const removedKeys: string[] = [];

  if (targets.local) {
    const keys: string[] = [];
    for (let i = 0; i < targets.local.length; i++) {
      const k = targets.local.key(i);
      if (k !== null && k !== INSTALL_PROMPT_KEY) keys.push(k);
    }
    for (const k of keys) {
      targets.local.removeItem(k);
      removedKeys.push(k);
    }
  }
  targets.session?.clear();

  if (targets.caches) {
    for (const name of await targets.caches.keys()) {
      if (isKeptCache(name)) continue;
      await targets.caches.delete(name);
      removedCaches.push(name);
    }
  }
  return { caches: removedCaches, keys: removedKeys };
}

/** The browser's own storage, each part skipped when the browser refuses access. */
export function browserTargets(): ClearTargets {
  const safe = <T>(get: () => T): T | null => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  return {
    caches: safe(() => ("caches" in window ? window.caches : null)),
    local: safe(() => window.localStorage),
    session: safe(() => window.sessionStorage),
  };
}
