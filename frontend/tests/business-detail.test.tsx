// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BusinessDetail } from "@/components/admin/business-detail";
import { adminPermissions } from "@/lib/admin/admin";
import { axeViolations } from "./support/catalog";
import { installAdminServer, type AdminServer } from "./support/admin";
import { installConsole, type ConsoleState } from "./support/console";
import { show } from "./support/mentorship";

// THE BUSINESS DETAIL & ACT-AS (M4.5 W5, standing god-mode): the platform's record of one business —
// profile, integration HEALTH (never a credential), users, the lifecycle (each step confirmed;
// deactivation final and armed only by typing the business's name) — and the one way into its
// records: ACT AS IT. A SUPER_ADMIN enters the business's workspace (there is no grant, scope,
// expiry or approval); a programme officer cannot. There is no revoke surface here any more.

const pushMock = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/tenants/t-1", useRouter: () => ({ push: pushMock, replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

beforeEach(() => {
  pushMock.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const writes = (server: AdminServer) => server.calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.url.pathname.replace(/^\/api\/v1/, "")}`);

function setup(role: "SUPER_ADMIN" | "PROGRAM_OFFICER", tenantId = "t-1"): { server: AdminServer; state: ConsoleState } {
  const server = installAdminServer(role);
  const state = installConsole(server);
  show(<BusinessDetail tenantId={tenantId} permissions={adminPermissions(role)} />);
  return { server, state };
}

describe("the business detail", () => {
  it("shows the registry profile, integration health and users — no credential anywhere", async () => {
    setup("SUPER_ADMIN", "t-2");
    expect(await screen.findByRole("heading", { level: 1, name: "Thika Agrovet" })).toBeInTheDocument();
    expect(screen.getByText("Kiambu")).toBeInTheDocument();
    const health = await screen.findByRole("list", { name: "Integration health" });
    expect(within(health).getByText("KRA eTIMS")).toBeInTheDocument();
    expect(within(health).getByText("failing")).toBeInTheDocument();
    expect(within(health).getByText("KRA refused the device serial.")).toBeInTheDocument();
    expect(screen.queryByText(/consumer key|passkey|go live|activate credential/i)).not.toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it("lists the business's users from the platform directory", async () => {
    setup("PROGRAM_OFFICER");
    const table = await screen.findByRole("table", { name: /People who can sign in to Nakuru Hardware/ });
    expect(within(table).getByText("Akinyi Cashier")).toBeInTheDocument();
  });

  it("suspends only after confirming, and arms the FINAL deactivation only when the name is typed", async () => {
    const { server } = setup("PROGRAM_OFFICER");
    const user = userEvent.setup();
    await screen.findByRole("heading", { level: 1, name: "Nakuru Hardware" });
    expect(screen.getByText(/Deactivating is final/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Suspend" }));
    expect(writes(server)).toEqual([]);
    await user.click(within(screen.getByRole("alertdialog", { name: "Suspend Nakuru Hardware?" })).getByRole("button", { name: "Yes, suspend" }));
    expect(await screen.findByText("Nakuru Hardware is now suspended.")).toBeInTheDocument();
    expect(writes(server)).toEqual(["POST /tenants/t-1/suspend"]);

    await user.click(await screen.findByRole("button", { name: "Deactivate" }));
    const ask = screen.getByRole("alertdialog", { name: "Deactivate Nakuru Hardware for good?" });
    const yes = within(ask).getByRole("button", { name: /Working|Yes, deactivate permanently/ });
    expect(yes).toBeDisabled();
    await user.type(within(ask).getByLabelText(/Type the business’s name/), "Nakuru Hardware");
    await waitFor(() => expect(within(ask).getByRole("button", { name: "Yes, deactivate permanently" })).toBeEnabled());
    await user.click(within(ask).getByRole("button", { name: "Yes, deactivate permanently" }));
    expect(await screen.findByText("Nakuru Hardware is now deactivated.")).toBeInTheDocument();
    expect(writes(server)).toEqual(["POST /tenants/t-1/suspend", "POST /tenants/t-1/deactivate"]);
  });
});

describe("act as a business (standing god-mode)", () => {
  it("a super-admin enters the business's workspace — no grant, no scope, no approval", async () => {
    const { state } = setup("SUPER_ADMIN");
    const user = userEvent.setup();
    const panel = await screen.findByRole("region", { name: "Act as this business" });
    // Transparent: it says every action is logged where the owners can see it.
    expect(within(panel).getByText(/recorded in this business’s activity log/i)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Act as this business" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Act as Nakuru Hardware?" })).getByRole("button", { name: "Enter the workspace" }));
    await waitFor(() => expect(state.actedAs).toBe("t-1"));
    expect(pushMock).toHaveBeenCalledWith("/dashboard");
  });

  it("a programme officer cannot act as a business — there is no grant/approval surface left", async () => {
    setup("PROGRAM_OFFICER");
    const panel = await screen.findByRole("region", { name: "Act as this business" });
    expect(within(panel).getByText(/Only a super-administrator can enter a business’s workspace/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: "Act as this business" })).not.toBeInTheDocument();
    // No grant, revoke, scope or expiry anywhere on the page.
    expect(screen.queryByText(/grant|revoke|VIEW only|expires/i)).not.toBeInTheDocument();
  });
});
