import { NotFoundView } from "@/components/errors/error-view";

/** notFound() inside the owner portal: a missing record, or one of another account (rule 54). */
export default function OwnerNotFound() {
  return <NotFoundView homeHref="/owner" />;
}
