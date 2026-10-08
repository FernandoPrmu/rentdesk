import { Plus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Home" };

// Placeholder dashboard: the owner dashboard (RPT-01) comes with billing cycles.
export default async function OwnerHomePage() {
  const user = await requireUser("OWNER");
  return (
    <>
      <PageHeader title={`Hello, ${user.full_name || user.username}`} description="Your rental business at a glance" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Customers</CardTitle>
            <CardDescription>Create logins for your customers and manage their accounts.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 sm:flex-row">
            <Link href="/owner/customers" className={cn(buttonVariants({ variant: "outline" }), "h-12 gap-2 text-base")}>
              <Users className="size-5" aria-hidden /> View customers
            </Link>
            <Link href="/owner/customers/new" className={cn(buttonVariants(), "h-12 gap-2 text-base")}>
              <Plus className="size-5" aria-hidden /> New customer
            </Link>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Billing</CardTitle>
            <CardDescription>Meter readings, invoices and payments will appear here.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    </>
  );
}
