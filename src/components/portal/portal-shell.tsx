import { type ReactNode, Suspense } from "react";

import { BottomNav, type Portal, SidebarNav } from "@/components/portal/portal-nav";
import { cn } from "@/lib/utils";

/**
 * Frame for the three portals. Customers get a phone-style single column with a
 * bottom bar on every screen size; owners and admins get a sidebar from md up and
 * the bottom bar below it. `brand` and `account` read the session, so they stream
 * in behind their own Suspense boundaries; so does the page.
 */
export function PortalShell({
  portal,
  brand,
  account,
  children,
}: {
  portal: Portal;
  brand: ReactNode;
  account: ReactNode;
  children: ReactNode;
}) {
  const isCustomer = portal === "customer";
  const width = isCustomer ? "max-w-lg" : "max-w-6xl";
  return (
    <div className="flex min-h-dvh flex-col bg-muted/40">
      <header className="sticky top-0 z-20 border-b bg-background pt-[env(safe-area-inset-top)]">
        <div className={cn("mx-auto flex h-14 w-full items-center gap-3 px-4", width)}>
          <Suspense fallback={<div className="h-9 w-40 animate-pulse rounded-md bg-muted" />}>{brand}</Suspense>
          <div className="ml-auto">
            <Suspense fallback={null}>{account}</Suspense>
          </div>
        </div>
      </header>
      <div className={cn("mx-auto flex w-full flex-1", width)}>
        {!isCustomer && (
          <aside className="hidden w-56 shrink-0 border-r py-4 pr-3 pl-2 md:block">
            <SidebarNav portal={portal} />
          </aside>
        )}
        <main className={cn("min-w-0 flex-1 px-4 py-5 pb-24", !isCustomer && "md:px-6 md:pb-8")}>
          <Suspense fallback={<PageSkeleton />}>{children}</Suspense>
        </main>
      </div>
      <BottomNav portal={portal} className={isCustomer ? undefined : "md:hidden"} />
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-label="Loading">
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-28 animate-pulse rounded-xl bg-muted" />
      <div className="h-28 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

/** Page title row with an optional action (e.g. "New customer"). */
export function PageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}
