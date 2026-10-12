import "server-only";

import { type ActionResult, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import type { LateFeeSources } from "@/lib/billing/late-fee";
import type { BillingSettingsInput } from "@/lib/settings/billing-schema";
import { updateOwnerSettings } from "@/lib/settings/service";
import { createClient } from "@/lib/supabase/server";

/**
 * Owner billing settings: late fee on/off, default amount and grace days (PAY-13,
 * LATE-01). owner_settings holds the owner's overrides (null = platform default).
 * Reads run as the signed-in owner (RLS: their own row); saving goes through the
 * validated, audited settings rpc (decision 82).
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

/** Spec 11.6 / decision 22: does the owner bill an estimate when no reading arrives (owner, else platform)? */
export async function getEstimatedBilling(): Promise<boolean> {
  const supabase = await createClient();
  const [platform, owner] = await Promise.all([
    supabase.from("platform_settings").select("estimated_billing_enabled").single(),
    supabase.from("owner_settings").select("estimated_billing_enabled").maybeSingle(),
  ]);
  if (platform.error) throw new Error(`platform settings: ${platform.error.message}`);
  return owner.data?.estimated_billing_enabled ?? platform.data.estimated_billing_enabled;
}

/** Through the validated, audited settings rpc (migration 0034: no direct writes). */
export async function saveBillingSettings(actor: CurrentUser, input: BillingSettingsInput): Promise<ActionResult> {
  const result = await updateOwnerSettings(actor, {
    late_fee_enabled: input.late_fee_enabled,
    late_fee_cents: input.late_fee,
    grace_period_days: input.grace_period_days,
    estimated_billing_enabled: input.estimated_billing_enabled,
  });
  return result.ok ? ok(undefined) : result;
}
