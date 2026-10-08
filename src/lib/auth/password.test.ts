import { describe, expect, it } from "vitest";

import { checkPassword, PASSWORD_RULES } from "./password";
import { generateTemporaryPassword } from "./temporary-password";

describe("generateTemporaryPassword", () => {
  it("has the grouped format, mixed classes and no look-alike characters", () => {
    for (let i = 0; i < 500; i++) {
      const p = generateTemporaryPassword();
      expect(p).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).not.toMatch(/[01OIl]/);
    }
  });

  it("is random and meets the strength rules", () => {
    const seen = new Set(Array.from({ length: 1000 }, generateTemporaryPassword));
    expect(seen.size).toBe(1000);
    for (const p of [...seen].slice(0, 50)) {
      expect(checkPassword(p, { username: "cust.perera" }).ok).toBe(true);
    }
  });
});

describe("checkPassword", () => {
  it("accepts a strong password", () => {
    const r = checkPassword("Kandy-lake-2026", { username: "cust.bandara" });
    expect(r.ok).toBe(true);
  });

  it("reports each failing rule", () => {
    expect(checkPassword("short1").passed.length).toBe(false);
    expect(checkPassword("1234567890123").passed.letter).toBe(false);
    expect(checkPassword("onlyletters-here").passed.number).toBe(false);
    expect(checkPassword("Password123").passed.common).toBe(false);
    expect(checkPassword("aaaaaaaaaaaa").passed.common).toBe(false);
    expect(checkPassword("x1".repeat(40)).passed.max).toBe(false);
  });

  it("rejects passwords that contain the username or a part of it", () => {
    expect(checkPassword("cust.bandara99", { username: "cust.bandara" }).passed.username).toBe(false);
    expect(checkPassword("MyBandara2026", { username: "cust.bandara" }).passed.username).toBe(false);
    // The role prefix alone is not a username part.
    expect(checkPassword("customer-2026x", { username: "cust.bandara" }).passed.username).toBe(true);
  });

  it("lists a label for every rule shown to users", () => {
    expect(PASSWORD_RULES.map((r) => r.id)).toEqual(["length", "letter", "number", "username", "common"]);
    expect(PASSWORD_RULES.every((r) => r.label.length > 0)).toBe(true);
  });
});
