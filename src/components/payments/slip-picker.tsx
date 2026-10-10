"use client";

import { Camera, FileText, FolderOpen, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { compressPhoto } from "@/lib/meter/compress";
import { sha256Hex, SLIP_PHOTO_OPTIONS, slipExtension, slipPlan } from "@/lib/payments/slip-prepare";
import { createClient } from "@/lib/supabase/client";

/**
 * The payment slip (PAY-02, PAY-03; decision 41). Unlike meter photos, the
 * customer may take a photo or choose a picture or PDF from the phone. Large
 * pictures are made smaller here, the fingerprint of the original is kept for the
 * duplicate check, and the file is uploaded to the customer's private folder.
 * The server checks the stored file again before anything is recorded.
 */

export interface UploadedSlip {
  path: string;
  originalSha256: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string | null;
}

async function toJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    return await compressPhoto(
      bitmap.width,
      bitmap.height,
      (width, height, quality) =>
        new Promise<Blob>((resolve, reject) => {
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext("2d");
          if (!ctx) return reject(new Error("This browser cannot prepare the picture."));
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(bitmap, 0, 0, width, height);
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The picture could not be prepared."))), "image/jpeg", quality);
        }),
      SLIP_PHOTO_OPTIONS,
    );
  } finally {
    bitmap.close();
  }
}

export function SlipPicker({
  ownerId,
  customerId,
  value,
  onChange,
  error,
}: {
  ownerId: string;
  customerId: string;
  value: UploadedSlip | null;
  onChange: (slip: UploadedSlip | null) => void;
  error?: string;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const files = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => () => {
    if (value?.previewUrl) URL.revokeObjectURL(value.previewUrl);
  }, [value]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setProblem(null);
    const plan = slipPlan(file);
    if (plan.action === "REFUSE") return setProblem(plan.error);
    setBusy(true);
    try {
      const originalSha256 = await sha256Hex(await file.arrayBuffer());
      const blob = plan.action === "COMPRESS" ? await toJpeg(file) : file;
      const mimeType = plan.action === "COMPRESS" ? "image/jpeg" : plan.mimeType;
      const path = `${ownerId}/${customerId}/${crypto.randomUUID()}.${slipExtension(mimeType)}`;
      const { error: uploadError } = await createClient().storage.from("payment-slips").upload(path, blob, { contentType: mimeType, upsert: false });
      if (uploadError) throw new Error(uploadError.message);
      onChange({
        path,
        originalSha256,
        name: file.name || "slip",
        mimeType,
        sizeBytes: blob.size,
        previewUrl: mimeType === "application/pdf" ? null : URL.createObjectURL(blob),
      });
    } catch (e) {
      console.error("[slip upload]", e);
      setProblem(
        e instanceof Error && /too large/i.test(e.message)
          ? "The picture is too large. Please take it again or choose a smaller file."
          : "The slip could not be uploaded. Check your connection and try again.",
      );
    } finally {
      setBusy(false);
      if (camera.current) camera.current.value = "";
      if (files.current) files.current.value = "";
    }
  }

  const message = problem ?? error ?? null;
  return (
    <div className="space-y-2" data-testid="slip-picker">
      <p className="text-sm font-medium">Payment slip</p>
      {value ? (
        <div className="flex items-center gap-3 rounded-xl border bg-background p-3">
          {value.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a local preview of the chosen file
            <img src={value.previewUrl} alt="The payment slip you added" className="size-16 rounded-md border object-cover" />
          ) : (
            <FileText className="size-10 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate font-medium" data-testid="slip-name">{value.name}</p>
            <p className="text-muted-foreground">{Math.max(1, Math.round(value.sizeBytes / 1024))} KB · ready to send</p>
          </div>
          <Button type="button" variant="outline" className="h-11 gap-1.5" onClick={() => onChange(null)}>
            <X className="size-4" aria-hidden /> Change
          </Button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <Button type="button" className="h-14 gap-2 text-base" disabled={busy} onClick={() => camera.current?.click()}>
            {busy ? <Loader2 className="size-5 animate-spin" aria-hidden /> : <Camera className="size-5" aria-hidden />} Take photo
          </Button>
          <Button type="button" variant="outline" className="h-14 gap-2 text-base" disabled={busy} onClick={() => files.current?.click()}>
            <FolderOpen className="size-5" aria-hidden /> Choose file
          </Button>
        </div>
      )}
      <input
        ref={camera}
        type="file"
        accept="image/*"
        capture="environment"
        className="sr-only"
        tabIndex={-1}
        aria-label="Take a photo of the slip"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      <input
        ref={files}
        type="file"
        accept="image/jpeg,image/png,image/heic,image/heif,application/pdf"
        className="sr-only"
        tabIndex={-1}
        aria-label="Choose the slip file"
        data-testid="slip-file-input"
        onChange={(e) => pick(e.target.files?.[0])}
      />
      {busy && <p className="text-sm text-muted-foreground">Uploading the slip…</p>}
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
      <p className="text-xs text-muted-foreground">A photo of the bank slip, a screenshot of the transfer, or the PDF from your bank (up to 5 MB).</p>
    </div>
  );
}
