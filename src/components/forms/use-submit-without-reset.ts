"use client";

import { type FormEvent, useTransition } from "react";

/**
 * React resets a `<form action={...}>` after every submission, which would clear
 * what the user typed when the server answers with a validation error. Submitting
 * through this handler dispatches the same action without the automatic reset.
 */
export function useSubmitWithoutReset(dispatch: (formData: FormData) => void) {
  const [, startTransition] = useTransition();
  return (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    startTransition(() => dispatch(formData));
  };
}
