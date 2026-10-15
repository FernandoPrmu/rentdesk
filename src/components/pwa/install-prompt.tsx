"use client";

import { Download, Share, SquarePlus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { EARLY_INSTALL_EVENT, INSTALL_PROMPT_KEY, installPlatform, type InstallPlatform, type InstallState } from "@/lib/pwa/install";
import { cn } from "@/lib/utils";

type PromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: "accepted" | "dismissed" }> };

function readStored(): string | null {
  try {
    return window.localStorage.getItem(INSTALL_PROMPT_KEY);
  } catch {
    return null;
  }
}

function store(state: InstallState) {
  try {
    window.localStorage.setItem(INSTALL_PROMPT_KEY, state);
  } catch {
    // Private mode: the card simply comes back next time.
  }
}

// The browser fires beforeinstallprompt once per page load, often while /login is open.
// The root layout's catcher keeps it here until a portal shows the card.
let caught: PromptEvent | null = null;
const listeners = new Set<(e: PromptEvent | null) => void>();

function setCaught(e: PromptEvent | null) {
  caught = e;
  for (const l of listeners) l(e);
}

/** Root layout: keeps the install event (and hides the browser's own banner) on every page. */
export function InstallEventCatcher() {
  useEffect(() => {
    // Fired before hydration: the head script (CATCH_EARLY_INSTALL_EVENT) kept it.
    const early = window as unknown as Record<string, PromptEvent | undefined>;
    if (early[EARLY_INSTALL_EVENT]) {
      setCaught(early[EARLY_INSTALL_EVENT]);
      delete early[EARLY_INSTALL_EVENT];
    }
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setCaught(e as PromptEvent);
    };
    const onInstalled = () => {
      store("installed");
      setCaught(null);
    };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);
  return null;
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

/**
 * "Install RentDesk" card above the bottom bar (decision 90). Rendered only by the
 * portal shell, so it never appears on /login before sign-in. It appears after the
 * user's first tap or key press: the page's own content comes first, and the card is
 * never the page's largest paint (LCP, task 12).
 */
export function InstallPrompt({ withBottomBar }: { withBottomBar: "always" | "mobile" }) {
  const [platform, setPlatform] = useState<InstallPlatform | null>(null);
  const [promptEvent, setPromptEvent] = useState<PromptEvent | null>(null);
  const [interacted, setInteracted] = useState(false);

  useEffect(() => {
    const done = () => setInteracted(true);
    window.addEventListener("pointerdown", done, { once: true, passive: true });
    window.addEventListener("keydown", done, { once: true });
    return () => {
      window.removeEventListener("pointerdown", done);
      window.removeEventListener("keydown", done);
    };
  }, []);

  useEffect(() => {
    const decide = (event: PromptEvent | null) =>
      installPlatform({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        standalone: isStandalone(),
        stored: readStored(),
        hasPromptEvent: event !== null,
      });

    const onEvent = (event: PromptEvent | null) => {
      setPromptEvent(event);
      setPlatform(decide(event));
    };
    listeners.add(onEvent);
    // An event caught earlier (e.g. on /login) is shown now; iOS has no event, so
    // decide once after the page has settled.
    const timer = window.setTimeout(() => onEvent(caught), caught ? 0 : 1500);
    return () => {
      listeners.delete(onEvent);
      window.clearTimeout(timer);
    };
  }, []);

  if (!platform || !interacted) return null;

  const dismiss = () => {
    store("dismissed");
    setPlatform(null);
  };

  const install = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    store(outcome === "accepted" ? "installed" : "dismissed");
    setCaught(null);
    setPromptEvent(null);
    setPlatform(null);
  };

  return (
    <section
      aria-labelledby="install-title"
      data-testid="install-prompt"
      className={cn(
        "fixed inset-x-0 z-30 flex justify-center px-3",
        "bottom-[calc(4.5rem+env(safe-area-inset-bottom))]",
        withBottomBar === "mobile" && "md:bottom-4",
      )}
    >
      <div className="relative w-full max-w-md rounded-xl border bg-background p-4 pr-12 shadow-lg">
        <button
          type="button"
          onClick={dismiss}
          aria-label="Not now, close"
          className="absolute top-2 right-2 inline-flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
        >
          <X aria-hidden className="size-5" />
        </button>
        <h2 id="install-title" className="text-base font-semibold">
          Install RentDesk on this phone
        </h2>
        {platform === "prompt" ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">Open it from your home screen like any app, in one tap.</p>
            <div className="mt-3 flex gap-2">
              <Button className="h-11 flex-1" onClick={() => void install()}>
                <Download aria-hidden className="size-4" />
                Install
              </Button>
              <Button variant="outline" className="h-11" onClick={dismiss}>
                Not now
              </Button>
            </div>
          </>
        ) : (
          <>
            <ol className="mt-2 space-y-2 text-sm">
              <li className="flex items-start gap-2">
                <span className="font-semibold">1.</span>
                <span>
                  In Safari, tap the Share button <Share aria-label="Share" className="inline size-4 align-text-bottom" /> at the bottom of the screen.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-semibold">2.</span>
                <span>
                  Scroll down and tap <strong>Add to Home Screen</strong> <SquarePlus aria-hidden className="inline size-4 align-text-bottom" />.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="font-semibold">3.</span>
                <span>
                  Tap <strong>Add</strong>. RentDesk is now on your home screen.
                </span>
              </li>
            </ol>
            <Button variant="outline" className="mt-3 h-11 w-full" onClick={dismiss}>
              Got it
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
