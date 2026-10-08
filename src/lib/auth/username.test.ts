import { describe, expect, it } from "vitest";

import {
  emailToUsername,
  isValidUsername,
  normalizeUsername,
  slugifyName,
  USERNAME_PATTERN,
  usernameCandidates,
  usernameToEmail,
} from "./username";

describe("usernameToEmail", () => {
  it("maps a username to the synthetic login email", () => {
    expect(usernameToEmail("owner.lanka")).toBe("owner.lanka@users.rentdesk.invalid");
  });

  it("normalises case and surrounding spaces first", () => {
    expect(usernameToEmail("  Cust.Bandara ")).toBe("cust.bandara@users.rentdesk.invalid");
    expect(normalizeUsername(" ADMIN ")).toBe("admin");
  });

  it("rejects anything that is not a valid username", () => {
    for (const bad of ["", "ab", "a b c", "x@evil.com", "owner.lanka@users.rentdesk.invalid", ".dot-first", "a".repeat(41)]) {
      expect(() => usernameToEmail(bad), bad).toThrow("Invalid username");
    }
  });

  it("round-trips through emailToUsername", () => {
    expect(emailToUsername(usernameToEmail("cust.perera"))).toBe("cust.perera");
    expect(emailToUsername("someone@example.com")).toBeNull();
  });
});

describe("usernameCandidates", () => {
  it("builds readable usernames from business names", () => {
    expect(slugifyName("Perera Printers (Pvt) Ltd")).toBe("perera-printers");
    expect(slugifyName("Café & Copy Co.")).toBe("cafe-copy");
    expect(usernameCandidates("cust", "Perera Printers (Pvt) Ltd", 3)).toEqual([
      "cust.perera-printers",
      "cust.perera-printers2",
      "cust.perera-printers3",
    ]);
  });

  it("falls back when the name has no usable characters", () => {
    expect(usernameCandidates("owner", "මුද්‍රණ", 2)).toEqual(["owner.user", "owner.user2"]);
  });

  it("always produces valid usernames, even for very long names", () => {
    const names = ["A".repeat(200), "Lanka Copy Solutions International Holdings", "x", "--- !!! ---"];
    for (const name of names) {
      for (const candidate of usernameCandidates("cust", name, 120)) {
        expect(candidate, candidate).toMatch(USERNAME_PATTERN);
        expect(isValidUsername(candidate)).toBe(true);
      }
    }
    const many = usernameCandidates("owner", "A".repeat(200), 120);
    expect(new Set(many).size).toBe(120);
  });
});
