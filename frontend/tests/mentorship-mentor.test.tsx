// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MentorActionItems, MentorCohort, MentorEngagements, MentorSessions } from "@/components/mentorship/mentor";
import { axeViolations } from "./support/catalog";
import { posted } from "./support/money";
import { installMentorshipServer, reads, show, type MentorshipServer } from "./support/mentorship";

// The mentor / coach workspace (Wave 7 part A): a business's figures open only through an ACTIVE
// engagement its owner consented to, each read is logged for the owner, and nothing is read in the
// background. Agreeing goals and KPIs (with a live actual), the action plan, coaching sessions, the
// cohort, and ending an engagement.

vi.mock("next/navigation", () => ({ usePathname: () => "/mentorship", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: MentorshipServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type User = ReturnType<typeof userEvent.setup>;
async function openNakuru(user: User) {
  await user.click(await screen.findByRole("button", { name: "Nakuru Hardware · Active" }));
  return screen.findByRole("dialog", { name: "Nakuru Hardware" });
}

describe("engagements and consent", () => {
  it("lists every engagement and opens no figures until the owner has consented", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<MentorEngagements />);
    const list = await screen.findByRole("list", { name: "Engagements" });
    expect(within(list).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Nakuru Hardware · Active", "Thika Agrovet · Awaiting the owner’s consent", "Kisumu Traders · Ended"]);
    expect(await axeViolations()).toEqual([]);

    await user.click(within(list).getByRole("button", { name: /Thika Agrovet/ }));
    const thika = await screen.findByRole("dialog", { name: "Thika Agrovet" });
    expect(within(thika).getByText("Waiting for the owner’s consent")).toBeInTheDocument();
    await user.click(within(thika).getByRole("button", { name: "Close" }));
    await user.click(within(list).getByRole("button", { name: /Kisumu Traders/ }));
    expect(await screen.findByText(/Programme finished/)).toBeInTheDocument();
    // Neither an unconsented nor an ended engagement is ever asked for figures.
    expect(server.calls.filter((c) => /e-(2|3)\/(dashboard|snapshot)/.test(c.url.pathname))).toEqual([]);
    expect(reads(server)).toEqual([]);
  });

  it("reads the snapshot only when asked, and each read lands in the owner's log", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<MentorEngagements />);
    const sheet = await openNakuru(user);
    expect(await within(sheet).findByRole("region", { name: "KPI standings" })).toHaveTextContent("Target KES 100,000.00 · actual KES 91,450.00");
    expect(reads(server)).toEqual(["dashboard:MONTHLY_REVENUE"]);
    expect(server.calls.some((c) => c.url.pathname.endsWith("/snapshot"))).toBe(false);

    await user.click(within(sheet).getByRole("button", { name: "Read this month’s figures" }));
    const snapshot = await within(sheet).findByRole("region", { name: "Month-to-date snapshot" });
    expect(snapshot).toHaveTextContent("Revenue");
    expect(snapshot).toHaveTextContent("KES 91,450.00");
    expect(snapshot).toHaveTextContent("KES -612,530.00");
    expect(snapshot).toHaveTextContent("recorded in the owner’s access log");
    expect(reads(server)).toEqual(["snapshot", "dashboard:MONTHLY_REVENUE"]);
  });

  it("ends an engagement after confirming", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<MentorEngagements />);
    const sheet = await openNakuru(user);
    await user.click(await within(sheet).findByRole("button", { name: "End engagement" }));
    const ask = within(sheet).getByRole("alertdialog", { name: "End the engagement with Nakuru Hardware?" });
    await user.type(within(ask).getByLabelText(/Why/), "Goals met");
    await user.click(within(ask).getByRole("button", { name: "Yes, end it" }));
    expect(await screen.findByText(/has ended/)).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-1/end")).toEqual([{ reason: "Goals met" }]);
  });
});

describe("goals, KPIs, action items and sessions", () => {
  it("agrees a goal (shillings) and moves its status", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<MentorEngagements />);
    const sheet = await openNakuru(user);
    await user.click(await within(sheet).findByRole("tab", { name: "Goals" }));
    await user.click(within(sheet).getByRole("button", { name: "Agree a goal" }));
    const form = within(sheet).getByRole("form", { name: "New goal" });
    await user.click(within(form).getByRole("button", { name: "Agree the goal" }));
    expect(within(form).getByText("Name the goal.")).toBeInTheDocument();
    await user.type(within(form).getByLabelText("Goal"), "Cut stock-outs");
    await user.type(within(form).getByLabelText(/Target amount/), "150,000");
    await user.click(within(form).getByRole("button", { name: "Agree the goal" }));
    expect(await within(sheet).findByText("Goal “Cut stock-outs” agreed.")).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-1/goals")).toEqual([{ title: "Cut stock-outs", targetValue: "150000.00" }]);

    const goal = await within(sheet).findByRole("listitem", { name: "Grow monthly revenue" });
    await user.selectOptions(within(goal).getByLabelText("Status of Grow monthly revenue"), "AT_RISK");
    await waitFor(() => expect(posted(server, "/mentorship/goals/g-1", "PATCH")).toEqual([{ status: "AT_RISK" }]));
  });

  it("agrees a KPI with a money or rate target and checks its live actual", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<MentorEngagements />);
    const sheet = await openNakuru(user);
    await user.click(await within(sheet).findByRole("tab", { name: "KPIs" }));
    await user.click(within(sheet).getByRole("button", { name: "Agree a KPI" }));
    const form = within(sheet).getByRole("form", { name: "New KPI" });
    await user.selectOptions(within(form).getByLabelText("Measure"), "GROSS_MARGIN_PCT");
    await user.type(within(form).getByLabelText("Target (%)"), "abc");
    await user.click(within(form).getByRole("button", { name: "Agree the KPI" }));
    expect(within(form).getByText(/at most two decimals/)).toBeInTheDocument();
    await user.clear(within(form).getByLabelText("Target (%)"));
    await user.type(within(form).getByLabelText("Target (%)"), "35");
    await user.click(within(form).getByRole("button", { name: "Agree the KPI" }));
    expect(await within(sheet).findByText("KPI “Gross margin (%)” agreed.")).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-1/indicators")).toEqual([{ name: "Gross margin (%)", sourceKey: "GROSS_MARGIN_PCT", targetRate: "35" }]);

    const kpi = await within(sheet).findByRole("listitem", { name: "Monthly revenue" });
    await user.click(within(kpi).getByRole("button", { name: "Check Monthly revenue now" }));
    expect(await within(kpi).findByRole("status")).toHaveTextContent("Now KES 91,450.00");
    expect(reads(server)).toContain("indicator:MONTHLY_REVENUE");
  });

  it("adds an action item, completes one, and records a session", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<MentorEngagements />);
    const sheet = await openNakuru(user);
    await user.click(await within(sheet).findByRole("tab", { name: "Action items" }));
    await user.click(within(sheet).getByRole("button", { name: "Add an action item" }));
    const form = within(sheet).getByRole("form", { name: "New action item" });
    await user.type(within(form).getByLabelText("What is to be done"), "Count stock monthly");
    await user.type(within(form).getByLabelText(/Due/), "2026-11-30");
    await user.click(within(form).getByRole("button", { name: "Add the action item" }));
    expect(await within(sheet).findByText("Action item added for the business owner.")).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-1/action-items")).toEqual([{ title: "Count stock monthly", responsibleParty: "ENTREPRENEUR", dueDate: "2026-11-30" }]);
    await user.click(await within(sheet).findByRole("button", { name: "Mark “Send pricing template” done" }));
    await waitFor(() => expect(posted(server, "/mentorship/action-items/a-2", "PATCH")).toEqual([{ status: "DONE" }]));

    await user.click(within(sheet).getByRole("tab", { name: "Sessions" }));
    await user.click(within(sheet).getByRole("button", { name: "Record a session" }));
    const session = within(sheet).getByRole("form", { name: "Record a session" });
    await user.clear(within(session).getByLabelText("Date"));
    await user.type(within(session).getByLabelText("Date"), "2099-01-01");
    await user.type(within(session).getByLabelText("Summary"), "Walked the shop floor");
    await user.click(within(session).getByRole("button", { name: "Record the session" }));
    expect(within(session).getByText("A session can’t be dated in the future.")).toBeInTheDocument();
    await user.clear(within(session).getByLabelText("Date"));
    await user.type(within(session).getByLabelText("Date"), "2026-11-05");
    await user.click(within(session).getByRole("button", { name: "Record the session" }));
    expect(await within(sheet).findByText("Session of 5 Nov 2026 recorded.")).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-1/sessions")).toEqual([{ sessionDate: "2026-11-05", summary: "Walked the shop floor" }]);
  });
});

describe("the mentor's other pages", () => {
  it("gathers open action items and sessions across active engagements only", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<MentorActionItems />);
    const items = await screen.findByRole("list", { name: "Open action items" });
    expect(within(items).getAllByRole("listitem").map((li) => li.getAttribute("aria-label"))).toEqual(["Reconcile the till weekly", "Send pricing template"]);
    expect(server.calls.filter((c) => /e-(2|3)\//.test(c.url.pathname))).toEqual([]);
    cleanup();

    show(<MentorSessions />);
    const sessions = await screen.findByRole("list", { name: "Sessions" });
    await user.click(within(sessions).getByRole("button", { name: /3 Nov 2026 · Nakuru Hardware/ }));
    const detail = await screen.findByRole("dialog", { name: "Coaching session" });
    expect(await within(detail).findByText("Reprice cement")).toBeInTheDocument();
  });

  it("shows the cohort's headline figures per business", async () => {
    server = installMentorshipServer();
    show(<MentorCohort />);
    const table = await screen.findByRole("table", { name: /Cohort/ });
    expect(within(table).getByRole("row", { name: /Nakuru Hardware/ })).toHaveTextContent("91,450.00-612,530.0069.29%2");
    expect(within(table).queryByRole("row", { name: /Thika|Kisumu/ })).not.toBeInTheDocument();
    expect(reads(server)).toEqual(["cohort"]);
  });
});
