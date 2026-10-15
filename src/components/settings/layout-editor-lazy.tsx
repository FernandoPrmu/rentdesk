"use client";

import dynamic from "next/dynamic";

/** The drag-and-resize letterhead editor (and pdf.js, which it loads) only when a letterhead is shown (task 12). */
export const LayoutEditor = dynamic(() => import("@/components/settings/layout-editor").then((m) => m.LayoutEditor), {
  ssr: false,
  loading: () => <div className="aspect-[210/297] w-full animate-pulse rounded-lg border bg-muted" role="status" aria-label="Loading the letterhead preview" />,
});
