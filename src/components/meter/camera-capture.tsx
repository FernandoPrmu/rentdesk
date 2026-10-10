"use client";

import { Camera, RefreshCw, Smartphone, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { compressPhoto } from "@/lib/meter/compress";

/**
 * Live meter photo (INV-03, CLAUDE.md rule 5, spec 6.5): the camera stream only,
 * rear camera preferred. There is deliberately no file input: a phone would offer
 * its gallery. The frame is compressed to about 200 KB JPEG here, on the phone.
 */

export interface CapturedPhoto {
  blob: Blob;
  url: string;
  capturedAt: string;
}

export type CameraProblem = "denied" | "no-camera" | "busy" | "insecure" | "other";

function problemOf(error: unknown): CameraProblem {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "denied";
  if (name === "NotFoundError" || name === "OverconstrainedError" || name === "DevicesNotFoundError") return "no-camera";
  if (name === "NotReadableError" || name === "TrackStartError" || name === "AbortError") return "busy";
  return "other";
}

/** Draws the frozen frame at a size and encodes it as JPEG. */
function canvasEncoder(source: HTMLCanvasElement) {
  return (width: number, height: number, quality: number) =>
    new Promise<Blob>((resolve, reject) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return reject(new Error("The picture could not be prepared"));
      ctx.drawImage(source, 0, 0, width, height);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The picture could not be prepared"))), "image/jpeg", quality);
    });
}

export function CameraCapture({ onCaptured, onClose }: { onCaptured: (photo: CapturedPhoto) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"starting" | "live" | "capturing" | { problem: CameraProblem }>("starting");
  const [attempt, setAttempt] = useState(0);

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setState({ problem: "insecure" });
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
        }
        setState("live");
      } catch (error) {
        if (!cancelled) setState({ problem: problemOf(error) });
      }
    }
    void start();
    return () => {
      cancelled = true;
      stop();
    };
  }, [attempt, stop]);

  async function capture() {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    setState("capturing");
    try {
      // Freeze the frame first, then encode it at the size and quality that fit.
      const frame = document.createElement("canvas");
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      frame.getContext("2d")?.drawImage(video, 0, 0);
      const capturedAt = new Date().toISOString();
      const blob = await compressPhoto(frame.width, frame.height, canvasEncoder(frame));
      stop();
      onCaptured({ blob, url: URL.createObjectURL(blob), capturedAt });
    } catch {
      setState({ problem: "other" });
    }
  }

  const problem = typeof state === "object" ? state.problem : null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black text-white" role="dialog" aria-modal="true" aria-label="Meter photo" data-testid="camera">
      <div className="flex items-center justify-between px-4 pt-[max(env(safe-area-inset-top),0.75rem)] pb-2">
        <p className="text-base font-medium">Photo of the meter</p>
        <Button type="button" variant="ghost" className="h-11 gap-1.5 text-white hover:bg-white/10 hover:text-white" onClick={() => { stop(); onClose(); }}>
          <X className="size-5" aria-hidden /> Close
        </Button>
      </div>

      {problem ? (
        <CameraHelp
          problem={problem}
          onRetry={() => {
            setState("starting");
            setAttempt((n) => n + 1);
          }}
        />
      ) : (
        <>
          <div className="relative flex-1 overflow-hidden">
            <video ref={videoRef} playsInline muted className="absolute inset-0 size-full object-contain" data-testid="camera-video" />
            <div className="pointer-events-none absolute inset-x-6 top-1/2 h-32 -translate-y-1/2 rounded-xl border-2 border-white/70" aria-hidden />
            <p className="absolute inset-x-0 bottom-3 text-center text-sm text-white/90">Fit the meter numbers inside the frame. Make sure they are sharp.</p>
          </div>
          <div className="flex justify-center px-4 pt-4 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
            <button
              type="button"
              onClick={capture}
              disabled={state !== "live"}
              className="flex size-20 items-center justify-center rounded-full border-4 border-white bg-white/20 disabled:opacity-40"
              aria-label="Take photo"
            >
              <Camera className="size-8" aria-hidden />
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Spec 11.2: step-by-step help to enable the camera; no upload fallback. */
export function CameraHelp({ problem, onRetry }: { problem: CameraProblem; onRetry: () => void }) {
  const desktop = typeof window !== "undefined" && !window.matchMedia("(pointer: coarse)").matches;
  return (
    <div className="flex-1 overflow-y-auto bg-background px-4 py-6 text-foreground" data-testid="camera-help" role="alert">
      {problem === "denied" && (
        <div className="space-y-4">
          <h2 className="text-xl font-bold">Allow the camera</h2>
          <p>RentDesk needs your camera to photograph the meter. Photos from the gallery cannot be used.</p>
          <section className="space-y-1">
            <h3 className="font-semibold">Android (Chrome)</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Tap the icon to the left of the web address (a lock or settings icon).</li>
              <li>Tap <strong>Permissions</strong> (or <strong>Site settings</strong>).</li>
              <li>Set <strong>Camera</strong> to <strong>Allow</strong>.</li>
              <li>Come back here and tap <strong>Try again</strong>.</li>
            </ol>
          </section>
          <section className="space-y-1">
            <h3 className="font-semibold">iPhone (Safari)</h3>
            <ol className="list-decimal space-y-1 pl-5">
              <li>Tap <strong>aA</strong> in the address bar, then <strong>Website Settings</strong>.</li>
              <li>Set <strong>Camera</strong> to <strong>Allow</strong>.</li>
              <li>If that is not there: open the <strong>Settings</strong> app › <strong>Safari</strong> › <strong>Camera</strong> › <strong>Allow</strong>.</li>
              <li>Come back here and tap <strong>Try again</strong>.</li>
            </ol>
          </section>
        </div>
      )}
      {problem === "no-camera" &&
        (desktop ? (
          <div className="space-y-3">
            <Smartphone className="size-10 text-primary" aria-hidden />
            <h2 className="text-xl font-bold">Please use your phone</h2>
            <p>This computer has no camera. Sign in to RentDesk on your phone and take the meter photo there.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <h2 className="text-xl font-bold">No camera found</h2>
            <p>We could not find a camera on this device. Try again, or sign in on a phone with a camera.</p>
          </div>
        ))}
      {problem === "busy" && (
        <div className="space-y-3">
          <h2 className="text-xl font-bold">The camera is busy</h2>
          <p>Another app is using the camera. Close it (for example a video call), then tap Try again.</p>
        </div>
      )}
      {problem === "insecure" && (
        <div className="space-y-3">
          <h2 className="text-xl font-bold">The camera cannot open here</h2>
          <p>Open RentDesk with its normal https:// address in Chrome or Safari, then try again.</p>
        </div>
      )}
      {problem === "other" && (
        <div className="space-y-3">
          <h2 className="text-xl font-bold">The camera did not start</h2>
          <p>Please try again. If it keeps happening, restart the browser.</p>
        </div>
      )}
      <Button type="button" className="mt-6 h-12 w-full gap-2 text-base" onClick={onRetry}>
        <RefreshCw className="size-5" aria-hidden /> Try again
      </Button>
    </div>
  );
}
