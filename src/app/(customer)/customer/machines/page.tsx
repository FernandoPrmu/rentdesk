import type { Metadata } from "next";

import { ComingSoon } from "@/components/portal/coming-soon";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Machines" };

export default async function CustomerMachinesPage() {
  await requireUser("CUSTOMER");
  return <ComingSoon title="Your machines" text="The machines you rent will be listed here." />;
}
