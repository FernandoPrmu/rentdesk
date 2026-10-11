import { NotificationBell } from "@/components/notifications/notification-bell";
import { getCurrentUser } from "@/lib/auth/current-user";
import { unreadCount } from "@/lib/notifications/queries";

const CENTRE: Record<"ADMIN" | "OWNER" | "CUSTOMER", string> = {
  ADMIN: "/admin/notifications",
  OWNER: "/owner/notifications",
  CUSTOMER: "/customer/notifications",
};

/** The bell in every portal header (NOT-01): first count on the server, then live. */
export async function HeaderBell() {
  const user = await getCurrentUser();
  if (!user || user.status !== "ACTIVE") return null;
  let count = 0;
  try {
    count = await unreadCount(user.id);
  } catch (error) {
    console.error("[notifications] bell:", error instanceof Error ? error.message : error);
  }
  return <NotificationBell userId={user.id} initialCount={count} href={CENTRE[user.role]} />;
}
