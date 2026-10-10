"use client";

import { useEffect, useRef, useState } from "react";

import { type Area, type Corner, type LetterheadLayout, moveArea, resizeArea } from "@/lib/invoices/pdf/layout";

/**
 * BRD-05: the letterhead on an A4 preview with the invoice data area on top.
 * Drag the box to move it; drag a corner to resize it. Pointer events, so it
 * works with a finger at 360 px; 44 px handles. Values are percent of the page.
 */

type Drag = { mode: "move" } | { mode: "resize"; corner: Corner };

const CORNERS: { corner: Corner; className: string; label: string }[] = [
  { corner: "nw", className: "left-0 top-0 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize", label: "Resize from top left" },
  { corner: "ne", className: "right-0 top-0 translate-x-1/2 -translate-y-1/2 cursor-nesw-resize", label: "Resize from top right" },
  { corner: "sw", className: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2 cursor-nesw-resize", label: "Resize from bottom left" },
  { corner: "se", className: "bottom-0 right-0 translate-x-1/2 translate-y-1/2 cursor-nwse-resize", label: "Resize from bottom right" },
];

export function LayoutEditor({
  background,
  layout,
  onChange,
}: {
  background: { kind: "PDF" | "IMAGE"; url: string | null };
  layout: LetterheadLayout;
  onChange: (layout: LetterheadLayout) => void;
}) {
  const pageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ kind: Drag; startX: number; startY: number; start: Area } | null>(null);

  function begin(kind: Drag, e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { kind, startX: e.clientX, startY: e.clientY, start: layout.area };
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    const page = pageRef.current;
    if (!d || !page) return;
    const rect = page.getBoundingClientRect();
    const dx = ((e.clientX - d.startX) / rect.width) * 100;
    const dy = ((e.clientY - d.startY) / rect.height) * 100;
    const area = d.kind.mode === "move" ? moveArea(d.start, dx, dy) : resizeArea(d.start, d.kind.corner, dx, dy);
    onChange({ preset: "CUSTOM", area });
  }

  function end() {
    drag.current = null;
  }

  const a = layout.area;
  return (
    <div
      ref={pageRef}
      className="relative mx-auto aspect-[210/297] w-full max-w-[340px] touch-none select-none overflow-visible rounded-md border bg-white shadow-sm"
      data-testid="layout-editor"
    >
      <div className="absolute inset-0 overflow-hidden rounded-md">
        {background.url && background.kind === "IMAGE" && (
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed URL of a private file
          <img src={background.url} alt="Your letterhead" className="size-full object-fill" draggable={false} />
        )}
        {background.url && background.kind === "PDF" && <PdfThumbnail url={background.url} />}
      </div>
      <div
        role="group"
        aria-label={`Invoice details area: left ${a.x}%, top ${a.y}%, width ${a.w}%, height ${a.h}%`}
        className="absolute flex cursor-move items-center justify-center border-2 border-dashed border-primary bg-primary/10"
        style={{ left: `${a.x}%`, top: `${a.y}%`, width: `${a.w}%`, height: `${a.h}%` }}
        onPointerDown={(e) => begin({ mode: "move" }, e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        data-testid="layout-area"
      >
        <span className="rounded bg-background/90 px-2 py-1 text-xs font-medium text-primary">Invoice details</span>
        {CORNERS.map((c) => (
          <span
            key={c.corner}
            role="presentation"
            aria-label={c.label}
            className={`absolute flex size-11 items-center justify-center ${c.className}`}
            onPointerDown={(e) => begin({ mode: "resize", corner: c.corner }, e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            data-testid={`layout-handle-${c.corner}`}
          >
            <span className="size-4 rounded-full border-2 border-white bg-primary shadow" />
          </span>
        ))}
      </div>
    </div>
  );
}

/** Page 1 of a PDF letterhead, drawn with pdf.js (loaded only on this page). */
function PdfThumbnail({ url }: { url: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
        const doc = await pdfjs.getDocument({ url }).promise;
        const page = await doc.getPage(1);
        const canvas = canvasRef.current;
        if (cancelled || !canvas) return;
        const base = page.getViewport({ scale: 1 });
        const scale = (canvas.clientWidth * (window.devicePixelRatio || 1)) / base.width;
        const viewport = page.getViewport({ scale });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        await page.render({ canvas, viewport }).promise;
      } catch (error) {
        console.warn("[letterhead] PDF preview:", error);
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [url]);

  if (failed) {
    return (
      <p className="flex size-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Your PDF letterhead cannot be shown here. Use “Preview sample invoice” to see it.
      </p>
    );
  }
  // Stretched to the page, as on the invoice.
  return <canvas ref={canvasRef} className="size-full" aria-label="Your letterhead" data-testid="letterhead-pdf-canvas" />;
}
