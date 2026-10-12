import { Settings } from "lucide-react";
import Link from "next/link";

import { NotificationList } from "@/components/notifications/notification-list";
import { PageHeader } from "@/components/portal/portal-shell";
import { requireUser } from "@/lib/auth/current-user";
import { listNotifications } from "@/lib/notifications/queries";
import { preferencesPath } from "@/lib/notifications/policy";

/** The notification centre page of each portal (NOT-01, CP-08). */
export async function NotificationCentrePage({ role }: { role: "CUSTOMER" | "OWNER" | "ADMIN" }) {
  const user = await requireUser(role);
  const { items, more } = await listNotifications(user.id);
  return (
    <div className="max-w-2xl space-y-4">
      <PageHeader
        title="Notifications"
        action={
          <Link href={preferencesPath(role)} className="inline-flex h-11 items-center gap-2 rounded-lg px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground">
            <Settings className="size-4" aria-hidden /> Email settings
          </Link>
        }
      />
      <NotificationList initial={items} more={more} />
    </div>
  );
}
