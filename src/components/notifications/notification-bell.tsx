"use client";

import { Bell } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { createClient } from "@/lib/supabase/client";

/**
 * Header bell with the unread count (NOT-01). The database sends a tiny Realtime
 * Broadcast on the user's private topic "notifications:<id>" when one of their
 * notifications is added or read (migration 0033; only they may join it); the bell
 * then counts again with its own client, so RLS decides. Broadcast, not Postgres
 * Changes: no write-ahead-log decoding on the free-tier database. It also counts
 * again when the tab regains focus and after a reconnect.
 */
export function NotificationBell({ userId, initialCount, href }: { userId: string; initialCount: number; href: string }) {
  const [count, setCount] = useState(initialCount);
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
    let subscribedOnce = false;
    let channel: ReturnType<typeof client.channel> | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    // Several signals close together (a burst of notifications) cost one count.
    const soon = () => {
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => void recount(), 250);
    };
    (async () => {
      // Private topics are authorised with the user's token.
      const { data } = await client.auth.getSession();
      if (cancelled) return;
      if (data.session) await client.realtime.setAuth(data.session.access_token);
      channel = client
        .channel(`notifications:${userId}`, { config: { private: true } })
        .on("broadcast", { event: "changed" }, soon)
        .subscribe((status) => {
          // The server already counted for the first render; count again only after a reconnect.
          if (status === "SUBSCRIBED") {
            if (subscribedOnce) void recount();
            subscribedOnce = true;
          }
        });
    })();
    const onFocus = () => void recount();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      if (pending) clearTimeout(pending);
      window.removeEventListener("focus", onFocus);
      if (channel) void client.removeChannel(channel);
    };
  }, [userId, recount]);

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
          className="absolute top-1 right-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-destructive px-1 text-[11px] leading-none font-bold text-white"
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
    </Link>
  );
}
