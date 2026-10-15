import { History } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { savePlatformSettingsAction } from "@/app/(admin)/admin/settings/actions";
import { PageHeader } from "@/components/portal/portal-shell";
import { SettingsForm } from "@/components/settings/settings-form";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/current-user";
import { formatDateTime } from "@/lib/format";
import { getPlatformSettings } from "@/lib/settings/service";
import { platformForm } from "@/lib/settings/view";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Settings" };

/**
 * ADM-06: platform defaults (deadlines, reminder schedules, late fee defaults,
 * service escalation, disputes, agreement notice, sign-in lockout and sessions,
 * email limits). Owners may override the business ones. Every change is in the audit log.
 * Email templates: Emails › Email templates. SMS / WhatsApp: deferred (paid provider).
 */
export default async function AdminSettingsPage() {
  await requireUser("ADMIN");
  const settings = await getPlatformSettings();
  return (
    <div className="max-w-2xl">
      <PageHeader
        title="Settings"
        description={`Platform defaults for every owner. Last changed ${formatDateTime(settings.updated_at)}.`}
        action={
          <Link href="/admin/audit?entity=platform_settings" className={cn(buttonVariants({ variant: "outline" }), "h-11 gap-2")}>
            <History className="size-4" aria-hidden /> Change history
          </Link>
        }
      />
      <SettingsForm groups={platformForm(settings)} action={savePlatformSettingsAction} mode="platform" testId="platform-settings-form" />
    </div>
  );
}
