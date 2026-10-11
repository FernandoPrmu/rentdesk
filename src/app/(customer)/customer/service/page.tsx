import { Wrench } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { RequestList } from "@/components/service/request-list";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth/current-user";
import { listCustomerRequests } from "@/lib/service/queries";
import { cn } from "@/lib/utils";

export const metadata: Metadata = { title: "My requests" };

/** CP-07 / SRV-05: the customer's service requests, open first, and a way to ask for more. */
export default async function CustomerRequestsPage() {
  const user = await requireUser("CUSTOMER");
  const rows = await listCustomerRequests(user.id);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold tracking-tight">My requests</h1>
      <Link href="/customer/service/new" className={cn(buttonVariants(), "h-14 w-full gap-2 text-lg")}>
        <Wrench className="size-6" aria-hidden /> Request service
      </Link>
      <RequestList rows={rows} hrefBase="/customer/service" showCustomer={false} empty="No requests yet. Tap Request service when you need toner, a repair or a part." label="My requests" />
    </div>
  );
}
