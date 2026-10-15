import "server-only";

import { z } from "zod";

import { must } from "@/lib/actions/errors";
import { isIsoDate } from "@/lib/agreements/cycle-calendar";
import { createClient } from "@/lib/supabase/server";

/**
 * ADM-05: the audit log viewer. Admin reads (RLS: admins see every row), newest
 * first, 50 at a time by id (keyset: `before`), filtered by actor (username),
 * owner, action, entity and Colombo dates. Three queries a page: the rows, then the
 * usernames and owner names they mention.
 */

export const AUDIT_PAGE_SIZE = 50;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined))
    .catch(undefined);
const optionalDate = z
  .string()
  .optional()
  .transform((v) => (v && isIsoDate(v) ? v : undefined))
  .catch(undefined);

export const auditFilterSchema = z.object({
  actor: optionalText(60),
  owner: z.uuid().optional().catch(undefined),
  action: z
    .string()
    .regex(/^[A-Z_]{2,40}$/)
    .optional()
    .catch(undefined),
  entity: z
    .string()
    .regex(/^[a-z_]{2,60}$/)
    .optional()
    .catch(undefined),
  from: optionalDate,
  to: optionalDate,
  before: z.coerce.number().int().positive().optional().catch(undefined),
});
export type AuditFilter = z.output<typeof auditFilterSchema>;

/** Actions and entities offered in the filters (anything else can still be linked to). */
export const AUDIT_ACTIONS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "STATUS_CHANGE",
  "LOGIN",
  "LOGIN_FAILED",
  "LOCKOUT",
  "LOGOUT",
  "PASSWORD_RESET",
  "PASSWORD_CHANGED",
  "ACCESS_DENIED",
  "SUPPORT_VIEW",
  "REPORT_EXPORTED",
] as const;

export const AUDIT_ENTITIES = [
  "platform_settings",
  "owner_settings",
  "profiles",
  "owners",
  "customers",
  "machines",
  "rental_agreements",
  "billing_cycle_tickets",
  "invoices",
  "payments",
  "payment_allocations",
  "credits",
  "deposit_transactions",
  "disputes",
  "service_requests",
  "notification_templates",
  "reports",
] as const;

/** Colombo midnight of a date, as a timestamp. */
const colomboStart = (date: string) => `${date}T00:00:00+05:30`;
const nextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export interface AuditRow {
  id: number;
  created_at: string;
  action: string;
  entity: string;
  entity_id: string | null;
  actor_id: string | null;
  actor_role: string | null;
  owner_id: string | null;
  details: Record<string, unknown>;
  actor: string | null;
  owner: string | null;
}

async function names(actorIds: string[], ownerIds: string[]) {
  const supabase = await createClient();
  const [actors, owners] = await Promise.all([
    actorIds.length ? supabase.from("profiles").select("id, username").in("id", actorIds) : Promise.resolve({ data: [], error: null }),
    ownerIds.length ? supabase.from("owners").select("id, business_name").in("id", ownerIds) : Promise.resolve({ data: [], error: null }),
  ]);
  return {
    actor: new Map((must(actors, "actors") ?? []).map((a) => [a.id, a.username])),
    owner: new Map((must(owners, "owners") ?? []).map((o) => [o.id, o.business_name])),
  };
}

export async function listAudit(filter: AuditFilter): Promise<{ rows: AuditRow[]; next: number | null; actorMatches: number | null }> {
  const supabase = await createClient();
  let actorIds: string[] | null = null;
  if (filter.actor) {
    const pattern = `%${filter.actor.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    const { data, error } = await supabase.from("profiles").select("id").ilike("username", pattern).limit(50);
    if (error) throw new Error(`audit actor: ${error.message}`);
    actorIds = data.map((p) => p.id);
    if (actorIds.length === 0) return { rows: [], next: null, actorMatches: 0 };
  }
  let q = supabase
    .from("audit_logs")
    .select("id, created_at, action, entity, entity_id, actor_id, actor_role, owner_id, details")
    .order("id", { ascending: false })
    .limit(AUDIT_PAGE_SIZE + 1);
  if (actorIds) q = q.in("actor_id", actorIds);
  if (filter.owner) q = q.eq("owner_id", filter.owner);
  if (filter.action) q = q.eq("action", filter.action);
  if (filter.entity) q = q.eq("entity", filter.entity);
  if (filter.from) q = q.gte("created_at", colomboStart(filter.from));
  if (filter.to) q = q.lt("created_at", colomboStart(nextDay(filter.to)));
  if (filter.before) q = q.lt("id", filter.before);
  const { data, error } = await q;
  if (error) throw new Error(`audit log: ${error.message}`);
  const page = data.slice(0, AUDIT_PAGE_SIZE);
  const n = await names(
    [...new Set(page.map((r) => r.actor_id).filter((v): v is string => !!v))],
    [...new Set(page.map((r) => r.owner_id).filter((v): v is string => !!v))],
  );
  return {
    rows: page.map((r) => ({
      ...r,
      details: (r.details ?? {}) as Record<string, unknown>,
      actor: r.actor_id ? (n.actor.get(r.actor_id) ?? null) : null,
      owner: r.owner_id ? (n.owner.get(r.owner_id) ?? null) : null,
    })),
    next: data.length > AUDIT_PAGE_SIZE ? page[page.length - 1].id : null,
    actorMatches: actorIds?.length ?? null,
  };
}

export async function getAudit(id: number): Promise<AuditRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("audit_logs")
    .select("id, created_at, action, entity, entity_id, actor_id, actor_role, owner_id, details")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`audit entry: ${error.message}`);
  if (!data) return null;
  const n = await names(data.actor_id ? [data.actor_id] : [], data.owner_id ? [data.owner_id] : []);
  return {
    ...data,
    details: (data.details ?? {}) as Record<string, unknown>,
    actor: data.actor_id ? (n.actor.get(data.actor_id) ?? null) : null,
    owner: data.owner_id ? (n.owner.get(data.owner_id) ?? null) : null,
  };
}

export async function listOwnerChoices() {
  const supabase = await createClient();
  const { data, error } = await supabase.from("owners").select("id, business_name").order("business_name").limit(500);
  if (error) throw new Error(`owners: ${error.message}`);
  return data;
}
