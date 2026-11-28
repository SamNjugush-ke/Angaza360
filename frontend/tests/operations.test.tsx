// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Integrations } from "@/components/admin/integrations";
import { Jobs } from "@/components/admin/jobs";
import { reportLink } from "@/components/admin/tenants";
import { Exports } from "@/components/exports/exports";
import { adminPermissions } from "@/lib/admin/admin";
import { axeViolations } from "./support/catalog";
import { installAdminServer, type AdminServer } from "./support/admin";
import { installConsole } from "./support/console";
import { show } from "./support/mentorship";

// OPERATIONAL CONTROL & THE REPORTING CENTER (M4.5 W5):
//   * integrations — the business health board is READ-ONLY (no control touches a business's keys);
//     Angaza's own notification credentials are the SUPER_ADMIN's, and no value ever comes back:
//     every response is searched for every stored secret;
//   * jobs — a console run is confirmed, needs a fresh step-up, and is IDEMPOTENT: the step-up retry
//     carries the SAME key, so it is one run; a new decision is a new key;
//   * the reporting center — the platform library through the same filter-then-export screen as T-B4:
//     the export carries exactly the applied filters.

vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

beforeEach(() => {
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => undefined }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const callsTo = (server: AdminServer, pattern: RegExp) => server.calls.filter((c) => pattern.test(c.url.pathname));

describe("integrations", () => {
  it("a programme officer sees the business health board, read-only, and never the platform credentials", async () => {
    const server = installAdminServer("PROGRAM_OFFICER");
    installConsole(server);
    const user = userEvent.setup();
    show(<Integrations permissions={adminPermissions("PROGRAM_OFFICER")} />);
    const table = await screen.findByRole("table", { name: "Business integration health" });
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(within(table).getByRole("link", { name: "Thika Agrovet" })).toHaveAttribute("href", "/admin/tenants/t-2");
    await user.selectOptions(screen.getByLabelText("Health"), "FAILING");
    await waitFor(() => expect(within(screen.getByRole("table", { name: "Business integration health" })).getAllByRole("row")).toHaveLength(2));
    // Nothing on the board can act on a business's credentials.
    expect(within(screen.getByRole("table", { name: "Business integration health" })).queryAllByRole("button")).toEqual([]);
    expect(screen.queryByRole("region", { name: /Platform notifications/ })).not.toBeInTheDocument();
    expect(callsTo(server, /platform-credentials/)).toEqual([]);
    expect(callsTo(server, /\/integrations/)).toEqual([]);
  });

  it("a super-admin stores, verifies (idempotently) and activates a platform credential — no secret is ever shown or returned", async () => {
    const server = installAdminServer("SUPER_ADMIN");
    const state = installConsole(server);
    const user = userEvent.setup();
    show(<Integrations permissions={adminPermissions("SUPER_ADMIN")} />);
    const cell = await screen.findByRole("region", { name: "SMTP email sandbox" });
    expect(within(cell).getByText("not stored")).toBeInTheDocument();
    expect(within(cell).getByText(/this deployment sends from here/)).toBeInTheDocument();

    await user.click(within(cell).getByRole("button", { name: "Store credentials" }));
    const form = within(cell).getByRole("form", { name: "Store SMTP email sandbox credentials" });
    const password = within(form).getByLabelText(/^Password/);
    expect(password).toHaveAttribute("type", "password");
    await user.type(within(form).getByLabelText(/SMTP host/), "smtp.example.test");
    await user.type(within(form).getByLabelText(/^Port/), "587");
    await user.type(within(form).getByLabelText(/^Username/), "mailer");
    await user.type(password, "S3cret-value-xyz");
    await user.type(within(form).getByLabelText(/From address/), "no-reply@angaza.test");
    await user.click(within(form).getByRole("button", { name: "Store credentials" }));
    const prompt = await within(cell).findByRole("dialog", { name: "Confirm it is you" });
    await user.type(within(prompt).getByLabelText("Authenticator code"), "123456");
    await user.click(within(prompt).getByRole("button", { name: "Confirm and continue" }));
    expect(await within(cell).findByText(/stored and waiting to be switched on/)).toBeInTheDocument();
    await waitFor(() => expect(within(screen.getByRole("region", { name: "SMTP email sandbox" })).getByText("pending")).toBeInTheDocument());

    // Verify twice: the same outcome, and nothing but the health record changes.
    const fresh = () => screen.getByRole("region", { name: "SMTP email sandbox" });
    await user.click(within(fresh()).getByRole("button", { name: "Verify" }));
    expect(await within(fresh()).findByText(/Verified:/)).toBeInTheDocument();
    await user.click(within(fresh()).getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(within(fresh()).getByText("healthy")).toBeInTheDocument());
    expect(within(fresh()).getByText("pending")).toBeInTheDocument();
    expect(callsTo(server, /\/verify$/)).toHaveLength(2);

    await user.click(within(fresh()).getByRole("button", { name: "Activate" }));
    await waitFor(() => expect(within(fresh()).getByText("active")).toBeInTheDocument());

    // No value ever came back, and none is on the page.
    expect(state.storedSecrets).toContain("S3cret-value-xyz");
    await waitFor(() => expect(state.responses.length).toBeGreaterThan(3));
    for (const body of state.responses) expect(body).not.toContain("S3cret-value-xyz");
    expect(document.body.innerHTML).not.toContain("S3cret-value-xyz");
    expect(await axeViolations()).toEqual([]);
  });
});

describe("jobs", () => {
  it("a console run is confirmed, needs a step-up, and is ONE run however many times the request is sent", async () => {
    const server = installAdminServer("SUPER_ADMIN");
    const state = installConsole(server);
    const user = userEvent.setup();
    show(<Jobs permissions={adminPermissions("SUPER_ADMIN")} initialJob="expire-tokens" />);
    const detail = await screen.findByRole("region", { name: "Expire invitations and codes" });
    expect(within(detail).getByText(/hourly/)).toBeInTheDocument();
    await user.click(within(detail).getByRole("button", { name: "Run now" }));
    await user.click(within(detail).getByRole("button", { name: "Yes, run it now" }));
    const prompt = await within(detail).findByRole("dialog", { name: "Confirm it is you" });
    await user.type(within(prompt).getByLabelText("Authenticator code"), "123456");
    await user.click(within(prompt).getByRole("button", { name: "Confirm and continue" }));
    expect(await within(detail).findByText(/It ran and finished/)).toBeInTheDocument();

    const sent = callsTo(server, /\/jobs\/expire-tokens\/run$/).map((c) => (c as { headers?: Headers }).headers?.get("idempotency-key"));
    expect(sent).toHaveLength(2); // refused for the step-up, then sent again …
    expect(new Set(sent).size).toBe(1); // … with the SAME key
    expect(state.runs.filter((r) => r.jobName === "expire-tokens" && r.trigger === "CONSOLE")).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Run history" })).getByText("console")).toBeInTheDocument());

    // A new decision is a new key — and a new run.
    await user.click(within(screen.getByRole("region", { name: "Expire invitations and codes" })).getByRole("button", { name: "Run now" }));
    await user.click(screen.getByRole("button", { name: "Yes, run it now" }));
    await waitFor(() => expect(state.runs.filter((r) => r.jobName === "expire-tokens" && r.trigger === "CONSOLE")).toHaveLength(2));
  });

  it("shows a failed run's reason clearly, and offers no run to a programme officer", async () => {
    const server = installAdminServer("SUPER_ADMIN");
    const state = installConsole(server);
    state.steppedUp = true;
    const user = userEvent.setup();
    show(<Jobs permissions={adminPermissions("SUPER_ADMIN")} initialJob="mpesa-reconcile" />);
    const detail = await screen.findByRole("region", { name: "Reconcile M-Pesa with Safaricom" });
    expect(within(detail).getByText(/Last failure:/).closest("p")).toHaveTextContent("Safaricom unreachable");
    await user.click(within(detail).getByRole("button", { name: "Run now" }));
    await user.click(within(detail).getByRole("button", { name: "Yes, run it now" }));
    expect(await within(detail).findByText(/It failed after 3 attempts/)).toBeInTheDocument();
    cleanup();

    const officer = installAdminServer("PROGRAM_OFFICER");
    installConsole(officer);
    show(<Jobs permissions={adminPermissions("PROGRAM_OFFICER")} />);
    await screen.findByRole("region", { name: "Retry queued eTIMS invoices" });
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
  });
});

describe("the reporting center", () => {
  it("runs the platform library and exports exactly the applied filters — never an unapplied change", async () => {
    const server = installAdminServer("PROGRAM_OFFICER");
    const state = installConsole(server);
    server.tenants.push({ ...server.tenants[0], id: "t-3", name: "Kisumu Fish", status: "SUSPENDED" });
    const user = userEvent.setup();
    show(<Exports library="platform" initialReport="businesses" initialFilters={{ status: "ACTIVE" }} />);
    expect(await screen.findByRole("heading", { level: 1, name: "Reporting center" })).toBeInTheDocument();
    expect(within(await screen.findByRole("navigation", { name: "Reports" })).getAllByRole("button").map((b) => b.textContent)).toEqual(["Businesses", "Donor programme figures"]);
    const rows = await screen.findAllByRole("row");
    expect(rows.map((r) => r.textContent)).toEqual(expect.arrayContaining(["Nakuru Hardware", "Thika Agrovet"]));
    expect(screen.queryByText("Kisumu Fish")).not.toBeInTheDocument();

    // A change typed but not applied is not exported.
    await user.type(screen.getByLabelText("Name contains"), "zzz");
    await user.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(state.exports).toHaveLength(1));
    expect(state.exports[0]).toEqual({ report: "businesses", format: "csv", filters: { status: "ACTIVE" } });
    expect(callsTo(server, /report-library/)).toEqual([]);
  });

  it("the tenant explorer's export link carries its filters into the businesses report", () => {
    expect(reportLink("ACTIVE", { q: " nakuru ", tier: "MWANZO", county: "Nakuru", sector: "" })).toBe("/admin/reports?report=businesses&status=ACTIVE&tier=MWANZO&county=Nakuru&q=nakuru");
  });
});
