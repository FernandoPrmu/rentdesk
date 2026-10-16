import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findOfflineHtml, offlineHtmlCandidates, offlinePrecacheEntry } from "./offline-page.mts";

let dist: string;
const put = (...parts: string[]) => {
  const file = path.join(dist, ...parts);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, "<html></html>");
  return file;
};
// sha256("/offline/page"), as Next 16.4 names the source route's directory.
const SOURCE = "ec47f4de984fe544c98cbb5377f81d823005b94cf2cd4779463f573d9d258f7a";

beforeEach(() => {
  dist = mkdtempSync(path.join(tmpdir(), "rentdesk-dist-"));
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

describe("finding the prerendered offline page (decision 88)", () => {
  it("finds it where a plain next build writes it", () => {
    const file = put("server", "app", "offline.html");
    expect(findOfflineHtml(dist)).toBe(file);
  });

  it("finds it in the response cache layout a deployment adapter (Vercel) uses", () => {
    put("server", "route-cache", "APP_PAGE", "a".repeat(64), "$", "login.html");
    const file = put("server", "route-cache", "APP_PAGE", SOURCE, "$", "offline.html");
    expect(findOfflineHtml(dist)).toBe(file);
  });

  it("ignores other pages and other route kinds", () => {
    put("server", "app", "owner", "offline.html");
    put("server", "route-cache", "APP_ROUTE", SOURCE, "$", "offline.html");
    put("server", "route-cache", "APP_PAGE", SOURCE, "$", "owner", "offline.html");
    expect(offlineHtmlCandidates(dist)).toEqual([]);
  });

  it("fails the build when the page is missing or ambiguous", () => {
    expect(() => findOfflineHtml(dist)).toThrow(/was not found/);
    put("server", "app", "offline.html");
    put("server", "route-cache", "APP_PAGE", SOURCE, "$", "offline.html");
    expect(() => findOfflineHtml(dist)).toThrow(/More than one/);
  });

  it("precaches it as /offline, versioned by its content", () => {
    const a = offlinePrecacheEntry("<html>a</html>");
    expect(a.url).toBe("/offline");
    expect(a.revision).toMatch(/^[0-9a-f]{32}$/);
    expect(offlinePrecacheEntry("<html>a</html>")).toEqual(a);
    expect(offlinePrecacheEntry("<html>b</html>").revision).not.toBe(a.revision);
  });
});
