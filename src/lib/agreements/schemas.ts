import { z } from "zod";

import { addDays } from "@/lib/agreements/cycle-calendar";
import {
  count,
  isoDate,
  optionalIsoDate,
  optionalRupees,
  optionalText,
  reasonField,
  requiredText,
  rupees,
  wholeNumber,
} from "@/lib/forms";
import type { MachineType } from "@/lib/machines/schemas";

/**
 * Agreement input (MAC-02, MAC-04, AGR-01, AGR-02, LATE-01, DEP-01..04, RET-01).
 * Money arrives in rupees and leaves as integer cents. Colour terms and readings
 * are required for a COLOUR machine and dropped for a MONO one. The database
 * checks all of it again.
 */

export const DEFAULT_DUE_DAYS = 7;
export const MAX_UPFRONT_ENTRIES = 10;

export const LATE_FEE_MODES = ["OWNER_DEFAULT", "CUSTOM", "NONE"] as const;
export type LateFeeMode = (typeof LATE_FEE_MODES)[number];

/** How money changed hands (SECURITY_DEPOSIT is only ever set by a deposit deduction). */
export const PAYMENT_METHODS = ["BANK_TRANSFER", "DEPOSIT", "CASH", "CHEQUE", "ONLINE", "OTHER"] as const;
export const UPFRONT_TYPES = ["SECURITY_DEPOSIT", "ADVANCE_PAYMENT"] as const;
export type UpfrontType = (typeof UPFRONT_TYPES)[number];

/** Not shown for a mono machine: whatever is sent becomes null. */
const ignored = z.unknown().optional().transform(() => null);

/** Colour values exist only on colour machines. Field-level, so every error shows at once. */
function colourCount(type: MachineType, label: string) {
  return type === "COLOUR" ? count(label) : ignored;
}

/** A select that may be missing or empty: the default then. */
function choice<const T extends readonly [string, ...string[]]>(values: T, fallback: T[number], message: string) {
  return z
    .string()
    .default("")
    .transform((v) => (v === "" ? fallback : v))
    .pipe(z.enum(values, message));
}

function pricingFields(type: MachineType) {
  return {
    monthly_commitment: rupees("Monthly commitment"),
    bw_included: count("Included B&W copies"),
    bw_rate: rupees("B&W excess rate"),
    colour_included: colourCount(type, "Included colour copies"),
    colour_rate: type === "COLOUR" ? rupees("Colour excess rate") : ignored,
    due_days: wholeNumber("Days to pay", 0, 120),
    late_fee_mode: choice(LATE_FEE_MODES, "OWNER_DEFAULT", "Choose a late fee setting."),
    late_fee: optionalRupees("Late fee"),
  };
}

type Issues = { addIssue: (issue: { code: "custom"; path: string[]; message: string }) => void };

/** LATE-01: a custom late fee needs an amount above zero. */
function checkLateFee(value: { late_fee_mode: LateFeeMode; late_fee: number | null }, ctx: Issues) {
  if (value.late_fee_mode === "CUSTOM" && (value.late_fee === null || value.late_fee <= 0)) {
    ctx.addIssue({ code: "custom", path: ["late_fee"], message: "Enter the late fee for this agreement." });
  }
}

/** Pricing terms as the database functions expect them (cents). */
export function termsPayload(value: {
  monthly_commitment: number;
  bw_included: number;
  bw_rate: number;
  colour_included: number | null;
  colour_rate: number | null;
  due_days: number;
  late_fee_mode: LateFeeMode;
  late_fee: number | null;
}) {
  return {
    monthly_commitment_cents: value.monthly_commitment,
    bw_included: value.bw_included,
    bw_rate_cents: value.bw_rate,
    colour_included: value.colour_included,
    colour_rate_cents: value.colour_rate,
    due_days: value.due_days,
    late_fee_mode: value.late_fee_mode,
    late_fee_cents: value.late_fee_mode === "CUSTOM" ? value.late_fee : null,
  };
}

/** One "money received upfront" row (DEP-01, DEP-02). */
export function upfrontEntrySchema(today: string) {
  return z.object({
    type: choice(UPFRONT_TYPES, "SECURITY_DEPOSIT", "Choose security deposit or advance payment."),
    amount: rupees("Amount").refine((cents) => cents > 0, "The amount must be more than 0."),
    received_on: isoDate("Date received").refine((d) => d <= today, "The date received cannot be in the future."),
    method: z.string().default("").pipe(z.enum(PAYMENT_METHODS, "Choose how it was paid.")),
    reference: optionalText("Reference", 100),
    note: optionalText("Note", 500),
  });
}
export type UpfrontEntry = z.infer<ReturnType<typeof upfrontEntrySchema>>;

/** Rows are named upfront_<n>_<field>; returns them in order, errors keyed by input name. */
export function collectUpfront(values: Record<string, unknown>, today: string, ctx: Issues): UpfrontEntry[] {
  const indexes = Object.keys(values)
    .map((k) => /^upfront_(\d+)_type$/.exec(k)?.[1])
    .filter((i): i is string => i !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  if (indexes.length > MAX_UPFRONT_ENTRIES) {
    ctx.addIssue({ code: "custom", path: ["upfront"], message: `At most ${MAX_UPFRONT_ENTRIES} payments can be recorded.` });
    return [];
  }
  const schema = upfrontEntrySchema(today);
  const entries: UpfrontEntry[] = [];
  for (const i of indexes) {
    const raw = Object.fromEntries(
      ["type", "amount", "received_on", "method", "reference", "note"].map((f) => [f, values[`upfront_${i}_${f}`] ?? ""]),
    );
    const parsed = schema.safeParse(raw);
    if (parsed.success) entries.push(parsed.data);
    else for (const issue of parsed.error.issues) ctx.addIssue({ code: "custom", path: [`upfront_${i}_${String(issue.path[0])}`], message: issue.message });
  }
  return entries;
}

function pick<T extends Record<string, unknown>>(value: Record<string, unknown>, keys: string[]): T {
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as T;
}

/** Assign a machine to a customer (MAC-02, AGR-01, DEP-01/02). `today` is Asia/Colombo. */
export function assignmentSchema(type: MachineType, today: string) {
  const shape = {
    customer_id: z.uuid("Choose a customer."),
    start_date: isoDate("Start date"),
    first_billing_date: isoDate("First billing date"),
    end_date: optionalIsoDate("End date"),
    installation_location: requiredText("Installation location", 200),
    initial_bw: count("Initial B&W reading"),
    initial_colour: colourCount(type, "Initial colour reading"),
    ...pricingFields(type),
  };
  return z.looseObject(shape).transform((value, ctx) => {
    if (value.first_billing_date < today) {
      ctx.addIssue({ code: "custom", path: ["first_billing_date"], message: "The first billing date cannot be in the past." });
    }
    if (value.first_billing_date <= value.start_date) {
      ctx.addIssue({ code: "custom", path: ["first_billing_date"], message: "The first billing date must be after the start date." });
    }
    if (value.start_date > addDays(today, 366)) {
      ctx.addIssue({ code: "custom", path: ["start_date"], message: "The start date is too far ahead." });
    }
    if (value.end_date !== null && value.end_date < value.start_date) {
      ctx.addIssue({ code: "custom", path: ["end_date"], message: "The end date cannot be before the start date." });
    }
    checkLateFee(value, ctx);
    const upfront = collectUpfront(value, today, ctx);
    const known = pick<{ [K in keyof typeof shape]: z.output<(typeof shape)[K]> }>(value, Object.keys(shape));
    return { ...known, upfront };
  });
}
export type AssignmentInput = z.output<ReturnType<typeof assignmentSchema>>;

/** p_terms for rpc_assign_machine / rpc_reassign_machine. */
export function assignmentPayload(input: AssignmentInput) {
  return {
    start_date: input.start_date,
    first_billing_date: input.first_billing_date,
    end_date: input.end_date,
    installation_location: input.installation_location,
    initial_bw_reading: input.initial_bw,
    initial_colour_reading: input.initial_colour,
    ...termsPayload(input),
    upfront: input.upfront.map((u) => ({
      type: u.type,
      amount_cents: u.amount,
      received_on: u.received_on,
      method: u.method,
      reference: u.reference,
      note: u.note,
    })),
  };
}

/** Edit terms (AGR-02, LATE-01): pricing and the late fee apply from the next cycle, the rest at once. */
export function termsEditSchema(type: MachineType, startDate: string) {
  return z
    .object({
      ...pricingFields(type),
      installation_location: requiredText("Installation location", 200),
      end_date: optionalIsoDate("End date"),
      note: optionalText("Note", 500),
    })
    .superRefine((value, ctx) => {
      if (value.end_date !== null && value.end_date < startDate) {
        ctx.addIssue({ code: "custom", path: ["end_date"], message: "The end date cannot be before the start date." });
      }
      checkLateFee(value, ctx);
    });
}
export type TermsEditInput = z.infer<ReturnType<typeof termsEditSchema>>;

/** DEP-03/04: deduct, refund, keep. The totals are checked against the deposit held by the action. */
const settlementShape = () => ({
  deduct: optionalRupees("Amount for unpaid bills"),
  refund: optionalRupees("Amount refunded"),
  retain: optionalRupees("Amount kept"),
  refunded_on: optionalIsoDate("Refund date"),
  refund_method: z.string().default(""),
  refund_reference: optionalText("Refund reference", 100),
  retain_reason: optionalText("Reason for keeping", 500),
});

export interface SettlementInput {
  deductCents: number;
  refundCents: number;
  retainCents: number;
  refundedOn: string | null;
  refundMethod: (typeof PAYMENT_METHODS)[number] | null;
  refundReference: string | null;
  retainReason: string | null;
}

function toSettlement(v: z.output<z.ZodObject<ReturnType<typeof settlementShape>>>, today: string, ctx: Issues): SettlementInput {
  const refundCents = v.refund ?? 0;
  const retainCents = v.retain ?? 0;
  const method = (PAYMENT_METHODS as readonly string[]).includes(v.refund_method) ? (v.refund_method as SettlementInput["refundMethod"]) : null;
  if (refundCents > 0) {
    if (!v.refunded_on) ctx.addIssue({ code: "custom", path: ["refunded_on"], message: "Enter the date the refund was paid." });
    else if (v.refunded_on > today) ctx.addIssue({ code: "custom", path: ["refunded_on"], message: "The refund date cannot be in the future." });
    if (!method) ctx.addIssue({ code: "custom", path: ["refund_method"], message: "Choose how the refund was paid." });
  }
  if (retainCents > 0 && !v.retain_reason) {
    ctx.addIssue({ code: "custom", path: ["retain_reason"], message: "Give a reason for keeping part of the deposit." });
  }
  return {
    deductCents: v.deduct ?? 0,
    refundCents,
    retainCents,
    refundedOn: refundCents > 0 ? v.refunded_on : null,
    refundMethod: refundCents > 0 ? method : null,
    refundReference: refundCents > 0 ? v.refund_reference : null,
    retainReason: retainCents > 0 ? v.retain_reason : null,
  };
}

/** Settle a held deposit later, on a returned agreement. */
export function settlementSchema(today: string) {
  return z.object(settlementShape()).transform((v, ctx) => toSettlement(v, today, ctx));
}

/** p_settlement for rpc_settle_deposit / the deposit part of rpc_return_machine. */
export function settlementPayload(s: SettlementInput) {
  return {
    deduct_cents: s.deductCents,
    refund_cents: s.refundCents,
    refunded_on: s.refundedOn,
    refund_method: s.refundMethod,
    refund_reference: s.refundReference,
    retain_cents: s.retainCents,
    retain_reason: s.retainReason,
  };
}

/**
 * Return (MAC-04, RET-01): closing readings, reason, prorated or full final cycle,
 * the credits to apply (rule 13: all offered credits unless unticked), and the
 * deposit (settle now or keep holding).
 */
export function returnSchema(type: MachineType, today: string) {
  const shape = {
    closing_bw: count("Closing B&W reading"),
    closing_colour: colourCount(type, "Closing colour reading"),
    reason: reasonField,
    rule: choice(["PRORATED", "FULL"] as const, "PRORATED", "Choose prorated or full."),
    idempotency_key: z.uuid("Please reload the page and try again."),
    credit_ids: z.string().default(""),
    deposit_action: z.string().default(""),
    ...settlementShape(),
  };
  return z.looseObject(shape).transform((v, ctx) => {
    const offered = v.credit_ids.split(",").filter(Boolean);
    const creditsExcluded = offered.filter((id) => v[`credit_${id}`] !== "on");
    const settle = v.deposit_action === "SETTLE";
    const deposit = settle ? toSettlement(v, today, ctx) : null;
    return {
      closing_bw: v.closing_bw,
      closing_colour: v.closing_colour as number | null,
      reason: v.reason,
      rule: v.rule,
      idempotency_key: v.idempotency_key,
      creditsExcluded,
      deposit,
    };
  });
}
export type ReturnInput = z.output<ReturnType<typeof returnSchema>>;
