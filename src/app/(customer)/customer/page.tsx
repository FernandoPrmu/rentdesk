import { CircleCheck } from "lucide-react";
import type { Metadata } from "next";

import { Card, CardContent } from "@/components/ui/card";
import { requireUser } from "@/lib/auth/current-user";

export const metadata: Metadata = { title: "Home" };

/**
 * CP-01 / CP-02 placeholder. The real list of tasks (meter reading due, invoice to
 * pay, slip rejected) arrives with billing cycle tickets.
 */
export default async function CustomerHomePage() {
  const user = await requireUser("CUSTOMER");
  return (
    <div className="space-y-5">
      <div>
        <p className="text-sm text-muted-foreground">Hello, {user.full_name || user.username}</p>
        <h1 className="text-2xl font-bold tracking-tight">What you need to do now</h1>
      </div>
      <Card>
        <CardContent className="flex items-center gap-4 py-2">
          <CircleCheck className="size-10 shrink-0 text-primary" aria-hidden />
          <div>
            <p className="text-lg font-semibold">Nothing right now</p>
            <p className="text-sm text-muted-foreground">
              When it is time to send your meter reading or pay a bill, it will show here.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
