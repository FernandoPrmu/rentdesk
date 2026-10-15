import { NotFoundView } from "@/components/errors/error-view";

/** notFound() inside the customer portal: a missing record, or one of another account (rule 54). */
export default function CustomerNotFound() {
  return <NotFoundView homeHref="/customer" />;
}
