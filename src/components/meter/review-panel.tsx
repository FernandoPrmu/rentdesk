"use client";

import { Check, PencilLine, Undo2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { ReadingFields, ReadingPreview } from "@/components/meter/reading-form";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import type { MeterContext } from "@/lib/billing/meter-invoice";
import { formatCount } from "@/lib/format";
import { previewReading, type ReadingErrors, type TypedText } from "@/lib/meter/readings";
import type { ReviewCredit, ReviewReading } from "@/lib/meter/service";
import { formatRupees } from "@/lib/money";

/**
 * Owner review actions (INV-07, INV-08, DEP-02): credits on the draft, confirm (with
 * an explicit tick for a counter rollover), reject with a reason, correct a reading
 * with a note. The server recalculates with the billing engine and the rpc checks
 * it again; this screen only previews.
 */
export function ReviewPanel({
  ticketId,
  invoiceId,
  estimated,
  machineType,
  readings,
  credits,
  rolloverToConfirm,
  finalRejection,
  context,
  actions,
}: {
  ticketId: string;
  invoiceId: string;
  estimated: boolean;
  machineType: "MONO" | "COLOUR";
  readings: ReviewReading[];
  credits: ReviewCredit[];
  rolloverToConfirm: boolean;
  /** Rejecting now reaches the limit (rule 28). */
  finalRejection: boolean;
  context: MeterContext | null;
  actions: {
    confirm: (ticketId: string, rolloverConfirmed: boolean) => Promise<ActionResult<{ invoiceNo: string }>>;
    reject: (ticketId: string, reason: string) => Promise<ActionResult<{ final: boolean }>>;
    correct: (ticketId: string, input: { bw: string; colour: string; note: string }) => Promise<ActionResult & { fieldErrors?: ReadingErrors & { note?: string } }>;
    setCredit: (invoiceId: string, creditId: string, include: boolean) => Promise<ActionResult<{ totalCents: number }>>;
  };
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [rolloverOk, setRolloverOk] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [correcting, setCorrecting] = useState(false);

  const run = <T,>(task: () => Promise<ActionResult<T>>, success: (data: T) => string) =>
    start(async () => {
      try {
        const result = await task();
        if (result.ok) {
          toast.success(success(result.data));
          router.refresh();
        } else toast.error(result.error);
      } catch {
        toast.error("The server could not be reached. Please try again.");
      }
    });

  return (
    <div className="space-y-5">
      {credits.length > 0 && (
        <section className="space-y-2" aria-label="Credits">
          <h2 className="text-lg font-semibold">Customer credits</h2>
          <p className="text-sm text-muted-foreground">Added to the invoice automatically. Remove one to keep it for later (for example to refund it).</p>
          <ul className="divide-y rounded-xl border bg-background">
            {credits.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-3" data-testid="review-credit">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{c.label}</p>
                  <p className="text-sm text-muted-foreground">
                    {c.removed ? `Removed · ${formatRupees(c.availableCents)} stays available` : `${formatRupees(c.appliedCents)} taken off · ${formatRupees(c.availableCents)} available`}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-11 gap-1.5"
                  disabled={pending}
                  onClick={() => run(() => actions.setCredit(invoiceId, c.id, c.removed), (d) => `Credit ${c.removed ? "added back" : "removed"}. Total ${formatRupees(d.totalCents)}`)}
                >
                  {c.removed ? <Undo2 className="size-4" aria-hidden /> : <X className="size-4" aria-hidden />}
                  {c.removed ? "Add back" : "Remove"}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {rolloverToConfirm && (
        <label className="flex items-start gap-3 rounded-xl border border-amber-500/50 bg-amber-500/10 p-4">
          <input type="checkbox" className="mt-1 size-5" checked={rolloverOk} onChange={(e) => setRolloverOk(e.target.checked)} data-testid="rollover-confirm" />
          <span className="text-sm">
            <strong>The counter went past its maximum and started again.</strong> I checked the photo: the reading is right and the copies are counted
            correctly.
          </span>
        </label>
      )}

      <div className="grid gap-2 sm:grid-cols-3">
        <Button
          type="button"
          className="h-12 gap-2 text-base"
          disabled={pending || (rolloverToConfirm && !rolloverOk)}
          onClick={() => run(() => actions.confirm(ticketId, rolloverOk), (d) => `Invoice ${d.invoiceNo} sent to the customer`)}
        >
          <Check className="size-5" aria-hidden /> Confirm invoice
        </Button>
        {!estimated && (
          <Button type="button" variant="outline" className="h-12 gap-2 text-base" disabled={pending} onClick={() => setCorrecting((v) => !v)}>
            <PencilLine className="size-5" aria-hidden /> Correct reading
          </Button>
        )}
        <Button type="button" variant="outline" className="h-12 gap-2 text-base text-destructive" disabled={pending} onClick={() => setRejecting(true)}>
          <X className="size-5" aria-hidden /> {estimated ? "Reject estimate" : "Reject reading"}
        </Button>
      </div>

      {correcting && context && (
        <CorrectionForm
          machineType={machineType}
          readings={readings}
          context={context}
          onCancel={() => setCorrecting(false)}
          onSubmit={async (input) => {
            const result = await actions.correct(ticketId, input);
            if (result.ok) {
              toast.success("Reading corrected. The customer was told.");
              setCorrecting(false);
              router.refresh();
            }
            return result;
          }}
        />
      )}

      <AlertDialog open={rejecting} onOpenChange={setRejecting}>
        <AlertDialogContent>
          {rejecting && (
            <RejectForm
              estimated={estimated}
              final={finalRejection}
              onCancel={() => setRejecting(false)}
              onSubmit={async (reason) => {
                const result = await actions.reject(ticketId, reason);
                if (result.ok) {
                  toast.success(result.data.final ? "Rejected. Enter the reading yourself now." : "Rejected. The customer was asked to send it again.");
                  setRejecting(false);
                  router.refresh();
                }
                return result;
              }}
            />
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RejectForm({
  estimated,
  final,
  onCancel,
  onSubmit,
}: {
  estimated: boolean;
  final: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<ActionResult<unknown>>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) return setError("Write a reason the customer will understand.");
        start(async () => {
          const result = await onSubmit(reason.trim());
          if (!result.ok) setError(result.error);
        });
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{estimated ? "Reject the estimated invoice" : "Reject the reading"}</AlertDialogTitle>
        <AlertDialogDescription>
          {estimated
            ? "The ticket goes back to waiting for the customer's reading. No other estimate is made for it."
            : final
              ? "This is the last rejection allowed: after it, you enter the reading yourself."
              : "The customer is told why and sends a new photo and reading."}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="reject-reason">Reason</Label>
        <Textarea id="reject-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="text-base" placeholder="For example: the photo is blurry" />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel className="h-11" disabled={pending} onClick={onCancel}>
          Cancel
        </AlertDialogCancel>
        <Button type="submit" variant="destructive" className="h-11" disabled={pending}>
          {pending ? "Rejecting…" : "Reject"}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}

function CorrectionForm({
  machineType,
  readings,
  context,
  onCancel,
  onSubmit,
}: {
  machineType: "MONO" | "COLOUR";
  readings: ReviewReading[];
  context: MeterContext;
  onCancel: () => void;
  onSubmit: (input: { bw: string; colour: string; note: string }) => Promise<ActionResult & { fieldErrors?: ReadingErrors & { note?: string } }>;
}) {
  const current = (c: "BW" | "COLOUR") => readings.find((r) => r.counter === c);
  const [typed, setTyped] = useState<TypedText>({ bw: String(current("BW")?.current ?? ""), colour: String(current("COLOUR")?.current ?? "") });
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<ReadingErrors & { note?: string }>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const preview = useMemo(() => previewReading(context, typed), [context, typed]);
  const previous = { BW: current("BW")?.previous ?? null, COLOUR: current("COLOUR")?.previous ?? null };

  return (
    <form
      className="space-y-4 rounded-xl border bg-background p-4"
      aria-label="Correct the reading"
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return setErrors({ note: "Write what you corrected and why" });
        start(async () => {
          const result = await onSubmit({ ...typed, note });
          if (!result.ok) {
            setErrors(result.fieldErrors ?? {});
            setMessage(result.error);
          }
        });
      }}
    >
      <h2 className="text-lg font-semibold">Correct the reading</h2>
      <p className="text-sm text-muted-foreground">
        The customer typed {readings.map((r) => `${r.counter === "BW" ? "B&W" : "colour"} ${formatCount(r.correctedFrom ?? r.current)}`).join(", ")}. They will see the old and the new value.
      </p>
      <ReadingFields machineType={machineType} values={typed} onChange={setTyped} errors={{ ...(preview.ok ? {} : preview.errors), ...errors }} previous={previous} idPrefix="correct" />
      <ReadingPreview preview={preview} audience="owner" />
      <div className="space-y-1.5">
        <Label htmlFor="correct-note">Note (shown to the customer)</Label>
        <Textarea id="correct-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="text-base" placeholder="For example: the photo shows 12,050" />
        {errors.note && <p className="text-sm text-destructive">{errors.note}</p>}
      </div>
      {message && <p className="text-sm text-destructive">{message}</p>}
      <div className="flex gap-2">
        <Button type="submit" className="h-12 flex-1 text-base" disabled={pending || !preview.ok}>
          {pending ? "Saving…" : "Save correction"}
        </Button>
        <Button type="button" variant="outline" className="h-12 text-base" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
