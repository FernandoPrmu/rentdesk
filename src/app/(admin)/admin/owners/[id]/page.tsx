import { Eye } from "lucide-react";
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
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { getOwner } from "@/lib/accounts/queries";
import { uuidSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { EMAIL_OFF_NOTE, emailSetup } from "@/lib/notifications/policy";
import { cn } from "@/lib/utils";

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
            suspendWarning={
              emailSetup().enabled
                ? "All of this owner's customers are blocked too, and they are told by email."
                : "All of this owner's customers are blocked too, and they are told in the app."
            }
            email={owner.email}
            emailOffNote={emailSetup().enabled ? null : EMAIL_OFF_NOTE}
          />
        </CardContent>
      </Card>
      <Card data-testid="support-entry">
        <CardHeader>
          <CardTitle>Support view</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={`/admin/owners/${owner.id}/support`} method="get" className="space-y-3">
            <p className="text-sm text-muted-foreground">
              See this owner&apos;s dashboard, reports and lists as they see them. Read only; every page you open is recorded in the audit log.
            </p>
            <label className="grid gap-1.5 text-sm">
              Reason <span className="text-muted-foreground">(optional)</span>
              <Input name="reason" maxLength={300} className="h-12 text-base" placeholder="e.g. Owner asked about a report" />
            </label>
            <button type="submit" className={cn(buttonVariants({ variant: "outline" }), "h-12 w-full gap-2 text-base sm:w-auto")}>
              <Eye className="size-5" aria-hidden /> Open support view
            </button>
          </form>
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
