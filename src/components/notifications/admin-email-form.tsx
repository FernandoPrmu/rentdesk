"use client";

import { toast } from "sonner";

import { setAdminEmailAction } from "@/app/actions/notifications";
import { FormError, FormField } from "@/components/forms/form-field";
import { useFormAction } from "@/components/forms/use-form-action";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";

/** Where the admin's alerts are emailed (escalations, daily job problems). */
export function AdminEmailForm({ email }: { email: string | null }) {
  const hydrated = useHydrated();
  const { onSubmit, pending, errors, formError } = useFormAction(setAdminEmailAction, () => toast.success("Email address saved"));
  return (
    <form onSubmit={onSubmit} className="space-y-3" noValidate>
      <FormField name="email" label="Your email for admin alerts" type="email" autoComplete="email" defaultValue={email ?? ""} error={errors.email} hint="Leave empty to get alerts in RentDesk only." />
      <FormError message={formError} />
      <Button type="submit" className="h-12 w-full text-base sm:w-auto sm:px-8" disabled={!hydrated || pending}>
        {pending ? "Saving…" : "Save email address"}
      </Button>
    </form>
  );
}
