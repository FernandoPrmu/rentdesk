import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AccountFilters, AccountList } from "@/components/accounts/account-list";
import { PageHeader } from "@/components/portal/portal-shell";
import { buttonVariants } from "@/components/ui/button";
import { listCustomers } from "@/lib/accounts/queries";
import { accountListFilterSchema } from "@/lib/accounts/schemas";
import { requireUser } from "@/lib/auth/current-user";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Customers" };

export default async function CustomersPage({ searchParams }: PageProps<"/owner/customers">) {
  await requireUser("OWNER");
  const filter = accountListFilterSchema.parse(await searchParams);
  const customers = await listCustomers(filter);

  return (
    <>
      <PageHeader
        title="Customers"
        action={
          <Link href="/owner/customers/new" className={cn(buttonVariants(), "h-12 gap-2 px-5 text-base")}>
            <Plus className="size-5" aria-hidden /> New customer
          </Link>
        }
      />
      <AccountFilters q={filter.q} status={filter.status} placeholder="Name, business, phone or username" />
      <AccountList
        basePath="/owner/customers"
        empty={filter.q || filter.status ? "No customers match this search." : "No customers yet. Create the first one."}
        items={customers.map((c) => ({
          id: c.id,
          title: c.name,
          subtitle: c.business_name,
          username: c.profile.username,
          phone: c.phone,
          status: c.profile.status,
          mustChangePassword: c.profile.must_change_password,
        }))}
      />
    </>
  );
}
