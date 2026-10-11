import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import { type ActionResult, fail, ok } from "@/lib/action-result";
import type { CurrentUser } from "@/lib/auth/current-user";
import { supabaseRpc } from "@/lib/cron/server";
import { dbErrorMessage } from "@/lib/db-errors";
import { notificationsFor } from "@/lib/notifications/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { RpcError } from "@/lib/tickets/transitions";
import type { Database } from "@/types/db";

import { canEdit, type CommentRow, commentPreview, commentRecipient, editCommentSchema, newCommentSchema } from "./rules";

/**
 * Ticket comments (TKT-11, CP-06; decision 50). The thread is read with the
 * signed-in user's client (RLS: the ticket's customer and owner, and admin);
 * writes go through app.add_ticket_comment / app.edit_ticket_comment, which check
 * the author, the length, the 5-minute edit window and the rate limit again.
 */

type Client = SupabaseClient<Database>;

export async function listComments(client: Client, ticketId: string): Promise<CommentRow[]> {
  const { data, error } = await client
    .from("ticket_comments")
    .select("id, author_id, author_role, body, created_at, edited_at")
    .eq("ticket_id", ticketId)
    .order("created_at")
    .order("id")
    .limit(500);
  if (error) throw new Error(`comments: ${error.message}`);
  return data;
}

function failure(error: unknown): { ok: false; error: string } {
  if (error instanceof RpcError) return fail(dbErrorMessage({ code: error.code, message: error.message.replace(/^[A-Z_]+: /, "") }, "comment"));
  console.error("[comment]", error);
  return fail("The message could not be sent. Please try again.");
}

export async function addComment(user: CurrentUser, input: z.input<typeof newCommentSchema>): Promise<ActionResult<{ commentId: string }>> {
  const parsed = newCommentSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, { body: parsed.error.issues[0].message });
  if (user.role !== "OWNER" && user.role !== "CUSTOMER") return fail("Only the customer and the rental company write here.");
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const { data: t } = await admin
      .from("billing_cycle_tickets")
      .select(
        "id, owner_id, customer_id, machine:machines!billing_cycle_tickets_machine_fkey(brand, model), customer:customers!billing_cycle_tickets_customer_fkey(name)",
      )
      .eq("id", i.ticketId)
      .maybeSingle();
    const mine = t && (user.role === "OWNER" ? t.owner_id === user.id : t.customer_id === user.id);
    if (!t || !mine) return fail("This ticket was not found.");
    const to = commentRecipient(user.role, t);
    const company = user.role === "OWNER" ? (await admin.from("owner_company_profiles").select("company_name").eq("owner_id", t.owner_id).maybeSingle()).data : null;
    const from = user.role === "CUSTOMER" ? t.customer.name : (company?.company_name ?? "Your rental company");
    const r = (await supabaseRpc(admin)("rpc_add_ticket_comment", {
      p_ticket_id: t.id,
      p_actor_id: user.id,
      p_idempotency_key: i.idempotencyKey,
      p_body: i.body,
      p_notifications: notificationsFor("comment.added", [to], { customer: from, machine: `${t.machine.brand} ${t.machine.model}`, preview: commentPreview(i.body) }),
    })) as { comment_id: string };
    return ok({ commentId: r.comment_id });
  } catch (error) {
    return failure(error);
  }
}

export async function editComment(user: CurrentUser, input: z.input<typeof editCommentSchema>): Promise<ActionResult> {
  const parsed = editCommentSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0].message, { body: parsed.error.issues[0].message });
  const i = parsed.data;
  const admin = createAdminClient();
  try {
    const { data: c } = await admin.from("ticket_comments").select("author_id, created_at").eq("id", i.commentId).maybeSingle();
    if (!c || c.author_id !== user.id) return fail("This message was not found.");
    if (!canEdit(c, user.id, new Date())) return fail("A message can be changed only in the first 5 minutes.");
    await supabaseRpc(admin)("rpc_edit_ticket_comment", { p_comment_id: i.commentId, p_actor_id: user.id, p_body: i.body });
    return ok(undefined);
  } catch (error) {
    return failure(error);
  }
}
