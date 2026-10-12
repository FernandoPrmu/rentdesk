import { describe, expect, it } from "vitest";

import { isActive, MORE, moreActive } from "./portal-nav";

describe("phone navigation (task 11)", () => {
  it("More holds every other owner and admin section", () => {
    expect(MORE.owner.map((i) => i.label)).toEqual(["Machines", "Invoices", "Payments", "Outstanding", "Approvals", "Reports", "Notifications", "Settings"]);
    expect(MORE.admin.map((i) => i.label)).toContain("Audit log");
    expect(MORE.customer).toEqual([]);
  });

  it("the More tab is highlighted on its sections only", () => {
    expect(moreActive("owner", "/owner/reports/income")).toBe(true);
    expect(moreActive("owner", "/owner/settings/reminders")).toBe(true);
    expect(moreActive("owner", "/owner/tickets")).toBe(false);
    expect(moreActive("owner", "/owner")).toBe(false);
    expect(moreActive("admin", "/admin/audit/12")).toBe(true);
    expect(moreActive("admin", "/admin/owners/1/support")).toBe(false);
    expect(moreActive("owner", null)).toBe(false);
  });

  it("home is exact; sections include their pages", () => {
    expect(isActive("/owner/tickets", { href: "/owner", exact: true })).toBe(false);
    expect(isActive("/owner/reports/usage", { href: "/owner/reports" })).toBe(true);
    expect(isActive("/owner/reportsx", { href: "/owner/reports" })).toBe(false);
  });
});
