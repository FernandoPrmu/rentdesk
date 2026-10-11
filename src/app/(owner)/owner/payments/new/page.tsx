import type { Metadata } from "next";

import { RecordPaymentForm } from "@/components/payments/record-payment-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { getRecordView } from "@/lib/payments/service";

import { recordPaymentAction } from "../actions";

export const metadata: Metadata = { title: "Record a payment" };

/** PAY-07 / 11.5: cash or a cheque collected, a transfer seen in the bank, or an advance; no slip needed. */
export default async function RecordPaymentPage({ searchParams }: PageProps<"/owner/payments/new">) {
  const owner = await requireUser("OWNER");
  const { customer } = await searchParams;
  const view = await getRecordView(owner, typeof customer === "string" ? customer : null);
  return (
    <div className="max-w-2xl">
      <BackLink href="/owner/payments" label="Payments" />
      <PageHeader title="Record a payment" description="Money you received without a payment slip. The customer gets a receipt." />
      <RecordPaymentForm key={view.customer?.id ?? "none"} view={view} action={recordPaymentAction} />
    </div>
  );
}
