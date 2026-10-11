"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False while the server-rendered page is still waiting for its JavaScript, true
 * once it is interactive. Buttons that run a Server Action through onClick stay
 * disabled until then: on a slow phone a tap before that would silently do nothing.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
