// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axeViolations } from "./support/catalog";
import { posted, refusal } from "./support/money";
import { installPeopleServer, showPeople, type PeopleServer } from "./support/people";

// People & access (Wave 5 part A): the staff list with role changes and deactivation, each behind
// a confirmation and refused in the server's words (the last active owner); the owner's own row,
// which is never changed from here; invitations — sent by email/SMS with the code never shown,
// the invite page's address to share, revocable while this screen is open; and the audit log.

vi.mock("next/navigation", () => ({ usePathname: () => "/people", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: PeopleServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
const tab = async (user: User, name: string) => user.click(await screen.findByRole("tab", { name }));
const row = async (name: string) => screen.findByRole("listitem", { name });

describe("the staff list", () => {
  it("lists everyone with their role and state, and leaves the owner's own row alone", async () => {
    server = installPeopleServer();
    showPeople();
    const list = await screen.findByRole("list", { name: "Staff" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(4);
    const auditor = await row("Mwangi Auditor");
    expect(within(auditor).getByText("Viewer / auditor")).toBeInTheDocument();
    expect(within(auditor).getByText("Deactivated")).toBeInTheDocument();
    expect(within(auditor).getByText("Has not signed in yet")).toBeInTheDocument();
    expect(within(auditor).getByRole("button", { name: "Reactivate" })).toBeInTheDocument();

    const self = await row("Wanjiru Owner");
    expect(within(self).getByText("(you)")).toBeInTheDocument();
    expect(within(self).queryByRole("button")).not.toBeInTheDocument();
    expect(within(self).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(self).getByText(/can’t change your own role or deactivate yourself/)).toBeInTheDocument();
    expect(await axeViolations()).toEqual([]);
  });

  it("offers exactly the tenant roles, and changes a role after confirming", async () => {
    server = installPeopleServer();
    const user = userEvent.setup();
    showPeople();
    const cashier = await row("Akinyi Cashier");
    const select = within(cashier).getByLabelText("New role for Akinyi Cashier");
    const options = within(select).getAllByRole("option").map((o) => o.getAttribute("value"));
    expect(options).toEqual(["", "MSME_OWNER", "MSME_MANAGER", "ACCOUNTANT", "HR_OFFICER", "WAREHOUSE_STAFF", "VIEWER_AUDITOR"]);
    expect(within(cashier).getByRole("button", { name: "Change role" })).toBeDisabled();

    await user.selectOptions(select, "MSME_MANAGER");
    await user.click(within(cashier).getByRole("button", { name: "Change role" }));
    const ask = within(cashier).getByRole("alertdialog", { name: "Change Akinyi Cashier’s role from Cashier to Manager?" });
    expect(ask).toHaveTextContent("signed out everywhere");
    await user.click(within(ask).getByRole("button", { name: "Yes, change the role" }));
    expect(await screen.findByText(/Akinyi Cashier is now Manager/)).toBeInTheDocument();
    expect(posted(server, "/users/u-cash/role", "PATCH")).toEqual([{ role: "MSME_MANAGER" }]);
    await waitFor(() => expect(within(screen.getByRole("listitem", { name: "Akinyi Cashier" })).getByText("Manager")).toBeInTheDocument());
  });

  it("deactivates and reactivates, and shows the server's refusal without losing the dialog", async () => {
    server = installPeopleServer();
    const user = userEvent.setup();
    showPeople();
    server.routes.push((call) => (call.url.pathname === "/api/v1/users/u-mgr/deactivate" && server.calls.filter((c) => c.url.pathname === call.url.pathname).length === 1 ? refusal(409, "A business must keep at least one active owner.") : null));

    const manager = await row("Otieno Manager");
    await user.click(within(manager).getByRole("button", { name: "Deactivate" }));
    const ask = within(manager).getByRole("alertdialog", { name: "Deactivate Otieno Manager?" });
    await user.click(within(ask).getByRole("button", { name: "Yes, deactivate" }));
    expect(await within(ask).findByRole("alert")).toHaveTextContent("A business must keep at least one active owner.");
    // Still asking, so it can be tried again or backed out of.
    await user.click(within(ask).getByRole("button", { name: "Yes, deactivate" }));
    expect(await screen.findByText("Otieno Manager is deactivated and signed out.")).toBeInTheDocument();

    const again = await row("Otieno Manager");
    await waitFor(() => expect(within(again).getByText("Deactivated")).toBeInTheDocument());
    await user.click(within(again).getByRole("button", { name: "Reactivate" }));
    await user.click(within(again).getByRole("button", { name: "Yes, reactivate" }));
    expect(await screen.findByText("Otieno Manager can sign in again.")).toBeInTheDocument();
    expect(server.calls.filter((c) => c.method === "POST" && /\/(de|re)activate$/.test(c.url.pathname)).map((c) => c.url.pathname)).toEqual([
      "/api/v1/users/u-mgr/deactivate",
      "/api/v1/users/u-mgr/deactivate",
      "/api/v1/users/u-mgr/reactivate",
    ]);
  });
});

describe("invitations", () => {
  it("checks the form, sends the invitation (its link goes in the message) and never shows a code", async () => {
    server = installPeopleServer();
    const user = userEvent.setup();
    showPeople();
    await tab(user, "Invitations");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(screen.getByText(/Enter the person’s email address/)).toBeInTheDocument();
    expect(screen.getByText("Choose the role they will have.")).toBeInTheDocument();
    expect(posted(server, "/users/invite")).toEqual([]);

    await user.type(screen.getByLabelText("Email address"), "kamau@nakuru.test");
    await user.selectOptions(screen.getByLabelText("Role"), "CASHIER");
    expect(screen.getByText("The till only.")).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Phone for an SMS copy/), "0712 345 678");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    const status = await screen.findByText(/Invitation sent to/);
    expect(status).toHaveTextContent("kamau@nakuru.test as Cashier");
    expect(status).toHaveTextContent("Their message carries the link to accept.");
    expect(posted(server, "/users/invite")).toEqual([{ email: "kamau@nakuru.test", role: "CASHIER", phone: "0712345678" }]);
    const sent = await row("Invitation to kamau@nakuru.test");
    expect(sent).toHaveTextContent("Email simulated — this environment does not send real messages · SMS simulated");
    expect(document.body.textContent).not.toMatch(/f{64}|token/i);
    // The form is clear for the next person.
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(await axeViolations()).toEqual([]);
  });

  it("keeps what was typed when the server refuses, and revokes a sent invitation", async () => {
    server = installPeopleServer();
    const user = userEvent.setup();
    showPeople();
    await tab(user, "Invitations");
    await user.type(screen.getByLabelText("Email address"), "u-mgr@nakuru.test");
    await user.selectOptions(screen.getByLabelText("Role"), "ACCOUNTANT");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A user with that email already exists.");
    expect(screen.getByLabelText("Email address")).toHaveValue("u-mgr@nakuru.test");
    expect(screen.getByLabelText("Role")).toHaveValue("ACCOUNTANT");

    await user.clear(screen.getByLabelText("Email address"));
    await user.type(screen.getByLabelText("Email address"), "njeri@nakuru.test");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    const sent = await row("Invitation to njeri@nakuru.test");
    await user.click(within(sent).getByRole("button", { name: "Revoke" }));
    await user.click(within(sent).getByRole("button", { name: "Yes, revoke it" }));
    // Revoked, it leaves the open list (read from the API).
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "Invitation to njeri@nakuru.test" })).not.toBeInTheDocument());
    expect(posted(server, "/users/invitations/inv-1/revoke")).toEqual([undefined]);
  });
});

describe("open invitations (T-B-INVITE-LIST)", () => {
  it("lists invitations sent before this visit, so any open one can be revoked", async () => {
    server = installPeopleServer();
    server.invitations.push({ id: "inv-old", email: "earlier@nakuru.test", role: "ACCOUNTANT", status: "PENDING", tokenHash: "f".repeat(64) }, { id: "inv-gone", email: "revoked@nakuru.test", role: "CASHIER", status: "REVOKED", tokenHash: "e".repeat(64) });
    const user = userEvent.setup();
    showPeople();
    await tab(user, "Invitations");
    const list = await screen.findByRole("list", { name: "Open invitations" });
    expect(within(list).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Invitation to earlier@nakuru.test"]);
    const earlier = within(list).getByRole("listitem", { name: "Invitation to earlier@nakuru.test" });
    expect(earlier).toHaveTextContent("Accountant · open until");
    await user.click(within(earlier).getByRole("button", { name: "Revoke" }));
    await user.click(within(earlier).getByRole("button", { name: "Yes, revoke it" }));
    expect(await screen.findByText("None open.")).toBeInTheDocument();
    expect(posted(server, "/users/invitations/inv-old/revoke")).toEqual([undefined]);
  });
});

describe("the audit log", () => {
  it("records each change, newest first, naming who and what", async () => {
    server = installPeopleServer();
    const user = userEvent.setup();
    showPeople();
    const cashier = await row("Akinyi Cashier");
    await user.selectOptions(within(cashier).getByLabelText("New role for Akinyi Cashier"), "WAREHOUSE_STAFF");
    await user.click(within(cashier).getByRole("button", { name: "Change role" }));
    await user.click(within(cashier).getByRole("button", { name: "Yes, change the role" }));
    await screen.findByText(/is now Warehouse staff/);

    await tab(user, "Audit log");
    const log = await screen.findByRole("list", { name: "Audit log" });
    const [first] = within(log).getAllByRole("listitem");
    expect(first).toHaveTextContent("Changed a role");
    expect(first).toHaveTextContent("by Wanjiru Owner · for Akinyi Cashier");
    expect(first).toHaveTextContent("Cashier → Warehouse staff");
    expect(server.calls.some((c) => c.url.pathname === "/api/v1/users/audit" && c.url.searchParams.get("limit") === "50")).toBe(true);
    expect(await axeViolations()).toEqual([]);
  });
});
