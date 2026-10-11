import type { Metadata } from "next";

import { EmailLinks } from "@/components/notifications/email-links";
import { PreferencesForm } from "@/components/notifications/preferences-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { getPreferences } from "@/lib/notifications/queries";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Emails" };

/** Settings › Emails: the owner's own email settings, templates (NOT-04) and the delivery log (NOT-05). */
export default async function OwnerEmailSettingsPage() {
  const user = await requireUser("OWNER");
  const supabase = await createClient();
  const [{ data: me }, prefs] = await Promise.all([supabase.from("owners").select("email").eq("id", user.id).maybeSingle(), getPreferences(user.id)]);
  return (
    <div className="max-w-xl space-y-5">
      <BackLink href="/owner/settings" label="Settings" />
      <PageHeader title="Emails" description="Your customers get emails from your company name; replies come to your company email." />
      <EmailLinks base="/owner/settings/notifications" />
      <Card>
        <CardHeader>
          <CardTitle>Emails to you</CardTitle>
        </CardHeader>
        <CardContent>
          <PreferencesForm
            defaults={prefs}
            email={me?.email ?? null}
            noEmailHint="Ask the RentDesk team to add one."
            updatesLabel="New readings and payment slips to check, disputes, new service requests and missed deadlines."
          />
        </CardContent>
      </Card>
    </div>
  );
}
