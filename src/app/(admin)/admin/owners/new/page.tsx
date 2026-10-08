import type { Metadata } from "next";

import { createOwnerAction } from "@/app/(admin)/admin/owners/actions";
import { AccountForm } from "@/components/accounts/account-form";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "New owner" };

export default async function NewOwnerPage() {
  await requireUser("ADMIN");
  return (
    <div className="max-w-xl">
      <BackLink href="/admin/owners" label="Owners" />
      <PageHeader title="New owner" description="A username and temporary password are created for them." />
      <Card>
        <CardContent>
          <AccountForm kind="owner" mode="create" action={createOwnerAction} detailsBase="/admin/owners" />
        </CardContent>
      </Card>
    </div>
  );
}
