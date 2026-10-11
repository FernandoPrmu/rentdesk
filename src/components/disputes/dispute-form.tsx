"use client";

import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useState, useTransition } from "react";

import { useHydrated } from "@/components/forms/use-hydrated";
import { SlipPicker, type UploadedSlip } from "@/components/payments/slip-picker";
import { Button, buttonVariants } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import type { DisputeInput } from "@/lib/disputes/service";
import { cn } from "@/lib/utils";

/**
 * 11.4 / CP-06: the customer disputes a bill (once, decision 47): what is wrong,
 * and optionally a photo or PDF that shows it (same checks as payment slips). The
 * key makes a retry return the first dispute. Reminders and the late fee stop
 * while the rental company looks at it.
 */
export function DisputeForm({
  invoiceId,
  invoiceNo,
  ownerId,
  customerId,
  action,
}: {
  invoiceId: string;
  invoiceNo: string;
  ownerId: string;
  customerId: string;
  action: (input: DisputeInput) => Promise<ActionResult<{ ticketId: string; replayed: boolean }>>;
}) {
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<UploadedSlip | null>(null);
  const [key] = useState(() => crypto.randomUUID());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const hydrated = useHydrated();

  if (sent) {
    return (
      <div className="space-y-5 py-4 text-center" data-testid="dispute-sent">
        <CircleCheck className="mx-auto size-16 text-primary" aria-hidden />
        <h1 className="text-2xl font-bold">Dispute sent</h1>
        <p className="text-muted-foreground">Your rental company will look at bill {invoiceNo} and answer you. Reminders for this bill stop until then.</p>
        <Link href={`/customer/tickets/${sent}`} className={cn(buttonVariants(), "h-12 w-full text-base")}>
          Open the ticket
        </Link>
      </div>
    );
  }

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        setMessage(null);
        if (reason.trim().length < 3) return setErrors({ reason: "Tell your rental company what is wrong with the bill." });
        start(async () => {
          try {
            const result = await action({ invoiceId, idempotencyKey: key, reason, filePath: file?.path ?? null });
            if (result.ok) return setSent(result.data.ticketId);
            setErrors(result.fieldErrors ?? {});
            setMessage(result.error);
          } catch {
            setMessage("Not sent: the connection was lost. Tap Send again.");
          }
        });
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="dispute-reason" className="text-base">
          What is wrong with the bill?
        </Label>
        <Textarea
          id="dispute-reason"
          value={reason}
          onChange={(e) => {
            setReason(e.target.value);
            setErrors({});
          }}
          rows={4}
          maxLength={1000}
          className="text-base"
          placeholder="For example: the meter shows 7,300, not 7,600"
          aria-invalid={Boolean(errors.reason)}
        />
        {errors.reason && <p className="text-sm text-destructive">{errors.reason}</p>}
      </div>
      <SlipPicker
        ownerId={ownerId}
        customerId={customerId}
        value={file}
        onChange={setFile}
        error={errors.file}
        bucket="dispute-files"
        label="Photo or PDF (optional)"
        hint="For example a photo of the meter or of a letter. JPG, PNG or PDF up to 5 MB."
      />
      {message && (
        <p role="alert" className="rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" className="h-14 w-full text-lg" disabled={pending || !hydrated}>
        {pending ? "Sending…" : "Send dispute"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">A bill can be disputed once. You can always write to your rental company in the ticket&apos;s messages.</p>
    </form>
  );
}
