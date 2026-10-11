"use client";

import { CircleCheck, Star } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { ReasonDialog } from "@/components/forms/reason-dialog";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import type { CustomerStepForm } from "@/lib/service/service";
import type { ServiceStatus } from "@/lib/service/states";
import { cn } from "@/lib/utils";

/**
 * The customer's steps on a request (spec 7.2; decision 57): confirm the repair
 * (Closed) or say it is still not fixed (back to In progress, with what is wrong);
 * cancel while it is still New.
 */
export function CustomerRequestActions({
  requestId,
  status,
  action,
}: {
  requestId: string;
  status: ServiceStatus;
  action: (requestId: string, input: CustomerStepForm) => Promise<ActionResult<{ status: ServiceStatus }>>;
}) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [open, setOpen] = useState<"reopen" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = async (input: CustomerStepForm, message: string) => {
    const result = await action(requestId, input);
    if (result.ok) {
      toast.success(message);
      setOpen(null);
      router.refresh();
    }
    return result;
  };

  if (status === "RESOLVED") {
    return (
      <div className="space-y-3 rounded-xl border-2 border-primary/40 bg-background p-4" data-testid="confirm-fix">
        <p className="text-lg font-semibold">Is it working now?</p>
        <p className="text-sm text-muted-foreground">Your rental company says the work is done. Please check and tell them.</p>
        <Button
          type="button"
          className="h-14 w-full gap-2 text-lg"
          disabled={!hydrated || pending}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                const r = await run({ action: "CONFIRM" }, "Thank you. The request is closed.");
                if (!r.ok) setError(r.error);
              } catch {
                setError("The server could not be reached. Please try again.");
              }
            })
          }
        >
          <CircleCheck className="size-6" aria-hidden /> {pending ? "Saving…" : "Yes, it is fixed"}
        </Button>
        <Button type="button" variant="outline" className="h-12 w-full text-base" disabled={!hydrated || pending} onClick={() => setOpen("reopen")}>
          No, still not fixed
        </Button>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <ReasonDialog
          open={open === "reopen"}
          onOpenChange={(o) => setOpen(o ? "reopen" : null)}
          title="Still not fixed"
          description="Tell your rental company what is still wrong. The request goes back to them."
          confirmLabel="Send"
          placeholder="For example: the paper still jams in tray 2"
          onConfirm={(reason) => run({ action: "REOPEN", reason }, "Sent. Your rental company will look at it again.")}
        />
      </div>
    );
  }

  if (status !== "NEW") return null;
  return (
    <>
      <Button type="button" variant="outline" className="h-12 w-full text-base" disabled={!hydrated} onClick={() => setOpen("cancel")}>
        Cancel this request
      </Button>
      <ReasonDialog
        open={open === "cancel"}
        onOpenChange={(o) => setOpen(o ? "cancel" : null)}
        title="Cancel the request"
        description="You can cancel until your rental company has seen it."
        confirmLabel="Cancel request"
        destructive
        placeholder="For example: it works again"
        onConfirm={(reason) => run({ action: "CANCEL", reason }, "Request cancelled.")}
      />
    </>
  );
}

/** SRV-09: 1 to 5 stars and an optional comment, once, after the request is closed. */
export function RatingForm({ requestId, action }: { requestId: string; action: (requestId: string, input: { rating: number; comment?: string }) => Promise<ActionResult> }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="space-y-3 rounded-xl border bg-background p-4"
      data-testid="rating-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (rating < 1) return setError("Tap a star to rate the service.");
        start(async () => {
          setError(null);
          try {
            const r = await action(requestId, { rating, comment: comment.trim() || undefined });
            if (!r.ok) return setError(r.error);
            toast.success("Thank you for your rating.");
            router.refresh();
          } catch {
            setError("The server could not be reached. Please try again.");
          }
        });
      }}
    >
      <p className="text-lg font-semibold">How was the service?</p>
      <div className="flex gap-1" role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={rating === n}
            aria-label={`${n} ${n === 1 ? "star" : "stars"}`}
            className="flex size-12 items-center justify-center rounded-lg"
            onClick={() => setRating(n)}
          >
            <Star className={cn("size-9", n <= rating ? "fill-amber-400 text-amber-500" : "text-muted-foreground")} aria-hidden />
          </button>
        ))}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="rating-comment">
          Comment <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Textarea id="rating-comment" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} maxLength={500} className="text-base" />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" className="h-12 w-full text-base" disabled={!hydrated || pending}>
        {pending ? "Sending…" : "Send rating"}
      </Button>
    </form>
  );
}
