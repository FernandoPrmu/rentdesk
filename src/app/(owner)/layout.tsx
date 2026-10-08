import type { ReactNode } from "react";

import { AccountMenu } from "@/components/auth/account-menu";
import { BrandBadge } from "@/components/branding/brand-badge";
import { PortalShell } from "@/components/portal/portal-shell";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getBranding } from "@/lib/branding/company";

/** Owner portal. The proxy and each page check the OWNER role and completed setup. */
export default function OwnerLayout({ children }: { children: ReactNode }) {
  return (
    <PortalShell portal="owner" brand={<OwnerBrand />} account={<AccountMenu />}>
      {children}
    </PortalShell>
  );
}

/** The owner's own logo and company name (BRD-02). */
async function OwnerBrand() {
  const user = await getCurrentUser();
  if (!user || user.role !== "OWNER") return null;
  const branding = await getBranding(user.id);
  return <BrandBadge name={branding?.companyName ?? user.full_name} logoUrl={branding?.logoUrl ?? null} subtitle="Owner portal" />;
}
