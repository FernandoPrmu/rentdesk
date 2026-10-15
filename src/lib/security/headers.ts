/**
 * Security headers for every response (decision 87). Built once in next.config.ts from
 * the Supabase URL of the build. Only relative imports (loaded by next.config.ts).
 *
 * CSP: everything from this origin; Supabase (REST, Storage signed URLs, Realtime
 * websocket) as the only other origin. Fonts are self-hosted by next/font. Scripts
 * allow 'unsafe-inline' because Next.js writes inline bootstrap scripts into the
 * prerendered static shells (cacheComponents); a nonce would make every page dynamic.
 * Everything else stays strict: no other origin may run code, no plugins, no framing.
 */

export type HeaderOptions = {
  supabaseUrl: string | undefined;
  /** `next dev`: React needs eval for its debugging, and HMR uses a websocket. */
  dev: boolean;
  /** Served over HTTPS (a Vercel deployment): ask the browser to upgrade any http URL. */
  https: boolean;
};

const PERMISSIONS = [
  "camera=(self)",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "bluetooth=()",
  "hid=()",
  "midi=()",
  "magnetometer=()",
  "gyroscope=()",
  "accelerometer=()",
  "display-capture=()",
  "screen-wake-lock=()",
  "publickey-credentials-get=()",
  "browsing-topics=()",
  "interest-cohort=()",
];

/** The Supabase origin and its websocket origin, or nothing when the URL is missing or invalid. */
export function supabaseOrigins(url: string | undefined): { https: string; wss: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return { https: u.origin, wss: `${u.protocol === "https:" ? "wss" : "ws"}://${u.host}` };
  } catch {
    return null;
  }
}

export function contentSecurityPolicy({ supabaseUrl, dev, https }: HeaderOptions): string {
  const sb = supabaseOrigins(supabaseUrl);
  const supa = sb ? [sb.https] : [];
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", ...supa],
    "font-src": ["'self'", "data:"],
    "connect-src": ["'self'", ...supa, ...(sb ? [sb.wss] : []), ...(dev ? ["ws:"] : [])],
    "media-src": ["'self'", "blob:"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
    // A slip PDF is shown in an <object> from a signed Storage URL (owner payment page).
    "object-src": supa.length ? supa : ["'none'"],
    "frame-src": ["'self'", ...supa],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
  };
  const parts = Object.entries(directives).map(([k, v]) => `${k} ${v.join(" ")}`);
  if (https) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}

export function securityHeaders(options: HeaderOptions): { key: string; value: string }[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy(options) },
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Permissions-Policy", value: PERMISSIONS.join(", ") },
    { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
    { key: "X-DNS-Prefetch-Control", value: "off" },
  ];
}
