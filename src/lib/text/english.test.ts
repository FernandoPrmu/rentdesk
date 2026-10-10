import { describe, expect, it } from "vitest";

import { customerSchema } from "@/lib/accounts/schemas";
import { assignmentSchema, termsEditSchema } from "@/lib/agreements/schemas";
import { companySchema } from "@/lib/branding/schemas";
import { machineCreateSchema } from "@/lib/machines/schemas";

import { ENGLISH_ONLY_MESSAGE, isEnglishText, toPdfText } from "./english";

const SINHALA = "ශ්‍රී ලංකා මුද්‍රණ සේවා";
const TAMIL = "கொழும்பு அச்சகம்";

const errorsOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  Object.fromEntries((result.error?.issues ?? []).map((i) => [String(i.path[0]), i.message]));

describe("English-only text (decision 33)", () => {
  it("accepts English letters, digits, punctuation, symbols and line breaks", () => {
    expect(isEnglishText("Lanka Copiers (Pvt) Ltd.")).toBe(true);
    expect(isEnglishText("No. 12/3, Galle Road,\nColombo 03")).toBe(true);
    expect(isEnglishText("A&B #1 @ 50% + $ * = ? ! ~ ^ _ | \\ < > { } [ ] ; : ' \" `")).toBe(true);
    // Phone keyboards insert curly quotes, dashes and the ellipsis on their own.
    expect(isEnglishText("Perera’s “Copy” Centre – Kandy — Main…")).toBe(true);
    expect(isEnglishText("")).toBe(true);
  });

  it("refuses Sinhala, Tamil, accents and emoji", () => {
    expect(isEnglishText(SINHALA)).toBe(false);
    expect(isEnglishText(TAMIL)).toBe(false);
    expect(isEnglishText(`Lanka ${SINHALA}`)).toBe(false);
    expect(isEnglishText("Café")).toBe(false);
    expect(isEnglishText("Copiers 😀")).toBe(false);
    expect(isEnglishText("Rs 100")).toBe(false); // no-break space
  });

  it("the PDF fallback replaces each unsupported character with ? and reports it", () => {
    expect(toPdfText("Lanka Copiers")).toEqual({ text: "Lanka Copiers", replaced: [] });
    expect(toPdfText("Café 😀")).toEqual({ text: "Caf? ?", replaced: ["é", "😀"] });
    expect(toPdfText(TAMIL).text).toMatch(/^[? ]+$/);
    expect(toPdfText("a\tb\r\nc").text).toBe("a b\nc");
  });
});

describe("invoice fields refuse other scripts with one clear message", () => {
  const company = {
    company_name: "Lanka Copiers",
    address: "12 Galle Road, Colombo 03",
    phone: "0771234567",
    email: "info@lanka.lk",
    bank_name: "Commercial Bank",
    bank_branch: "Kollupitiya",
    bank_account_name: "Lanka Copiers (Pvt) Ltd",
    bank_account_no: "1000 2345 67",
  };

  it("company and bank details", () => {
    expect(companySchema.safeParse(company).success).toBe(true);
    for (const field of ["company_name", "address", "bank_name", "bank_branch", "bank_account_name"]) {
      for (const text of [SINHALA, TAMIL]) {
        expect(errorsOf(companySchema.safeParse({ ...company, [field]: text }))[field], field).toBe(ENGLISH_ONLY_MESSAGE);
      }
    }
  });

  it("customer name, business name and address", () => {
    const customer = { name: "Nimal Perera", business_name: "Perera Stores", phone: "0771234567", email: "", address: "Kandy" };
    expect(customerSchema.safeParse(customer).success).toBe(true);
    for (const field of ["name", "business_name", "address"]) {
      for (const text of [SINHALA, TAMIL]) {
        expect(errorsOf(customerSchema.safeParse({ ...customer, [field]: text }))[field], field).toBe(ENGLISH_ONLY_MESSAGE);
      }
    }
  });

  it("machine brand, model and serial number", () => {
    const machine = { brand: "Canon", model: "iR 2625", serial_no: "SN-1", type: "MONO" };
    expect(machineCreateSchema.safeParse(machine).success).toBe(true);
    for (const field of ["brand", "model", "serial_no"]) {
      for (const text of [SINHALA, TAMIL]) {
        expect(errorsOf(machineCreateSchema.safeParse({ ...machine, [field]: text }))[field], field).toBe(ENGLISH_ONLY_MESSAGE);
      }
    }
  });

  it("installation location (assign and edit)", () => {
    const assign = {
      customer_id: "00000000-0000-4000-8000-000000000001",
      start_date: "2026-06-30",
      first_billing_date: "2026-10-28",
      end_date: "",
      installation_location: SINHALA,
      initial_bw: "0",
      monthly_commitment: "5,000",
      bw_included: "2000",
      bw_rate: "2.50",
      due_days: "7",
    };
    expect(errorsOf(assignmentSchema("MONO", "2026-10-10").safeParse(assign)).installation_location).toBe(ENGLISH_ONLY_MESSAGE);
    const edit = { monthly_commitment: "5,000", bw_included: "2000", bw_rate: "2.50", due_days: "7", installation_location: TAMIL };
    expect(errorsOf(termsEditSchema("MONO", "2026-06-30").safeParse(edit)).installation_location).toBe(ENGLISH_ONLY_MESSAGE);
  });
});
