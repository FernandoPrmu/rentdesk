"use client";

import { type ReactNode, useState, useTransition } from "react";

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

/**
 * A confirmation that needs a reason (reject, reverse, move, cancel, reopen; spec
 * 11.1 "every rejection needs a reason"). The reason is required here and again
 * on the server.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  placeholder,
  destructive,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  placeholder?: string;
  destructive?: boolean;
  children?: ReactNode;
  onConfirm: (reason: string) => Promise<ActionResult<unknown>>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        {open && (
          <ReasonForm
            title={title}
            description={description}
            confirmLabel={confirmLabel}
            placeholder={placeholder}
            destructive={destructive}
            onCancel={() => onOpenChange(false)}
            onConfirm={onConfirm}
          >
            {children}
          </ReasonForm>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

function ReasonForm({
  title,
  description,
  confirmLabel,
  placeholder,
  destructive,
  children,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  placeholder?: string;
  destructive?: boolean;
  children?: ReactNode;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<ActionResult<unknown>>;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim().length < 3) return setError("Write a reason the customer will understand.");
        start(async () => {
          try {
            const result = await onConfirm(reason.trim());
            if (!result.ok) setError(result.fieldErrors?.reason ?? result.error);
          } catch {
            setError("The server could not be reached. Please try again.");
          }
        });
      }}
    >
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {children}
      <div className="space-y-1.5">
        <Label htmlFor="reason-text">Reason</Label>
        <Textarea id="reason-text" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} className="text-base" placeholder={placeholder} />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel className="h-11" disabled={pending} onClick={onCancel}>
          Cancel
        </AlertDialogCancel>
        <Button type="submit" variant={destructive ? "destructive" : "default"} className="h-11" disabled={pending}>
          {pending ? "Saving…" : confirmLabel}
        </Button>
      </AlertDialogFooter>
    </form>
  );
}
