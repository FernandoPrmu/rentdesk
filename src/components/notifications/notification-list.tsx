"use client";

import { BellOff, CheckCheck, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { loadMoreNotifications, markAllNotificationsRead, markNotificationRead } from "@/app/actions/notifications";
import { useHydrated } from "@/components/forms/use-hydrated";
import { Button } from "@/components/ui/button";
import { unreachable } from "@/lib/actions/client-errors";
import { formatDateTime } from "@/lib/format";
import type { CentreItem } from "@/lib/notifications/queries";
import { cn } from "@/lib/utils";

/**
 * The notification centre (NOT-01, CP-08): newest first, unread ones marked, a tap
 * marks one read and opens its page, "Mark all as read", and more on request.
 * Sized for 360 px: whole rows are the tap targets.
 */
export function NotificationList({ initial, more: initialMore }: { initial: CentreItem[]; more: boolean }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [items, setItems] = useState(initial);
  const [more, setMore] = useState(initialMore);
  const [pending, start] = useTransition();
  const unread = items.filter((i) => !i.readAt).length;

  const open = (item: CentreItem) =>
    start(async () => {
      if (!item.readAt) {
        setItems((all) => all.map((i) => (i.id === item.id ? { ...i, readAt: new Date().toISOString() } : i)));
        try {
          await markNotificationRead(item.id);
        } catch {
          // Still open the page; it stays unread on the server and the bell shows it.
        }
      }
      if (item.link) router.push(item.link);
    });

  const markAll = () =>
    start(async () => {
      try {
        const result = await markAllNotificationsRead();
        if (!result.ok) return void toast.error(result.error);
        const now = new Date().toISOString();
        setItems((all) => all.map((i) => (i.readAt ? i : { ...i, readAt: now })));
        toast.success("All marked as read");
      } catch {
        toast.error(unreachable("safe"));
      }
    });

  const loadMore = () =>
    start(async () => {
      const last = items[items.length - 1];
      if (!last) return;
      try {
        const result = await loadMoreNotifications(last.createdAt);
        if (!result.ok) return void toast.error(result.error);
        setItems((all) => [...all, ...result.data.items.filter((n) => !all.some((a) => a.id === n.id))]);
        setMore(result.data.more);
      } catch {
        toast.error(unreachable("safe"));
      }
    });

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border bg-background px-4 py-10 text-center text-muted-foreground">
        <BellOff className="size-8" aria-hidden />
        <p>No notifications yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground" data-testid="unread-count">
          {unread === 0 ? "All read" : `${unread} unread`}
        </p>
        <Button type="button" variant="outline" className="h-11 gap-2" disabled={!hydrated || pending || unread === 0} onClick={markAll}>
          <CheckCheck className="size-5" aria-hidden /> Mark all as read
        </Button>
      </div>
      <ul className="divide-y overflow-hidden rounded-xl border bg-background" aria-label="Notifications">
        {items.map((item) => (
          <li key={item.id}>
            <button
              type="button"
              disabled={!hydrated}
              onClick={() => open(item)}
              data-unread={item.readAt ? "false" : "true"}
              className={cn(
                "flex min-h-16 w-full items-start gap-3 px-4 py-3 text-left hover:bg-muted/60",
                !item.readAt && "bg-primary/5",
                item.urgent && !item.readAt && "border-l-4 border-l-destructive",
              )}
            >
              <span
                aria-hidden
                className={cn("mt-2 size-2.5 shrink-0 rounded-full", item.readAt ? "bg-transparent" : "bg-primary")}
              />
              <span className="min-w-0 flex-1">
                <span className={cn("block break-words", !item.readAt && "font-semibold")}>
                  {item.title}
                  {!item.readAt && <span className="sr-only"> (unread)</span>}
                </span>
                {item.body && <span className="mt-0.5 block text-sm break-words text-muted-foreground">{item.body}</span>}
                <span className="mt-1 block text-xs text-muted-foreground">{formatDateTime(item.createdAt)}</span>
              </span>
              {item.link && <ChevronRight className="mt-1 size-5 shrink-0 text-muted-foreground" aria-hidden />}
            </button>
          </li>
        ))}
      </ul>
      {more && (
        <Button type="button" variant="secondary" className="h-12 w-full text-base" disabled={!hydrated || pending} onClick={loadMore}>
          {pending ? "Loading…" : "Show older"}
        </Button>
      )}
    </div>
  );
}
