import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  resetCustomerPasswordAction,
  setCustomerStatusAction,
  updateCustomerAction,
} from "@/app/(owner)/owner/customers/actions";
import { AccountActions } from "@/components/accounts/account-actions";
import { AccountForm } from "@/components/accounts/account-form";
import { AccountSummary } from "@/components/accounts/account-summary";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCustomer } from "@/lib/accounts/queries";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerDetailPage({ params }: PageProps<"/owner/customers/[id]">) {
  await requireUser("OWNER");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  // RLS: an owner only ever sees their own customers; anything else is "not found".
  const customer = await getCustomer(id);
  if (!customer) notFound();

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href="/owner/customers" label="Customers" />
        <PageHeader title={customer.name} description={customer.business_name ?? undefined} />
        <AccountSummary
          username={customer.profile.username}
          status={customer.profile.status}
          lastLoginAt={customer.profile.last_login_at}
          mustChangePassword={customer.profile.must_change_password}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountActions
            name={customer.name}
            status={customer.profile.status}
            statusAction={setCustomerStatusAction.bind(null, customer.id)}
            resetAction={resetCustomerPasswordAction.bind(null, customer.id)}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountForm
            kind="customer"
            mode="edit"
            action={updateCustomerAction.bind(null, customer.id)}
            defaults={{
              name: customer.name,
              business_name: customer.business_name,
              phone: customer.phone,
              email: customer.email,
              address: customer.address,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
