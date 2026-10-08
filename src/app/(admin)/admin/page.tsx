import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { listOwners } from "@/lib/accounts/queries";
import { requireUser } from "@/lib/auth/current-user";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Admin" };

// Placeholder dashboard: the system dashboard is ADM-04 (later task).
export default async function AdminHomePage() {
  await requireUser("ADMIN");
  const owners = await listOwners({});
  const count = (status: string) => owners.filter((o) => o.profile.status === status).length;

  return (
    <>
      <PageHeader title="Dashboard" description="Platform overview" />
      <Card>
        <CardHeader>
          <CardTitle>Owners</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-3 gap-3 text-center">
            {(["ACTIVE", "SUSPENDED", "DEACTIVATED"] as const).map((s) => (
              <div key={s} className="rounded-lg bg-muted p-3">
                <dt className="text-xs text-muted-foreground">{s.charAt(0) + s.slice(1).toLowerCase()}</dt>
                <dd className="text-2xl font-bold">{count(s)}</dd>
              </div>
            ))}
          </dl>
          <Link href="/admin/owners" className={cn(buttonVariants(), "h-12 w-full text-base sm:w-auto sm:px-6")}>
            Manage owners
          </Link>
        </CardContent>
      </Card>
    </>
  );
}
