import type { Metadata } from "next";

import { updateCompanyAction } from "@/app/actions/company";
import { CompanyForm } from "@/components/branding/company-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { getBranding, getCompanyProfile } from "@/lib/branding/company";

export const metadata: Metadata = { title: "Company details" };

/** BRD-03: changes apply to new invoices; issued invoices keep their branding snapshot. */
export default async function CompanySettingsPage() {
  const user = await requireUser("OWNER");
  const [profile, branding] = await Promise.all([getCompanyProfile(user.id), getBranding(user.id)]);

  return (
    <div className="max-w-2xl">
      <BackLink href="/owner/settings" label="Settings" />
      <PageHeader title="Company details" description="Changes apply to new invoices. Invoices already sent keep the old details." />
      <Card>
        <CardContent>
          <CompanyForm
            action={updateCompanyAction}
            logoUrl={branding?.logoUrl ?? null}
            submitLabel="Save changes"
            defaults={{
              company_name: profile?.company_name ?? "",
              address: profile?.address ?? null,
              phone: profile?.phone ?? null,
              email: profile?.email ?? null,
              bank_name: profile?.bank_name ?? null,
              bank_branch: profile?.bank_branch ?? null,
              bank_account_name: profile?.bank_account_name ?? null,
              bank_account_no: profile?.bank_account_no ?? null,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
