"use client";

import dynamic from "next/dynamic";

/**
 * The live camera (capture, frame check, compression) loads only when the customer
 * opens it, so the meter page itself stays small on a slow connection (task 12).
 */
export const CameraCapture = dynamic(() => import("@/components/meter/camera-capture").then((m) => m.CameraCapture), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black text-base text-white" role="status">
      Opening the camera…
    </div>
  ),
});
