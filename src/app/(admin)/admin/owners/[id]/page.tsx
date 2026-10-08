import type { Metadata } from "next";
import { notFound } from "next/navigation";

import {
  resetOwnerPasswordAction,
  setOwnerStatusAction,
  updateOwnerAction,
} from "@/app/(admin)/admin/owners/actions";
import { AccountActions } from "@/components/accounts/account-actions";
import { AccountForm } from "@/components/accounts/account-form";
import { AccountSummary } from "@/components/accounts/account-summary";
import { BackLink } from "@/components/portal/back-link";
import { PageHeader } from "@/components/portal/portal-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getOwner } from "@/lib/accounts/queries";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Owner" };

export default async function OwnerDetailPage({ params }: PageProps<"/admin/owners/[id]">) {
  await requireUser("ADMIN");
  const { id } = await params;
  if (!uuidSchema.safeParse(id).success) notFound();
  const owner = await getOwner(id);
  if (!owner) notFound();

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <BackLink href="/admin/owners" label="Owners" />
        <PageHeader title={owner.business_name} />
        <AccountSummary
          username={owner.profile.username}
          status={owner.profile.status}
          lastLoginAt={owner.profile.last_login_at}
          mustChangePassword={owner.profile.must_change_password}
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountActions
            name={owner.business_name}
            status={owner.profile.status}
            statusAction={setOwnerStatusAction.bind(null, owner.id)}
            resetAction={resetOwnerPasswordAction.bind(null, owner.id)}
            suspendWarning="All of this owner's customers are blocked too."
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <AccountForm
            kind="owner"
            mode="edit"
            action={updateOwnerAction.bind(null, owner.id)}
            defaults={{
              business_name: owner.business_name,
              contact_person: owner.contact_person,
              phone: owner.phone,
              email: owner.email,
              address: owner.address,
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}
