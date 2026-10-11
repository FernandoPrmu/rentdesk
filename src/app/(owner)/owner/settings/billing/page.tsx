import type { Metadata } from "next";

import { updateBillingSettingsAction } from "@/app/(owner)/owner/settings/billing/actions";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { BillingSettingsForm } from "@/components/settings/billing-settings-form";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { resolveLateFee } from "@/lib/billing/late-fee";
import { centsToRupeesInput } from "@/lib/money";
import { getEstimatedBilling, getLateFeeSources } from "@/lib/settings/billing";

export const metadata: Metadata = { title: "Billing settings" };

/** PAY-13 / LATE-01: the owner's default late fee and grace period (platform default until set). */
export default async function BillingSettingsPage() {
  await requireUser("OWNER");
  const [sources, estimates] = await Promise.all([getLateFeeSources(), getEstimatedBilling()]);
  const current = resolveLateFee({ agreement: { mode: "OWNER_DEFAULT", feeCents: null }, ...sources });

  return (
    <div className="max-w-2xl">
      <BackLink href="/owner/settings" label="Settings" />
      <PageHeader title="Billing" description="Your default late fee and estimated invoices. Changes apply from now on." />
      <Card>
        <CardContent>
          <BillingSettingsForm
            action={updateBillingSettingsAction}
            defaults={{
              late_fee_enabled: current.enabled,
              late_fee: current.feeCents > 0 ? centsToRupeesInput(current.feeCents) : "0",
              grace_period_days: String(current.graceDays),
              estimated_billing_enabled: estimates,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
