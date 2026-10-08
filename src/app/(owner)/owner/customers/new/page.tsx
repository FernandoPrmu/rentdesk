import type { Metadata } from "next";

import { createCustomerAction } from "@/app/(owner)/owner/customers/actions";
import { AccountForm } from "@/components/accounts/account-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "New customer" };

export default async function NewCustomerPage() {
  await requireUser("OWNER");
  return (
    <div className="max-w-xl">
      <BackLink href="/owner/customers" label="Customers" />
      <PageHeader title="New customer" description="A username and temporary password are created for them." />
      <Card>
        <CardContent>
          <AccountForm kind="customer" mode="create" action={createCustomerAction} detailsBase="/owner/customers" />
        </CardContent>
      </Card>
    </div>
  );
}
