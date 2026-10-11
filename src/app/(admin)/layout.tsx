import type { ReactNode } from "react";

import { AccountMenu } from "@/components/auth/account-menu";
import { BrandBadge } from "@/components/branding/brand-badge";
import { HeaderBell } from "@/components/notifications/header-bell";
import { PortalShell } from "@/components/portal/portal-shell";
import { APP_NAME } from "@/lib/brand";

/** Admin portal (Ciigus). The proxy and each page check the ADMIN role. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <PortalShell portal="admin" brand={<BrandBadge name={APP_NAME} subtitle="Admin" logoUrl={null} />} account={<HeaderActions />}>
      {children}
    </PortalShell>
  );
}

/** Notification bell (NOT-01) and the account menu. */
function HeaderActions() {
  return (
    <div className="flex items-center gap-1">
      <HeaderBell />
      <AccountMenu />
    </div>
  );
}
