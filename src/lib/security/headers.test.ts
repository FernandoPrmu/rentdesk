import { describe, expect, it } from "vitest";

import { contentSecurityPolicy, securityHeaders, supabaseOrigins } from "./headers.ts";

const SB = "https://gpviraoifdnakkigrfga.supabase.co";

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name, values] as [string, string[]];
    }),
  );
}

describe("security headers (decision 87)", () => {
  const prod = directives(contentSecurityPolicy({ supabaseUrl: SB, dev: false, https: true }));

  it("allows Supabase REST, Storage and the Realtime websocket, nothing else remote", () => {
    expect(prod.get("connect-src")).toEqual(["'self'", SB, "wss://gpviraoifdnakkigrfga.supabase.co"]);
    expect(prod.get("img-src")).toEqual(["'self'", "data:", "blob:", SB]);
    expect(prod.get("default-src")).toEqual(["'self'"]);
    expect(prod.get("font-src")).toEqual(["'self'", "data:"]);
  });

  it("forbids framing, plugins from elsewhere, other base URLs and form targets", () => {
    expect(prod.get("frame-ancestors")).toEqual(["'none'"]);
    expect(prod.get("object-src")).toEqual([SB]);
    expect(prod.get("base-uri")).toEqual(["'self'"]);
    expect(prod.get("form-action")).toEqual(["'self'"]);
    expect(prod.has("upgrade-insecure-requests")).toBe(true);
  });

  it("allows eval and the HMR websocket only in next dev", () => {
    expect(prod.get("script-src")).toEqual(["'self'", "'unsafe-inline'"]);
    const dev = directives(contentSecurityPolicy({ supabaseUrl: SB, dev: true, https: false }));
    expect(dev.get("script-src")).toContain("'unsafe-eval'");
    expect(dev.get("connect-src")).toContain("ws:");
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
  });

  it("falls back to self only without a valid Supabase URL", () => {
    expect(supabaseOrigins("not a url")).toBeNull();
    expect(supabaseOrigins("javascript:alert(1)")).toBeNull();
    const none = directives(contentSecurityPolicy({ supabaseUrl: undefined, dev: false, https: false }));
    expect(none.get("connect-src")).toEqual(["'self'"]);
    expect(none.get("object-src")).toEqual(["'none'"]);
  });

  it("sends HSTS, nosniff, referrer policy and camera for this site only", () => {
    const h = new Map(securityHeaders({ supabaseUrl: SB, dev: false, https: true }).map((x) => [x.key, x.value]));
    expect(h.get("Strict-Transport-Security")).toBe("max-age=63072000; includeSubDomains");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    const perms = h.get("Permissions-Policy")!.split(", ");
    expect(perms).toContain("camera=(self)");
    expect(perms.filter((p) => p !== "camera=(self)").every((p) => p.endsWith("=()"))).toBe(true);
    expect(perms).toEqual(expect.arrayContaining(["microphone=()", "geolocation=()", "payment=()"]));
  });
});
