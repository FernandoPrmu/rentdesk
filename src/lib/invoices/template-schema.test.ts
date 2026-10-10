import { describe, expect, it } from "vitest";

import { ENGLISH_ONLY_MESSAGE } from "../text/english";

import { invoiceTemplateSchema } from "./template-schema";

const form = {
  letterhead_path: "o/letterheads/x.pdf",
  preset: "HEADER_FOOTER",
  area_x: "7",
  area_y: "20",
  area_w: "86",
  area_h: "64",
  payment_instructions: "  Cheques payable to Lanka Copy Solutions.  ",
};

describe("invoice template form (BRD-04..07)", () => {
  it("parses the layout as percentages and trims the instructions", () => {
    expect(invoiceTemplateSchema.parse(form)).toEqual({
      letterheadPath: "o/letterheads/x.pdf",
      layout: { preset: "HEADER_FOOTER", area: { x: 7, y: 20, w: 86, h: 64 } },
      paymentInstructions: "Cheques payable to Lanka Copy Solutions.",
    });
  });

  it("no letterhead and no instructions: built-in template", () => {
    expect(invoiceTemplateSchema.parse({})).toMatchObject({ letterheadPath: null, paymentInstructions: null });
  });

  it("keeps a dragged area on the page", () => {
    expect(invoiceTemplateSchema.parse({ ...form, preset: "CUSTOM", area_x: "70", area_w: "60" }).layout).toEqual({ preset: "CUSTOM", area: { x: 40, y: 20, w: 60, h: 64 } });
  });

  it("refuses bad numbers and unknown presets", () => {
    expect(invoiceTemplateSchema.safeParse({ ...form, area_x: "abc" }).success).toBe(false);
    expect(invoiceTemplateSchema.safeParse({ ...form, area_w: "120" }).success).toBe(false);
    expect(invoiceTemplateSchema.safeParse({ ...form, preset: "FANCY" }).success).toBe(false);
  });

  it("payment instructions are printed on invoices: English letters only, at most 300 characters", () => {
    for (const text of ["ශ්‍රී ලංකා බැංකුව", "கொழும்பு வங்கி"]) {
      const result = invoiceTemplateSchema.safeParse({ ...form, payment_instructions: text });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]).toMatchObject({ path: ["payment_instructions"], message: ENGLISH_ONLY_MESSAGE });
    }
    expect(invoiceTemplateSchema.safeParse({ ...form, payment_instructions: "x".repeat(301) }).success).toBe(false);
  });
});
