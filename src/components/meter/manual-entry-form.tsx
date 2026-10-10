"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";

import { ReadingFields, ReadingPreview } from "@/components/meter/reading-form";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/action-result";
import type { MeterContext } from "@/lib/billing/meter-invoice";
import { previewReading, type TypedText } from "@/lib/meter/readings";

type ManualAction = (input: { ticketId: string; idempotencyKey: string; bw: string; colour: string; note: string }) => Promise<
  ActionResult & { fieldErrors?: Record<string, string> }
>;

/** INV-12 (rule 32): the owner types the reading for the customer, with a reason; same billing engine. */
export function ManualEntryForm({
  ticketId,
  machineType,
  context,
  previous,
  action,
}: {
  ticketId: string;
  machineType: "MONO" | "COLOUR";
  context: MeterContext;
  previous: { BW: number | null; COLOUR: number | null };
  action: ManualAction;
}) {
  const router = useRouter();
  const [key] = useState(() => crypto.randomUUID());
  const [typed, setTyped] = useState<TypedText>({ bw: "", colour: "" });
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const preview = useMemo(() => previewReading(context, typed), [context, typed]);
  const typedSomething = typed.bw.trim() !== "" || typed.colour.trim() !== "";

  return (
    <form
      className="space-y-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (!note.trim()) return setErrors({ note: "Write why you are entering the reading" });
        start(async () => {
          try {
            const result = await action({ ticketId, idempotencyKey: key, ...typed, note });
            if (result.ok) {
              toast.success("Reading saved. Check it and confirm the invoice.");
              router.push(`/owner/tickets/${ticketId}/review`);
            } else {
              setErrors(result.fieldErrors ?? {});
              setMessage(result.error);
            }
          } catch {
            setMessage("The server could not be reached. Please try again.");
          }
        });
      }}
    >
      <ReadingFields
        machineType={machineType}
        values={typed}
        onChange={(v) => {
          setTyped(v);
          setMessage(null);
        }}
        errors={{ ...(typedSomething && !preview.ok ? preview.errors : {}), ...errors }}
        previous={previous}
        idPrefix="manual"
      />
      {typedSomething && <ReadingPreview preview={preview} audience="owner" />}
      <div className="space-y-1.5">
        <Label htmlFor="manual-note">Why are you entering it? (shown to the customer)</Label>
        <Textarea id="manual-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} className="text-base" placeholder="For example: the customer read it out on the phone" />
        {errors.note && <p className="text-sm text-destructive">{errors.note}</p>}
      </div>
      {message && (
        <p role="alert" className="text-sm font-medium text-destructive">
          {message}
        </p>
      )}
      <Button type="submit" className="h-12 w-full text-base" disabled={pending || !preview.ok}>
        {pending ? "Saving…" : "Save reading"}
      </Button>
    </form>
  );
}
