"use client";

import { Minus, Plus, X } from "lucide-react";
import { type PointerEvent, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * The meter photo for the owner's review (spec 6.5): a short-lived signed URL,
 * tap to open full screen, then pinch, double tap or +/- to zoom and drag to move.
 */
export function PhotoViewer({ url, alt }: { url: string; alt: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block w-full overflow-hidden rounded-xl border bg-black" aria-label="Open the photo full screen">
        {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed URL */}
        <img src={url} alt={alt} className="max-h-80 w-full object-contain" data-testid="review-photo" />
      </button>
      <p className="mt-1 text-xs text-muted-foreground">Tap to zoom.</p>
      {open && <ZoomView url={url} alt={alt} onClose={() => setOpen(false)} />}
    </>
  );
}

const MIN = 1;
const MAX = 5;
const clamp = (v: number) => Math.min(MAX, Math.max(MIN, v));

function ZoomView({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; scale: number } | null>(null);
  const lastTap = useRef(0);

  const zoom = (next: number) => {
    const s = clamp(next);
    setScale(s);
    if (s === 1) setOffset({ x: 0, y: 0 });
  };

  function down(e: PointerEvent) {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
    } else {
      const now = Date.now();
      if (now - lastTap.current < 300) zoom(scale > 1 ? 1 : 2.5);
      lastTap.current = now;
    }
  }

  function move(e: PointerEvent) {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      zoom(pinch.current.scale * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.current.distance));
    } else if (scale > 1) {
      setOffset((o) => ({ x: o.x + e.clientX - prev.x, y: o.y + e.clientY - prev.y }));
    }
  }

  function up(e: PointerEvent) {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Meter photo">
      <div className="flex items-center justify-end gap-2 p-3">
        <Button type="button" variant="secondary" size="icon" className="size-11" onClick={() => zoom(scale - 0.5)} aria-label="Zoom out">
          <Minus className="size-5" aria-hidden />
        </Button>
        <Button type="button" variant="secondary" size="icon" className="size-11" onClick={() => zoom(scale + 0.5)} aria-label="Zoom in">
          <Plus className="size-5" aria-hidden />
        </Button>
        <Button type="button" variant="secondary" className="h-11 gap-1.5" onClick={onClose}>
          <X className="size-5" aria-hidden /> Close
        </Button>
      </div>
      <div className="relative flex-1 touch-none overflow-hidden" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a private photo behind a signed URL */}
        <img
          src={url}
          alt={alt}
          draggable={false}
          className="absolute inset-0 size-full object-contain select-none"
          style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        />
      </div>
    </div>
  );
}
