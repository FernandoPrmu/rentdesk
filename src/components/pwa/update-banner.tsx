"use client";

import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { BUILD_ID, isNewVersion, parseVersion, VERSION_CHECK_MS, VERSION_PATH } from "@/lib/pwa/version";

/**
 * "New version available — tap to refresh" (decision 89). Shown when /api/version
 * answers with another build, or when a new service worker is waiting. Checked on
 * focus, when the page becomes visible and every 15 minutes. Tapping it lets the
 * waiting worker take over and reloads the same address, so the user stays on the
 * page they were on (a typed meter reading is kept on the device, rule 31).
 */
export function UpdateBanner() {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);

  const check = useCallback(async () => {
    if (!navigator.onLine) return;
    try {
      const res = await fetch(VERSION_PATH, { cache: "no-store" });
      if (!res.ok) return;
      if (isNewVersion(BUILD_ID, parseVersion(await res.json()))) setAvailable(true);
    } catch {
      // Offline or a slow network: try again at the next check.
    }
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    window.addEventListener("rentdesk:check-version", onVisible);
    const timer = window.setInterval(onVisible, VERSION_CHECK_MS);

    // A worker of a newer build that installed in the background also means a new version.
    let cleanupSw = () => {};
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistration().then((reg) => {
        if (!reg) return;
        if (reg.waiting && navigator.serviceWorker.controller) setAvailable(true);
        const onFound = () => {
          const worker = reg.installing;
          worker?.addEventListener("statechange", () => {
            if (worker.state === "installed" && navigator.serviceWorker.controller) setAvailable(true);
          });
        };
        reg.addEventListener("updatefound", onFound);
        cleanupSw = () => reg.removeEventListener("updatefound", onFound);
      });
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
      window.removeEventListener("rentdesk:check-version", onVisible);
      window.clearInterval(timer);
      cleanupSw();
    };
  }, [check]);

  if (!available) return null;

  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex justify-center px-3 pt-[max(0.5rem,env(safe-area-inset-top))]" role="status">
      <button
        type="button"
        onClick={() => {
          setBusy(true);
          void refreshToNewVersion();
        }}
        disabled={busy}
        className="flex min-h-12 w-full max-w-md items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-3 text-base font-medium text-background shadow-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:opacity-80"
      >
        <RefreshCw aria-hidden className={busy ? "size-5 animate-spin" : "size-5"} />
        {busy ? "Refreshing…" : "New version available — tap to refresh"}
      </button>
    </div>
  );
}

/** Activates a waiting service worker (if any), then reloads this same address. */
async function refreshToNewVersion() {
  try {
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      await reg?.update().catch(() => undefined);
      const waiting = reg?.waiting ?? reg?.installing;
      if (waiting && navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          navigator.serviceWorker.addEventListener("controllerchange", done, { once: true });
          window.setTimeout(done, 3000);
          waiting.postMessage({ type: "SKIP_WAITING" });
        });
      }
    }
  } finally {
    window.location.reload();
  }
}
