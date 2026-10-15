"use client";

import { useEffect } from "react";

import { browserTargets, clearUserData } from "@/lib/pwa/clear-user-data";

/** On /login: nobody is signed in, so nothing of the last user may stay (decision 88). */
export function ClearOnLogin() {
  useEffect(() => {
    void clearUserData(browserTargets()).catch(() => undefined);
  }, []);
  return null;
}
