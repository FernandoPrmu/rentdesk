import { LogOut } from "lucide-react";

import { signOutAction } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";
import { getCurrentUser } from "@/lib/auth/current-user";

/** Header corner: who is signed in, and a sign-out button. */
export async function AccountMenu() {
  const user = await getCurrentUser();
  if (!user) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="hidden max-w-48 truncate text-sm text-muted-foreground sm:inline">{user.full_name || user.username}</span>
      <SignOutButton compact />
    </div>
  );
}

export function SignOutButton({ compact = false }: { compact?: boolean }) {
  return (
    <form action={signOutAction}>
      <Button
        type="submit"
        variant={compact ? "ghost" : "outline"}
        className={compact ? "h-11 gap-2 px-3" : "h-12 w-full gap-2 text-base"}
      >
        <LogOut className="size-5" aria-hidden />
        Sign out
      </Button>
    </form>
  );
}
