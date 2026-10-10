import type { Metadata } from "next";

import { PayForm } from "@/components/payments/pay-form";
import { BackLink } from "@/components/portal/back-link";
import { requireUser } from "@/lib/auth/current-user";
import { getPayView } from "@/lib/payments/service";

import { submitPaymentAction } from "./actions";

export const metadata: Metadata = { title: "Pay" };

/**
 * CP-04 / PAY-02: pay one or more bills with one slip. Opened from the Home task,
 * Bills or a bill (?invoice= ticks it). The gallery and files are allowed here,
 * unlike meter photos.
 */
export default async function CustomerPayPage({ searchParams }: PageProps<"/customer/pay">) {
  const user = await requireUser("CUSTOMER");
  const { invoice } = await searchParams;
  const preselect = (Array.isArray(invoice) ? invoice : invoice ? [invoice] : []).filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const view = await getPayView(user, preselect);
  return (
    <div className="space-y-4">
      <BackLink href="/customer/bills" label="Bills" />
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Send a payment slip</h1>
        <p className="text-sm text-muted-foreground">Pay your rental company first (bank transfer or deposit), then send the slip here.</p>
      </div>
      <PayForm view={view} action={submitPaymentAction} />
    </div>
  );
}
