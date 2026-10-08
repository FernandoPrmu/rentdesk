import { z } from "zod";

import { isoDate, optionalCount, optionalText, reasonField, requiredText } from "@/lib/forms";

/** Machines (MAC-01, MAC-03). Shared by the forms and the Server Actions. */

export const MACHINE_TYPES = ["MONO", "COLOUR"] as const;
export type MachineType = (typeof MACHINE_TYPES)[number];

export const MACHINE_STATUSES = ["AVAILABLE", "RENTED", "UNDER_REPAIR", "RETIRED"] as const;
export type MachineStatus = (typeof MACHINE_STATUSES)[number];

/** Statuses an owner can set by hand. RENTED comes only from an assignment. */
export const MANUAL_MACHINE_STATUSES = ["AVAILABLE", "UNDER_REPAIR", "RETIRED"] as const;

export const MACHINE_TYPE_LABEL: Record<MachineType, string> = { MONO: "Mono (B&W)", COLOUR: "Colour" };
export const MACHINE_STATUS_LABEL: Record<MachineStatus, string> = {
  AVAILABLE: "Available",
  RENTED: "Rented",
  UNDER_REPAIR: "Under repair",
  RETIRED: "Retired",
};

const machineFields = {
  brand: requiredText("Brand", 60),
  model: requiredText("Model", 80),
  serial_no: requiredText("Serial number", 60),
  purchase_date: z
    .string()
    .default("")
    .pipe(z.string().trim())
    .transform((v) => (v === "" ? null : v))
    .pipe(isoDate("Purchase date").nullable()),
  bw_counter_max: optionalCount("B&W counter maximum"),
  colour_counter_max: optionalCount("Colour counter maximum"),
  notes: optionalText("Notes", 1000),
};

function counterRules(value: { bw_counter_max: number | null; colour_counter_max: number | null }, type: MachineType, ctx: z.RefinementCtx) {
  if (value.bw_counter_max === 0) {
    ctx.addIssue({ code: "custom", path: ["bw_counter_max"], message: "The counter maximum must be more than 0." });
  }
  if (value.colour_counter_max === 0) {
    ctx.addIssue({ code: "custom", path: ["colour_counter_max"], message: "The counter maximum must be more than 0." });
  }
  if (type === "MONO" && value.colour_counter_max !== null) {
    ctx.addIssue({ code: "custom", path: ["colour_counter_max"], message: "A mono machine has no colour counter." });
  }
}

/** New machine: the type is chosen once and cannot change later. */
export const machineCreateSchema = z
  .object({ ...machineFields, type: z.enum(MACHINE_TYPES, "Choose mono or colour.") })
  .superRefine((value, ctx) => counterRules(value, value.type, ctx));
export type MachineCreateInput = z.infer<typeof machineCreateSchema>;

/** Edit: same fields without the type (the machine's own type is checked). */
export function machineUpdateSchema(type: MachineType) {
  return z.object(machineFields).superRefine((value, ctx) => counterRules(value, type, ctx));
}
export type MachineUpdateInput = z.infer<ReturnType<typeof machineUpdateSchema>>;

export const machineStatusSchema = z.object({
  status: z.enum(MANUAL_MACHINE_STATUSES, "Choose a status."),
  reason: reasonField,
});

/** List filters from the URL (?q=&type=&status=). */
export const machineListFilterSchema = z.object({
  q: z.string().trim().max(80).optional().catch(undefined),
  type: z.enum(MACHINE_TYPES).optional().catch(undefined),
  status: z.enum(MACHINE_STATUSES).optional().catch(undefined),
});
export type MachineListFilter = z.infer<typeof machineListFilterSchema>;
