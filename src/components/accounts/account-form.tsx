"use client";

import { useRouter } from "next/navigation";
import { useActionState, useState } from "react";
import { toast } from "sonner";

import { CredentialsDialog, type ShownCredentials } from "@/components/accounts/credentials-dialog";
import { FormField } from "@/components/forms/form-field";
import { useSubmitWithoutReset } from "@/components/forms/use-submit-without-reset";
import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";

export type AccountKind = "owner" | "customer";

interface FieldDef {
  name: string;
  label: string;
  type?: "text" | "email" | "tel";
  required?: boolean;
  autoComplete?: string;
  multiline?: boolean;
}

const FIELDS: Record<AccountKind, FieldDef[]> = {
  owner: [
    { name: "business_name", label: "Business name", required: true, autoComplete: "organization" },
    { name: "contact_person", label: "Contact person", required: true, autoComplete: "name" },
    { name: "phone", label: "Phone", type: "tel", required: true, autoComplete: "tel" },
    { name: "email", label: "Email", type: "email", autoComplete: "email" },
    { name: "address", label: "Address", autoComplete: "street-address", multiline: true },
  ],
  customer: [
    { name: "name", label: "Customer name", required: true, autoComplete: "name" },
    { name: "business_name", label: "Business name", autoComplete: "organization" },
    { name: "phone", label: "Phone", type: "tel", required: true, autoComplete: "tel" },
    { name: "email", label: "Email", type: "email", autoComplete: "email" },
    { name: "address", label: "Address", autoComplete: "street-address", multiline: true },
  ],
};

export type CreateAccountResult = ActionResult<ShownCredentials & { userId: string }>;
type FormAction<T> = (prev: T | null, formData: FormData) => Promise<T>;

/**
 * Create or edit an owner (admin portal) or a customer (owner portal). After a
 * create, the new login details are shown once, then the browser opens the new
 * account's page.
 */
export function AccountForm(
  props:
    | { kind: AccountKind; mode: "create"; action: FormAction<CreateAccountResult>; detailsBase: string }
    | { kind: AccountKind; mode: "edit"; action: FormAction<ActionResult>; defaults: Record<string, string | null> },
) {
  const router = useRouter();
  const [credentials, setCredentials] = useState<(ShownCredentials & { userId: string }) | null>(null);
  const [state, formAction, pending] = useActionState(async (prev: ActionResult<unknown> | null, formData: FormData) => {
    const result = await (props.action as FormAction<ActionResult<unknown>>)(prev, formData);
    if (result.ok) {
      if (props.mode === "create") setCredentials((result as Extract<CreateAccountResult, { ok: true }>).data);
      else toast.success("Changes saved");
    }
    return result;
  }, null);
  const defaults = props.mode === "edit" ? props.defaults : {};
  const onSubmit = useSubmitWithoutReset(formAction);

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {FIELDS[props.kind].map((field) => (
          <FormField
            key={field.name}
            name={field.name}
            label={field.label}
            type={field.type}
            required={field.required}
            autoComplete={field.autoComplete}
            multiline={field.multiline}
            defaultValue={defaults[field.name] ?? ""}
            error={errors[field.name]}
          />
        ))}
        {state && !state.ok && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {state.error}
          </p>
        )}
        <Button type="submit" disabled={pending} className="h-12 w-full text-base sm:w-auto sm:px-8">
          {pending ? "Saving…" : props.mode === "create" ? `Create ${props.kind} account` : "Save changes"}
        </Button>
      </form>
      {props.mode === "create" && (
        <CredentialsDialog
          credentials={credentials}
          title={`${props.kind === "owner" ? "Owner" : "Customer"} account created`}
          onDone={() => {
            const id = credentials?.userId;
            setCredentials(null);
            if (id) router.push(`${props.detailsBase}/${id}`);
          }}
        />
      )}
    </>
  );
}
