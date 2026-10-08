"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { type ActionResult, fail } from "@/lib/action-result";
import { currentActor } from "@/lib/auth/current-user";
import { changeOwnPassword } from "@/lib/auth/password-change";

const schema = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().max(200),
  confirmPassword: z.string().max(200),
});

/** AUTH-03: forced (first sign-in / after reset) or voluntary password change. */
export async function changePasswordAction(_prev: ActionResult | null, formData: FormData): Promise<ActionResult> {
  const user = await currentActor(["ADMIN", "OWNER", "CUSTOMER"], { allowGate: "/change-password" });
  const parsed = schema.safeParse({
    currentPassword: formData.get("currentPassword") ?? undefined,
    newPassword: formData.get("newPassword") ?? "",
    confirmPassword: formData.get("confirmPassword") ?? "",
  });
  if (!parsed.success) return fail("Please fill in all fields.");

  const result = await changeOwnPassword(user, parsed.data);
  if (!result.ok) return result;
  redirect(result.data.redirectTo);
}
