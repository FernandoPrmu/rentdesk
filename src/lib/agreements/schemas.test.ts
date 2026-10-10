import { describe, expect, it } from "vitest";

import { assignmentPayload, assignmentSchema, returnSchema, settlementPayload, settlementSchema, termsEditSchema } from "./schemas";

const TODAY = "2026-10-08";
const CUSTOMER = "8d0f6a2e-4a5b-4c7d-9e1f-2a3b4c5d6e7f";

const monoForm = {
  customer_id: CUSTOMER,
  start_date: "2026-06-30",
  first_billing_date: "2026-10-28",
  end_date: "",
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
      installation_location: "Front office",
      initial_bw_reading: 12_500,
      initial_colour_reading: null,
      monthly_commitment_cents: 500_000,
      bw_included: 2000,
      bw_rate_cents: 250,
      colour_included: null,
      colour_rate_cents: null,
      due_days: 7,
      late_fee_mode: "OWNER_DEFAULT",
      late_fee_cents: null,
      upfront: [],
    });
  });

  it("LATE-01: owner default unless set; a custom fee needs an amount; none drops it", () => {
    const custom = assignmentSchema("MONO", TODAY).safeParse({ ...monoForm, late_fee_mode: "CUSTOM", late_fee: "" });
    expect(errorsOf(custom).late_fee).toMatch(/late fee/);
    const ok = assignmentSchema("MONO", TODAY).parse({ ...monoForm, late_fee_mode: "CUSTOM", late_fee: "750" });
    expect(assignmentPayload(ok)).toMatchObject({ late_fee_mode: "CUSTOM", late_fee_cents: 75_000 });
    const none = assignmentSchema("MONO", TODAY).parse({ ...monoForm, late_fee_mode: "NONE", late_fee: "750" });
    expect(assignmentPayload(none)).toMatchObject({ late_fee_mode: "NONE", late_fee_cents: null });
    expect(assignmentSchema("MONO", TODAY).safeParse({ ...monoForm, late_fee_mode: "SOMETIMES" }).success).toBe(false);
  });

  it("DEP-01/02: collects money received upfront, in order, with errors per row", () => {
    const rows = {
      upfront_3_type: "ADVANCE_PAYMENT",
      upfront_3_amount: "2,000",
      upfront_3_received_on: "2026-10-01",
      upfront_3_method: "CASH",
      upfront_3_reference: "",
      upfront_3_note: "",
      upfront_0_type: "SECURITY_DEPOSIT",
      upfront_0_amount: "10,000",
      upfront_0_received_on: "2026-06-30", // a rental already running: past dates are fine
      upfront_0_method: "BANK_TRANSFER",
      upfront_0_reference: "TT-123",
      upfront_0_note: "Held until return",
    };
    const parsed = assignmentSchema("MONO", TODAY).parse({ ...monoForm, ...rows });
    expect(assignmentPayload(parsed).upfront).toEqual([
      { type: "SECURITY_DEPOSIT", amount_cents: 1_000_000, received_on: "2026-06-30", method: "BANK_TRANSFER", reference: "TT-123", note: "Held until return" },
      { type: "ADVANCE_PAYMENT", amount_cents: 200_000, received_on: "2026-10-01", method: "CASH", reference: null, note: null },
    ]);

    const bad = assignmentSchema("MONO", TODAY).safeParse({
      ...monoForm,
      ...rows,
      upfront_3_amount: "0",
      upfront_3_received_on: "2026-10-09",
      upfront_0_method: "",
    });
    expect(errorsOf(bad)).toMatchObject({
      upfront_3_amount: expect.stringMatching(/more than 0/),
      upfront_3_received_on: expect.stringMatching(/future/),
      upfront_0_method: expect.stringMatching(/how it was paid/),
    });
  });

  it("accepts a mono form that has no colour inputs at all", () => {
    const { colour_included: _a, colour_rate: _b, initial_colour: _c, ...rendered } = monoForm;
    void [_a, _b, _c];
    expect(assignmentSchema("MONO", TODAY).safeParse(rendered).success).toBe(true);
    expect(returnSchema("MONO", TODAY).safeParse({ closing_bw: "1", reason: "Ended", idempotency_key: "3f0c7a1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b" }).success).toBe(true);
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
      late_fee_mode: "OWNER_DEFAULT",
    });
    expect(errorsOf(termsEditSchema("MONO", "2026-06-30").safeParse({ ...edit, late_fee_mode: "CUSTOM" })).late_fee).toBeDefined();
  });

  it("checks the end date and colour terms", () => {
    expect(errorsOf(termsEditSchema("MONO", "2026-06-30").safeParse({ ...edit, end_date: "2026-01-01" })).end_date).toBeDefined();
    expect(errorsOf(termsEditSchema("COLOUR", "2026-06-30").safeParse(edit)).colour_rate).toBeDefined();
  });
});

describe("returnSchema", () => {
  const KEY = "3f0c7a1e-2b4d-4e5f-8a9b-0c1d2e3f4a5b";
  const base = { closing_bw: "15,000", closing_colour: "", reason: "Contract ended", idempotency_key: KEY };

  it("needs a reason, non-negative whole readings and a request key", () => {
    expect(returnSchema("MONO", TODAY).parse(base)).toEqual({
      closing_bw: 15_000,
      closing_colour: null,
      reason: "Contract ended",
      rule: "PRORATED",
      idempotency_key: KEY,
      creditsExcluded: [],
      deposit: null,
    });
    const bad = returnSchema("COLOUR", TODAY).safeParse({ closing_bw: "-1", closing_colour: "", reason: "", idempotency_key: "x" });
    expect(Object.keys(errorsOf(bad)).sort()).toEqual(["closing_bw", "closing_colour", "idempotency_key", "reason"]);
  });

  it("rule 13: offered credits apply unless unticked", () => {
    const parsed = returnSchema("MONO", TODAY).parse({ ...base, credit_ids: "c1,c2,c3", credit_c1: "on", credit_c3: "on", rule: "FULL" });
    expect(parsed.creditsExcluded).toEqual(["c2"]);
    expect(parsed.rule).toBe("FULL");
  });

  it("DEP-03: settle now or keep holding; a refund needs a date and method, keeping needs a reason", () => {
    expect(returnSchema("MONO", TODAY).parse({ ...base, deposit_action: "HOLD", refund: "100" }).deposit).toBeNull();
    const settle = returnSchema("MONO", TODAY).safeParse({ ...base, deposit_action: "SETTLE", deduct: "3,000", refund: "6,000", retain: "1,000" });
    expect(errorsOf(settle)).toMatchObject({ refunded_on: expect.any(String), refund_method: expect.any(String), retain_reason: expect.any(String) });
    const ok = returnSchema("MONO", TODAY).parse({
      ...base,
      deposit_action: "SETTLE",
      deduct: "3,000",
      refund: "6,000",
      refunded_on: TODAY,
      refund_method: "CASH",
      retain: "1,000",
      retain_reason: "Damaged tray",
    });
    expect(settlementPayload(ok.deposit!)).toEqual({
      deduct_cents: 300_000,
      refund_cents: 600_000,
      refunded_on: TODAY,
      refund_method: "CASH",
      refund_reference: null,
      retain_cents: 100_000,
      retain_reason: "Damaged tray",
    });
  });

  it("settle later: the same rules; a future refund date is refused", () => {
    expect(errorsOf(settlementSchema(TODAY).safeParse({ refund: "500", refunded_on: "2026-10-09", refund_method: "CASH" })).refunded_on).toMatch(/future/);
    expect(settlementSchema(TODAY).parse({ deduct: "500" })).toMatchObject({ deductCents: 50_000, refundCents: 0, retainCents: 0, refundedOn: null });
  });
});
