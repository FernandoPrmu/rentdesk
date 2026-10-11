"use client";

import { MessageSquare, Pencil } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import { authorLabel, canEdit, COMMENT_MAX, type CommentRow } from "@/lib/comments/rules";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type AddAction = (input: { ticketId: string; idempotencyKey: string; body: string }) => Promise<ActionResult<{ commentId: string }>>;
type EditAction = (input: { commentId: string; body: string }) => Promise<ActionResult>;

/**
 * TKT-11 / CP-06: the ticket's messages between the customer and the rental
 * company (decision 50). Plain text, up to 1,000 characters; the author may change
 * a message for 5 minutes (the server checks the time again). The other side gets
 * an in-app notification. A retried send uses the same key, so it is never doubled.
 */
export function CommentThread({
  ticketId,
  viewerId,
  comments,
  names,
  add,
  edit,
  readOnly = false,
}: {
  ticketId: string;
  viewerId: string;
  comments: CommentRow[];
  names: { owner: string; customer: string };
  add: AddAction;
  edit: EditAction;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [body, setBody] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [pending, start] = useTransition();
  // Re-render each 15 s so the Edit buttons disappear when the 5 minutes are over.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);

  function send() {
    setError(null);
    start(async () => {
      try {
        const result = await add({ ticketId, idempotencyKey: key, body });
        if (!result.ok) return setError(result.fieldErrors?.body ?? result.error);
        setBody("");
        setKey(crypto.randomUUID());
        router.refresh();
      } catch {
        setError("Not sent: the connection was lost. Tap Send again.");
      }
    });
  }

  function saveEdit() {
    if (!editing) return;
    setError(null);
    start(async () => {
      const result = await edit({ commentId: editing.id, body: editing.body });
      if (!result.ok) return setError(result.fieldErrors?.body ?? result.error);
      setEditing(null);
      router.refresh();
    });
  }

  return (
    <section className="space-y-3" aria-labelledby="ticket-messages" data-testid="comment-thread">
      <h2 id="ticket-messages" className="flex items-center gap-2 text-lg font-semibold">
        <MessageSquare className="size-5" aria-hidden /> Messages
      </h2>
      {comments.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}
      <ol className="space-y-2">
        {comments.map((c) => {
          const mine = c.author_id === viewerId;
          const isEditing = editing?.id === c.id;
          return (
            <li key={c.id} className={cn("flex", mine ? "justify-end" : "justify-start")} data-testid="comment">
              <div className={cn("max-w-[85%] rounded-2xl px-3 py-2", mine ? "bg-primary text-primary-foreground" : "bg-muted")}>
                <p className="text-xs font-semibold opacity-80">{authorLabel(c, viewerId, names)}</p>
                {isEditing ? (
                  <div className="mt-1 space-y-2">
                    <Label htmlFor={`edit-${c.id}`} className="sr-only">
                      Change the message
                    </Label>
                    <Textarea
                      id={`edit-${c.id}`}
                      value={editing.body}
                      maxLength={COMMENT_MAX}
                      onChange={(e) => setEditing({ id: c.id, body: e.target.value })}
                      rows={3}
                      className="bg-background text-base text-foreground"
                    />
                    <div className="flex gap-2">
                      <Button type="button" size="sm" variant="secondary" className="h-10" disabled={pending} onClick={saveEdit}>
                        Save
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="h-10" disabled={pending} onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <p className="text-base break-words whitespace-pre-wrap" data-testid="comment-body">
                    {c.body}
                  </p>
                )}
                <p className="mt-1 flex items-center gap-2 text-xs opacity-80">
                  <span>
                    {formatDateTime(c.created_at)}
                    {c.edited_at ? " · edited" : ""}
                  </span>
                  {!readOnly && !isEditing && hydrated && canEdit(c, viewerId, now) && (
                    <button type="button" className="inline-flex min-h-8 items-center gap-1 underline underline-offset-2" onClick={() => setEditing({ id: c.id, body: c.body })}>
                      <Pencil className="size-3" aria-hidden /> Edit
                    </button>
                  )}
                </p>
              </div>
            </li>
          );
        })}
      </ol>
      {!readOnly && (
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Label htmlFor="comment-body" className="text-sm">
            Write a message
          </Label>
          <Textarea
            id="comment-body"
            value={body}
            maxLength={COMMENT_MAX}
            onChange={(e) => {
              setBody(e.target.value);
              setError(null);
            }}
            rows={3}
            className="text-base"
            placeholder="For example: my camera does not open"
            aria-describedby="comment-hint"
          />
          <p id="comment-hint" className="text-xs text-muted-foreground">
            English only, up to {COMMENT_MAX.toLocaleString("en-US")} characters ({body.length} used). You can change a message for 5 minutes.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" className="h-12 w-full text-base sm:w-auto sm:px-8" disabled={pending || !hydrated || body.trim() === ""}>
            {pending ? "Sending…" : "Send message"}
          </Button>
        </form>
      )}
    </section>
  );
}
