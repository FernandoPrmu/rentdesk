import type { Metadata } from "next";

import { NotificationCentrePage } from "@/components/notifications/centre-page";

export const metadata: Metadata = { title: "Notifications" };

export default function Page() {
  return <NotificationCentrePage role="OWNER" />;
}
