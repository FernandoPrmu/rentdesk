"use client";

import { useActionState } from "react";

import { useSubmitWithoutReset } from "@/components/forms/use-submit-without-reset";
import type { ActionResult } from "@/lib/action-result";

export type FormAction<T = undefined> = (prev: ActionResult<T> | null, formData: FormData) => Promise<ActionResult<T>>;

/**
 * Wires a Server Action to a form: keeps what was typed on a validation error,
 * exposes field errors, and runs `onSuccess` once the server confirms.
 */
export function useFormAction<T>(action: FormAction<T>, onSuccess?: (data: T) => void) {
  const [state, formAction, pending] = useActionState(async (prev: ActionResult<T> | null, formData: FormData) => {
    const result = await action(prev, formData);
    if (result.ok) onSuccess?.(result.data);
    return result;
  }, null);
  const onSubmit = useSubmitWithoutReset(formAction);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const formError = state && !state.ok ? state.error : null;
  return { onSubmit, pending, errors, formError };
}
