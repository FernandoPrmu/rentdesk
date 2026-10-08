"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { GENERIC_LOGIN_ERROR, signInWithUsername } from "@/lib/auth/login";

const loginSchema = z.object({
  username: z.string().max(100),
  password: z.string().max(200),
  next: z.string().max(500).optional(),
});

export interface LoginState {
  error: string;
}

/** AUTH-08: username + password sign-in with lockout; one generic error for wrong details. */
export async function loginAction(_prev: LoginState | null, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    username: formData.get("username") ?? "",
    password: formData.get("password") ?? "",
    next: formData.get("next") || undefined,
  });
  if (!parsed.success) return { error: GENERIC_LOGIN_ERROR };

  const outcome = await signInWithUsername(parsed.data);
  if (!outcome.ok) return { error: outcome.error };
  redirect(outcome.redirectTo);
}
