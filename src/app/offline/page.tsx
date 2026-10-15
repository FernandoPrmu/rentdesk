import type { Metadata } from "next";
import { WifiOff } from "lucide-react";

import { AppShell } from "@/components/app-shell";
import { RetryWhenOnline } from "@/components/pwa/retry-when-online";

export const metadata: Metadata = { title: "No connection" };

/**
 * Offline fallback (decision 88). Fully static and outside the proxy, so the copy the
 * service worker keeps never holds anyone's data. The worker shows it in place of a
 * page that could not load, at that page's address, so "Try again" reloads the page
 * the user wanted.
 */
export default function OfflinePage() {
  return (
    <AppShell>
      <section className="flex flex-1 flex-col items-center justify-center gap-5 text-center">
        <WifiOff aria-hidden className="size-12 text-muted-foreground" />
        <div className="space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">No internet connection</h1>
          <p className="text-base text-muted-foreground">
            RentDesk needs a connection to show your bills, tickets and messages. Check your
            mobile data or Wi-Fi. This page opens again by itself when you are back online.
          </p>
          <p className="text-sm text-muted-foreground">
            A meter reading you were typing is kept on this phone; you can send it when you are online.
          </p>
        </div>
        <RetryWhenOnline />
      </section>
    </AppShell>
  );
}
