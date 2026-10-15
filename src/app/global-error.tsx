"use client";

import "./globals.css";

/**
 * Last resort when the root layout itself fails: no app components (they may be what
 * failed), plain markup with the app's styles, and a full reload of the same address.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-muted/40 px-4">
        <main role="alert" className="w-full max-w-md space-y-4 rounded-xl border bg-background p-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight">RentDesk could not load</h1>
          <p className="text-base text-muted-foreground">
            This is usually a slow connection or a busy server. Tap Reload. If it keeps happening, wait a minute and try again.
          </p>
          {error.digest && <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="h-12 w-full rounded-lg bg-primary text-base font-medium text-primary-foreground"
          >
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
