// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTECTED_PREFIXES, ROLE_LANDING, type Role } from "@/lib/auth/landing";
import { PATHNAME_HEADER } from "@/lib/auth/names";
import { allNavPaths, navItemsFor } from "@/lib/nav/config";
import { decideAccess, ROUTE_ACCESS, routeAccessFor } from "@/lib/nav/access";

// The guard runs on the server; stand in its request (the proxy's path header) and the session.
const requestHeaders = new Headers();
let sessionRole: Role = "MSME_OWNER";
vi.mock("next/headers", () => ({ headers: async () => requestHeaders }));
vi.mock("@/lib/auth/session", () => ({
  requireSession: async () => ({
    user: { id: "u1", fullName: "Test User", email: "t@example.test", role: sessionRole, isActive: true },
    role: sessionRole,
    tenant: null,
  }),
}));

const { guarded } = await import("@/lib/auth/guard");

const ROLES = Object.keys(ROLE_LANDING) as Role[];

const Page = guarded(() => <h1>The page itself</h1>);

async function visit(role: Role, path: string | null) {
  sessionRole = role;
  requestHeaders.delete(PATHNAME_HEADER);
  if (path !== null) requestHeaders.set(PATHNAME_HEADER, path);
  render((await Page({})) as ReactElement);
}

beforeEach(() => {
  sessionRole = "MSME_OWNER";
});
afterEach(cleanup);

describe("the server-side route guard renders a 403 state, never the page", () => {
  it("refuses CASHIER at /payroll", async () => {
    await visit("CASHIER", "/payroll");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don’t have access to Payroll");
    expect(screen.getByText("403 · Not authorized")).toBeInTheDocument();
    expect(screen.queryByText("The page itself")).toBeNull();
    expect(screen.getByRole("link", { name: "Go to your home" })).toHaveAttribute("href", "/pos");
  });

  it("admits OWNER at /payroll (and a deeper path under it, query ignored)", async () => {
    await visit("MSME_OWNER", "/payroll");
    expect(screen.getByRole("heading", { name: "The page itself" })).toBeInTheDocument();
    cleanup();
    await visit("MSME_OWNER", "/payroll/runs/123?tab=payslips");
    expect(screen.getByRole("heading", { name: "The page itself" })).toBeInTheDocument();
  });

  it("refuses VIEWER_AUDITOR at /people", async () => {
    await visit("VIEWER_AUDITOR", "/people");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don’t have access to People & access");
    expect(screen.queryByText("The page itself")).toBeNull();
  });

  it("blocks workspace crossovers: a merchant in /admin, a mentor in the merchant area", async () => {
    await visit("MSME_OWNER", "/admin/tenants");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don’t have access to Tenants");
    expect(screen.queryByText("The page itself")).toBeNull();
    cleanup();
    await visit("MENTOR", "/dashboard");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don’t have access to Dashboard");
    expect(screen.getByRole("link", { name: "Go to your home" })).toHaveAttribute("href", "/mentorship");
    cleanup();
    await visit("CASHIER", "/admin");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don’t have access to Platform administration");
  });

  it("fails closed when the path is unknown to it", async () => {
    await visit("SUPER_ADMIN", null);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("You don’t have access to this section");
    cleanup();
    await visit("SUPER_ADMIN", "/not-a-section");
    expect(screen.queryByText("The page itself")).toBeNull();
  });
});

describe("decideAccess", () => {
  const allowed = (role: Role, path: string) => decideAccess(role, path).allowed;

  it("decides the named pairs", () => {
    expect(allowed("CASHIER", "/payroll")).toBe(false);
    expect(allowed("MSME_OWNER", "/payroll")).toBe(true);
    expect(allowed("VIEWER_AUDITOR", "/people")).toBe(false);
    expect(allowed("MSME_OWNER", "/admin/tenants")).toBe(false);
    expect(allowed("MENTOR", "/dashboard")).toBe(false);
  });

  it("blocks every crossover between the three workspaces", () => {
    expect(allowed("MSME_MANAGER", "/mentorship/mentees")).toBe(false);
    expect(allowed("CASHIER", "/mentorship")).toBe(false);
    expect(allowed("COACH", "/pos")).toBe(false);
    expect(allowed("MENTOR", "/admin/applications")).toBe(false);
    expect(allowed("SUPER_ADMIN", "/dashboard")).toBe(false);
    expect(allowed("PROGRAM_OFFICER", "/mentorship")).toBe(false);
    // /mentorship is shared: the owner's (merchant nav) and the mentors' (their own).
    expect(allowed("MSME_OWNER", "/mentorship")).toBe(true);
    expect(allowed("MENTOR", "/mentorship")).toBe(true);
    // The longest entry governs: Users is SUPER_ADMIN's alone.
    expect(allowed("PROGRAM_OFFICER", "/admin/users")).toBe(false);
    expect(allowed("SUPER_ADMIN", "/admin/users")).toBe(true);
  });

  it("does not match a path that merely shares a prefix", () => {
    expect(routeAccessFor("/payrollx")).toBeNull();
    expect(allowed("MSME_OWNER", "/payrollx")).toBe(false);
  });
});

describe("one source: the guard is derived from the nav config", () => {
  it("covers every protected prefix", () => {
    for (const prefix of PROTECTED_PREFIXES) expect(routeAccessFor(prefix)?.path).toBe(prefix);
  });

  it("admits a role exactly where its nav shows it, and at its landing", () => {
    for (const role of ROLES) {
      const shown = new Set(navItemsFor(role).map((item) => item.path));
      for (const path of allNavPaths()) expect([role, path, allowed(role, path)]).toEqual([role, path, shown.has(path)]);
      expect([role, decideAccess(role, ROLE_LANDING[role]).allowed]).toEqual([role, true]);
    }
    function allowed(role: Role, path: string) {
      return decideAccess(role, path).allowed;
    }
  });

  it("has no entry that admits nobody", () => {
    for (const entry of ROUTE_ACCESS) expect([entry.path, entry.roles.length > 0]).toEqual([entry.path, true]);
  });
});

describe("every page in the authenticated area is guarded", () => {
  // jsdom gives import.meta.url an http scheme, so resolve from the project root (vitest cwd).
  const appDir = join(process.cwd(), "app", "(app)");
  const pages: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") pages.push(full);
    }
  })(appDir);

  it("finds the pages", () => {
    expect(pages.length).toBeGreaterThanOrEqual(24);
  });

  it.each(pages.map((p) => [relative(appDir, p).split(sep).join("/")] as const))("%s exports guarded(...) under a covered path", (page) => {
    const source = readFileSync(join(appDir, page), "utf8");
    expect(source).toMatch(/^export default guarded\(\w+\);$/m);
    const route = `/${page.replace(/\/?page\.tsx$/, "")}`;
    expect(routeAccessFor(route)).not.toBeNull();
  });
});
