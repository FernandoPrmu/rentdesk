"use client";

import { Check, Copy } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface ShownCredentials {
  username: string;
  temporaryPassword: string;
}

function CopyField({ label, value, testId }: { label: string; value: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code data-testid={testId} className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2.5 font-mono text-base">
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          className="h-11 w-11 shrink-0"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            } catch {
              // Clipboard blocked: the value is visible and selectable.
            }
          }}
        >
          {copied ? <Check className="size-5" /> : <Copy className="size-5" />}
        </Button>
      </div>
    </div>
  );
}

/**
 * Shows new login details exactly once (AUTH-02/04). They are not stored anywhere
 * and cannot be shown again: closing the dialog requires confirming they were saved.
 */
export function CredentialsDialog({
  credentials,
  title,
  onDone,
}: {
  credentials: ShownCredentials | null;
  title: string;
  onDone: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const both = credentials ? `Username: ${credentials.username}\nTemporary password: ${credentials.temporaryPassword}` : "";

  return (
    <Dialog open={credentials !== null} disablePointerDismissal onOpenChange={() => {}}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Give these details to the user. The password is shown only now. They must choose a new password when they
            first sign in.
          </DialogDescription>
        </DialogHeader>
        {credentials && (
          <div className="space-y-3">
            <CopyField label="Username" value={credentials.username} testId="credential-username" />
            <CopyField label="Temporary password" value={credentials.temporaryPassword} testId="credential-password" />
            <Button
              type="button"
              variant="secondary"
              className="h-11 w-full gap-2"
              onClick={() => navigator.clipboard?.writeText(both).catch(() => {})}
            >
              <Copy className="size-4" /> Copy both
            </Button>
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <input type="checkbox" className="size-5" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              I have saved these details
            </label>
          </div>
        )}
        <DialogFooter>
          <Button
            type="button"
            className="h-12 w-full text-base"
            disabled={!saved}
            onClick={() => {
              setSaved(false);
              onDone();
            }}
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
