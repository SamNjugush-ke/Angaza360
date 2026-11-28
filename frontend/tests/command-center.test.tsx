// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AdminOverview } from "@/components/admin/overview";
import { Tenants } from "@/components/admin/tenants";
import { adminPermissions } from "@/lib/admin/admin";
import type { Role } from "@/lib/auth/landing";
import { decideAccess } from "@/lib/nav/access";
import { axeViolations } from "./support/catalog";
import { installAdminServer } from "./support/admin";
import { installConsole } from "./support/console";
import { show } from "./support/mentorship";

// THE COMMAND CENTER (M4.5 W5): the executive overview is the console's landing — its tiles agree
// with the screens they link to (the fake computes the overview from the same rows the detail
// screens list) — the tenant explorer filters by status, plan, county, sector and name, and the
// console's routes are platform staff's alone.

vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the executive overview", () => {
  it("shows the headline ledgers, health and job strips and the activity feed, each linking to its detail", async () => {
    const server = installAdminServer("SUPER_ADMIN");
    installConsole(server);
    show(<AdminOverview permissions={adminPermissions("SUPER_ADMIN")} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Command Center" })).toBeInTheDocument();

    const statuses = await screen.findByRole("list", { name: "Businesses by status" });
    expect(within(statuses).getByRole("link", { name: /Active/ })).toHaveAttribute("href", "/admin/tenants?status=ACTIVE");
    const pipeline = screen.getByRole("list", { name: "Applications by status" });
    expect(within(pipeline).getByRole("link", { name: /Waiting for review/ })).toHaveAttribute("href", "/admin/applications?status=SUBMITTED");
    expect(screen.getByRole("link", { name: "Health board" })).toHaveAttribute("href", "/admin/integrations");
    expect(screen.getByRole("link", { name: "All jobs" })).toHaveAttribute("href", "/admin/jobs");
    expect(screen.getByRole("link", { name: "Audit log" })).toHaveAttribute("href", "/admin/audit");

    const jobs = screen.getByRole("list", { name: "Jobs" });
    expect(within(jobs).getByRole("link", { name: /Reconcile M-Pesa/ })).toHaveTextContent(/failed/);
    expect(within(screen.getByRole("list", { name: "Business integrations" })).getByText(/KRA eTIMS/)).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Recent activity" })).getByText(/suspended a business/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it("reconciles to the detail screens: the business count is the tenant explorer's", async () => {
    const server = installAdminServer("SUPER_ADMIN");
    installConsole(server);
    const { unmount } = show(<AdminOverview permissions={adminPermissions("SUPER_ADMIN")} />);
    const statuses = await screen.findByRole("list", { name: "Businesses by status" });
    const activeOnTile = within(within(statuses).getByRole("link", { name: /Active/ }).closest("li") as HTMLElement).getByText(/^\d+$/).textContent;
    const awaiting = within(screen.getByRole("list", { name: "Applications by status" }).querySelectorAll("li")[0] as HTMLElement).getByText(/^\d+$/).textContent;
    unmount();

    show(<Tenants permissions={adminPermissions("SUPER_ADMIN")} initialStatus="ACTIVE" />);
    expect(await screen.findByText(/Showing/)).toHaveTextContent(`Showing ${String(activeOnTile)} of ${String(activeOnTile)}`);
    expect(Number(awaiting)).toBe(server.applications.filter((a) => a.status === "SUBMITTED").length);
  });
});

describe("the tenant explorer", () => {
  it("filters by county, plan, sector and name, and opens a business's detail page", async () => {
    const server = installAdminServer("PROGRAM_OFFICER");
    installConsole(server);
    const user = userEvent.setup();
    show(<Tenants permissions={adminPermissions("PROGRAM_OFFICER")} />);
    const list = await screen.findByRole("list", { name: "Businesses" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    await user.selectOptions(screen.getByLabelText("County"), "Kiambu");
    expect(within(screen.getByRole("list", { name: "Businesses" })).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText(/Thika Agrovet/)).toBeInTheDocument();
    expect(screen.getByText(/Showing/)).toHaveTextContent("Showing 1 of 2");

    await user.selectOptions(screen.getByLabelText("County"), "");
    await user.type(screen.getByLabelText("Name or subdomain"), "nakuru");
    expect(within(screen.getByRole("list", { name: "Businesses" })).getAllByRole("listitem")).toHaveLength(1);
    await user.selectOptions(screen.getByLabelText("Plan"), "BIASHARA");
    expect(screen.getByText("No businesses match")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Plan"), "MWANZO");
    await user.type(screen.getByLabelText("Sector contains"), "retail");
    await user.click(screen.getByRole("button", { name: /Nakuru Hardware/ }));
    expect(screen.getByRole("link", { name: /Open the business/ })).toHaveAttribute("href", "/admin/tenants/t-1");
  });
});

describe("the console is platform staff's alone", () => {
  const PATHS = ["/admin", "/admin/tenants", "/admin/tenants/t-1", "/admin/applications"];
  it("a business user, a mentor and a cashier reach none of it; platform staff reach all of it", () => {
    for (const role of ["MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "CASHIER", "MENTOR", "COACH"] as Role[]) {
      for (const path of PATHS) expect([role, path, decideAccess(role, path).allowed]).toEqual([role, path, false]);
    }
    for (const role of ["SUPER_ADMIN", "PROGRAM_OFFICER"] as Role[]) {
      for (const path of PATHS) expect([role, path, decideAccess(role, path).allowed]).toEqual([role, path, true]);
    }
  });
});
