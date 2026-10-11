"use client";

import { Camera, CircleCheck, RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useTransition } from "react";

import { CameraCapture, type CapturedPhoto } from "@/components/meter/camera-capture";
import { ReadingFields } from "@/components/meter/reading-form";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import type { ReadingErrors, TypedText } from "@/lib/meter/readings";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type SendAction = (input: { ticketId: string; photoPath: string; capturedAt: string | null; bw: string; colour: string }) => Promise<ActionResult & { fieldErrors?: Record<string, string> }>;

/**
 * 11.4: the fresh meter photo the rental company asked for during a dispute. Live
 * camera only (rule 5: no gallery), the same capture checks as the meter reading,
 * and the number(s) the meter shows now. The photo is deleted when the dispute ends.
 */
export function DisputePhotoEntry({
  ticketId,
  ownerId,
  machineType,
  note,
  action,
}: {
  ticketId: string;
  ownerId: string;
  machineType: "MONO" | "COLOUR";
  note: string | null;
  action: SendAction;
}) {
  const [photo, setPhoto] = useState<(CapturedPhoto & { id: string }) | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [typed, setTyped] = useState<TypedText>({ bw: "", colour: "" });
  const [errors, setErrors] = useState<ReadingErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [sending, start] = useTransition();

  useEffect(() => () => (photo ? URL.revokeObjectURL(photo.url) : undefined), [photo]);

  function send() {
    if (!photo) return;
    setMessage(null);
    start(async () => {
      try {
        let path = uploadedPath;
        if (!path) {
          path = `${ownerId}/${ticketId}/${photo.id}.jpg`;
          const { error } = await createClient().storage.from("meter-photos").upload(path, photo.blob, { contentType: "image/jpeg", upsert: false });
          if (error && !/exist|duplicate/i.test(error.message)) {
            setMessage("The photo could not be sent. Check your connection and tap Send again.");
            return;
          }
          setUploadedPath(path);
        }
        const result = await action({ ticketId, photoPath: path, capturedAt: photo.capturedAt, bw: typed.bw, colour: typed.colour });
        if (result.ok) return setSent(true);
        setErrors((result.fieldErrors ?? {}) as ReadingErrors);
        setMessage(result.error);
      } catch {
        setMessage("Not sent: the connection was lost. Tap Send again.");
      }
    });
  }

  if (sent) {
    return (
      <div className="space-y-5 py-4 text-center" data-testid="dispute-photo-sent">
        <CircleCheck className="mx-auto size-16 text-primary" aria-hidden />
        <h1 className="text-2xl font-bold">Photo sent</h1>
        <p className="text-muted-foreground">Thank you. Your rental company will check it and answer your dispute.</p>
        <Link href={`/customer/tickets/${ticketId}`} className={cn(buttonVariants(), "h-12 w-full text-base")}>
          Back to the ticket
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {note && (
        <p role="status" className="rounded-lg bg-muted px-3 py-2 text-sm">
          <strong>Your rental company asks:</strong> {note}
        </p>
      )}
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">1. Photo of the meter</h2>
        {photo ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL of the photo just taken */}
            <img src={photo.url} alt="Meter photo you took" className="max-h-64 w-full rounded-xl border bg-black object-contain" />
            <Button type="button" variant="outline" className="h-12 w-full gap-2 text-base" onClick={() => setCameraOpen(true)}>
              <RotateCcw className="size-5" aria-hidden /> Retake photo
            </Button>
          </div>
        ) : (
          <Button type="button" className="h-14 w-full gap-2 text-lg" onClick={() => setCameraOpen(true)}>
            <Camera className="size-6" aria-hidden /> Open camera
          </Button>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">2. The number on the meter now</h2>
        <ReadingFields
          machineType={machineType}
          values={typed}
          onChange={(v) => {
            setTyped(v);
            setErrors({});
            setMessage(null);
          }}
          errors={errors}
          previous={{ BW: null, COLOUR: null }}
          idPrefix="fresh"
        />
      </section>
      {message && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {message}
        </p>
      )}
      <Button type="button" className="h-14 w-full text-lg" disabled={!photo || sending || typed.bw.trim() === ""} onClick={send}>
        {sending ? "Sending…" : "Send photo"}
      </Button>
      {cameraOpen && (
        <CameraCapture
          onCaptured={(p) => {
            setPhoto({ ...p, id: crypto.randomUUID() });
            setUploadedPath(null);
            setCameraOpen(false);
          }}
          onClose={() => setCameraOpen(false)}
        />
      )}
    </div>
  );
}
