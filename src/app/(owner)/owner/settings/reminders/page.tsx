import type { Metadata } from "next";

import { saveReminderSettingsAction } from "@/app/(owner)/owner/settings/reminders/actions";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { SettingsForm } from "@/components/settings/settings-form";
import { requireUser } from "@/lib/auth/current-user";
import { effectiveSettings, settingsProblems } from "@/lib/settings/rules";
import { getOwnerOverrides, getPlatformSettings } from "@/lib/settings/service";
import { OWNER_REMINDER_GROUPS, ownerForm, settingLabel } from "@/lib/settings/view";

export const metadata: Metadata = { title: "Reminders and deadlines" };

/**
 * ADM-06 (owner part) and AGR-03: the owner's stage deadlines, reminder schedule,
 * service escalation times and the agreement end reminder, each either the platform
 * default or the owner's own value. Validated together, saved through the audited rpc.
 */
export default async function ReminderSettingsPage() {
  const user = await requireUser("OWNER");
  const [platform, overrides] = await Promise.all([getPlatformSettings(), getOwnerOverrides(user.id)]);
  // The admin may have changed a default since: say so when the mix no longer fits.
  const problems = settingsProblems(effectiveSettings(platform, overrides));
  return (
    <div className="max-w-2xl">
      <BackLink href="/owner/settings" label="Settings" />
      <PageHeader title="Reminders and deadlines" description="When customers and you are reminded, and when things count as late. Changes apply from the next daily run." />
      {problems.length > 0 && (
        <div role="alert" className="mb-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <p className="font-medium text-destructive">Some of your settings no longer fit the platform defaults:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p) => (
              <li key={p.key}>
                {settingLabel(p.key)}: {p.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <SettingsForm groups={ownerForm(platform, overrides, OWNER_REMINDER_GROUPS)} action={saveReminderSettingsAction} mode="owner" testId="owner-settings-form" />
    </div>
  );
}
