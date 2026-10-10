"use server";

import { refresh } from "next/cache";

import { type ActionResult, fail, fieldErrorsFrom } from "@/lib/action-result";
import { formValues } from "@/lib/accounts/schemas";
import { currentActor } from "@/lib/auth/current-user";
import { invoiceTemplateSchema } from "@/lib/invoices/template-schema";
import { type LetterheadFile, previewSampleInvoice, saveInvoiceTemplate, uploadLetterhead } from "@/lib/invoices/template";

/** Settings › Invoice template (BRD-04..07). */

export async function uploadLetterheadAction(formData: FormData): Promise<ActionResult<LetterheadFile & { warning: string | null }>> {
  const actor = await currentActor("OWNER");
  const file = formData.get("letterhead");
  return uploadLetterhead(actor, file instanceof File ? file : null);
}

function parse(formData: FormData) {
  return invoiceTemplateSchema.safeParse(formValues(formData));
}

export async function previewInvoiceTemplateAction(formData: FormData): Promise<ActionResult<{ url: string }>> {
  const actor = await currentActor("OWNER");
  const parsed = parse(formData);
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  return previewSampleInvoice(actor, parsed.data);
}

export async function saveInvoiceTemplateAction(formData: FormData): Promise<ActionResult> {
  const actor = await currentActor("OWNER");
  const parsed = parse(formData);
  if (!parsed.success) return fail("Please check the highlighted fields.", fieldErrorsFrom(parsed.error.issues));
  const result = await saveInvoiceTemplate(actor, parsed.data);
  if (result.ok) refresh();
  return result;
}
