import { PageSkeleton } from "@/components/portal/portal-shell";

/** Shown at once on every navigation inside the portal while the page loads. */
export default function Loading() {
  return <PageSkeleton />;
}
