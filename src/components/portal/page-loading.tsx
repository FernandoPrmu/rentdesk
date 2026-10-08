import { PageSkeleton } from "@/components/portal/portal-shell";

/**
 * Route loading UI: every portal page reads the session, so each route segment
 * re-exports this as its loading.tsx and navigations show a skeleton at once.
 */
export default function PageLoading() {
  return <PageSkeleton />;
}
