import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { completeSetupAction } from "@/app/actions/company";
import { AppShell } from "@/components/app-shell";
import { SignOutButton } from "@/components/auth/account-menu";
import { CompanyForm } from "@/components/branding/company-form";
import { PageSkeleton } from "@/components/portal/portal-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwner } from "@/lib/accounts/queries";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Set up your company" };

/** BRD-01: an owner completes this once, after the first password change, before the dashboard. */
export default function SetupPage() {
  return (
    <AppShell wide>
      <Suspense fallback={<PageSkeleton />}>
        <Setup />
      </Suspense>
    </AppShell>
  );
}

async function Setup() {
  const user = await requireUser("OWNER", { allowGate: "/setup" });
  if (user.onboarded) redirect("/owner");
  const owner = await getOwner(user.id);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">
            <h1>Set up your company</h1>
          </CardTitle>
          <CardDescription>
            These details appear on your invoices and in your customers&apos; app. You can change them later in Settings.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CompanyForm
            action={completeSetupAction}
            logoUrl={null}
            submitLabel="Save and continue"
            defaults={{
              company_name: owner?.business_name ?? "",
              address: owner?.address ?? null,
              phone: owner?.phone ?? null,
              email: owner?.email ?? null,
              bank_name: null,
              bank_branch: null,
              bank_account_name: owner?.business_name ?? null,
              bank_account_no: null,
            }}
          />
        </CardContent>
      </Card>
      <SignOutButton />
    </div>
  );
}
