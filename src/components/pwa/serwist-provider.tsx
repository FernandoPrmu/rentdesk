"use client";

import { SerwistProvider as BaseSerwistProvider } from "@serwist/next/react";
import type { ReactNode } from "react";

/** Registers /sw.js in production builds only, so dev never serves stale cached pages. */
export function SerwistProvider({ children }: { children: ReactNode }) {
  return (
    <BaseSerwistProvider swUrl="/sw.js" disable={process.env.NODE_ENV !== "production"}>
      {children}
    </BaseSerwistProvider>
  );
}
