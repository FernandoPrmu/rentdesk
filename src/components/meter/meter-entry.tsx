"use client";

import { Camera, CircleCheck, RotateCcw, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";

import { CameraCapture, type CapturedPhoto } from "@/components/meter/camera-capture";
import { ReadingFields, ReadingPreview } from "@/components/meter/reading-form";
import { Button, buttonVariants } from "@/components/ui/button";
import type { ActionResult } from "@/lib/action-result";
import { formatDate } from "@/lib/format";
import { browserStorage, clearDraft, loadDraft, saveDraft } from "@/lib/meter/draft";
import { previewReading, type ReadingErrors, type TypedText } from "@/lib/meter/readings";
import type { MeterEntryView } from "@/lib/meter/service";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

type SubmitAction = (input: {
  ticketId: string;
  idempotencyKey: string;
  bw: string;
  colour: string;
  photoPath: string;
  capturedAt: string | null;
}) => Promise<ActionResult<{ replayed: boolean }> & { fieldErrors?: ReadingErrors }>;

/**
 * CP-03 / INV-01..06, INV-13: live photo, the reading(s), the engine preview, send.
 * The typed readings and the submission key survive a refresh (rule 31); the photo
 * is uploaded once per capture and a retry reuses it; the key makes the server
 * return the first result for a repeated send.
 */
export function MeterEntry({ view, action }: { view: MeterEntryView; action: SubmitAction }) {
  const [typed, setTyped] = useState<TypedText>({ bw: "", colour: "" });
  const [key, setKey] = useState<string | null>(null);
  const [photo, setPhoto] = useState<(CapturedPhoto & { id: string }) | null>(null);
  const [uploadedPath, setUploadedPath] = useState<string | null>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [serverErrors, setServerErrors] = useState<ReadingErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [sending, startSending] = useTransition();

  // The draft lives in this browser only, so it is read after the first render.
  useEffect(() => {
    const draft = loadDraft(browserStorage(), view.ticketId);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restoring a saved draft once on mount
    setTyped({ bw: draft?.bw ?? "", colour: draft?.colour ?? "" });
    setKey(draft?.idempotencyKey ?? crypto.randomUUID());
  }, [view.ticketId]);

  useEffect(() => {
    if (key) saveDraft(browserStorage(), view.ticketId, { ...typed, idempotencyKey: key });
  }, [typed, key, view.ticketId]);

  useEffect(() => () => (photo ? URL.revokeObjectURL(photo.url) : undefined), [photo]);

  const preview = useMemo(() => previewReading(view.context, typed), [view.context, typed]);
  const typedSomething = typed.bw.trim() !== "" || typed.colour.trim() !== "";
  const errors = { ...(typedSomething && !preview.ok ? preview.errors : {}), ...serverErrors };

  function onTyped(values: TypedText) {
    setTyped(values);
    setServerErrors({});
    setMessage(null);
  }

  function onCaptured(p: CapturedPhoto) {
    setPhoto({ ...p, id: crypto.randomUUID() });
    setUploadedPath(null);
    setCameraOpen(false);
    setMessage(null);
  }

  function send() {
    if (!photo || !key || !preview.ok) return;
    setMessage(null);
    startSending(async () => {
      try {
        let path = uploadedPath;
        if (!path) {
          path = `${view.ownerId}/${view.ticketId}/${photo.id}.jpg`;
          const { error } = await createClient().storage.from("meter-photos").upload(path, photo.blob, { contentType: "image/jpeg", upsert: false });
          // Already there: an earlier attempt uploaded it before the connection dropped.
          if (error && !/exist|duplicate/i.test(error.message)) {
            setMessage("The photo could not be sent. Check your connection and tap Send again.");
            return;
          }
          setUploadedPath(path);
        }
        const result = await action({ ticketId: view.ticketId, idempotencyKey: key, bw: typed.bw, colour: typed.colour, photoPath: path, capturedAt: photo.capturedAt });
        if (result.ok) {
          clearDraft(browserStorage(), view.ticketId);
          setSent(true);
          return;
        }
        setServerErrors(result.fieldErrors ?? {});
        setMessage(result.error);
      } catch {
        setMessage("Not sent: the connection was lost. Your reading is saved on this phone. Tap Send again.");
      }
    });
  }

  if (sent) {
    return (
      <div className="space-y-5 py-4 text-center" data-testid="meter-sent">
        <CircleCheck className="mx-auto size-16 text-primary" aria-hidden />
        <h1 className="text-2xl font-bold">Reading sent</h1>
        <p className="text-muted-foreground">Thank you. Your rental company will check the photo and send your bill.</p>
        <Link href="/customer" className={cn(buttonVariants(), "h-12 w-full text-base")}>
          Back to Home
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Enter meter reading</h1>
        <p className="text-muted-foreground">
          {view.machine} ({view.serialNo})
          {view.months > 1 ? ` · covers ${view.months} months` : ""}
        </p>
        <p className={cn("mt-1 text-sm font-medium", view.overdue && "text-destructive")} data-testid="meter-deadline">
          {view.overdue ? "This reading is late. Please send it now." : view.byDate ? `Send by ${formatDate(view.byDate)}` : ""}
        </p>
      </div>

      {view.lastRejection && (
        <p role="status" className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm">
          <strong>Your last reading was not accepted:</strong> {view.lastRejection}
        </p>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-semibold">1. Photo of the meter</h2>
        {photo ? (
          <div className="space-y-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL of the photo just taken */}
            <img src={photo.url} alt="Meter photo you took" className="max-h-64 w-full rounded-xl border bg-black object-contain" data-testid="meter-photo" />
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
        <h2 className="text-lg font-semibold">2. The number on the meter</h2>
        <ReadingFields machineType={view.machineType} values={typed} onChange={onTyped} errors={errors} previous={view.previous} />
      </section>

      {preview.ok && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">3. Check and send</h2>
          <ReadingPreview preview={preview} audience="customer" />
        </section>
      )}
      {!preview.ok && typedSomething && <ReadingPreview preview={preview} audience="customer" />}

      {message && (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {message}
        </p>
      )}

      <Button type="button" className="h-14 w-full text-lg" disabled={!photo || !preview.ok || sending || !key} onClick={send}>
        {sending ? "Sending…" : "Send reading"}
      </Button>
      {!photo && <p className="text-center text-sm text-muted-foreground">Take the photo first.</p>}

      {cameraOpen && <CameraCapture onCaptured={onCaptured} onClose={() => setCameraOpen(false)} />}
    </div>
  );
}
