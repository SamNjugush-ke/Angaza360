// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import { Greeting, greetingLine } from "@/components/shell/greeting";
import type { ShellContext } from "@/components/shell/types";
import { ToastProvider } from "@/components/toast/toast";
import { failureMessage, SERVER_FAULT, UNREACHABLE } from "@/lib/api/messages";
import { resolveWorkspace } from "@/lib/nav/workspace";
import { chooseLocation, installPosFetch, json, showTill, TILL, type Route } from "./support/pos";

// M4.5 W3, the UX remediation: the greeting addresses the PERSON (first name) with the business as
// context, never the business as the salutation, in every workspace; a failed request never shows
// a bare status code or a server's technical words; and a server fault at "Charge" tells the
// cashier to check before charging again.

vi.mock("next/navigation", () => ({ usePathname: () => "/pos", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  chooseLocation(null);
});

describe("the greeting", () => {
  it("addresses the person by first name, by the Nairobi clock", () => {
    // 05:30 UTC is 08:30 in Nairobi; 12:30 UTC is 15:30; 16:00 UTC is 19:00.
    expect(greetingLine("Wanjiku Kamau", new Date("2026-11-16T05:30:00Z"))).toBe("Good morning, Wanjiku");
    expect(greetingLine("Wanjiku Kamau", new Date("2026-11-16T12:30:00Z"))).toBe("Good afternoon, Wanjiku");
    expect(greetingLine("  ", new Date("2026-11-16T16:00:00Z"))).toBe("Good evening");
  });

  it("in every workspace: the person in the salutation, the business or workspace as context", () => {
    vi.stubGlobal("fetch", async () => json(200, { data: [], count: 0 }));
    const cases: Array<[ShellContext["role"], string]> = [
      ["CASHIER", "Nakuru Hardware"],
      ["MENTOR", "Mentorship"],
      ["SUPER_ADMIN", "Administration"],
    ];
    for (const [role, contextName] of cases) {
      const context: ShellContext = { fullName: "Wanjiku Kamau", email: "w@test.ke", role, workspace: resolveWorkspace(role), contextName };
      render(
        <AppShell context={context}>
          <Greeting />
        </AppShell>,
        { wrapper: ToastProvider },
      );
      const line = within(screen.getByRole("main")).getByText(/Good (morning|afternoon|evening), Wanjiku/);
      expect(line.textContent).not.toContain(`, ${contextName}`);
      expect(line.parentElement).toHaveTextContent(`· ${contextName}`);
      cleanup();
    }
  });
});

describe("failure messages", () => {
  it("never shows a bare status code or a server's technical words", () => {
    expect(failureMessage(500, "Internal Server Error")).toBe(SERVER_FAULT);
    expect(failureMessage(502, null)).toBe(SERVER_FAULT);
    expect(failureMessage(0, null)).toBe(UNREACHABLE);
    expect(failureMessage(404, "Not Found")).toMatch(/could not be found/);
    expect(failureMessage(400, "Request failed (400).")).not.toMatch(/\(400\)/);
    // The backend's own words, written for people, are shown as they are.
    expect(failureMessage(400, "Insufficient stock for NKH-CEM-50 (Bamburi Cement 50kg): requested 9, available 4.")).toMatch(/^Insufficient stock/);
    expect(SERVER_FAULT).toMatch(/may or may not have been saved/);
  });

  it("a server fault at Charge tells the cashier to check the shift's sales before charging again, keeping the cart", async () => {
    chooseLocation(TILL.id);
    const { routes } = installPosFetch();
    (routes as Route[]).push((call) => (call.method === "POST" && call.url.pathname === "/api/v1/pos/sales" ? json(500, { statusCode: 500, error: "Internal Server Error", message: "Internal Server Error" }) : null));
    const user = userEvent.setup();
    showTill("CASHIER");
    await user.type(await screen.findByLabelText("Scan or search products"), "cement");
    await user.click(await screen.findByRole("button", { name: /Bamburi Cement 50kg/ }));
    const pay = await screen.findByRole("button", { name: /Take payment · KES/ });
    await waitFor(() => expect(pay).toBeEnabled());
    await user.click(pay);
    await user.click(await screen.findByRole("button", { name: /^Charge/ }));
    expect(await screen.findByText(/may or may not have gone through\. Open “Sales this shift” to check before charging again/)).toBeInTheDocument();
    expect(screen.queryByText(/Internal Server Error/)).toBeNull();
  });
});

beforeEach(() => {
  document.cookie = "ag_location=; path=/; max-age=0";
});
