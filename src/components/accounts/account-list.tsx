import { ChevronRight, Search } from "lucide-react";
import Link from "next/link";

import { ChoiceSelect } from "@/components/forms/choice-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AccountStatusValue } from "@/lib/accounts/schemas";

const STATUS_LABEL: Record<AccountStatusValue, string> = {
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  DEACTIVATED: "Deactivated",
};

export function StatusBadge({ status }: { status: AccountStatusValue }) {
  const variant = status === "ACTIVE" ? "secondary" : status === "SUSPENDED" ? "destructive" : "outline";
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

/** Search box + status filter. A plain GET form: works without JavaScript and keeps the URL shareable. */
export function AccountFilters({
  q,
  status,
  balance,
  placeholder,
  withBalance,
}: {
  q?: string;
  status?: string;
  balance?: string;
  placeholder: string;
  /** Owner's customer list: filter by outstanding balance (CUS-05). */
  withBalance?: boolean;
}) {
  return (
    // Keyed by the URL filters: when they change (e.g. tapping the nav link to clear
    // a search) the form remounts with the new values. Without the key the mounted
    // inputs keep stale text and Base UI reports a changed default value.
    <form key={JSON.stringify({ q, status, balance })} method="get" role="search" className="mb-4 grid gap-2 sm:flex sm:flex-row">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input name="q" defaultValue={q} placeholder={placeholder} aria-label="Search" className="h-12 pl-10 text-base" />
      </div>
      <div className="sm:w-44">
        <ChoiceSelect
          name="status"
          ariaLabel="Status"
          defaultValue={status}
          emptyLabel="All statuses"
          options={[
            { value: "ACTIVE", label: "Active" },
            { value: "SUSPENDED", label: "Suspended" },
            { value: "DEACTIVATED", label: "Deactivated" },
          ]}
        />
      </div>
      {withBalance && (
        <div className="sm:w-48">
          <ChoiceSelect
            name="balance"
            ariaLabel="Balance"
            defaultValue={balance}
            emptyLabel="Any balance"
            options={[
              { value: "due", label: "Has balance due" },
              { value: "clear", label: "Nothing due" },
            ]}
          />
        </div>
      )}
      <Button type="submit" variant="secondary" className="h-12 px-5 text-base">
        Search
      </Button>
    </form>
  );
}

export interface AccountListItem {
  id: string;
  title: string;
  subtitle: string | null;
  username: string;
  phone: string | null;
  status: AccountStatusValue;
  mustChangePassword: boolean;
  /** Extra highlighted fact, e.g. the outstanding balance. */
  note?: string;
}

/** Card rows: comfortable on a phone, still compact on a desktop. */
export function AccountList({ items, basePath, empty }: { items: AccountListItem[]; basePath: string; empty: string }) {
  if (items.length === 0) {
    return <p className="rounded-xl border border-dashed bg-background p-6 text-center text-muted-foreground">{empty}</p>;
  }
  return (
    <ul className="divide-y overflow-hidden rounded-xl border bg-background">
      {items.map((item) => (
        <li key={item.id}>
          <Link href={`${basePath}/${item.id}`} className="flex min-h-16 items-center gap-3 px-4 py-3 hover:bg-muted/60">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate font-medium">{item.title}</span>
                <StatusBadge status={item.status} />
                {item.mustChangePassword && item.status === "ACTIVE" && <Badge variant="outline">Not signed in yet</Badge>}
                {item.note && <Badge variant="destructive">{item.note}</Badge>}
              </div>
              <p className="truncate text-sm text-muted-foreground">
                {[item.subtitle, item.username, item.phone].filter(Boolean).join(" · ")}
              </p>
            </div>
            <ChevronRight className="size-5 shrink-0 text-muted-foreground" aria-hidden />
          </Link>
        </li>
      ))}
    </ul>
  );
}
