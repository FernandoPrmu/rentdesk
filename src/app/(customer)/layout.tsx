import type { ReactNode } from "react";

import { BrandBadge } from "@/components/branding/brand-badge";
import { PortalShell } from "@/components/portal/portal-shell";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getBranding } from "@/lib/branding/company";

/**
 * Customer portal (mobile-first, bottom navigation). The header shows the
 * customer's provider: the owner's logo and company name (BRD-02).
 */
export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <PortalShell portal="customer" brand={<ProviderBrand />} account={null}>
      {children}
    </PortalShell>
  );
}

async function ProviderBrand() {
  const user = await getCurrentUser();
  if (!user || user.role !== "CUSTOMER" || !user.owner_id) return null;
  const branding = await getBranding(user.owner_id);
  return <BrandBadge name={branding?.companyName ?? "RentDesk"} logoUrl={branding?.logoUrl ?? null} subtitle={user.full_name} />;
}
