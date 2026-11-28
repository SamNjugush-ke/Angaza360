// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { ToastProvider } from "@/components/toast/toast";
import type { ShellContext } from "@/components/shell/types";
import type { Role } from "@/lib/auth/landing";
import { bottomBarFor } from "@/lib/nav/config";
import { resolveWorkspace } from "@/lib/nav/workspace";

let pathname = "/dashboard";
vi.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const LOCATIONS = [
  { id: "loc-main", name: "Main store", code: "MAIN", type: "MAIN", isDefault: true, isActive: true },
  { id: "loc-till", name: "Till 1", code: "TILL1", type: "POS", isDefault: false, isActive: true },
];

let locationCalls: string[];
let answer: () => Promise<Response> | Response;

beforeEach(() => {
  locationCalls = [];
  answer = () => new Response(JSON.stringify({ data: LOCATIONS, count: 2 }), { status: 200 });
  document.cookie = "ag_location=; path=/; max-age=0";
  vi.stubGlobal("fetch", async (url: string) => {
    locationCalls.push(url);
    return answer();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function shell(role: Role, at = "/dashboard") {
  pathname = at;
  const context: ShellContext = {
    fullName: "Wanjiku Kamau",
    email: "wanjiku@nakuru-hardware.co.ke",
    role,
    workspace: resolveWorkspace(role),
    contextName: "Nakuru Hardware",
  };
  return render(
    <AppShell context={context}>
      <h1>Body</h1>
    </AppShell>,
    { wrapper: ToastProvider }, // the root layout's, in the app
  );
}

const toolbar = () => within(screen.getByRole("banner", { name: "Toolbar" }));
const businessBar = () => within(screen.getByRole("banner", { name: "Business bar" }));
const bottomBarLabels = () =>
  within(screen.getByRole("navigation", { name: "Primary" }))
    .getAllByRole("listitem")
    .map((li) => li.textContent);

describe("the location selector", () => {
  it("loads this business's active locations through the BFF and selects the default", async () => {
    shell("MSME_OWNER");
    const select = await toolbar().findByRole("combobox", { name: "Location" });
    expect(select).toHaveValue("loc-main");
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Main store", "Till 1"]);
    expect(locationCalls).toEqual(["/api/v1/locations?activeOnly=true"]); // once, for both bars
    expect(businessBar().getByRole("combobox", { name: "Location" })).toHaveValue("loc-main");
  });

  it("persists a change in the readable ag_location cookie, and both bars follow it", async () => {
    const user = userEvent.setup();
    shell("MSME_OWNER");
    const select = await toolbar().findByRole("combobox", { name: "Location" });
    await user.selectOptions(select, "loc-till");
    expect(document.cookie).toContain("ag_location=loc-till");
    expect(businessBar().getByRole("combobox", { name: "Location" })).toHaveValue("loc-till");
  });

  it("restores a saved location, and ignores an id that is not one of this business's", async () => {
    document.cookie = "ag_location=loc-till; path=/";
    shell("MSME_MANAGER", "/pos");
    expect(await toolbar().findByRole("combobox", { name: "Location" })).toHaveValue("loc-till");

    cleanup();
    document.cookie = "ag_location=another-business-location; path=/";
    shell("MSME_MANAGER", "/pos");
    expect(await toolbar().findByRole("combobox", { name: "Location" })).toHaveValue("loc-main");
  });

  it("a cashier gets their assigned till as context, never a selector (M4.5 W3)", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      locationCalls.push(url);
      return url === "/api/v1/pos/my-location"
        ? new Response(JSON.stringify({ restricted: true, location: { id: "loc-till", code: "TILL1", name: "Till 1", type: "POS" }, lowStock: [], myRequests: [] }), { status: 200 })
        : new Response(JSON.stringify({ data: LOCATIONS, count: 2 }), { status: 200 });
    });
    shell("CASHIER", "/pos");
    expect(await toolbar().findByText("Till 1", { exact: false })).toHaveTextContent("Your till: Till 1");
    expect(toolbar().queryByRole("combobox", { name: "Location" })).toBeNull();
    expect(businessBar().queryByRole("combobox", { name: "Location" })).toBeNull();
    expect(locationCalls).toContain("/api/v1/pos/my-location");
  });

  it("shows a loading state while the locations load", async () => {
    let release: (r: Response) => void = () => undefined;
    answer = () => new Promise<Response>((resolve) => (release = resolve));
    shell("MSME_OWNER");
    expect(toolbar().getByRole("status")).toHaveTextContent("Loading locations");
    expect(toolbar().getByRole("status")).toHaveAttribute("aria-busy", "true");
    await act(async () => release(new Response(JSON.stringify({ data: LOCATIONS, count: 2 }), { status: 200 })));
    expect(await toolbar().findByRole("combobox", { name: "Location" })).toBeInTheDocument();
  });

  it("shows an empty state when the business has no locations", async () => {
    answer = () => new Response(JSON.stringify({ data: [], count: 0 }), { status: 200 });
    shell("MSME_OWNER");
    expect(await toolbar().findByText("No locations yet")).toBeInTheDocument();
    expect(toolbar().queryByRole("combobox")).toBeNull();
  });

  it("shows an error with a retry that recovers", async () => {
    const user = userEvent.setup();
    answer = () => new Response("{}", { status: 500 });
    shell("MSME_OWNER");
    const alert = await toolbar().findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load locations");
    answer = () => new Response(JSON.stringify({ data: LOCATIONS, count: 2 }), { status: 200 });
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await toolbar().findByRole("combobox", { name: "Location" })).toHaveValue("loc-main");
  });

  it("is absent — and nothing is fetched — for a role the backend refuses locations (HR officer)", async () => {
    shell("HR_OFFICER", "/payroll");
    await waitFor(() => expect(screen.getByRole("heading", { name: "Body" })).toBeInTheDocument());
    expect(screen.queryByRole("combobox", { name: "Location" })).toBeNull();
    expect(locationCalls).toEqual([]);
  });
});

describe("the mobile bottom bar", () => {
  it("is composed per role", () => {
    const labels = (role: Role) => bottomBarFor(role).destinations.map((d) => d.label);
    expect(labels("MSME_OWNER")).toEqual(["Dashboard", "Sales & receipts", "Products & services"]);
    expect(labels("CASHIER")).toEqual(["Sales & receipts", "Products & services", "Customers & receivables"]);
    expect(labels("HR_OFFICER")).toEqual(["Payroll", "Reports & exports"]);
    expect(labels("ACCOUNTANT")).toEqual(["Dashboard", "Sales & receipts", "Inventory & locations", "Procurement"]);
    expect(labels("MENTOR")).toEqual(["My engagements", "Mentees", "Action items", "Sessions"]);
    expect(bottomBarFor("CASHIER").newSale).toBe(true);
    expect(bottomBarFor("ACCOUNTANT").newSale).toBe(false);
  });

  it("renders the role's destinations with New sale in the centre where the till applies", () => {
    shell("MSME_OWNER");
    expect(bottomBarLabels()).toEqual(["Dashboard", "Sales & receipts", "New sale", "Products & services", "More"]);
    cleanup();
    shell("CASHIER", "/sales");
    expect(bottomBarLabels()).toEqual(["Sales & receipts", "Products & services", "New sale", "Customers & receivables", "More"]);
    const primary = within(screen.getByRole("navigation", { name: "Primary" }));
    expect(primary.getByRole("link", { name: "Sales & receipts" })).toHaveAttribute("aria-current", "page");
    cleanup();
    shell("HR_OFFICER", "/payroll");
    expect(bottomBarLabels()).toEqual(["Payroll", "Reports & exports", "More"]);
  });
});

describe("the More sheet", () => {
  it("opens a labelled modal dialog with the full grouped nav, traps focus, and Esc returns focus", async () => {
    const user = userEvent.setup();
    shell("MSME_OWNER", "/expenses");
    const more = within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "More" });
    await user.click(more);

    const dialog = screen.getByRole("dialog", { name: "All sections" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(more).toHaveAttribute("aria-expanded", "true");
    for (const heading of ["Overview", "Sell", "Catalog & stock", "Money", "Compliance"]) {
      expect(within(dialog).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(dialog).getAllByRole("link")).toHaveLength(15);
    expect(within(dialog).getByRole("link", { name: "Expenses & payables" })).toHaveAttribute("aria-current", "page");

    // Focus starts inside and cannot leave it.
    const close = within(dialog).getByRole("button", { name: "Close" });
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(within(dialog).getByRole("link", { name: "Mentorship" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(more).toHaveFocus();
  });

  it("closes when a destination is chosen", async () => {
    const user = userEvent.setup();
    shell("CASHIER", "/pos");
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "More" }));
    const dialog = screen.getByRole("dialog", { name: "All sections" });
    expect(within(dialog).getAllByRole("link").map((l) => l.textContent)).toEqual([
      "Point of Sale",
      "Sales & receipts",
      "Products & services",
      "Customers & receivables",
      "Reports & exports",
    ]);
    await user.click(within(dialog).getByRole("link", { name: "Customers & receivables" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the mobile business bar", () => {
  it("is recomposed: business, location chip and profile — no search control until one exists", async () => {
    shell("MSME_OWNER");
    const bar = businessBar();
    expect(bar.getByText("Nakuru Hardware")).toBeInTheDocument();
    expect(await bar.findByRole("combobox", { name: "Location" })).toBeInTheDocument();
    expect(bar.queryByRole("button", { name: /search/i })).toBeNull();
    expect(bar.getByRole("button", { name: "Account: Wanjiku Kamau" })).toBeInTheDocument();
  });
});
