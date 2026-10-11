import type { Metadata } from "next";

import { AdminEmailForm } from "@/components/notifications/admin-email-form";
import { EmailLinks } from "@/components/notifications/email-links";
import { PreferencesForm } from "@/components/notifications/preferences-form";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import type { Quota } from "@/lib/notifications/policy";
import { getPreferences } from "@/lib/notifications/queries";
import { emailTransport, outboxConfig } from "@/lib/notifications/server";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = { title: "Emails" };

/**
 * Admin › Emails (NOT-02/04/05, ADM-05/06): how email is set up, today's use of the
 * free tier (decision 69), the global templates, the full delivery log, and where
 * the admin's own alerts go.
 */
export default async function AdminEmailsPage() {
  const user = await requireUser("ADMIN");
  const admin = createAdminClient();
  const [{ data: me }, prefs, { data: quota }] = await Promise.all([
    admin.from("profiles").select("email").eq("id", user.id).maybeSingle(),
    getPreferences(user.id),
    admin.rpc("rpc_email_quota", { p_now: new Date().toISOString() }),
  ]);
  const config = outboxConfig();
  const transport = emailTransport();
  const q = quota as unknown as Quota | null;
  const rows: [string, string][] = [
    ["Sending through", transport ? (transport.name === "resend" ? "Resend" : "Fake (nothing leaves the server)") : "Not set up: emails are skipped and logged"],
    ["From", config.fromAddress],
    [
      "Mode",
      config.production
        ? "Production: emails go to the real addresses"
        : config.devRedirect
          ? `Not production: every email goes to ${config.devRedirect}`
          : "Not production and EMAIL_DEV_REDIRECT is not set: nothing is sent",
    ],
    ["Sent today (UTC day)", q ? `${q.sent_today} of ${q.daily_limit} (the last ${q.reserve} are kept for essential emails)` : "—"],
    ["Sent this month", q ? `${q.sent_month} of ${q.monthly_limit}` : "—"],
  ];
  return (
    <div className="max-w-2xl space-y-5">
      <PageHeader title="Emails" />
      <EmailLinks base="/admin/emails" />
      <Card>
        <CardHeader>
          <CardTitle>Email setup</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]" data-testid="email-setup">
            {rows.map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="break-words">{v}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Emails to you</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <AdminEmailForm email={me?.email ?? null} />
          <PreferencesForm
            defaults={prefs}
            email={me?.email ?? null}
            noEmailHint="Add one above to get alerts by email."
            updatesLabel="Escalations (owners who have not acted, unanswered disputes and service requests) and daily job problems."
          />
        </CardContent>
      </Card>
    </div>
  );
}
