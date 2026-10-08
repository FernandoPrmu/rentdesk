import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AccountFilters, AccountList } from "@/components/accounts/account-list";
import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { listOwners } from "@/lib/accounts/queries";
import { accountListFilterSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Owners" };

export default async function OwnersPage({ searchParams }: PageProps<"/admin/owners">) {
  await requireUser("ADMIN");
  const filter = accountListFilterSchema.parse(await searchParams);
  const owners = await listOwners(filter);

  return (
    <>
      <PageHeader
        title="Owners"
        description="Machine rental businesses on RentDesk"
        action={
          <Link href="/admin/owners/new" className={cn(buttonVariants(), "h-12 gap-2 px-5 text-base")}>
            <Plus className="size-5" aria-hidden /> New owner
          </Link>
        }
      />
      <AccountFilters q={filter.q} status={filter.status} placeholder="Business, contact, phone or username" />
      <AccountList
        basePath="/admin/owners"
        empty={filter.q || filter.status ? "No owners match this search." : "No owners yet."}
        items={owners.map((o) => ({
          id: o.id,
          title: o.business_name,
          subtitle: o.contact_person,
          username: o.profile.username,
          phone: o.phone,
          status: o.profile.status,
          mustChangePassword: o.profile.must_change_password,
        }))}
      />
    </>
  );
}
