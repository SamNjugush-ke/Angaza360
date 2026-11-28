import { describe, expect, it } from "vitest";
import { isProtectedPath, landingFor, ROLE_LANDING, safeReturnTo } from "@/lib/auth/landing";

describe("ROLE_LANDING", () => {
  it("sends each role to its workspace", () => {
    expect(ROLE_LANDING).toEqual({
      MSME_OWNER: "/dashboard",
      MSME_MANAGER: "/dashboard",
      ACCOUNTANT: "/dashboard",
      VIEWER_AUDITOR: "/dashboard",
      CASHIER: "/pos",
      WAREHOUSE_STAFF: "/inventory",
      HR_OFFICER: "/payroll",
      MENTOR: "/mentorship",
      COACH: "/mentorship",
      SUPER_ADMIN: "/admin",
      PROGRAM_OFFICER: "/admin",
    });
  });

  it("lands every role on a protected path", () => {
    for (const path of Object.values(ROLE_LANDING)) expect(isProtectedPath(path)).toBe(true);
  });
});

describe("isProtectedPath", () => {
  it("covers the prefixes and their subpaths, nothing else", () => {
    expect(isProtectedPath("/dashboard")).toBe(true);
    expect(isProtectedPath("/pos/shift/12")).toBe(true);
    expect(isProtectedPath("/admin/tenants")).toBe(true);
    expect(isProtectedPath("/dashboards")).toBe(false);
    expect(isProtectedPath("/login")).toBe(false);
    expect(isProtectedPath("/")).toBe(false);
    expect(isProtectedPath("/api/v1/dashboard")).toBe(false);
  });
});

describe("safeReturnTo", () => {
  it("keeps a protected same-site path with its query", () => {
    expect(safeReturnTo("/pos")).toBe("/pos");
    expect(safeReturnTo("/inventory/products?page=2")).toBe("/inventory/products?page=2");
  });

  it.each([
    null,
    "",
    "https://evil.example/dashboard",
    "//evil.example/dashboard",
    "/\\evil.example",
    "javascript:alert(1)",
    "dashboard",
    "/login",
    "/api/v1/dashboard",
    "/",
    "/%2F%2Fevil.example",
  ])("refuses %j", (value) => {
    expect(safeReturnTo(value)).toBeNull();
  });

  it("is what landingFor prefers over the role default", () => {
    expect(landingFor("CASHIER", "/inventory")).toBe("/inventory");
    expect(landingFor("CASHIER", "https://evil.example")).toBe("/pos");
    expect(landingFor("MENTOR")).toBe("/mentorship");
  });
});
