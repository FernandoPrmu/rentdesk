import type { Metadata } from "next";

import { AppShell } from "@/components/app-shell";
import { NotFoundView } from "@/components/errors/error-view";

export const metadata: Metadata = { title: "Not found" };

/** Unknown addresses. "/" sends a signed-in user to their own Home, everyone else to sign in. */
export default function NotFound() {
  return (
    <AppShell>
      <NotFoundView homeHref="/" />
    </AppShell>
  );
}
