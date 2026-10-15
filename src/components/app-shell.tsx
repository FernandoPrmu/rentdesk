import Link from "next/link";
import type { ReactNode } from "react";

import { APP_NAME } from "@/lib/brand";
import { cn } from "@/lib/utils";

/**
 * Mobile-first page frame for pages outside the portals (landing, login, password
 * change, owner setup): sticky top bar and a single centred column (360 px first).
 */
export function AppShell({ children, wide = false, headerRight }: { children: ReactNode; wide?: boolean; headerRight?: ReactNode }) {
  const width = wide ? "max-w-2xl" : "max-w-md";
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <a
        href="#main"
        className="sr-only z-50 rounded-md bg-background px-4 py-3 text-base font-medium text-foreground shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:outline-2 focus:outline-primary"
      >
        Skip to content
      </a>
      <header className="sticky top-0 z-10 bg-primary pt-[env(safe-area-inset-top)] text-primary-foreground">
        <div className={cn("mx-auto flex h-14 w-full items-center px-4", width)}>
          <Link href="/" className="text-lg font-semibold tracking-tight">
            {APP_NAME}
          </Link>
          {headerRight && <div className="ml-auto">{headerRight}</div>}
        </div>
      </header>
      <main id="main" tabIndex={-1} className={cn("mx-auto flex w-full flex-1 flex-col px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] outline-none", width)}>
        {children}
      </main>
    </div>
  );
}
