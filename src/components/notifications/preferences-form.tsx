"use client";

import { useState } from "react";
import { toast } from "sonner";

import { savePreferencesAction } from "@/app/actions/notifications";
import { FormError } from "@/components/forms/form-field";
import { useFormAction } from "@/components/forms/use-form-action";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";

/**
 * Email settings (decision 68): reminders and other updates can be turned off;
 * essential emails always go. In-app notifications are never turned off.
 */
export function PreferencesForm({
  defaults,
  email,
  noEmailHint,
  updatesLabel,
}: {
  defaults: { reminders: boolean; updates: boolean };
  email: string | null;
  /** What to do when there is no address. */
  noEmailHint: string;
  updatesLabel: string;
}) {
  const hydrated = useHydrated();
  const [reminders, setReminders] = useState(defaults.reminders);
  const [updates, setUpdates] = useState(defaults.updates);
  const { onSubmit, pending, formError } = useFormAction(savePreferencesAction, () => toast.success("Email settings saved"));
  return (
    <form onSubmit={onSubmit} className="space-y-4" noValidate>
      <p className="text-sm" data-testid="email-address">
        {email ? (
          <>
            Emails go to <strong className="break-all">{email}</strong>.
          </>
        ) : (
          <span className="text-muted-foreground">No email address on your account. {noEmailHint}</span>
        )}
      </p>
      <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border bg-background px-3 py-3">
        <input
          type="checkbox"
          name="email_reminders"
          checked={reminders}
          onChange={(e) => setReminders(e.target.checked)}
          className="mt-0.5 size-6 shrink-0 accent-primary"
        />
        <span>
          <span className="block font-medium">Reminder emails</span>
          <span className="block text-sm text-muted-foreground">Meter reading and payment reminders, and other reminders before a deadline.</span>
        </span>
      </label>
      <label className="flex min-h-14 cursor-pointer items-start gap-3 rounded-lg border bg-background px-3 py-3">
        <input
          type="checkbox"
          name="email_updates"
          checked={updates}
          onChange={(e) => setUpdates(e.target.checked)}
          className="mt-0.5 size-6 shrink-0 accent-primary"
        />
        <span>
          <span className="block font-medium">Update emails</span>
          <span className="block text-sm text-muted-foreground">{updatesLabel}</span>
        </span>
      </label>
      <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">
        Bills, receipts, login details and changes to your account are always emailed. Everything is also in the Notifications list in RentDesk.
      </p>
      <FormError message={formError} />
      <Button type="submit" className="h-12 w-full text-base sm:w-auto sm:px-8" disabled={!hydrated || pending}>
        {pending ? "Saving…" : "Save email settings"}
      </Button>
    </form>
  );
}
