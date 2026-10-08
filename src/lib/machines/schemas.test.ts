import { describe, expect, it } from "vitest";

import { machineCreateSchema, machineListFilterSchema, machineStatusSchema, machineUpdateSchema } from "./schemas";

const form = {
  brand: " Canon ",
  model: "iR C3226",
  serial_no: "LCS-C-009",
  type: "COLOUR",
  purchase_date: "2025-03-01",
  bw_counter_max: "999,999",
  colour_counter_max: "",
  notes: "",
};

describe("machine schemas", () => {
  it("parses a new machine", () => {
    expect(machineCreateSchema.parse(form)).toEqual({
      brand: "Canon",
      model: "iR C3226",
      serial_no: "LCS-C-009",
      type: "COLOUR",
      purchase_date: "2025-03-01",
      bw_counter_max: 999_999,
      colour_counter_max: null,
      notes: null,
    });
  });

  it("treats fields the form does not render as empty (no colour counter on a mono machine)", () => {
    const mono = { brand: "Ricoh", model: "MP 2555", serial_no: "E2E-1", type: "MONO", bw_counter_max: "" };
    expect(machineCreateSchema.parse(mono)).toMatchObject({ type: "MONO", colour_counter_max: null, purchase_date: null, notes: null });
  });

  it("rejects bad input", () => {
    const result = machineCreateSchema.safeParse({ ...form, brand: "", type: "LASER", purchase_date: "2025-02-30", bw_counter_max: "0" });
    const fields = (result.error?.issues ?? []).map((i) => i.path[0]);
    expect(fields).toEqual(expect.arrayContaining(["brand", "type", "purchase_date"]));
  });

  it("does not allow a colour counter on a mono machine", () => {
    expect(machineCreateSchema.safeParse({ ...form, type: "MONO", colour_counter_max: "99999" }).success).toBe(false);
    expect(machineUpdateSchema("MONO").safeParse({ ...form, colour_counter_max: "99999" }).success).toBe(false);
    expect(machineUpdateSchema("COLOUR").safeParse({ ...form, colour_counter_max: "99999" }).success).toBe(true);
    expect(machineUpdateSchema("COLOUR").safeParse({ ...form, bw_counter_max: "0" }).success).toBe(false);
  });

  it("never lets an owner set RENTED by hand", () => {
    expect(machineStatusSchema.safeParse({ status: "RENTED", reason: "Because" }).success).toBe(false);
    expect(machineStatusSchema.safeParse({ status: "UNDER_REPAIR", reason: "  " }).success).toBe(false);
    expect(machineStatusSchema.parse({ status: "RETIRED", reason: " Worn out " })).toEqual({ status: "RETIRED", reason: "Worn out" });
  });

  it("ignores unknown list filters", () => {
    expect(machineListFilterSchema.parse({ q: " ricoh ", type: "PLOTTER", status: "RENTED" })).toEqual({
      q: "ricoh",
      type: undefined,
      status: "RENTED",
    });
  });
});
