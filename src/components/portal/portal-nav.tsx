"use client";

import {
  BarChart3,
  Bell,
  Building2,
  CalendarClock,
  ClipboardCheck,
  Ellipsis,
  FileText,
  History,
  House,
  LayoutDashboard,
  LifeBuoy,
  type LucideIcon,
  Mail,
  Printer,
  Receipt,
  Settings,
  Ticket,
  TriangleAlert,
  Users,
  Wallet,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, Suspense, useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type Portal = "admin" | "owner" | "customer";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Active only on this exact path (portal home). */
  exact?: boolean;
}

/** Desktop sidebar: every section. */
const SIDEBAR: Record<Portal, NavItem[]> = {
  admin: [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
    { href: "/admin/owners", label: "Owners", icon: Building2 },
    { href: "/admin/invoices", label: "Invoices", icon: FileText },
    { href: "/admin/escalations", label: "Escalations", icon: TriangleAlert },
    { href: "/admin/reports", label: "Reports", icon: BarChart3 },
    { href: "/admin/audit", label: "Audit log", icon: History },
    { href: "/admin/jobs", label: "Daily job", icon: CalendarClock },
    { href: "/admin/emails", label: "Emails", icon: Mail },
    { href: "/admin/settings", label: "Settings", icon: Settings },
  ],
  owner: [
    { href: "/owner", label: "Home", icon: House, exact: true },
    { href: "/owner/tickets", label: "Tickets", icon: Ticket },
    { href: "/owner/service", label: "Service", icon: Wrench },
    { href: "/owner/invoices", label: "Invoices", icon: FileText },
    { href: "/owner/customers", label: "Customers", icon: Users },
    { href: "/owner/machines", label: "Machines", icon: Printer },
    { href: "/owner/reports", label: "Reports", icon: BarChart3 },
    { href: "/owner/settings", label: "Settings", icon: Settings },
  ],
  customer: [
    { href: "/customer", label: "Home", icon: House, exact: true },
    { href: "/customer/machines", label: "Machines", icon: Printer },
    { href: "/customer/service", label: "Service", icon: Wrench },
    { href: "/customer/bills", label: "Bills", icon: Receipt },
    { href: "/customer/help", label: "Help", icon: LifeBuoy },
  ],
};

/**
 * Phone bottom bar: at most five tabs at 360 px. Owners and admins get the most used
 * sections and a "More" tab that opens a sheet with everything else.
 */
const BAR: Record<Portal, NavItem[]> = {
  admin: SIDEBAR.admin.filter((i) => ["/admin", "/admin/owners", "/admin/escalations"].includes(i.href)),
  owner: SIDEBAR.owner.filter((i) => ["/owner", "/owner/tickets", "/owner/service", "/owner/customers"].includes(i.href)),
  customer: SIDEBAR.customer,
};

export const MORE: Record<Portal, NavItem[]> = {
  admin: [
    { href: "/admin/invoices", label: "Invoices", icon: FileText },
    { href: "/admin/reports", label: "Reports", icon: BarChart3 },
    { href: "/admin/audit", label: "Audit log", icon: History },
    { href: "/admin/jobs", label: "Daily job", icon: CalendarClock },
    { href: "/admin/emails", label: "Emails", icon: Mail },
    { href: "/admin/notifications", label: "Notifications", icon: Bell },
    { href: "/admin/settings", label: "Settings", icon: Settings },
  ],
  owner: [
    { href: "/owner/machines", label: "Machines", icon: Printer },
    { href: "/owner/invoices", label: "Invoices", icon: FileText },
    { href: "/owner/payments", label: "Payments", icon: Wallet },
    { href: "/owner/outstanding", label: "Outstanding", icon: Receipt },
    { href: "/owner/approvals", label: "Approvals", icon: ClipboardCheck },
    { href: "/owner/reports", label: "Reports", icon: BarChart3 },
    { href: "/owner/notifications", label: "Notifications", icon: Bell },
    { href: "/owner/settings", label: "Settings", icon: Settings },
  ],
  customer: [],
};

export function isActive(pathname: string | null, item: Pick<NavItem, "href" | "exact">) {
  if (pathname === null) return false;
  return item.exact ? pathname === item.href : pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The More tab is highlighted when the page is one of its sections (and not a bar tab). */
export function moreActive(portal: Portal, pathname: string | null): boolean {
  return !BAR[portal].some((i) => isActive(pathname, i)) && MORE[portal].some((i) => isActive(pathname, i));
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
      {SIDEBAR[portal].map((item) => {
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

const tabClass = (active: boolean) =>
  cn("flex h-16 w-full flex-col items-center justify-center gap-1 text-xs font-medium", active ? "text-primary" : "text-muted-foreground");

function BottomLinks({ portal, pathname, className }: { portal: Portal; pathname: string | null; className?: string }) {
  const items = BAR[portal];
  const more = MORE[portal];
  const columns = items.length + (more.length > 0 ? 1 : 0);
  return (
    <nav
      aria-label="Main"
      className={cn("fixed inset-x-0 bottom-0 z-20 border-t bg-background pb-[env(safe-area-inset-bottom)]", className)}
    >
      <ul className="mx-auto grid max-w-lg" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {items.map((item) => {
          const active = isActive(pathname, item);
          return (
            <li key={item.href}>
              <Link href={item.href} aria-current={active ? "page" : undefined} className={tabClass(active)}>
                <item.icon className="size-6" aria-hidden />
                <span className="max-w-full truncate px-0.5">{item.label}</span>
              </Link>
            </li>
          );
        })}
        {more.length > 0 && (
          <li>
            <MoreMenu portal={portal} pathname={pathname} />
          </li>
        )}
      </ul>
    </nav>
  );
}

function MoreMenu({ portal, pathname }: { portal: Portal; pathname: string | null }) {
  const [open, setOpen] = useState(false);
  const active = moreActive(portal, pathname);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-haspopup="dialog" aria-expanded={open} aria-current={active ? "page" : undefined} className={tabClass(active)} data-testid="nav-more">
        <Ellipsis className="size-6" aria-hidden />
        <span>More</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-auto bottom-0 left-0 max-w-none translate-x-0 translate-y-0 rounded-b-none pb-[calc(1rem+env(safe-area-inset-bottom))] sm:max-w-none" data-testid="more-sheet">
          <DialogTitle className="px-1 pt-1 text-lg">More</DialogTitle>
          <nav aria-label="More">
            <ul className="grid grid-cols-2 gap-2">
              {MORE[portal].map((item) => {
                const current = isActive(pathname, item);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={() => setOpen(false)}
                      aria-current={current ? "page" : undefined}
                      className={cn(
                        "flex min-h-14 items-center gap-3 rounded-lg border px-3 text-sm font-medium",
                        current ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted",
                      )}
                    >
                      <item.icon className="size-5 shrink-0" aria-hidden />
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>
        </DialogContent>
      </Dialog>
    </>
  );
}
