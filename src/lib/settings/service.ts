import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { must } from "@/lib/actions/errors";
import type { CurrentUser } from "@/lib/auth/current-user";
import { dbErrorMessage } from "@/lib/db-errors";
import {
  changedKeys,
  OWNER_KEYS,
  parseDbProblems,
  problemFieldErrors,
  SETTING_KEYS,
  type SettingKey,
  type SettingsValues,
  type SettingValue,
} from "@/lib/settings/rules";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/db";

/**
 * Settings screens (ADM-06, decision 82). Reads run as the signed-in user (RLS:
 * platform defaults for everyone signed in, overrides for their owner and admins);
 * writes go only through rpc_update_platform_settings / rpc_update_owner_settings,
 * which check the role, the keys and every rule again and are audited (old -> new).
 */

type Row = Record<string, unknown>;

function pick(row: Row | null, keys: readonly SettingKey[]): Partial<Record<SettingKey, SettingValue | null>> {
  const out: Partial<Record<SettingKey, SettingValue | null>> = {};
  if (!row) return out;
  for (const key of keys) {
    const v = row[key];
    // bigint columns arrive as numbers (late fee cents stay far below 2^53).
    out[key] = v === undefined ? null : (v as SettingValue | null);
  }
  return out;
}

export async function getPlatformSettings(): Promise<SettingsValues & { updated_at: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("platform_settings").select("*").single();
  if (error) throw new Error(`platform settings: ${error.message}`);
  return { ...(pick(data as Row, SETTING_KEYS) as SettingsValues), updated_at: data.updated_at };
}

/** The owner's overrides (null = platform default). */
export async function getOwnerOverrides(ownerId: string): Promise<Partial<Record<SettingKey, SettingValue | null>>> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("owner_settings").select("*").eq("owner_id", ownerId).maybeSingle();
  if (error) throw new Error(`owner settings: ${error.message}`);
  return pick(data as Row | null, OWNER_KEYS);
}

/** AGR-03: the owner's agreement end notice (their setting, else the platform default). */
export async function getAgreementNoticeDays(ownerId: string): Promise<number> {
  const supabase = await createClient();
  const data = must(await supabase.from("owner_settings_effective").select("agreement_end_notice_days").eq("owner_id", ownerId).maybeSingle(), "owner settings");
  return data?.agreement_end_notice_days ?? 30;
}

function problemResult(message: string): ActionResult<{ changed: string[] }> {
  const problems = parseDbProblems(message);
  if (problems.length === 0) return fail(message);
  return fail("Please check the highlighted fields.", problemFieldErrors(problems));
}

async function callUpdate(
  fn: "rpc_update_platform_settings" | "rpc_update_owner_settings",
  actorId: string,
  changes: Partial<Record<SettingKey, SettingValue | null>>,
): Promise<ActionResult<{ changed: string[] }>> {
  if (Object.keys(changes).length === 0) return ok({ changed: [] });
  const { data, error } = await createAdminClient().rpc(fn, { p_actor_id: actorId, p_changes: changes as unknown as Json });
  if (error) return error.code === "RD400" ? problemResult(error.message) : fail(dbErrorMessage(error, "settings"));
  return ok({ changed: ((data as { changed?: string[] } | null)?.changed ?? []) as string[] });
}

/** Admin: only the values that changed are sent (the audit shows exactly those). */
export async function updatePlatformSettings(admin: CurrentUser, changes: Partial<Record<SettingKey, SettingValue | null>>) {
  const current = await getPlatformSettings();
  const keys = changedKeys(current, changes);
  return callUpdate("rpc_update_platform_settings", admin.id, Object.fromEntries(keys.map((k) => [k, changes[k]])));
}

/** Owner: overrides, or null to go back to the platform default. */
export async function updateOwnerSettings(owner: CurrentUser, changes: Partial<Record<SettingKey, SettingValue | null>>) {
  const current = await getOwnerOverrides(owner.id);
  const keys = changedKeys(current, changes);
  return callUpdate("rpc_update_owner_settings", owner.id, Object.fromEntries(keys.map((k) => [k, changes[k]])));
}
