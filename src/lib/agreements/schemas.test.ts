import { describe, expect, it } from "vitest";

import { assignmentPayload, assignmentSchema, returnSchema, termsEditSchema } from "./schemas";

const TODAY = "2026-10-08";
const CUSTOMER = "8d0f6a2e-4a5b-4c7d-9e1f-2a3b4c5d6e7f";

const monoForm = {
  customer_id: CUSTOMER,
  start_date: "2026-06-30",
  first_billing_date: "2026-10-28",
  end_date: "",
  cycle_length_days: "30",
  installation_location: "Front office",
  initial_bw: "12,500",
  initial_colour: "",
  monthly_commitment: "5,000",
  bw_included: "2000",
  bw_rate: "2.50",
  colour_included: "",
  colour_rate: "",
  due_days: "7",
};

const errorsOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((result.error?.issues ?? []).map((i) => [String(i.path[0]), i.message]));

describe("assignmentSchema", () => {
  it("parses a mono assignment into cents and whole numbers", () => {
    const parsed = assignmentSchema("MONO", TODAY).parse(monoForm);
    expect(assignmentPayload(parsed)).toEqual({
      start_date: "2026-06-30",
      first_billing_date: "2026-10-28",
      end_date: null,
      cycle_length_days: 30,
      installation_location: "Front office",
      initial_bw_reading: 12_500,
      initial_colour_reading: null,
      monthly_commitment_cents: 500_000,
      bw_included: 2000,
      bw_rate_cents: 250,
      colour_included: null,
      colour_rate_cents: null,
      due_days: 7,
    });
  });

  it("accepts a mono form that has no colour inputs at all", () => {
    const { colour_included: _a, colour_rate: _b, initial_colour: _c, ...rendered } = monoForm;
    void [_a, _b, _c];
    expect(assignmentSchema("MONO", TODAY).safeParse(rendered).success).toBe(true);
    expect(returnSchema("MONO").safeParse({ closing_bw: "1", reason: "Ended" }).success).toBe(true);
  });

  it("drops colour values sent for a mono machine", () => {
    const parsed = assignmentSchema("MONO", TODAY).parse({ ...monoForm, colour_included: "500", colour_rate: "10", initial_colour: "9" });
    expect([parsed.colour_included, parsed.colour_rate, parsed.initial_colour]).toEqual([null, null, null]);
  });

  it("requires colour terms and the colour reading for a colour machine", () => {
    const result = assignmentSchema("COLOUR", TODAY).safeParse(monoForm);
    expect(errorsOf(result)).toMatchObject({
      colour_included: expect.stringContaining("whole number"),
      colour_rate: expect.stringContaining("rupees"),
      initial_colour: expect.stringContaining("whole number"),
    });
    const ok = assignmentSchema("COLOUR", TODAY).parse({ ...monoForm, colour_included: "500", colour_rate: "10", initial_colour: "2,000" });
    expect([ok.colour_included, ok.colour_rate, ok.initial_colour]).toEqual([500, 1000, 2000]);
  });

  it("allows a past start date but not a past first billing date", () => {
    expect(assignmentSchema("MONO", TODAY).safeParse({ ...monoForm, first_billing_date: TODAY }).success).toBe(true);
    const past = assignmentSchema("MONO", TODAY).safeParse({ ...monoForm, first_billing_date: "2026-10-07" });
    expect(errorsOf(past).first_billing_date).toMatch(/past/);
    const beforeStart = assignmentSchema("MONO", TODAY).safeParse({ ...monoForm, start_date: "2026-11-01", first_billing_date: "2026-11-01" });
    expect(errorsOf(beforeStart).first_billing_date).toMatch(/after the start date/);
  });

  it.each([
    ["initial_bw", "-1"],
    ["initial_bw", "12.5"],
    ["initial_bw", "abc"],
    ["bw_included", "-5"],
    ["monthly_commitment", "-100"],
    ["bw_rate", "2.505"],
    ["cycle_length_days", "0"],
    ["due_days", "121"],
    ["customer_id", "not-a-uuid"],
    ["start_date", "2026-02-30"],
  ])("rejects %s = %j", (field, value) => {
    const result = assignmentSchema("MONO", TODAY).safeParse({ ...monoForm, [field]: value });
    expect(result.success).toBe(false);
    expect(errorsOf(result)[field]).toBeDefined();
  });
});

describe("termsEditSchema", () => {
  const edit = {
    monthly_commitment: "6000",
    bw_included: "2000",
    bw_rate: "3",
    colour_included: "",
    colour_rate: "",
    due_days: "10",
    installation_location: "Back office",
    end_date: "",
    note: "  New price list ",
  };

  it("parses rupees to cents and trims the note", () => {
    expect(termsEditSchema("MONO", "2026-06-30").parse(edit)).toMatchObject({
      monthly_commitment: 600_000,
      bw_rate: 300,
      due_days: 10,
      note: "New price list",
      end_date: null,
    });
  });

  it("checks the end date and colour terms", () => {
    expect(errorsOf(termsEditSchema("MONO", "2026-06-30").safeParse({ ...edit, end_date: "2026-01-01" })).end_date).toBeDefined();
    expect(errorsOf(termsEditSchema("COLOUR", "2026-06-30").safeParse(edit)).colour_rate).toBeDefined();
  });
});

describe("returnSchema", () => {
  it("needs a reason and non-negative whole readings", () => {
    expect(returnSchema("MONO").parse({ closing_bw: "15,000", closing_colour: "", reason: "Contract ended" })).toEqual({
      closing_bw: 15_000,
      closing_colour: null,
      reason: "Contract ended",
    });
    const bad = returnSchema("COLOUR").safeParse({ closing_bw: "-1", closing_colour: "", reason: "" });
    expect(Object.keys(errorsOf(bad)).sort()).toEqual(["closing_bw", "closing_colour", "reason"]);
  });
});
