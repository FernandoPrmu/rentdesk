import { describe, expect, it } from "vitest";

import { isKeptCache, isPrecacheable, isStaticAsset, offlineAssetRefs, PRECACHE_PREFIX, STATIC_CACHE } from "./cache-policy.ts";
import { clearUserData } from "./clear-user-data.ts";
import { INSTALL_PROMPT_KEY, installPlatform, isIos } from "./install.ts";
import { isNewVersion, parseVersion, resolveBuildId } from "./version.ts";

const ORIGIN = "https://rentdesk.example";
const u = (path: string, origin = ORIGIN) => new URL(path, origin);

describe("precache list (decision 88)", () => {
  it.each([
    ".next/static/chunks/app-123.js",
    ".next/static/css/abc.css",
    ".next/static/media/geist.woff2",
    "public/icons/icon-192.png",
    ".next/server/app/offline.html",
    ".next\\static\\chunks\\x.js",
  ])("keeps %s", (p) => expect(isPrecacheable(p)).toBe(true));

  it.each([
    ".next/server/app/customer.html",
    ".next/server/app/owner/tickets.html",
    ".next/server/app/login.html",
    ".next/server/app/index.html",
    ".next/static/chunks/app-123.js.map",
    "public/sw.js",
    "public/anything.pdf",
  ])("leaves out %s", (p) => expect(isPrecacheable(p)).toBe(false));

  it("with the offline page's files known, keeps only those, the stylesheets and icons", () => {
    const refs = offlineAssetRefs(
      `<link rel="stylesheet" href="/_next/static/css/a.css"/><script src="/_next/static/chunks/main.js" async></script><link rel="preload" href="/_next/static/media/f-s.p.woff2?dpl=1"/>`,
    );
    expect([...refs]).toEqual(["/_next/static/css/a.css", "/_next/static/chunks/main.js", "/_next/static/media/f-s.p.woff2"]);
    expect(isPrecacheable(".next/static/chunks/main.js", refs)).toBe(true);
    expect(isPrecacheable(".next/static/media/f-s.p.woff2", refs)).toBe(true);
    expect(isPrecacheable(".next/static/css/other.css", refs)).toBe(true);
    expect(isPrecacheable(".next/static/chunks/pdf.worker.js", refs)).toBe(false);
    expect(isPrecacheable("public/icons/icon-192.png", refs)).toBe(true);
    expect(isPrecacheable(".next/server/app/offline.html", refs)).toBe(true);
  });
});

describe("runtime cache (decision 88)", () => {
  it.each(["/_next/static/chunks/a.js", "/_next/static/media/f.woff2", "/_next/static/chunks/a.js?dpl=1", "/icons/icon-512.png", "/manifest.webmanifest", "/icon.svg", "/apple-icon.png"])(
    "caches %s",
    (p) => expect(isStaticAsset(u(p), ORIGIN)).toBe(true),
  );

  it.each([
    "/customer",
    "/owner/tickets/1?_rsc=abc",
    "/api/version",
    "/api/invoices/1/pdf",
    "/api/receipts/1/pdf",
    "/api/reports/income?format=pdf",
    "/_next/image?url=https%3A%2F%2Fx.supabase.co%2Fstorage%2Fv1%2Fobject%2Fsign%2Flogo.png",
    "/offline",
    "/icons/icon-512.png?token=x",
    "/_next/static/chunks/a.js.map",
  ])("never caches %s", (p) => expect(isStaticAsset(u(p), ORIGIN)).toBe(false));

  it("never caches another origin, a signed URL or a non-GET", () => {
    expect(isStaticAsset(u("/storage/v1/object/sign/invoices/a.pdf?token=t", "https://x.supabase.co"), ORIGIN)).toBe(false);
    expect(isStaticAsset(u("/_next/static/chunks/a.js", "https://cdn.example"), ORIGIN)).toBe(false);
    expect(isStaticAsset(u("/_next/static/chunks/a.js"), ORIGIN, "POST")).toBe(false);
  });

  it("keeps only the static and precache caches", () => {
    expect(isKeptCache(STATIC_CACHE)).toBe(true);
    expect(isKeptCache(`${PRECACHE_PREFIX}-v2-https://rentdesk.example/`)).toBe(true);
    for (const old of ["pages", "apis", "others", "cross-origin", "next-data", "pages-rsc", "static-image-assets"]) expect(isKeptCache(old)).toBe(false);
  });
});

describe("sign-out clean-up (decision 88)", () => {
  function fakeStorage(entries: Record<string, string>) {
    const data = new Map(Object.entries(entries));
    return {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      data,
    };
  }

  it("removes drafts and other caches, keeps the install choice and static caches", async () => {
    const local = fakeStorage({ "rentdesk:meter-draft:t1": "{}", "rentdesk:pay-draft": "{}", other: "x", [INSTALL_PROMPT_KEY]: "dismissed" });
    const session = fakeStorage({ a: "1" });
    const names = new Set(["pages", "apis", STATIC_CACHE, `${PRECACHE_PREFIX}-v2-x`]);
    const caches = { keys: async () => [...names], delete: async (n: string) => names.delete(n) };

    const result = await clearUserData({ local, session, caches });

    expect([...local.data.keys()]).toEqual([INSTALL_PROMPT_KEY]);
    expect(session.data.size).toBe(0);
    expect([...names].sort()).toEqual([STATIC_CACHE, `${PRECACHE_PREFIX}-v2-x`].sort());
    expect(result.caches.sort()).toEqual(["apis", "pages"]);
    expect(result.keys).toHaveLength(3);
  });

  it("works when the browser refuses storage", async () => {
    await expect(clearUserData({ local: null, session: null, caches: null })).resolves.toEqual({ caches: [], keys: [] });
  });
});

describe("install prompt (decision 90)", () => {
  const android = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";
  const ipad = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15";

  it("recognises iPhone and iPadOS", () => {
    expect(isIos(iphone)).toBe(true);
    expect(isIos(ipad, 5)).toBe(true);
    expect(isIos(ipad, 0)).toBe(false);
    expect(isIos(android)).toBe(false);
  });

  const base = { standalone: false, stored: null, hasPromptEvent: false };
  it("offers the browser's dialog when there is one, iOS steps otherwise", () => {
    expect(installPlatform({ ...base, userAgent: android, hasPromptEvent: true })).toBe("prompt");
    expect(installPlatform({ ...base, userAgent: iphone })).toBe("ios");
    expect(installPlatform({ ...base, userAgent: android })).toBeNull();
  });

  it("never when installed, dismissed or already running as the app", () => {
    expect(installPlatform({ ...base, userAgent: iphone, standalone: true })).toBeNull();
    expect(installPlatform({ ...base, userAgent: iphone, stored: "dismissed" })).toBeNull();
    expect(installPlatform({ ...base, userAgent: android, hasPromptEvent: true, stored: "installed" })).toBeNull();
  });
});

describe("new version (decision 89)", () => {
  it("only for a different, known build", () => {
    expect(isNewVersion("abc", "def")).toBe(true);
    expect(isNewVersion("abc", "abc")).toBe(false);
    expect(isNewVersion("dev", "def")).toBe(false);
    expect(isNewVersion("abc", "dev")).toBe(false);
    expect(isNewVersion("abc", null)).toBe(false);
    expect(isNewVersion("abc", 42)).toBe(false);
  });

  it("reads the version body defensively", () => {
    expect(parseVersion({ buildId: "x1" })).toBe("x1");
    expect(parseVersion({ buildId: "" })).toBeNull();
    expect(parseVersion("x1")).toBeNull();
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion({ buildId: "x".repeat(201) })).toBeNull();
  });

  it("prefers the deployment, then the commit, then the fallback", () => {
    expect(resolveBuildId({ VERCEL_DEPLOYMENT_ID: "dpl_1", VERCEL_GIT_COMMIT_SHA: "sha" }, () => "f")).toBe("dpl_1");
    expect(resolveBuildId({ VERCEL_GIT_COMMIT_SHA: "sha" }, () => "f")).toBe("sha");
    expect(resolveBuildId({}, () => "f")).toBe("f");
  });
});
