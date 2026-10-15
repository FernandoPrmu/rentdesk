"use client";

import { Eye, EyeOff } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { type FormEvent, Suspense, useActionState, useState } from "react";

import { loginAction } from "@/app/login/actions";
import { useSubmitWithoutReset } from "@/components/forms/use-submit-without-reset";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isSignOutReason, SIGN_OUT_MESSAGES } from "@/lib/auth/session-policy";

/**
 * The form renders on the server (in the page's static shell), so it is on screen before
 * any JavaScript arrives (task 12: it was the page's largest paint and waited for the
 * scripts). Only the sign-out notice reads the address, inside its own Suspense; the
 * `next` address is read when the form is sent.
 */
export function LoginForm() {
  const [state, formAction, pending] = useActionState(loginAction, null);
  const [showPassword, setShowPassword] = useState(false);
  const [username, setUsername] = useState("");
  // Keep what was typed after a failed attempt (the password can then be shown and fixed).
  const submit = useSubmitWithoutReset(formAction);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    const next = event.currentTarget.elements.namedItem("next") as HTMLInputElement;
    next.value = new URLSearchParams(window.location.search).get("next") ?? "";
    submit(event);
  };

  return (
    // `action`: a tap before the scripts load still posts to the server action (never a GET
    // that would put the password in the address); after that `onSubmit` takes over.
    <form action={formAction} onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="next" defaultValue="" />
      {!state && (
        <Suspense fallback={null}>
          <SignOutNotice />
        </Suspense>
      )}
      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className="h-12 text-base"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <div className="relative">
          <Input
            id="password"
            name="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            required
            className="h-12 pr-12 text-base"
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-label={showPassword ? "Hide password" : "Show password"}
            className="absolute top-0 right-0 flex h-12 w-12 items-center justify-center text-muted-foreground"
          >
            {showPassword ? <EyeOff className="size-5" /> : <Eye className="size-5" />}
          </button>
        </div>
      </div>
      {state?.error && (
        <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {state.error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={pending} className="h-12 w-full text-base">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      <p className="text-center text-sm text-muted-foreground">Forgot your password? Ask your provider to reset it.</p>
    </form>
  );
}

/** Why the user was signed out (?reason=, AUTH-09/10). */
function SignOutNotice() {
  const reason = useSearchParams().get("reason");
  if (!isSignOutReason(reason)) return null;
  return (
    <p role="status" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {SIGN_OUT_MESSAGES[reason]}
    </p>
  );
}
