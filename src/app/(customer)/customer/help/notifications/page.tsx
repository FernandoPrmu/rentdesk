import type { Metadata } from "next";

import { PreferencesForm } from "@/components/notifications/preferences-form";
import { BackLink } from "@/components/portal/back-link";
import { requireUser } from "@/lib/auth/current-user";
import { getCompanyProfile } from "@/lib/branding/company";
import { getPreferences } from "@/lib/notifications/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Email settings" };

/** The customer's email settings (decision 68): reminders and updates can be turned off. */
export default async function CustomerEmailSettingsPage() {
  const user = await requireUser("CUSTOMER");
  const supabase = await createClient();
  const [{ data: me }, prefs, provider] = await Promise.all([
    supabase.from("customers").select("email").eq("id", user.id).maybeSingle(),
    getPreferences(user.id),
    user.owner_id ? getCompanyProfile(user.owner_id) : Promise.resolve(null),
  ]);
  return (
    <div className="space-y-4">
      <BackLink href="/customer/help" label="Help" />
      <h1 className="text-2xl font-bold tracking-tight">Email settings</h1>
      <PreferencesForm
        defaults={prefs}
        email={me?.email ?? null}
        noEmailHint={`Ask ${provider?.company_name ?? "your rental company"} to add one.`}
        updatesLabel="When a reading is sent back, a fresh photo is asked for, or a reading is corrected."
      />
    </div>
  );
}
