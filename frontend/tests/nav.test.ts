import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isProtectedPath, ROLE_LANDING, type Role } from "@/lib/auth/landing";
import { activeNavPath, allNavPaths, canSell, navFor, navItemsFor } from "@/lib/nav/config";
import { resolveWorkspace } from "@/lib/nav/workspace";

const labels = (role: Role) => navItemsFor(role).map((item) => item.label);

const ALL_MERCHANT = [
  "Dashboard",
  "Point of Sale",
  "Sales & receipts",
  "Products & services",
  "Inventory & locations",
  "Procurement",
  "Customers & receivables",
  "Expenses & payables",
  "Accounting & reports",
  "Payroll",
  "KRA eTIMS & tax",
  "Reports & exports",
  "People & access",
  "Business setup",
  "Mentorship",
];

describe("resolveWorkspace", () => {
  it("maps every role to its workspace", () => {
    const merchant: Role[] = ["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER", "HR_OFFICER", "WAREHOUSE_STAFF", "VIEWER_AUDITOR"];
    for (const role of merchant) expect(resolveWorkspace(role)).toBe("merchant");
    expect(resolveWorkspace("MENTOR")).toBe("mentorship");
    expect(resolveWorkspace("COACH")).toBe("mentorship");
    expect(resolveWorkspace("SUPER_ADMIN")).toBe("admin");
    expect(resolveWorkspace("PROGRAM_OFFICER")).toBe("admin");
  });
});

describe("the nav is filtered by role, mirroring the backend", () => {
  it("OWNER sees the full merchant nav", () => {
    expect(labels("MSME_OWNER")).toEqual(ALL_MERCHANT);
  });

  it("MANAGER sees all but People & access and Mentorship (both OWNER-only)", () => {
    expect(labels("MSME_MANAGER")).toEqual(ALL_MERCHANT.filter((l) => l !== "People & access" && l !== "Mentorship"));
  });

  it("CASHIER sees only the till's world", () => {
    expect(labels("CASHIER")).toEqual(["Point of Sale", "Sales & receipts", "Products & services", "Customers & receivables", "Reports & exports"]);
  });

  it("HR_OFFICER sees Payroll (and their own reports)", () => {
    expect(labels("HR_OFFICER")).toEqual(["Payroll", "Reports & exports"]);
  });

  it("WAREHOUSE_STAFF sees catalog and stock", () => {
    expect(labels("WAREHOUSE_STAFF")).toEqual(["Products & services", "Inventory & locations", "Procurement", "Reports & exports"]);
  });

  it("ACCOUNTANT sees the books, and not Products (every /v1/products route refuses it)", () => {
    expect(labels("ACCOUNTANT")).toEqual([
      "Dashboard",
      "Sales & receipts",
      "Inventory & locations",
      "Procurement",
      "Customers & receivables",
      "Expenses & payables",
      "Accounting & reports",
      "Payroll",
      "KRA eTIMS & tax",
      "Reports & exports",
    ]);
  });

  it("VIEWER_AUDITOR sees the read set — no till, no setup, no people", () => {
    expect(labels("VIEWER_AUDITOR")).toEqual([
      "Dashboard",
      "Sales & receipts",
      "Products & services",
      "Inventory & locations",
      "Procurement",
      "Customers & receivables",
      "Expenses & payables",
      "Accounting & reports",
      "Payroll",
      "KRA eTIMS & tax",
      "Reports & exports",
    ]);
  });

  it("MENTOR and COACH get the mentorship nav", () => {
    const mentorship = ["My engagements", "Mentees", "Action items", "Sessions", "Cohort"];
    expect(labels("MENTOR")).toEqual(mentorship);
    expect(labels("COACH")).toEqual(mentorship);
  });

  it("SUPER_ADMIN gets the admin nav; PROGRAM_OFFICER all but Users", () => {
    // The Command Center (M4.5 W5): the overview first, then businesses, programmes, operations, governance.
    expect(labels("SUPER_ADMIN")).toEqual(["Overview", "Applications", "Tenants", "Donor projects", "Integrations", "Jobs", "Reports", "Users", "Audit"]);
    expect(labels("PROGRAM_OFFICER")).toEqual(["Overview", "Applications", "Tenants", "Donor projects", "Integrations", "Jobs", "Reports", "Audit"]);
  });

  it("keeps the groups, and drops a group the role has nothing in", () => {
    expect(navFor("MSME_OWNER").map((g) => g.id)).toEqual(["overview", "sell", "catalog", "money", "compliance", "foot"]);
    expect(navFor("HR_OFFICER").map((g) => g.id)).toEqual(["money", "foot"]);
    expect(navFor("CASHIER").map((g) => g.id)).toEqual(["sell", "catalog", "money", "foot"]);
  });

  it("offers New sale only where the till is reachable", () => {
    expect(canSell("MSME_OWNER")).toBe(true);
    expect(canSell("MSME_MANAGER")).toBe(true);
    expect(canSell("CASHIER")).toBe(true);
    for (const role of ["ACCOUNTANT", "HR_OFFICER", "WAREHOUSE_STAFF", "VIEWER_AUDITOR", "MENTOR", "SUPER_ADMIN"] as const) {
      expect(canSell(role)).toBe(false);
    }
  });
});

describe("activeNavPath", () => {
  const mentor = navItemsFor("MENTOR");
  it("picks the longest matching item", () => {
    expect(activeNavPath("/mentorship", mentor)).toBe("/mentorship");
    expect(activeNavPath("/mentorship/sessions/42", mentor)).toBe("/mentorship/sessions");
    expect(activeNavPath("/mentorship-x", mentor)).toBeNull();
    expect(activeNavPath("/pos", navItemsFor("CASHIER"))).toBe("/pos");
  });
});

describe("routing coverage", () => {
  it("protects every nav path", () => {
    for (const path of allNavPaths()) expect(isProtectedPath(path), path).toBe(true);
  });

  it("has a page for every nav path and every landing", () => {
    const root = fileURLToPath(new URL("../app/(app)/", import.meta.url));
    for (const path of [...allNavPaths(), ...Object.values(ROLE_LANDING)]) {
      expect(existsSync(`${root}${path.slice(1)}/page.tsx`), path).toBe(true);
    }
  });

  it("lands each merchant and mentorship role on an item of its own nav", () => {
    for (const role of Object.keys(ROLE_LANDING) as Role[]) {
      if (resolveWorkspace(role) === "admin") continue; // admins land on the /admin overview
      expect(navItemsFor(role).map((i) => i.path), role).toContain(ROLE_LANDING[role]);
    }
  });
});
