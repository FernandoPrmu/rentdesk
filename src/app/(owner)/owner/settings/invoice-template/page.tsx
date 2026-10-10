import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { InvoiceTemplateForm } from "@/components/settings/invoice-template-form";
import { requireUser } from "@/lib/auth/current-user";
import { getInvoiceTemplate } from "@/lib/invoices/template";

import { previewInvoiceTemplateAction, saveInvoiceTemplateAction, uploadLetterheadAction } from "./actions";

export const metadata: Metadata = { title: "Invoice template" };

/** BRD-04..07: letterhead, where the invoice data goes on it, sample preview, payment instructions. */
export default async function InvoiceTemplatePage() {
  const user = await requireUser("OWNER");
  const template = await getInvoiceTemplate(user);
  if (!template) redirect("/setup");

  return (
    <div className="max-w-2xl">
      <BackLink href="/owner/settings" label="Settings" />
      <PageHeader
        title="Invoice template"
        description="How your invoice PDFs look. Changes apply to new invoices only; invoices already sent keep their PDF."
      />
      <InvoiceTemplateForm
        initial={template}
        uploadAction={uploadLetterheadAction}
        previewAction={previewInvoiceTemplateAction}
        saveAction={saveInvoiceTemplateAction}
      />
    </div>
  );
}
