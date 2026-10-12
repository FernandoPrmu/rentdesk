"use server";

import { refresh } from "next/cache";
import { z } from "zod";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import { dbErrorMessage } from "@/lib/db-errors";
import { emailEvents, isCatalogEvent } from "@/lib/notifications/events";
import { type CentreItem, listNotifications } from "@/lib/notifications/queries";
import { validateTemplate } from "@/lib/notifications/template";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Notification centre (NOT-01), email preferences (decision 68), templates (NOT-04)
 * and the admin's alert address. Reads and "mark as read" use the user's own client
 * (RLS: own rows, read_at only); the rest goes through service-role rpc wrappers
 * that check the actor again.
 */

const ALL_ROLES = ["CUSTOMER", "OWNER", "ADMIN"] as const;

export async function markNotificationRead(id: string): Promise<ActionResult> {
  const user = await currentActor([...ALL_ROLES]);
  if (!z.uuid().safeParse(id).success) return fail("Notification not found.");
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", user.id)
    .is("read_at", null);
  return error ? fail("Could not update the notification.") : ok(undefined);
}

export async function markAllNotificationsRead(): Promise<ActionResult> {
  const user = await currentActor([...ALL_ROLES]);
  const supabase = await createClient();
  const { error } = await supabase
    .from("notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", user.id)
    .eq("channel", "IN_APP")
    .is("read_at", null);
  if (error) return fail("Could not mark them as read. Please try again.");
  refresh();
  return ok(undefined);
}

export async function loadMoreNotifications(before: string): Promise<ActionResult<{ items: CentreItem[]; more: boolean }>> {
  const user = await currentActor([...ALL_ROLES]);
  if (!z.iso.datetime({ offset: true }).safeParse(before).success) return fail("Could not load more.");
  return ok(await listNotifications(user.id, before));
}

const preferencesSchema = z.object({
  email_reminders: z.literal("on").optional(),
  email_updates: z.literal("on").optional(),
});

export async function savePreferencesAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await currentActor([...ALL_ROLES]);
  const parsed = preferencesSchema.safeParse({ email_reminders: formData.get("email_reminders") ?? undefined, email_updates: formData.get("email_updates") ?? undefined });
  if (!parsed.success) return fail("Please try again.");
  const { error } = await createAdminClient().rpc("rpc_save_notification_preferences", {
    p_user_id: user.id,
    p_reminders: parsed.data.email_reminders === "on",
    p_updates: parsed.data.email_updates === "on",
  });
  if (error) return fail(dbErrorMessage(error, "notifications"));
  refresh();
  return ok(undefined);
}

const templateSchema = z.object({
  subject: z.string().max(400),
  body: z.string().max(10_000),
});

/** Owner: their own override. Admin: the global text every owner inherits. */
export async function saveTemplateAction(event: string, _prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor(["OWNER", "ADMIN"]);
  if (!isCatalogEvent(event) || !emailEvents().includes(event)) return fail("Unknown email.");
  const parsed = templateSchema.safeParse({ subject: formData.get("subject") ?? "", body: formData.get("body") ?? "" });
  if (!parsed.success) return fail("Please check the text.");
  const template = { subject: parsed.data.subject.trim(), body: parsed.data.body.replace(/\r\n?/g, "\n").trim() };
  // Unknown variables, stray braces, non-English text, a missing password: refused (decision 71).
  const problems = validateTemplate(event, template);
  if (problems.length > 0) {
    const fieldErrors: Record<string, string> = {};
    for (const p of problems) fieldErrors[p.field] ??= p.message;
    return fail("Please fix the highlighted text.", fieldErrors);
  }
  const { error } = await createAdminClient().rpc("rpc_save_notification_template", {
    p_actor_id: actor.id,
    p_owner_id: (actor.role === "OWNER" ? actor.id : null) as string,
    p_event: event,
    p_subject: template.subject,
    p_body: template.body,
  });
  if (error) return fail(dbErrorMessage(error, "notifications"));
  refresh();
  return ok(undefined);
}

export async function resetTemplateAction(event: string): Promise<ActionResult> {
  const actor = await currentActor(["OWNER", "ADMIN"]);
  if (!isCatalogEvent(event)) return fail("Unknown email.");
  const { error } = await createAdminClient().rpc("rpc_reset_notification_template", {
    p_actor_id: actor.id,
    p_owner_id: (actor.role === "OWNER" ? actor.id : null) as string,
    p_event: event,
  });
  if (error) return fail(dbErrorMessage(error, "notifications"));
  refresh();
  return ok(undefined);
}

const adminEmailSchema = z.object({
  email: z
    .string()
    .trim()
    .max(200)
    .transform((v) => (v === "" ? null : v.toLowerCase()))
    .pipe(z.email("Enter a valid email address.").nullable()),
});

export async function setAdminEmailAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("ADMIN");
  const parsed = adminEmailSchema.safeParse({ email: formData.get("email") ?? "" });
  if (!parsed.success) return fail("Please check the email address.", { email: parsed.error.issues[0].message });
  const { error } = await createAdminClient().rpc("rpc_set_admin_email", { p_actor_id: actor.id, p_email: parsed.data.email as string });
  if (error) return fail(dbErrorMessage(error, "notifications"));
  refresh();
  return ok(undefined);
}
