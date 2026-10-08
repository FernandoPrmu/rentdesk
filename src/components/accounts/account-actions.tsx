"use client";

import { Ban, KeyRound, RotateCcw, UserRoundX } from "lucide-react";
import { useActionState, useState, useTransition } from "react";
import { toast } from "sonner";

import { CredentialsDialog, type ShownCredentials } from "@/components/accounts/credentials-dialog";
import { useSubmitWithoutReset } from "@/components/forms/use-submit-without-reset";
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
import type { AccountStatusValue } from "@/lib/accounts/schemas";

type StatusAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;
type ResetAction = () => Promise<ActionResult<ShownCredentials>>;

const STATUS_COPY: Record<AccountStatusValue, { verb: string; title: string; warning: string }> = {
  SUSPENDED: {
    verb: "Suspend",
    title: "Suspend this account?",
    warning: "The user is signed out and cannot sign in until the account is reactivated.",
  },
  ACTIVE: { verb: "Reactivate", title: "Reactivate this account?", warning: "The user can sign in again." },
  DEACTIVATED: {
    verb: "Deactivate",
    title: "Deactivate this account?",
    warning: "Use this when the user has left. They cannot sign in. Their records are kept.",
  },
};

function StatusDialog({
  target,
  name,
  extraWarning,
  action,
  onClose,
}: {
  target: AccountStatusValue | null;
  name: string;
  extraWarning?: string;
  action: StatusAction;
  onClose: () => void;
}) {
  const [state, formAction, pending] = useActionState(async (prev: ActionResult | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) {
      toast.success("Account status changed");
      onClose();
    }
    return result;
  }, null);
  const onSubmit = useSubmitWithoutReset(formAction);
  const copy = target ? STATUS_COPY[target] : null;

  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && !pending && onClose()}>
      <AlertDialogContent>
        {copy && target && (
          <form onSubmit={onSubmit} className="grid gap-4">
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>
                <strong>{name}</strong>. {copy.warning} {target !== "ACTIVE" && extraWarning}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <input type="hidden" name="status" value={target} />
            <div className="space-y-1.5">
              <Label htmlFor="status-reason">Reason</Label>
              <Textarea id="status-reason" name="reason" required minLength={3} rows={3} className="text-base" />
              {state && !state.ok && (
                <p role="alert" className="text-sm text-destructive">
                  {state.fieldErrors?.reason ?? state.error}
                </p>
              )}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel className="h-11" disabled={pending}>
                Cancel
              </AlertDialogCancel>
              <Button type="submit" variant={target === "ACTIVE" ? "default" : "destructive"} className="h-11" disabled={pending}>
                {pending ? "Saving…" : copy.verb}
              </Button>
            </AlertDialogFooter>
          </form>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Suspend / reactivate / deactivate (with reason and confirmation) and password
 * reset (new temporary password shown once). ADM-02/03, CUS-03.
 */
export function AccountActions({
  name,
  status,
  statusAction,
  resetAction,
  suspendWarning,
}: {
  name: string;
  status: AccountStatusValue;
  statusAction: StatusAction;
  resetAction: ResetAction;
  suspendWarning?: string;
}) {
  const [target, setTarget] = useState<AccountStatusValue | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [credentials, setCredentials] = useState<ShownCredentials | null>(null);
  const [resetting, startReset] = useTransition();

  const options: AccountStatusValue[] =
    status === "ACTIVE" ? ["SUSPENDED", "DEACTIVATED"] : status === "SUSPENDED" ? ["ACTIVE", "DEACTIVATED"] : ["ACTIVE"];
  const icons = { ACTIVE: RotateCcw, SUSPENDED: Ban, DEACTIVATED: UserRoundX };

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
      {options.map((s) => {
        const Icon = icons[s];
        return (
          <Button key={s} type="button" variant={s === "ACTIVE" ? "default" : "outline"} className="h-12 gap-2 text-base" onClick={() => setTarget(s)}>
            <Icon className="size-5" aria-hidden />
            {STATUS_COPY[s].verb}
          </Button>
        );
      })}
      {status !== "DEACTIVATED" && (
        <Button type="button" variant="outline" className="h-12 gap-2 text-base" onClick={() => setConfirmReset(true)}>
          <KeyRound className="size-5" aria-hidden />
          Reset password
        </Button>
      )}

      {/* Keyed so each opening starts with an empty form. */}
      <StatusDialog
        key={target ?? "closed"}
        target={target}
        name={name}
        extraWarning={suspendWarning}
        action={statusAction}
        onClose={() => setTarget(null)}
      />

      <AlertDialog open={confirmReset} onOpenChange={(open) => !open && !resetting && setConfirmReset(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the password?</AlertDialogTitle>
            <AlertDialogDescription>
              <strong>{name}</strong> gets a new temporary password and must choose a new one at the next sign-in. The old
              password stops working now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="h-11" disabled={resetting}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              className="h-11"
              disabled={resetting}
              onClick={() =>
                startReset(async () => {
                  const result = await resetAction();
                  setConfirmReset(false);
                  if (result.ok) setCredentials(result.data);
                  else toast.error(result.error);
                })
              }
            >
              {resetting ? "Resetting…" : "Reset password"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <CredentialsDialog credentials={credentials} title="New temporary password" onDone={() => setCredentials(null)} />
    </div>
  );
}
