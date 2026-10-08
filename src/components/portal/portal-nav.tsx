"use client";

import { Building2, House, LayoutDashboard, LifeBuoy, type LucideIcon, Printer, Receipt, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, Suspense } from "react";

import { cn } from "@/lib/utils";

export type Portal = "admin" | "owner" | "customer";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Active only on this exact path (portal home). */
  exact?: boolean;
}

const NAV: Record<Portal, NavItem[]> = {
  admin: [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
    { href: "/admin/owners", label: "Owners", icon: Building2 },
  ],
  owner: [
    { href: "/owner", label: "Home", icon: House, exact: true },
    { href: "/owner/customers", label: "Customers", icon: Users },
    { href: "/owner/machines", label: "Machines", icon: Printer },
    { href: "/owner/settings", label: "Settings", icon: Settings },
  ],
  customer: [
    { href: "/customer", label: "Home", icon: House, exact: true },
    { href: "/customer/machines", label: "Machines", icon: Printer },
    { href: "/customer/bills", label: "Bills", icon: Receipt },
    { href: "/customer/help", label: "Help", icon: LifeBuoy },
  ],
};

function isActive(pathname: string | null, item: NavItem) {
  if (pathname === null) return false;
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/**
 * The current path is runtime data, so the highlighted nav streams in; until then
 * (and in the prerendered shell) the same links render without a highlight.
 */
function WithPathname({ render }: { render: (pathname: string | null) => ReactNode }) {
  return <Suspense fallback={render(null)}><CurrentPath render={render} /></Suspense>;
}

function CurrentPath({ render }: { render: (pathname: string | null) => ReactNode }) {
  return render(usePathname());
}

/** Desktop sidebar (owner and admin portals, md and up). */
export function SidebarNav({ portal }: { portal: Portal }) {
  return <WithPathname render={(pathname) => <SidebarLinks portal={portal} pathname={pathname} />} />;
}

function SidebarLinks({ portal, pathname }: { portal: Portal; pathname: string | null }) {
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {NAV[portal].map((item) => {
        const active = isActive(pathname, item);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors",
              active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <item.icon className="size-5" aria-hidden />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Bottom navigation bar: always for customers, below md for owners and admins. */
export function BottomNav({ portal, className }: { portal: Portal; className?: string }) {
  return <WithPathname render={(pathname) => <BottomLinks portal={portal} pathname={pathname} className={className} />} />;
}

function BottomLinks({ portal, pathname, className }: { portal: Portal; pathname: string | null; className?: string }) {
  const items = NAV[portal];
  return (
    <nav
      aria-label="Main"
      className={cn(
        "fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)]",
        className,
      )}
    >
      <ul className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-16 flex-col items-center justify-center gap-1 text-xs font-medium",
                  active ? "text-primary" : "text-muted-foreground",
                )}
              >
                <item.icon className="size-6" aria-hidden />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
