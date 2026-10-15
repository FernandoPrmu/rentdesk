import type { MetadataRoute } from "next";

import { BACKGROUND_COLOR, THEME_COLOR } from "@/lib/brand";

/**
 * Web app manifest (CP-09, decision 90). `start_url` is "/": the proxy sends a signed-in
 * user from there to their own portal (customer, owner or admin) and everyone else to
 * the sign-in page, so one manifest opens the right home for every role. Shortcuts are
 * the customer's frequent tasks plus the owner's Approvals; a shortcut for another
 * role lands on that user's own home (the proxy's role guard).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "RentDesk",
    short_name: "RentDesk",
    description: "Photocopier rentals: meter readings, bills, payments and service, from your phone.",
    id: "/",
    start_url: "/?source=pwa",
    scope: "/",
    display: "standalone",
    display_override: ["standalone", "minimal-ui"],
    orientation: "portrait",
    background_color: BACKGROUND_COLOR,
    theme_color: THEME_COLOR,
    lang: "en",
    dir: "ltr",
    categories: ["business", "finance", "productivity"],
    prefer_related_applications: false,
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
      { src: "/icons/icon-monochrome-512.png", sizes: "512x512", type: "image/png", purpose: "monochrome" },
    ],
    shortcuts: [
      { name: "My bills", short_name: "Bills", url: "/customer/bills", icons: [{ src: "/icons/shortcut-bills-96.png", sizes: "96x96", type: "image/png" }] },
      { name: "Pay a bill", short_name: "Pay", url: "/customer/pay", icons: [{ src: "/icons/shortcut-pay-96.png", sizes: "96x96", type: "image/png" }] },
      { name: "Request service", short_name: "Service", url: "/customer/service/new", icons: [{ src: "/icons/shortcut-service-96.png", sizes: "96x96", type: "image/png" }] },
      { name: "Approvals (owners)", short_name: "Approvals", url: "/owner/approvals", icons: [{ src: "/icons/shortcut-approvals-96.png", sizes: "96x96", type: "image/png" }] },
    ],
  };
}
