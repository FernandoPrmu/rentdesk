import { StatusBadge } from "@/components/accounts/account-list";
import { Badge } from "@/components/ui/badge";
import type { AccountStatusValue } from "@/lib/accounts/schemas";
import { formatDateTime } from "@/lib/format";

/** Username, status and last sign-in under an account's title. */
export function AccountSummary({
  username,
  status,
  lastLoginAt,
  mustChangePassword,
}: {
  username: string;
  status: AccountStatusValue;
  lastLoginAt: string | null;
  mustChangePassword: boolean;
}) {
  return (
    <div className="-mt-3 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>
        Username <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{username}</code>
      </span>
      <StatusBadge status={status} />
      {mustChangePassword && <Badge variant="outline">Must change password</Badge>}
      <span>Last sign-in: {lastLoginAt ? formatDateTime(lastLoginAt) : "never"}</span>
    </div>
  );
}
