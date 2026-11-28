// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/toast/toast";
import type { ShellContext } from "@/components/shell/types";
import type { Role } from "@/lib/auth/landing";
import { resolveWorkspace } from "@/lib/nav/workspace";

let pathname = "/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

// The shell loads locations through the BFF; answer with one location unless a test says otherwise.
beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: [], count: 0 }), { status: 200 }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const toolbar = () => within(screen.getByRole("banner", { name: "Toolbar" }));

function shell(role: Role, at: string, contextName = "Nakuru Hardware") {
  pathname = at;
  const context: ShellContext = {
    fullName: "Wanjiku Kamau",
    email: "wanjiku@nakuru-hardware.co.ke",
    role,
    workspace: resolveWorkspace(role),
    contextName,
  };
  return render(
    <AppShell context={context}>
      <h1>Page body</h1>
    </AppShell>,
    { wrapper: ToastProvider }, // the root layout's, in the app
  );
}

const sidebarLinks = () =>
  within(screen.getByRole("navigation", { name: "Main" }))
    .getAllByRole("link")
    .map((link) => link.textContent);

describe("AppShell", () => {
  it("shows the business, the role and the role's grouped nav", () => {
    shell("MSME_OWNER", "/dashboard");
    const sidebar = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(sidebar).getByText("Nakuru Hardware")).toBeInTheDocument();
    expect(within(sidebar).getByText("Owner")).toBeInTheDocument();
    expect(within(sidebar).getByRole("img", { name: "Angaza360" })).toHaveAttribute("src", "/brand/angaza360-logo-white.svg");
    expect(sidebarLinks()).toHaveLength(15);
    for (const heading of ["Overview", "Sell", "Catalog & stock", "Money", "Compliance"]) {
      expect(within(sidebar).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { level: 1, name: "Page body" })).toBeInTheDocument();
  });

  it("marks the active item with aria-current, including on a subpath", () => {
    shell("MSME_OWNER", "/payroll/runs/7");
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Payroll" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
  });

  it("filters the nav for a CASHIER and offers New sale", () => {
    shell("CASHIER", "/pos");
    expect(sidebarLinks()).toEqual(["Point of Sale", "Sales & receipts", "Products & services", "Customers & receivables", "Reports & exports"]);
    expect(toolbar().getByRole("link", { name: "New sale" })).toHaveAttribute("href", "/pos");
  });

  it("offers no New sale to a role without the till", () => {
    shell("HR_OFFICER", "/payroll");
    expect(sidebarLinks()).toEqual(["Payroll", "Reports & exports"]);
    expect(screen.queryAllByRole("link", { name: "New sale" })).toEqual([]);
  });

  it("uses the mentorship nav set for a mentor", () => {
    shell("MENTOR", "/mentorship/sessions", "Mentorship");
    expect(sidebarLinks()).toEqual(["My engagements", "Mentees", "Action items", "Sessions", "Cohort"]);
    const nav = within(screen.getByRole("navigation", { name: "Main" }));
    expect(nav.getByRole("link", { name: "Sessions" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryAllByRole("link", { name: "New sale" })).toEqual([]);
  });

  it("uses the admin nav set for a programme officer", () => {
    shell("PROGRAM_OFFICER", "/admin/tenants", "Platform administration");
    expect(sidebarLinks()).toEqual(["Overview", "Applications", "Tenants", "Donor projects", "Integrations", "Jobs", "Reports", "Audit"]);
  });

  it("shows no search control until a search exists (M4.5 W3), and no notification badge", () => {
    shell("MSME_OWNER", "/dashboard");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.queryByText(/notification/i)).toBeNull();
  });

  it("names the account button by what it shows: the initials are a painted avatar, not text (label in name)", () => {
    shell("MSME_OWNER", "/dashboard");
    const button = toolbar().getByRole("button", { name: "Account: Wanjiku Kamau" });
    expect(button.textContent).toBe("Wanjiku Kamau");
    expect(button.querySelector("[data-initials]")?.getAttribute("data-initials")).toBe("WK");
  });

  it("opens the user menu with the name, email and Sign out; Esc closes it and returns focus", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.fn(async (url: string) =>
      url === "/api/auth/logout" ? new Response(null, { status: 204 }) : new Response(JSON.stringify({ data: [], count: 0 }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    document.cookie = "ag_csrf=csrf-from-cookie";
    shell("MSME_OWNER", "/dashboard");

    const trigger = toolbar().getByRole("button", { name: "Account: Wanjiku Kamau" });
    await user.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("wanjiku@nakuru-hardware.co.ke")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST", headers: { "x-csrf-token": "csrf-from-cookie" } }),
    );

    cleanup();
    shell("MSME_OWNER", "/dashboard");
    const again = toolbar().getByRole("button", { name: "Account: Wanjiku Kamau" });
    await user.click(again);
    await user.keyboard("{Escape}");
    expect(again).toHaveAttribute("aria-expanded", "false");
    expect(again).toHaveFocus();
  });
});
