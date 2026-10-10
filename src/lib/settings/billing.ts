import "server-only";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { LateFeeSources } from "@/lib/billing/late-fee";
import { dbErrorMessage } from "@/lib/db-errors";
import type { BillingSettingsInput } from "@/lib/settings/billing-schema";
import { createClient } from "@/lib/supabase/server";

/**
 * Owner billing settings: late fee on/off, default amount and grace days (PAY-13,
 * LATE-01). owner_settings holds the owner's overrides (null = platform default).
 * Runs as the signed-in owner: RLS and column grants limit it to their own row.
 */

export async function getLateFeeSources(): Promise<Pick<LateFeeSources, "owner" | "platform">> {
  const supabase = await createClient();
  const [platform, owner] = await Promise.all([
    supabase.from("platform_settings").select("late_fee_enabled, late_fee_cents, grace_period_days").single(),
    supabase.from("owner_settings").select("late_fee_enabled, late_fee_cents, grace_period_days").maybeSingle(),
  ]);
  if (platform.error) throw new Error(`platform settings: ${platform.error.message}`);
  if (owner.error) throw new Error(`owner settings: ${owner.error.message}`);
  return {
    platform: { enabled: platform.data.late_fee_enabled, feeCents: platform.data.late_fee_cents, graceDays: platform.data.grace_period_days },
    owner: {
      enabled: owner.data?.late_fee_enabled ?? null,
      feeCents: owner.data?.late_fee_cents ?? null,
      graceDays: owner.data?.grace_period_days ?? null,
    },
  };
}

export async function saveBillingSettings(actor: CurrentUser, input: BillingSettingsInput): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.from("owner_settings").upsert(
    {
      owner_id: actor.id,
      late_fee_enabled: input.late_fee_enabled,
      late_fee_cents: input.late_fee,
      grace_period_days: input.grace_period_days,
    },
    { onConflict: "owner_id" },
  );
  return error ? fail(dbErrorMessage(error, "billing settings")) : ok(undefined);
}
