"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

/**
 * Header bell with the unread count (NOT-01). It listens to Supabase Realtime for
 * the user's own notification rows (inserted, or marked read in another tab) and
 * counts again; RLS still decides what the browser may see. It also counts again
 * after a page change, so marking items read on the list updates it.
 */
export function NotificationBell({ userId, initialCount, href }: { userId: string; initialCount: number; href: string }) {
  const [count, setCount] = useState(initialCount);
  const pathname = usePathname();
  const supabase = useRef<ReturnType<typeof createClient> | null>(null);

  const recount = useCallback(async () => {
    const client = (supabase.current ??= createClient());
    const { count: unread, error } = await client
      .from("notifications")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("channel", "IN_APP")
      .is("read_at", null);
    if (!error && unread !== null) setCount(unread);
  }, [userId]);

  useEffect(() => {
    const client = (supabase.current ??= createClient());
    let cancelled = false;
    let channel: ReturnType<typeof client.channel> | null = null;
    (async () => {
      // Realtime checks RLS with the user's token: hand it over before subscribing.
      const { data } = await client.auth.getSession();
      if (cancelled) return;
      if (data.session) await client.realtime.setAuth(data.session.access_token);
      channel = client
        .channel(`notifications:${userId}`)
        .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, () => {
          void recount();
        })
        .subscribe((status) => {
          // After a reconnect, catch up on anything missed.
          if (status === "SUBSCRIBED") void recount();
        });
    })();
    const onFocus = () => void recount();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
      if (channel) void client.removeChannel(channel);
    };
  }, [userId, recount]);

  // A page change (e.g. after items were marked read on the list): count again, once the page settled.
  useEffect(() => {
    const t = setTimeout(() => void recount(), 300);
    return () => clearTimeout(t);
  }, [pathname, recount]);

  const label = count === 0 ? "Notifications" : `Notifications, ${count} unread`;
  return (
    <Link
      href={href}
      aria-label={label}
      data-testid="notification-bell"
      data-unread={count}
      className="relative inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Bell className="size-6" aria-hidden />
      {count > 0 && (
        <span
          data-testid="notification-badge"
          className={cn(
            "absolute top-1 right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] leading-none font-bold text-white",
          )}
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
