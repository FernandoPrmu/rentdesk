import "server-only";

import { notFound } from "next/navigation";

import type { CurrentUser } from "@/lib/auth/current-user";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Spec 11.7 "User tries to open another tenant's ticket, photo, or slip: role and
 * tenant checks; attempt logged" (decision 54). Pages and file routes read with the
 * signed-in user's client, so RLS already hides other tenants' rows; when nothing
 * came back, this checks with the service role whether the row exists and, if it
 * does, writes an ACCESS_DENIED audit entry before answering "not found". The user
 * sees exactly what a missing id shows.
 */

export type GuardedEntity = "billing_cycle_tickets" | "invoices" | "payments" | "receipts";

const OWNER_COLUMN: Record<GuardedEntity, string> = {
  billing_cycle_tickets: "owner_id",
  invoices: "owner_id",
  payments: "owner_id",
  receipts: "owner_id",
};

/** Records the attempt if the id belongs to someone else. Never throws. */
export async function logDeniedAccess(user: Pick<CurrentUser, "id" | "role">, entity: GuardedEntity, id: string, via: string): Promise<boolean> {
  try {
    const admin = createAdminClient();
    const { data } = await admin.from(entity).select(`id, ${OWNER_COLUMN[entity]}`).eq("id", id).maybeSingle();
    if (!data) return false;
    await admin.rpc("rpc_write_audit", {
      p_actor_id: user.id,
      p_action: "ACCESS_DENIED",
      p_entity: entity,
      p_entity_id: id,
      p_owner_id: (data as unknown as Record<string, string>)[OWNER_COLUMN[entity]],
      p_details: { role: user.role, via },
    });
    return true;
  } catch (error) {
    console.error("[access denied log]", error instanceof Error ? error.message : error);
    return false;
  }
}

/** For pages: log the attempt (if any) and show the not-found page. */
export async function deniedNotFound(user: Pick<CurrentUser, "id" | "role">, entity: GuardedEntity, id: string, via: string): Promise<never> {
  await logDeniedAccess(user, entity, id, via);
  notFound();
}
