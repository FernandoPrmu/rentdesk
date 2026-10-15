"use client";

import { SerwistProvider as BaseSerwistProvider } from "@serwist/next/react";
import type { ReactNode } from "react";

import "@/lib/zod-client";

/**
 * Registers /sw.js in production builds only, so dev never serves stale cached pages.
 * `cacheOnNavigation` is off: it would ask the worker to fetch every visited page
 * again (the worker never stores pages, decision 88, so it was only extra load).
 * `reloadOnOnline` is off: the offline page reloads itself, and a form being filled
 * in must never be reloaded away.
 */
export function SerwistProvider({ children }: { children: ReactNode }) {
  return (
    <BaseSerwistProvider swUrl="/sw.js" disable={process.env.NODE_ENV !== "production"} cacheOnNavigation={false} reloadOnOnline={false}>
      {children}
    </BaseSerwistProvider>
  );
}
