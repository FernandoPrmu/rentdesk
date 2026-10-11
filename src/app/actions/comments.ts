"use server";

import { refresh } from "next/cache";

import type { ActionResult } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import { addComment, editComment } from "@/lib/comments/service";

/** TKT-11: a message on a ticket by its customer or owner (the rpc checks who again). */
export async function addCommentAction(input: { ticketId: string; idempotencyKey: string; body: string }): Promise<ActionResult<{ commentId: string }>> {
  const actor = await currentActor(["CUSTOMER", "OWNER"]);
  const result = await addComment(actor, input);
  if (result.ok) refresh();
  return result;
}

/** TKT-11: the author changes a message within 5 minutes. */
export async function editCommentAction(input: { commentId: string; body: string }): Promise<ActionResult> {
  const actor = await currentActor(["CUSTOMER", "OWNER"]);
  const result = await editComment(actor, input);
  if (result.ok) refresh();
  return result;
}
