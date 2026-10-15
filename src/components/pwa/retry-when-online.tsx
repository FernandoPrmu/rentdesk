"use client";

import { useEffect } from "react";

import { Button } from "@/components/ui/button";

/** "Try again" on the offline page; reloads by itself when the connection returns. */
export function RetryWhenOnline() {
  useEffect(() => {
    const reload = () => window.location.reload();
    window.addEventListener("online", reload);
    return () => window.removeEventListener("online", reload);
  }, []);

  return (
    <Button size="lg" className="h-12 w-full text-base" onClick={() => window.location.reload()}>
      Try again
    </Button>
  );
}
