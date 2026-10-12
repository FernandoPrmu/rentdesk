"use server";

import { refresh } from "next/cache";

import { type ActionResult, fail } from "@/lib/action-result";
import { formValues } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { parseSettingsForm, settingsProblems } from "@/lib/settings/rules";
import { getPlatformSettings, updatePlatformSettings } from "@/lib/settings/service";
import { platformKeysIn } from "@/lib/settings/view";

/** ADM-06: platform defaults. Every value checked here (Zod) and again in the database; audited old -> new. */
export async function savePlatformSettingsAction(_prev: ActionResult<{ changed: string[] }> | null, formData: FormData): Promise<ActionResult<{ changed: string[] }>> {
  const actor = await currentActor("ADMIN");
  const parsed = parseSettingsForm(formValues(formData), platformKeysIn());
  if (Object.keys(parsed.fieldErrors).length > 0) return fail("Please check the highlighted fields.", parsed.fieldErrors);
  const current = await getPlatformSettings();
  const problems = settingsProblems({ ...current, ...parsed.changes } as Parameters<typeof settingsProblems>[0]);
  if (problems.length > 0) return fail("Please check the highlighted fields.", Object.fromEntries(problems.map((p) => [p.key, p.message])));
  const result = await updatePlatformSettings(actor, parsed.changes);
  if (result.ok) refresh();
  return result;
}
