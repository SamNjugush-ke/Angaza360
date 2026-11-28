// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Applications } from "@/components/admin/applications";
import { DonorProjects } from "@/components/admin/donor";
import { Tenants } from "@/components/admin/tenants";
import { Audit, Users } from "@/components/admin/users";
import { adminPermissions } from "@/lib/admin/admin";
import { axeViolations } from "./support/catalog";
import { posted } from "./support/money";
import { installAdminServer, type AdminServer } from "./support/admin";
import { show } from "./support/mentorship";

// Platform administration (Wave 8; the review is M4.5 W2): the application queue (start review,
// request changes, a transparent minor correction, approve — SUPER_ADMIN only — and reject; the ID
// document only for a super-admin or the reviewing officer),
// batch CSV onboarding (template → upload → correct → commit, only when all green, SUPER_ADMIN), the
// tenant registry (onboard-validate → onboard, SUPER_ADMIN; suspend locks users out; deactivate is
// final), donor projects (members pending consent; only consented businesses in the aggregate),
// inviting a mentor, users (SUPER_ADMIN) and the audit log. A programme officer is held back from
// every SUPER_ADMIN-only step.

vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: AdminServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const SA = adminPermissions("SUPER_ADMIN");
const PO = adminPermissions("PROGRAM_OFFICER");

describe("the application queue", () => {
  it("takes a submitted application for review, shows the live green-gate, and lets the super-admin approve a green one", async () => {
    server = installAdminServer();
    const user = userEvent.setup();
    show(<Applications permissions={SA} selfId="u-admin" />);
    const list = await screen.findByRole("list", { name: "Applications" });
    expect(await axeViolations()).toEqual([]);
    await user.click(within(list).getByRole("button", { name: /Duka Moja/ }));
    let sheet = await screen.findByRole("dialog", { name: "Application" });
    const gate = await within(sheet).findByRole("region", { name: "Green-gate" });
    expect(gate).toHaveTextContent("Red — needs fixing");
    expect(gate).toHaveTextContent("KRA PIN: That KRA PIN is already registered.");
    // Nothing is decided before a review starts.
    expect(within(sheet).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Start review" }));
    expect(await screen.findByText(/You are reviewing Duka Moja/)).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /Duka Moja/ }));
    sheet = await screen.findByRole("dialog", { name: "Application" });
    expect(await within(sheet).findByRole("button", { name: "Approve" })).toBeDisabled();
    await user.click(within(sheet).getByRole("button", { name: "Close" }));

    await user.click(within(list).getByRole("button", { name: /Mama Mboga Fresh/ }));
    sheet = await screen.findByRole("dialog", { name: "Application" });
    await user.click(await within(sheet).findByRole("button", { name: "Start review" }));
    await user.click(await within(list).findByRole("button", { name: /Mama Mboga Fresh/ }));
    sheet = await screen.findByRole("dialog", { name: "Application" });
    await user.click(await within(sheet).findByRole("button", { name: "Approve" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, approve and set it up" }));
    expect(await screen.findByText(/Mama Mboga Fresh is live at mama-mboga-fresh. Its owner .* has been invited/)).toBeInTheDocument();
    expect(posted(server, "/tenant-applications/a-1/start-review")).toEqual([undefined]);
    expect(posted(server, "/tenant-applications/a-1/approve")).toEqual([undefined]);
  });

  it("lets a programme officer review, request changes, correct a detail transparently and reject — never approve", async () => {
    server = installAdminServer("PROGRAM_OFFICER");
    const user = userEvent.setup();
    show(<Applications permissions={PO} selfId="u-officer" />);
    const list = await screen.findByRole("list", { name: "Applications" });
    await user.click(within(list).getByRole("button", { name: /Mama Mboga Fresh/ }));
    let sheet = await screen.findByRole("dialog", { name: "Application" });
    await user.click(await within(sheet).findByRole("button", { name: "Start review" }));
    await user.click(await within(list).findByRole("button", { name: /Mama Mboga Fresh/ }));
    sheet = await screen.findByRole("dialog", { name: "Application" });
    await within(sheet).findByRole("region", { name: "Green-gate" });
    expect(within(sheet).queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(within(sheet).getByText(/a super-administrator’s decision/)).toBeInTheDocument();

    // A minor correction: identity fields are not offered, and the change is recorded.
    await user.click(within(sheet).getByRole("button", { name: "Correct a detail" }));
    expect(within(sheet).queryByLabelText("Business name")).not.toBeInTheDocument();
    expect(within(sheet).queryByLabelText(/National ID/)).not.toBeInTheDocument();
    const county = within(sheet).getByLabelText("County");
    await user.clear(county);
    await user.type(county, "Nakuru County");
    await user.click(within(sheet).getByRole("button", { name: "Save correction" }));
    expect(await screen.findByText(/correction is saved and shown to the applicant/)).toBeInTheDocument();
    expect(posted(server, "/tenant-applications/a-1/corrections", "PATCH")).toEqual([{ county: "Nakuru County", note: null }]);

    await user.click(within(list).getByRole("button", { name: /Mama Mboga Fresh/ }));
    sheet = await screen.findByRole("dialog", { name: "Application" });
    expect(await within(sheet).findByRole("region", { name: "Timeline" })).toHaveTextContent("Details corrected");
    await user.click(within(sheet).getByRole("button", { name: "Reject" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, reject it" }));
    expect(within(sheet).getByText(/Give the reason/)).toBeInTheDocument();
    await user.type(within(sheet).getByLabelText(/Reason/), "Not an MSME");
    await user.click(within(sheet).getByRole("button", { name: "Yes, reject it" }));
    expect(await screen.findByText(/application is rejected; the applicant has been told why/)).toBeInTheDocument();
    expect(posted(server, "/tenant-applications/a-1/reject")).toEqual([{ reason: "Not an MSME" }]);
    expect(posted(server, "/tenant-applications/a-1/approve")).toEqual([]);
  });

  it("sends a request for changes to the applicant", async () => {
    server = installAdminServer();
    const user = userEvent.setup();
    show(<Applications permissions={SA} selfId="u-admin" />);
    const list = await screen.findByRole("list", { name: "Applications" });
    await user.click(within(list).getByRole("button", { name: /Mama Mboga Fresh/ }));
    let sheet = await screen.findByRole("dialog", { name: "Application" });
    await user.click(await within(sheet).findByRole("button", { name: "Start review" }));
    await user.click(await within(list).findByRole("button", { name: /Mama Mboga Fresh/ }));
    sheet = await screen.findByRole("dialog", { name: "Application" });
    await user.click(await within(sheet).findByRole("button", { name: "Request changes" }));
    await user.type(within(sheet).getByLabelText(/What should change/), "The ID photo is blurred.");
    await user.click(within(sheet).getByRole("button", { name: "Send the request" }));
    expect(await screen.findByText(/The request has been sent to Mama Mboga Fresh Owner/)).toBeInTheDocument();
    expect(posted(server, "/tenant-applications/a-1/request-changes")).toEqual([{ message: "The ID photo is blurred." }]);
  });

  it("offers the ID document only to a super-admin or the officer reviewing it, through a one-time grant", async () => {
    server = installAdminServer("PROGRAM_OFFICER");
    server.applications[0] = { ...server.applications[0], status: "UNDER_REVIEW", reviewerUserId: "u-someone-else" };
    const user = userEvent.setup();
    show(<Applications permissions={PO} selfId="u-officer" />);
    await user.click(await screen.findByRole("button", { name: /Mama Mboga Fresh/ }));
    let sheet = await screen.findByRole("dialog", { name: "Application" });
    const documents = await within(sheet).findByRole("region", { name: "ID document" });
    expect(documents).toHaveTextContent("Only a super-administrator or the officer reviewing this application may view it.");
    expect(within(documents).queryByRole("button", { name: "View (logged)" })).not.toBeInTheDocument();
    cleanup();

    server = installAdminServer("PROGRAM_OFFICER");
    server.applications[0] = { ...server.applications[0], status: "UNDER_REVIEW", reviewerUserId: "u-officer" };
    const tab = { location: { href: "" }, close: vi.fn() };
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    show(<Applications permissions={PO} selfId="u-officer" />);
    await user.click(await screen.findByRole("button", { name: /Mama Mboga Fresh/ }));
    sheet = await screen.findByRole("dialog", { name: "Application" });
    const mine = await within(sheet).findByRole("region", { name: "ID document" });
    await user.click(within(mine).getAllByRole("button", { name: "View (logged)" })[0] as HTMLElement);
    await waitFor(() => expect(tab.location.href).toBe("/api/v1/tenant-applications/documents/view/view-d-FRONT"));
    expect(posted(server, "/tenant-applications/a-1/documents/d-FRONT/view-grant")).toEqual([undefined]);
  });
});

describe("batch onboarding", () => {
  it("uploads a CSV, corrects the red row, and commits only once every row is green", async () => {
    server = installAdminServer();
    const user = userEvent.setup();
    show(<Applications permissions={SA} />);
    await user.click(await screen.findByRole("tab", { name: "Batch upload" }));
    const file = new File(["businessName,ownerFullName,ownerEmail,taxRegime\nBatch One,A,a@x.test,EXEMPT\n"], "batch.csv", { type: "text/csv" });
    await user.upload(screen.getByLabelText("CSV file"), file);
    await user.click(screen.getByRole("button", { name: /Upload and check/ }));
    const preview = await screen.findByRole("region", { name: "Batch preview" });
    expect(server.csv[0]).toContain("Batch One,A,a@x.test");
    expect(preview).toHaveTextContent("2 rows · 1 green · 1 red");
    const commit = within(preview).getByRole("button", { name: "Commit the batch" });
    expect(commit).toBeDisabled();

    const red = within(preview).getByRole("listitem", { name: "Row 2 · Batch Two" });
    expect(red).toHaveTextContent("Owner’s email: Not an email address.");
    await user.click(within(red).getByRole("button", { name: "Correct" }));
    const form = within(red).getByRole("form", { name: "Correct row 2" });
    expect(within(form).getByLabelText("Owner’s email")).toHaveAccessibleDescription("Not an email address.");
    await user.clear(within(form).getByLabelText("Owner’s email"));
    await user.type(within(form).getByLabelText("Owner’s email"), "two@batch.test");
    await user.click(within(form).getByRole("button", { name: "Save and re-check" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "Batch preview" })).toHaveTextContent("2 rows · 2 green · 0 red"));
    expect(posted(server, "/tenant-applications/r-2", "PATCH")[0]).toMatchObject({ ownerEmail: "two@batch.test", businessName: "Batch Two" });

    await user.click(screen.getByRole("button", { name: "Commit the batch" }));
    await user.click(screen.getByRole("button", { name: "Yes, commit the batch" }));
    expect(await screen.findByText("2 businesses set up; each owner has been invited.")).toBeInTheDocument();
  });

  it("lets a programme officer prepare a batch but not commit it", async () => {
    server = installAdminServer("PROGRAM_OFFICER");
    const user = userEvent.setup();
    show(<Applications permissions={PO} />);
    await user.click(await screen.findByRole("tab", { name: "Batch upload" }));
    await user.upload(screen.getByLabelText("CSV file"), new File(["x"], "b.csv", { type: "text/csv" }));
    await user.click(screen.getByRole("button", { name: /Upload and check/ }));
    const preview = await screen.findByRole("region", { name: "Batch preview" });
    expect(within(preview).queryByRole("button", { name: "Commit the batch" })).not.toBeInTheDocument();
    expect(preview).toHaveTextContent("A super-administrator commits the batch");
  });
});

describe("tenants", () => {
  it("validates a new business against the green-gate, then onboards it as super-admin", async () => {
    server = installAdminServer();
    const user = userEvent.setup();
    show(<Tenants permissions={SA} />);
    await user.click(await screen.findByRole("button", { name: /Onboard a business/ }));
    const form = screen.getByRole("form", { name: "Onboard a business" });
    await user.type(within(form).getByLabelText("Business name"), "Kisumu Traders");
    await user.type(within(form).getByLabelText("Owner’s full name"), "Otieno Ouma");
    await user.type(within(form).getByLabelText("Owner’s email"), "bad");
    await user.click(within(form).getByRole("button", { name: "Check the details" }));
    const report = await within(form).findByRole("region", { name: "Green-gate report" });
    expect(report).toHaveTextContent("Red — needs fixing");
    expect(within(form).getByLabelText("Owner’s email")).toHaveAccessibleDescription("Not an email address.");
    expect(within(form).queryByRole("button", { name: /Set up the business/ })).not.toBeInTheDocument();

    await user.clear(within(form).getByLabelText("Owner’s email"));
    await user.type(within(form).getByLabelText("Owner’s email"), "otieno@kisumu.test");
    await user.click(within(form).getByRole("button", { name: "Check the details" }));
    expect(await within(form).findByText("It will be set up at kisumu-traders.")).toBeInTheDocument();
    await user.click(within(form).getByRole("button", { name: "Set up the business and invite the owner" }));
    expect(await screen.findByText(/Kisumu Traders is live at kisumu-traders/)).toBeInTheDocument();
    expect(posted(server, "/tenants/onboard")).toEqual([
      { businessName: "Kisumu Traders", subdomain: null, sector: null, kraPin: null, taxRegime: "TURNOVER_TAX", ownerFullName: "Otieno Ouma", ownerEmail: "otieno@kisumu.test", ownerPhone: null, ownerNationalId: null },
    ]);
  });

  it("lets a programme officer validate but not onboard", async () => {
    server = installAdminServer("PROGRAM_OFFICER");
    const user = userEvent.setup();
    show(<Tenants permissions={PO} />);
    await user.click(await screen.findByRole("button", { name: /Onboard a business/ }));
    const form = screen.getByRole("form", { name: "Onboard a business" });
    await user.type(within(form).getByLabelText("Business name"), "Eldoret Feeds");
    await user.type(within(form).getByLabelText("Owner’s email"), "o@e.test");
    await user.click(within(form).getByRole("button", { name: "Check the details" }));
    expect(await within(form).findByText("It is ready. A super-administrator sets it up.")).toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: /Set up the business/ })).not.toBeInTheDocument();
  });

  it("suspends with the lock-out spelled out, reactivates, deactivates for good, and invites a mentor", async () => {
    server = installAdminServer("PROGRAM_OFFICER");
    const user = userEvent.setup();
    show(<Tenants permissions={PO} />);
    await user.click(await screen.findByRole("button", { name: /Nakuru Hardware/ }));
    let sheet = await screen.findByRole("dialog", { name: "Nakuru Hardware" });

    await user.click(within(sheet).getByRole("button", { name: "Invite a mentor" }));
    const invite = within(sheet).getByRole("region", { name: "Invite a mentor to Nakuru Hardware" });
    // The picker is the platform directory's mentors and coaches (T-B-ADMIN-USER-LIST).
    const picker = await within(invite).findByLabelText("Mentor");
    await waitFor(() => expect(within(picker).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a mentor or coach…", "Chris Coach (coach) · coach@angaza.test", "Mary Mentor (mentor) · mentor@angaza.test"]));
    await user.selectOptions(picker, "u-mentor");
    await user.click(within(invite).getByRole("button", { name: "Send the invitation" }));
    expect(await within(sheet).findByText(/Mary Mentor is invited to Nakuru Hardware. Nothing is shared until its owner consents./)).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements")).toEqual([{ mentorId: "u-mentor", tenantId: "t-1" }]);

    await user.click(within(sheet).getByRole("button", { name: "Suspend" }));
    const ask = within(sheet).getByRole("alertdialog", { name: "Suspend Nakuru Hardware?" });
    expect(ask).toHaveTextContent("Every user of the business is locked out at once");
    await user.click(within(ask).getByRole("button", { name: "Yes, suspend" }));
    expect(await screen.findByText("Nakuru Hardware is now suspended.")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /Nakuru Hardware/ }));
    sheet = await screen.findByRole("dialog", { name: "Nakuru Hardware" });
    expect(within(sheet).queryByRole("button", { name: "Suspend" })).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Deactivate" }));
    expect(within(sheet).getByRole("alertdialog")).toHaveTextContent("This is final");
    await user.click(within(sheet).getByRole("button", { name: "Yes, deactivate permanently" }));
    expect(await screen.findByText("Nakuru Hardware is now deactivated.")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: /Nakuru Hardware/ }));
    expect(await screen.findByText("Deactivated for good.")).toBeInTheDocument();
  });
});

describe("donor projects", () => {
  it("creates a project, adds a member pending consent, and aggregates consented businesses only", async () => {
    server = installAdminServer("PROGRAM_OFFICER");
    const user = userEvent.setup();
    show(<DonorProjects />);
    await user.click(await screen.findByRole("button", { name: /Grow Kenya 2026/ }));
    const sheet = await screen.findByRole("dialog", { name: "Donor project" });
    const members = await within(sheet).findByRole("list", { name: "Members" });
    expect(within(members).getByRole("listitem", { name: "Thika Agrovet" })).toHaveTextContent("Awaiting the owner’s consent");

    await user.click(within(sheet).getByRole("button", { name: "Compute" }));
    const aggregate = await within(sheet).findByRole("region", { name: "Cohort aggregate" });
    expect(await within(aggregate).findByText(/of 2 businesses included \(1 awaiting consent/)).toBeInTheDocument();
    const table = within(aggregate).getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByRole("row", { name: /Nakuru Hardware/ })).toBeInTheDocument();
    expect(within(table).queryByRole("row", { name: /Thika/ })).not.toBeInTheDocument();
    expect(aggregate).toHaveTextContent("KES 91,450.00");

    await user.click(within(members).getByRole("button", { name: "Remove Thika Agrovet" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, remove it" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Members" })).queryByRole("listitem", { name: "Thika Agrovet" })).not.toBeInTheDocument());
    await user.selectOptions(within(sheet).getByLabelText("Add a business"), "t-2");
    await user.click(within(sheet).getByRole("button", { name: "Add" }));
    expect(await within(sheet).findByText(/Thika Agrovet added. Its figures are read only once its owner consents./)).toBeInTheDocument();
    expect(posted(server, "/donor-projects/p-1/members")).toEqual([{ tenantId: "t-2" }]);
    await user.click(within(sheet).getByRole("button", { name: "Close" }));

    await user.click(screen.getByRole("button", { name: /New project/ }));
    const form = screen.getByRole("form", { name: "New donor project" });
    await user.type(within(form).getByLabelText("Code"), "AGRI-27");
    await user.type(within(form).getByLabelText("Project name"), "Agri Growth");
    await user.type(within(form).getByLabelText("Donor"), "Example Trust");
    await user.click(within(form).getByRole("button", { name: "Create the project" }));
    expect(await screen.findByText("Agri Growth created.")).toBeInTheDocument();
  });
});

describe("users and audit", () => {
  it("invites a business user (business required) and changes a user's role from the directory", async () => {
    server = installAdminServer();
    const user = userEvent.setup();
    show(<Users />);
    const inviteForm = screen.getByRole("form", { name: "Invite a user" });
    await user.type(within(inviteForm).getByLabelText("Email address"), "jane@nakuru.test");
    await user.selectOptions(within(inviteForm).getByLabelText("Role"), "CASHIER");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(screen.getByText("A business role needs its business.")).toBeInTheDocument();
    await user.selectOptions(await within(inviteForm).findByLabelText("Business"), "t-1");
    await user.click(screen.getByRole("button", { name: "Send invitation" }));
    expect(await screen.findByRole("listitem", { name: "Invitation to jane@nakuru.test" })).toHaveTextContent("Cashier");
    expect(posted(server, "/users/invite")).toEqual([{ email: "jane@nakuru.test", role: "CASHIER", tenantId: "t-1" }]);

    // Every user, from the directory; a business user is offered business roles only.
    const users = await screen.findByRole("list", { name: "Users" });
    expect(within(users).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Mary Mentor", "Chris Coach", "Akinyi Cashier"]);
    const cashier = within(users).getByRole("listitem", { name: "Akinyi Cashier" });
    expect(cashier).toHaveTextContent("Cashier · Nakuru Hardware");
    expect(within(within(cashier).getByLabelText("New role for Akinyi Cashier")).queryByRole("option", { name: "Mentor" })).not.toBeInTheDocument();
    await user.selectOptions(within(cashier).getByLabelText("New role for Akinyi Cashier"), "WAREHOUSE_STAFF");
    await user.click(within(cashier).getByRole("button", { name: "Change role" }));
    await user.click(within(cashier).getByRole("button", { name: "Yes, do it" }));
    expect(await screen.findByText("Akinyi Cashier is Warehouse staff, active.")).toBeInTheDocument();
    expect(posted(server, "/users/u-cash/role", "PATCH")).toEqual([{ role: "WAREHOUSE_STAFF" }]);

    await user.type(screen.getByLabelText("Search by name or email"), "coach");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Users" })).getAllByRole("listitem")).toHaveLength(1));
    expect(server.calls.some((c) => c.url.pathname === "/api/v1/users/directory" && c.url.searchParams.get("q") === "coach")).toBe(true);
  });

  it("lists the audit log, narrowed to one business", async () => {
    server = installAdminServer("PROGRAM_OFFICER");
    const user = userEvent.setup();
    show(<Audit />);
    const log = await screen.findByRole("list", { name: "Audit log" });
    expect(within(log).getAllByRole("listitem")[0]).toHaveTextContent("Business suspended · Nakuru Hardware");
    // Names, not ids (T-B-ADMIN-USER-LIST).
    expect(within(log).getAllByRole("listitem")[0]).toHaveTextContent("by Angaza Admin");
    expect(within(log).getAllByRole("listitem")[1]).toHaveTextContent("by Wanjiru Owner · for Akinyi Cashier");
    await user.selectOptions(screen.getByLabelText("Business"), "t-2");
    await waitFor(() => expect(server.calls.some((c) => c.url.pathname === "/api/v1/users/audit" && c.url.searchParams.get("tenantId") === "t-2")).toBe(true));
    expect(await axeViolations()).toEqual([]);
  });
});
