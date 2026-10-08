"use client";

import { Check, Circle } from "lucide-react";
import { useActionState, useState } from "react";

import { changePasswordAction } from "@/app/change-password/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkPassword, PASSWORD_RULES } from "@/lib/auth/password";
import { cn } from "@/lib/utils";

/** New password with the strength rules shown live as a checklist (AUTH-03). */
export function ChangePasswordForm({ username, forced }: { username: string; forced: boolean }) {
  const [state, formAction, pending] = useActionState(changePasswordAction, null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const check = checkPassword(password, { username });
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const mismatch = confirm.length > 0 && confirm !== password;

  return (
    <form action={formAction} className="space-y-4">
      {/* Lets password managers save the new password under the right username. */}
      <input type="text" name="username" value={username} autoComplete="username" readOnly hidden />
      {!forced && (
        <div className="space-y-2">
          <Label htmlFor="currentPassword">Current password</Label>
          <Input id="currentPassword" name="currentPassword" type="password" autoComplete="current-password" required className="h-12 text-base" />
          {errors.currentPassword && <p className="text-sm text-destructive">{errors.currentPassword}</p>}
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="newPassword">New password</Label>
        <Input
          id="newPassword"
          name="newPassword"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-describedby="password-rules"
          className="h-12 text-base"
        />
        {errors.newPassword && <p className="text-sm text-destructive">{errors.newPassword}</p>}
      </div>
      <ul id="password-rules" aria-label="Password rules" className="space-y-1.5 rounded-lg bg-muted/60 p-3 text-sm">
        {PASSWORD_RULES.map((rule) => {
          const met = password.length > 0 && check.passed[rule.id];
          return (
            <li key={rule.id} className={cn("flex items-center gap-2", met ? "text-foreground" : "text-muted-foreground")}>
              {met ? <Check className="size-4 text-green-600" aria-hidden /> : <Circle className="size-4" aria-hidden />}
              <span>{rule.label}</span>
              <span className="sr-only">{met ? "(done)" : "(not yet)"}</span>
            </li>
          );
        })}
      </ul>
      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Type the new password again</Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          aria-invalid={mismatch || undefined}
          className="h-12 text-base"
        />
        {(mismatch || errors.confirmPassword) && <p className="text-sm text-destructive">The passwords do not match.</p>}
      </div>
      {state && !state.ok && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" disabled={pending || !check.ok || mismatch || confirm.length === 0} className="h-12 w-full text-base">
        {pending ? "Saving…" : "Save new password"}
      </Button>
    </form>
  );
}
