"use client";

import { Play } from "lucide-react";
import { useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";

export function RunDailyJobButton({ action }: { action: () => Promise<ActionResult<{ status: string; summary: string }>> }) {
  const [running, start] = useTransition();
  return (
    <Button
      type="button"
      className="h-12 gap-2 px-5 text-base"
      disabled={running}
      onClick={() =>
        start(async () => {
          try {
            const result = await action();
            if (!result.ok) toast.error(result.error);
            else if (result.data.status === "SUCCESS") toast.success(`Daily job done: ${result.data.summary}`);
            else toast.warning(`Daily job finished with problems (${result.data.status.toLowerCase()}): ${result.data.summary}`);
          } catch {
            toast.error("The server could not be reached. Please try again.");
          }
        })
      }
    >
      <Play className="size-5" aria-hidden />
      {running ? "Running…" : "Run daily job now"}
    </Button>
  );
}
