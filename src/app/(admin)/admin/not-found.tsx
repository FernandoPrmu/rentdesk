import { NotFoundView } from "@/components/errors/error-view";

/** notFound() inside the admin portal: a missing record, or one of another account (rule 54). */
export default function AdminNotFound() {
  return <NotFoundView homeHref="/admin" />;
}
