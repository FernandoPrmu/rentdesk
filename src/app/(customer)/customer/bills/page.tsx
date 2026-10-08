import type { Metadata } from "next";

import { ComingSoon } from "@/components/portal/coming-soon";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Bills" };

export default async function CustomerBillsPage() {
  await requireUser("CUSTOMER");
  return <ComingSoon title="Your bills" text="Your invoices and payments will be listed here." />;
}
