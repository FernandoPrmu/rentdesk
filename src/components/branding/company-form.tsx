"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { BrandLogo } from "@/components/branding/brand-badge";
import { FormField } from "@/components/forms/form-field";
import { useSubmitWithoutReset } from "@/components/forms/use-submit-without-reset";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { ActionResult } from "@/lib/action-result";
import { LOGO_ACCEPT, LOGO_MAX_BYTES } from "@/lib/branding/logo";

export interface CompanyDefaults {
  company_name: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  bank_name: string | null;
  bank_branch: string | null;
  bank_account_name: string | null;
  bank_account_no: string | null;
}

type SaveAction = (prev: ActionResult | null, formData: FormData) => Promise<ActionResult>;

/**
 * Company details, bank details for invoices and an optional logo (BRD-01..03).
 * Used by /setup (first time) and Settings > Company.
 */
export function CompanyForm({
  action,
  defaults,
  logoUrl,
  submitLabel,
}: {
  action: SaveAction;
  defaults: CompanyDefaults;
  logoUrl: string | null;
  submitLabel: string;
}) {
  const [state, formAction, pending] = useActionState(async (prev: ActionResult | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) toast.success("Company details saved");
    return result;
  }, null);
  const [preview, setPreview] = useState<string | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [name, setName] = useState(defaults.company_name);
  const fileInput = useRef<HTMLInputElement>(null);
  const onSubmit = useSubmitWithoutReset(formAction);

  useEffect(() => () => {
    if (preview) URL.revokeObjectURL(preview);
  }, [preview]);

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const shownLogo = preview ?? (removeLogo ? null : logoUrl);

  return (
    <form onSubmit={onSubmit} className="space-y-6" noValidate>
      <fieldset className="space-y-4">
        <legend className="mb-3 text-lg font-semibold">Company</legend>
        <div className="space-y-1.5">
          <Label htmlFor="field-company_name">Company name</Label>
          <input
            id="field-company_name"
            name="company_name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="organization"
            required
            aria-invalid={errors.company_name ? true : undefined}
            className="flex h-12 w-full rounded-lg border border-input bg-transparent px-3 text-base outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive"
          />
          {errors.company_name && <p className="text-sm text-destructive">{errors.company_name}</p>}
        </div>
        <FormField name="address" label="Address" required multiline autoComplete="street-address" defaultValue={defaults.address ?? ""} error={errors.address} />
        <FormField name="phone" label="Phone" type="tel" required autoComplete="tel" defaultValue={defaults.phone ?? ""} error={errors.phone} />
        <FormField name="email" label="Email" type="email" required autoComplete="email" defaultValue={defaults.email ?? ""} error={errors.email} />
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-1 text-lg font-semibold">Logo</legend>
        <p className="text-sm text-muted-foreground">JPG, PNG or SVG, up to 2 MB. Shown to your customers and on invoices. You can add it later.</p>
        <div className="flex items-center gap-4">
          <BrandLogo name={name || "?"} logoUrl={shownLogo} className="size-16 text-xl" />
          <div className="flex flex-col gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={() => fileInput.current?.click()}>
              {shownLogo ? "Change logo" : "Choose logo"}
            </Button>
            {(shownLogo || preview) && (
              <Button
                type="button"
                variant="ghost"
                className="h-11"
                onClick={() => {
                  if (fileInput.current) fileInput.current.value = "";
                  setPreview(null);
                  setRemoveLogo(Boolean(logoUrl));
                }}
              >
                Remove logo
              </Button>
            )}
          </div>
        </div>
        <input
          ref={fileInput}
          type="file"
          name="logo"
          accept={LOGO_ACCEPT}
          className="sr-only"
          aria-label="Logo file"
          data-testid="logo-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            setLogoError(null);
            if (!file) return;
            if (file.size > LOGO_MAX_BYTES) {
              setLogoError("The logo must be 2 MB or smaller.");
              e.target.value = "";
              return;
            }
            setRemoveLogo(false);
            setPreview(URL.createObjectURL(file));
          }}
        />
        {removeLogo && <input type="hidden" name="remove_logo" value="on" />}
        {(logoError ?? errors.logo) && <p className="text-sm text-destructive">{logoError ?? errors.logo}</p>}
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="mb-1 text-lg font-semibold">Bank details for invoices</legend>
        <p className="text-sm text-muted-foreground">Customers see these on invoices when they pay you.</p>
        <FormField name="bank_name" label="Bank" required defaultValue={defaults.bank_name ?? ""} error={errors.bank_name} />
        <FormField name="bank_branch" label="Branch" defaultValue={defaults.bank_branch ?? ""} error={errors.bank_branch} />
        <FormField name="bank_account_name" label="Account name" required defaultValue={defaults.bank_account_name ?? ""} error={errors.bank_account_name} />
        <FormField
          name="bank_account_no"
          label="Account number"
          required
          inputMode="numeric"
          defaultValue={defaults.bank_account_no ?? ""}
          error={errors.bank_account_no}
        />
      </fieldset>

      {state && !state.ok && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending} className="h-12 w-full text-base sm:w-auto sm:px-8">
        {pending ? "Saving…" : submitLabel}
      </Button>
    </form>
  );
}
