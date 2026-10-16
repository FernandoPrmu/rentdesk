import { describe, expect, it } from "vitest";

import { USERNAME_PATTERN } from "../../src/lib/auth/username";
import { isEnglishText } from "../../src/lib/text/english";
import { adminEnv, adminInputProblems, localMigrations, refProblems } from "./go-live";

const REF = "gpviraoifdnakkigrfga";
const OTHER = "abcdefghijklmnopqrst";
const dbUrl = (ref: string) => `postgresql://postgres.${ref}:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres`;
const apiUrl = (ref: string) => `https://${ref}.supabase.co`;

describe("golive:wipe project checks", () => {
  it("passes only when the typed, linked and both URL refs agree", () => {
    expect(refProblems({ typed: REF, linked: REF, dbUrl: dbUrl(REF), apiUrl: apiUrl(REF) })).toEqual([]);
    expect(refProblems({ typed: ` ${REF} `, linked: REF, dbUrl: dbUrl(REF), apiUrl: apiUrl(REF) })).toEqual([]);
  });

  it("refuses a typo, another linked project or URLs of another project", () => {
    expect(refProblems({ typed: "gpviraoifdnakkigrfgb", linked: REF, dbUrl: dbUrl(REF), apiUrl: apiUrl(REF) })).toHaveLength(3);
    expect(refProblems({ typed: REF, linked: OTHER, dbUrl: dbUrl(REF), apiUrl: apiUrl(REF) })).toEqual([`The CLI is linked to ${OTHER}, not ${REF}.`]);
    expect(refProblems({ typed: REF, linked: null, dbUrl: dbUrl(REF), apiUrl: apiUrl(REF) })[0]).toMatch(/not linked/);
    expect(refProblems({ typed: REF, linked: REF, dbUrl: dbUrl(OTHER), apiUrl: apiUrl(REF) })).toEqual([`SUPABASE_DB_URL points at ${OTHER}, not ${REF}.`]);
    expect(refProblems({ typed: REF, linked: REF, dbUrl: dbUrl(REF), apiUrl: "http://localhost:54321" })[0]).toMatch(/unknown project/);
    expect(refProblems({ typed: "", linked: REF, dbUrl: dbUrl(REF), apiUrl: apiUrl(REF) })[0]).toBe("No project ref was typed.");
  });

  it("needs all three production variables from .env.admin.local", () => {
    expect(() => adminEnv({ SUPABASE_DB_URL: dbUrl(REF), NEXT_PUBLIC_SUPABASE_URL: apiUrl(REF) })).toThrow(/\.env\.admin\.local/);
    expect(adminEnv({ SUPABASE_DB_URL: dbUrl(REF), NEXT_PUBLIC_SUPABASE_URL: `${apiUrl(REF)}/`, SUPABASE_SERVICE_ROLE_KEY: "k" })).toEqual({
      dbUrl: dbUrl(REF),
      apiUrl: apiUrl(REF),
      serviceKey: "k",
    });
  });

  it("lists this checkout's migrations in order", () => {
    const versions = localMigrations();
    expect(versions.length).toBeGreaterThanOrEqual(42);
    expect([...versions].sort()).toEqual(versions);
    expect(versions).toContain("20261020000041");
  });
});

describe("golive:admin input", () => {
  const rules = { usernamePattern: USERNAME_PATTERN, isEnglish: isEnglishText };
  it("accepts a normal admin", () => {
    expect(adminInputProblems({ username: "ciigus.admin", fullName: "Nimal Perera", email: "admin@ciigus.lk" }, rules)).toEqual([]);
  });
  it("refuses bad usernames, names and emails", () => {
    expect(adminInputProblems({ username: "Ad", fullName: "N", email: "nope" }, rules)).toHaveLength(3);
    expect(adminInputProblems({ username: "admin", fullName: "නිමල්", email: "a@b.lk" }, rules)).toEqual(["Full name: please use English letters only."]);
    expect(adminInputProblems({ username: "-admin", fullName: "Nimal", email: "a@b.lk" }, rules)[0]).toMatch(/^Username/);
  });
});
