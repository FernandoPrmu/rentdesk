import { z } from "zod";

import { englishOnly } from "../text/english.ts";

/**
 * Ticket comments (TKT-11, CP-06; decision 50): a plain-text thread between the
 * ticket's customer and owner. English only (decision 33), 1 to 1,000 characters,
 * the author may change a message for 5 minutes, no deletes. The database checks
 * the same rules again (app.add_ticket_comment, app.edit_ticket_comment) with its
 * own clock. Pure; only relative imports.
 */

export const COMMENT_MAX = 1000;
export const EDIT_WINDOW_MS = 5 * 60 * 1000;

export const commentBody = z
  .string()
  .trim()
  .min(1, "Write a message.")
  .max(COMMENT_MAX, `A message has at most ${COMMENT_MAX.toLocaleString("en-US")} characters.`)
  .refine(...englishOnly);

export const newCommentSchema = z.object({ ticketId: z.uuid(), idempotencyKey: z.uuid(), body: commentBody });
export const editCommentSchema = z.object({ commentId: z.uuid(), body: commentBody });

export interface CommentRow {
  id: string;
  author_id: string;
  author_role: "ADMIN" | "OWNER" | "CUSTOMER" | null;
  body: string;
  created_at: string;
  edited_at: string | null;
}

/** The author may change a message until 5 minutes after it was sent. */
export function canEdit(comment: Pick<CommentRow, "author_id" | "created_at">, userId: string, now: Date): boolean {
  return comment.author_id === userId && now.getTime() <= Date.parse(comment.created_at) + EDIT_WINDOW_MS;
}

/** Seconds left to change it (0 when the window is over or it is someone else's). */
export function editSecondsLeft(comment: Pick<CommentRow, "author_id" | "created_at">, userId: string, now: Date): number {
  if (comment.author_id !== userId) return 0;
  return Math.max(0, Math.floor((Date.parse(comment.created_at) + EDIT_WINDOW_MS - now.getTime()) / 1000));
}

/** The start of a message for the notification (one line, at most 120 characters). */
export function commentPreview(body: string, max = 120): string {
  const line = body.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

/** Who is told about a new message: the other side of the ticket. */
export function commentRecipient(authorRole: "OWNER" | "CUSTOMER", ticket: { owner_id: string; customer_id: string }): { userId: string; role: "OWNER" | "CUSTOMER" } {
  return authorRole === "CUSTOMER" ? { userId: ticket.owner_id, role: "OWNER" } : { userId: ticket.customer_id, role: "CUSTOMER" };
}

/** "You", the company or the customer's name, for the thread. */
export function authorLabel(comment: Pick<CommentRow, "author_id" | "author_role">, viewerId: string, names: { owner: string; customer: string }): string {
  if (comment.author_id === viewerId) return "You";
  if (comment.author_role === "OWNER") return names.owner;
  if (comment.author_role === "CUSTOMER") return names.customer;
  return "RentDesk";
}
