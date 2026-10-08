import type { Metadata } from "next";
import { Suspense } from "react";

import { AppShell } from "@/components/app-shell";
import { SignOutButton } from "@/components/auth/account-menu";
import { PageSkeleton } from "@/components/portal/portal-shell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { PORTAL_HOME } from "@/lib/auth/session-policy";

import { ChangePasswordForm } from "./change-password-form";

export const metadata: Metadata = { title: "Change password" };

/** AUTH-03: every route redirects here while must_change_password is set. */
export default function ChangePasswordPage() {
  return (
    <AppShell>
      <Suspense fallback={<PageSkeleton />}>
        <ChangePassword />
      </Suspense>
    </AppShell>
  );
}

async function ChangePassword() {
  const user = await requireUser(undefined, { allowGate: "/change-password" });
  const forced = user.must_change_password;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-xl">{forced ? "Choose your own password" : "Change password"}</CardTitle>
          <CardDescription>
            {forced
              ? "You signed in with a temporary password. Choose a new password that only you know."
              : "Enter your current password, then the new one."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm username={user.username} forced={forced} />
        </CardContent>
      </Card>
      {forced ? (
        <SignOutButton />
      ) : (
        <a href={PORTAL_HOME[user.role]} className="block text-center text-sm font-medium text-primary underline-offset-4 hover:underline">
          Back
        </a>
      )}
    </div>
  );
}
