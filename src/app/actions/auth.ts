"use server";

import { redirect } from "next/navigation";

import { signOutCurrentUser } from "@/lib/auth/login";

/** Sign out (writes a LOGOUT audit entry). */
export async function signOutAction(): Promise<void> {
  await signOutCurrentUser();
  redirect("/login");
}
