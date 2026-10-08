"use server";

import { redirect } from "next/navigation";

import { guardRedirect } from "@/lib/auth/current-user";
import { signOutCurrentUser } from "@/lib/auth/login";
import { LOGIN_PATH } from "@/lib/auth/session-policy";

/**
 * Sign out (writes a LOGOUT audit entry while the session still exists), then go
 * to /login. When the proxy already ended the session (idle, expired, blocked) it
 * passes /login?reason=..., so the login page explains why. redirect() throws to
 * do its work, so it stays outside any try/catch.
 */
export async function signOutAction(): Promise<void> {
  await signOutCurrentUser();
  const target = await guardRedirect();
  redirect(target?.startsWith(`${LOGIN_PATH}?reason=`) ? target : LOGIN_PATH);
}
