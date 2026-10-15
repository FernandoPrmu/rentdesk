"use client";

import { ErrorView } from "@/components/errors/error-view";

/** Errors inside the owner portal keep its header and navigation. */
export default function OwnerError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return <ErrorView error={error} retry={retry} homeHref="/owner" />;
}
