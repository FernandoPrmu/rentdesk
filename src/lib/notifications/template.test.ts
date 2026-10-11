import { describe, expect, it } from "vitest";

import { allowedVariables, COMMON_VARIABLES, emailEvents, EVENTS, queuesDelivery, VARIABLES } from "./events";
import { contextVars, NOTIFICATION_EVENTS } from "./service";
import { defaultTemplate, GENERIC_TEMPLATE, renderEmail, renderTemplate, sampleVariables, usedVariables, validateTemplate } from "./template";

describe("event catalogue", () => {
  it("knows every event the notification builder makes", () => {
    for (const event of NOTIFICATION_EVENTS) expect(EVENTS, event).toHaveProperty(event);
  });

  it("lists only real variables", () => {
    for (const [event, info] of Object.entries(EVENTS)) {
      for (const name of info.vars) expect(VARIABLES, `${event}: ${name}`).toHaveProperty(name);
    }
  });

  it("gives every built-in template only the variables of its event", () => {
    for (const event of emailEvents()) {
      expect(validateTemplate(event, defaultTemplate(event)), event).toEqual([]);
    }
  });

  it("turns the facts of a message into variables, formatted like the in-app text", () => {
    expect(
      contextVars({ machine: "Canon iR C3226", amountCents: 1_280_000, dueDate: "2026-10-18", invoiceNo: "INV-000123", byDate: "2026-10-14", invoiceNos: ["A", "B"] }),
    ).toEqual({ machine: "Canon iR C3226", amount: "Rs. 12,800", due_date: "18 Oct 2026", invoice_no: "INV-000123", deadline: "14 Oct 2026", invoice_nos: "A, B" });
    // Every key it can make is a known variable.
    const all = contextVars({
      customer: "c", machine: "m", cycleNo: 1, byDate: "2026-01-01", dueDate: "2026-01-01", amountCents: 1, invoiceNo: "i", invoiceNos: ["i"],
      balanceCents: 1, creditCents: 1, totals: "t", changes: "c", reason: "r", count: 1, days: 1, hours: 1, months: 1, preview: "p",
      lastRunAt: "2026-01-01T00:00:00Z", urgency: "HIGH", request: "r", technician: "t", plannedDate: "2026-01-01", rating: 5,
    });
    for (const key of Object.keys(all)) expect(VARIABLES, key).toHaveProperty(key);
  });

  it("wakes the sender only when an action queued an email or SMS", () => {
    expect(queuesDelivery([{ event: "invoice.issued" }])).toBe(true);
    expect(queuesDelivery([{ event: "comment.added" }, { event: "service.acknowledged" }])).toBe(false);
    expect(queuesDelivery([{ event: "invoice.issued", email: false }])).toBe(false);
    expect(queuesDelivery([{ event: "ticket.created" }])).toBe(false);
    expect(queuesDelivery(undefined)).toBe(false);
    expect(queuesDelivery("[]")).toBe(false);
  });

  it("keeps an empty {priority} for normal requests, so their subject still renders", () => {
    expect(contextVars({ urgency: "NORMAL" })).toMatchObject({ priority: "", urgency: "Normal" });
    expect(contextVars({ urgency: "URGENT" }).priority).toBe("URGENT: ");
  });
});

describe("validateTemplate (NOT-04, decision 71)", () => {
  const ok = { subject: "Your bill {invoice_no}", body: "Hello {recipient_name},\n\nPay {amount} by {due_date}." };

  it("accepts known variables of the event", () => {
    expect(validateTemplate("invoice.issued", ok)).toEqual([]);
  });

  it("refuses unknown variables, naming them", () => {
    expect(validateTemplate("invoice.issued", { ...ok, body: "Hi {customer_name} {balance}" })).toEqual([
      { field: "body", message: "Unknown variables: {customer_name}, {balance}." },
    ]);
    // Another event's variable is unknown here.
    expect(validateTemplate("ticket.opened", { subject: "{invoice_no}", body: "x" })[0]).toEqual({ field: "subject", message: "Unknown variable: {invoice_no}." });
  });

  it("refuses braces that are not a variable", () => {
    for (const body of ["Hi {Customer_Name}", "Hi { amount }", "Hi {amount", "a } b"]) {
      expect(validateTemplate("invoice.issued", { ...ok, body }).map((p) => p.message), body).toContain("Use { } only around a variable name, like {customer_name}.");
    }
  });

  it("refuses empty fields, a two-line subject, non-English text and long text", () => {
    expect(validateTemplate("invoice.issued", { subject: " ", body: "" }).map((p) => p.message)).toEqual(["Enter a subject.", "Enter the text."]);
    expect(validateTemplate("invoice.issued", { ...ok, subject: "a\nb" })[0].message).toBe("The subject must be one line.");
    expect(validateTemplate("invoice.issued", { ...ok, body: "ඔබගේ බිල" })[0].message).toBe("Please use English letters only.");
    expect(validateTemplate("invoice.issued", { ...ok, body: "x".repeat(5001) })[0].message).toMatch(/under 5000/);
  });

  it("login details must keep the username and password, and never put the password in the subject", () => {
    expect(validateTemplate("account.credentials", { subject: "Login", body: "Hello {recipient_name}" })).toEqual([
      { field: "body", message: "Keep {username} and {temporary_password}: this email is useless without it." },
    ]);
    expect(validateTemplate("account.credentials", { subject: "Password {temporary_password}", body: "{username}" }).map((p) => p.field)).toEqual(["subject"]);
  });

  it("every event allows the common variables", () => {
    for (const event of emailEvents()) expect(allowedVariables(event)).toEqual(expect.arrayContaining([...COMMON_VARIABLES]));
  });
});

describe("rendering", () => {
  it("fills variables and tidies spacing", () => {
    expect(renderTemplate({ subject: "  Bill  {invoice_no} ", body: "A\n\n\n\nB {amount}" }, { invoice_no: "INV-1", amount: "Rs. 5.00" })).toEqual({
      ok: true,
      subject: "Bill INV-1",
      body: "A\n\nB Rs. 5.00",
    });
  });

  it("fails on a variable the message has no value for; an empty value is fine", () => {
    expect(renderTemplate({ subject: "{invoice_no}", body: "x" }, {})).toEqual({ ok: false, missing: ["invoice_no"] });
    expect(renderTemplate({ subject: "{priority}New request", body: "x" }, { priority: "" })).toMatchObject({ ok: true, subject: "New request" });
  });

  it("falls back from the owner's text to the built-in one, then to the generic one", () => {
    const vars = { recipient_name: "Nimal", company_name: "Lanka Copiers", title: "New bill", message: "Bill INV-1 is due." };
    // The owner's template needs {invoice_no}; a final invoice written in SQL has no such variable.
    const r = renderEmail("invoice.issued", { subject: "Bill {invoice_no}", body: "{amount}" }, vars);
    expect(r).toEqual({ subject: "New bill", body: "Hello Nimal,\n\nBill INV-1 is due.\n\nLanka Copiers", source: "generic" });
    const full = { ...vars, invoice_no: "INV-1", amount: "Rs. 1.00", machine: "Canon", due_date: "1 Nov 2026" };
    expect(renderEmail("invoice.issued", { subject: "Bill {invoice_no}", body: "{amount}" }, full)).toMatchObject({ subject: "Bill INV-1", source: "template" });
    expect(renderEmail("invoice.issued", null, full)).toMatchObject({ subject: "Your bill INV-1: Rs. 1.00", source: "default" });
    expect(renderEmail("machine.assigned", null, vars).source).toBe("default");
    expect(defaultTemplate("machine.assigned")).toEqual(GENERIC_TEMPLATE);
  });

  it("previews with a sample for every allowed variable", () => {
    const sample = sampleVariables("invoice.issued", { company_name: "Lanka Copiers" });
    expect(Object.keys(sample).sort()).toEqual([...allowedVariables("invoice.issued")].sort());
    expect(renderTemplate(defaultTemplate("invoice.issued"), sample).ok).toBe(true);
    expect(usedVariables("{a} {b} {a}")).toEqual(["a", "b"]);
  });
});
