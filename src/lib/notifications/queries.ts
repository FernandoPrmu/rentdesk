import "server-only";

import { z } from "zod";

import { createClient } from "@/lib/supabase/server";

import { type CatalogEvent, emailEvents, EVENTS } from "./events";
import { defaultTemplate, type EmailTemplate } from "./template";

/**
 * Reads for the notification centre (NOT-01), the delivery log (NOT-05), templates
 * (NOT-04) and preferences. All with the signed-in user's own client: RLS decides
 * (own in-app rows; the owner's tenant or, for admins, everything in the log).
 */

export const PAGE_SIZE = 20;

export interface CentreItem {
  id: string;
  event: string;
  title: string;
  body: string;
  link: string | null;
  createdAt: string;
  readAt: string | null;
  urgent: boolean;
}

export async function unreadCount(userId: string): Promise<number> {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("notifications")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("channel", "IN_APP")
    .is("read_at", null);
  if (error) throw new Error(`unread count: ${error.message}`);
  return count ?? 0;
}

/** The user's own in-app notifications, newest first; `before` pages back. */
export async function listNotifications(userId: string, before?: string | null): Promise<{ items: CentreItem[]; more: boolean }> {
  const supabase = await createClient();
  let query = supabase
    .from("notifications")
    .select("id, event, title, body, link, data, created_at, read_at")
    .eq("user_id", userId)
    .eq("channel", "IN_APP")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE + 1);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error) throw new Error(`notifications: ${error.message}`);
  const rows = data.slice(0, PAGE_SIZE);
  return {
    more: data.length > PAGE_SIZE,
    items: rows.map((n) => ({
      id: n.id,
      event: n.event,
      title: n.title,
      body: n.body,
      link: safeLink(n.link),
      createdAt: n.created_at,
      readAt: n.read_at,
      urgent: (n.data as { priority?: unknown } | null)?.priority === true,
    })),
  };
}

/** Only links inside the app are followed. */
function safeLink(link: string | null): string | null {
  return link && link.startsWith("/") && !link.startsWith("//") ? link : null;
}

// ---------------------------------------------------------------------------
// Delivery log (NOT-05, ADM-05)
// ---------------------------------------------------------------------------

export const LOG_STATUSES = ["PENDING", "SENT", "FAILED", "SKIPPED", "READ"] as const;
export const LOG_CHANNELS = ["IN_APP", "EMAIL", "SMS", "WHATSAPP"] as const;

export const logFilterSchema = z.object({
  status: z.enum(LOG_STATUSES).optional().catch(undefined),
  channel: z.enum(LOG_CHANNELS).optional().catch(undefined),
  event: z.string().regex(/^[a-z0-9_.]+$/).max(60).optional().catch(undefined),
  owner: z.uuid().optional().catch(undefined),
  before: z.iso.datetime({ offset: true }).optional().catch(undefined),
});
export type LogFilter = z.infer<typeof logFilterSchema>;

export interface LogRow {
  id: string;
  event: string;
  channel: string;
  status: string;
  attempts: number;
  lastError: string | null;
  recipient: string | null;
  title: string;
  createdAt: string;
  sentAt: string | null;
  readAt: string | null;
  userName: string;
  ownerId: string | null;
}

export async function deliveryLog(filter: LogFilter): Promise<{ rows: LogRow[]; more: boolean }> {
  const supabase = await createClient();
  let query = supabase
    .from("notification_log")
    .select("id, owner_id, user_id, event, channel, status, attempts, last_error, recipient, title, created_at, sent_at, read_at")
    .order("created_at", { ascending: false })
    .limit(50 + 1);
  if (filter.status) query = query.eq("status", filter.status);
  if (filter.channel) query = query.eq("channel", filter.channel);
  if (filter.event) query = query.eq("event", filter.event);
  if (filter.owner) query = query.eq("owner_id", filter.owner);
  if (filter.before) query = query.lt("created_at", filter.before);
  const { data, error } = await query;
  if (error) throw new Error(`delivery log: ${error.message}`);
  const rows = data.slice(0, 50);
  const ids = [...new Set(rows.map((r) => r.user_id).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (ids.length > 0) {
    const { data: people } = await supabase.from("profiles").select("id, full_name, username").in("id", ids);
    for (const p of people ?? []) names.set(p.id, p.full_name || p.username);
  }
  return {
    more: data.length > 50,
    rows: rows.map((r) => ({
      id: r.id ?? "",
      event: r.event ?? "",
      channel: r.channel ?? "",
      status: r.status ?? "",
      attempts: r.attempts ?? 0,
      lastError: r.last_error,
      recipient: r.recipient,
      title: r.title ?? "",
      createdAt: r.created_at ?? "",
      sentAt: r.sent_at,
      readAt: r.read_at,
      userName: (r.user_id && names.get(r.user_id)) || "Unknown",
      ownerId: r.owner_id,
    })),
  };
}

// ---------------------------------------------------------------------------
// Templates (NOT-04)
// ---------------------------------------------------------------------------

export interface TemplateState {
  event: CatalogEvent;
  label: string;
  audience: string;
  category: string;
  /** What this editor saves: the owner's override, or (admin) the global text. */
  own: EmailTemplate | null;
  /** What applies without it: the admin's global text (for owners) or the built-in one. */
  inherited: EmailTemplate;
  inheritedFrom: "GLOBAL" | "BUILT_IN";
}

/** Every email event with its current text, for an owner (`ownerId`) or the admin (null). */
export async function templateStates(ownerId: string | null): Promise<TemplateState[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notification_templates")
    .select("owner_id, event, subject, body")
    .eq("channel", "EMAIL")
    .eq("locale", "en");
  if (error) throw new Error(`templates: ${error.message}`);
  const global = new Map((data ?? []).filter((t) => t.owner_id === null).map((t) => [t.event, { subject: t.subject, body: t.body }]));
  const own = new Map((data ?? []).filter((t) => ownerId !== null && t.owner_id === ownerId).map((t) => [t.event, { subject: t.subject, body: t.body }]));
  return emailEvents().map((event) => {
    const info = EVENTS[event];
    const g = global.get(event);
    const inherited = ownerId !== null && g ? g : defaultTemplate(event);
    return {
      event,
      label: info.label,
      audience: info.audience,
      category: info.email ?? "",
      own: ownerId === null ? (g ?? null) : (own.get(event) ?? null),
      inherited,
      inheritedFrom: ownerId !== null && g ? "GLOBAL" : "BUILT_IN",
    };
  });
}

// ---------------------------------------------------------------------------
// Preferences (decision 68)
// ---------------------------------------------------------------------------

export async function getPreferences(userId: string): Promise<{ reminders: boolean; updates: boolean }> {
  const supabase = await createClient();
  const { data } = await supabase.from("notification_preferences").select("email_reminders, email_updates").eq("user_id", userId).maybeSingle();
  return { reminders: data?.email_reminders ?? true, updates: data?.email_updates ?? true };
}
