import { describe, expect, it } from "vitest";

import { accountListFilterSchema, customerListFilterSchema, customerSchema, ownerSchema, statusChangeSchema } from "./schemas";

describe("ownerSchema", () => {
  it("accepts a complete owner and normalises optional fields", () => {
    const r = ownerSchema.parse({
      business_name: "  Ceylon Office Machines ",
      contact_person: "Kumari Silva",
      phone: "+94 81 223 3445",
      email: " Hello@CeylonOffice.example ",
      address: "",
    });
    expect(r).toEqual({
      business_name: "Ceylon Office Machines",
      contact_person: "Kumari Silva",
      phone: "+94 81 223 3445",
      email: "hello@ceylonoffice.example",
      address: null,
    });
  });

  it("explains missing or invalid fields", () => {
    const r = ownerSchema.safeParse({ business_name: "", contact_person: "x", phone: "abc", email: "not-an-email", address: "" });
    expect(r.success).toBe(false);
    const messages = r.error!.issues.map((i) => `${String(i.path[0])}: ${i.message}`);
    expect(messages).toEqual([
      "business_name: Business name is required.",
      "phone: Enter a valid phone number.",
      "email: Enter a valid email address.",
    ]);
  });
});

describe("customerSchema", () => {
  it("requires a name and phone; the rest is optional", () => {
    expect(customerSchema.parse({ name: "Bandara Enterprises", business_name: "", phone: "0716789012", email: "", address: "Peradeniya" })).toEqual({
      name: "Bandara Enterprises",
      business_name: null,
      phone: "0716789012",
      email: null,
      address: "Peradeniya",
    });
    expect(customerSchema.safeParse({ name: " ", phone: "0716789012", business_name: "", email: "", address: "" }).success).toBe(false);
  });
});

describe("statusChangeSchema", () => {
  it("needs a known status and a reason", () => {
    expect(statusChangeSchema.safeParse({ status: "SUSPENDED", reason: "Unpaid for 3 months" }).success).toBe(true);
    expect(statusChangeSchema.safeParse({ status: "SUSPENDED", reason: " " }).success).toBe(false);
    expect(statusChangeSchema.safeParse({ status: "DELETED", reason: "xxx" }).success).toBe(false);
  });
});

describe("accountListFilterSchema", () => {
  it("ignores unknown filter values instead of failing", () => {
    expect(accountListFilterSchema.parse({ q: " lanka ", status: "SUSPENDED" })).toEqual({ q: "lanka", status: "SUSPENDED" });
    expect(accountListFilterSchema.parse({ q: ["a", "b"], status: "nope" })).toEqual({ q: undefined, status: undefined });
  });
});

describe("customerListFilterSchema", () => {
  it("accepts the balance filter and ignores unknown values", () => {
    expect(customerListFilterSchema.parse({ q: "silva", balance: "due" })).toEqual({ q: "silva", status: undefined, balance: "due" });
    expect(customerListFilterSchema.parse({ balance: "lots" }).balance).toBeUndefined();
  });
});
