import { describe, expect, it } from "vitest";

import { searchTerm } from "./queries";

describe("searchTerm", () => {
  it("keeps letters, digits and common contact characters", () => {
    expect(searchTerm("  Perera  Printers ")).toBe("Perera Printers");
    expect(searchTerm("hello@ceylon.example")).toBe("hello@ceylon.example");
    expect(searchTerm("+94 77-123")).toBe("+94 77-123");
  });

  it("removes characters that could change the PostgREST filter", () => {
    expect(searchTerm('a,b),id.eq.(x"')).toBe("a b id.eq. x");
    expect(searchTerm("100%_")).toBe("100");
    expect(searchTerm(" ,() ")).toBeNull();
    expect(searchTerm(undefined)).toBeNull();
  });
});
