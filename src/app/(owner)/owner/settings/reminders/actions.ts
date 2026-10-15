"use server";

import { refresh } from "next/cache";

import { type ActionResult, fail } from "@/lib/action-result";
import { formValues } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { effectiveSettings, parseSettingsForm, problemFieldErrors, settingsProblems } from "@/lib/settings/rules";
import { getOwnerOverrides, getPlatformSettings, updateOwnerSettings } from "@/lib/settings/service";
import { OWNER_REMINDER_GROUPS, ownerKeysIn } from "@/lib/settings/view";

/** Settings › Reminders and deadlines (ADM-06 remainder, AGR-03): the owner's overrides. */
export async function saveReminderSettingsAction(_prev: ActionResult<{ changed: string[] }> | null, formData: FormData): Promise<ActionResult<{ changed: string[] }>> {
  const actor = await currentActor("OWNER");
  const parsed = parseSettingsForm(formValues(formData), ownerKeysIn(OWNER_REMINDER_GROUPS), { inherit: true });
  if (Object.keys(parsed.fieldErrors).length > 0) return fail("Please check the highlighted fields.", parsed.fieldErrors);
  const [platform, current] = await Promise.all([getPlatformSettings(), getOwnerOverrides(actor.id)]);
  const problems = settingsProblems(effectiveSettings(platform, { ...current, ...parsed.changes }));
  if (problems.length > 0) return fail("Please check the highlighted fields.", problemFieldErrors(problems));
  const result = await updateOwnerSettings(actor, parsed.changes);
  if (result.ok) refresh();
  return result;
}
