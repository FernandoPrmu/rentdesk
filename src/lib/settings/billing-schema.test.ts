import { describe, expect, it } from "vitest";

import { billingSettingsSchema, describeLateFee, describeOwnerDefault } from "./billing-schema";

describe("Settings › Billing (PAY-13)", () => {
  it("parses the checkbox, rupees and grace days", () => {
    expect(billingSettingsSchema.parse({ late_fee_enabled: "on", late_fee: "500", grace_period_days: "7", estimated_billing_enabled: "on" })).toEqual({
      late_fee_enabled: true,
      estimated_billing_enabled: true,
      late_fee: 50_000,
      grace_period_days: 7,
    });
    // An unticked checkbox is not sent at all.
    const off = billingSettingsSchema.parse({ late_fee: "0", grace_period_days: "3" });
    expect(off.late_fee_enabled).toBe(false);
    expect(off.estimated_billing_enabled).toBe(false);
  });

  it("needs an amount when the late fee is on", () => {
    expect(billingSettingsSchema.safeParse({ late_fee_enabled: "on", late_fee: "0", grace_period_days: "7" }).success).toBe(false);
    expect(billingSettingsSchema.safeParse({ late_fee: "0", grace_period_days: "91" }).success).toBe(false);
  });

  it("describes the default the agreement form offers", () => {
    expect(describeLateFee({ enabled: true, feeCents: 50_000, graceDays: 7 })).toBe("Rs. 500, charged 7 days after the due date");
    expect(describeLateFee({ enabled: false, feeCents: 50_000, graceDays: 1 })).toBe("no late fee");
    expect(
      describeOwnerDefault({
        owner: { enabled: true, feeCents: null, graceDays: 1 },
        platform: { enabled: false, feeCents: 25_000, graceDays: 7 },
      }),
    ).toBe("Rs. 250, charged 1 day after the due date");
  });
});
