import { ChevronRight, KeyRound, Mail, Phone } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { SignOutButton } from "@/components/auth/account-menu";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { getCompanyProfile } from "@/lib/branding/company";

export const metadata: Metadata = { title: "Help" };

export default async function CustomerHelpPage() {
  const user = await requireUser("CUSTOMER");
  const provider = user.owner_id ? await getCompanyProfile(user.owner_id) : null;

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">Help</h1>
      {provider && (
        <Card>
          <CardHeader>
            <CardTitle>Contact {provider.company_name}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {provider.phone && (
              <a href={`tel:${provider.phone.replace(/[^+0-9]/g, "")}`} className="flex h-12 items-center gap-3 rounded-lg border px-4 font-medium">
                <Phone className="size-5 text-primary" aria-hidden /> {provider.phone}
              </a>
            )}
            {provider.email && (
              <a href={`mailto:${provider.email}`} className="flex h-12 items-center gap-3 rounded-lg border px-4 font-medium">
                <Mail className="size-5 text-primary" aria-hidden /> <span className="truncate">{provider.email}</span>
              </a>
            )}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Your account</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-sm text-muted-foreground">
            Signed in as <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{user.username}</code>
          </p>
          <Link href="/change-password" className="flex h-12 items-center gap-3 rounded-lg border px-4 font-medium">
            <KeyRound className="size-5 text-primary" aria-hidden />
            <span className="flex-1">Change password</span>
            <ChevronRight className="size-5 text-muted-foreground" aria-hidden />
          </Link>
          <SignOutButton />
        </CardContent>
      </Card>
    </div>
  );
}
