// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerMentorship } from "@/components/mentorship/owner";
import { axeViolations } from "./support/catalog";
import { posted } from "./support/money";
import { installMentorshipServer, show, type MentorshipServer } from "./support/mentorship";

// The owner's side (Wave 7 part B): an explicit consent — what a mentor would see, that every read is
// logged, that it can be ended — or a decline; the full engagement with its access log; marking the
// owner's own action items done; ending the engagement; and donor-programme memberships, whose
// consent decides whether the business's figures enter the cohort totals.

vi.mock("next/navigation", () => ({ usePathname: () => "/mentorship", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

let server: MentorshipServer;
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("consent", () => {
  it("asks for explicit consent, saying what is shared and that every read is logged, then grants it", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<OwnerMentorship />);
    const invite = await screen.findByRole("region", { name: /Mary Mentor \(mentor\) has been invited/ });
    expect(invite).toHaveTextContent("this month’s revenue, gross and net profit and cash position");
    expect(invite).toHaveTextContent("Every read is recorded");
    expect(invite).toHaveTextContent("end the engagement at any time");
    expect(await axeViolations()).toEqual([]);
    await user.click(within(invite).getByRole("button", { name: "I consent" }));
    expect(await screen.findByText(/Mary Mentor can now mentor Thika Agrovet/)).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-2/consent")).toEqual([undefined]);
    expect(server.engagements.find((e) => e.id === "e-2")?.status).toBe("ACTIVE");
  });

  it("declines an invitation, sharing nothing", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<OwnerMentorship />);
    const invite = await screen.findByRole("region", { name: /has been invited/ });
    await user.click(within(invite).getByRole("button", { name: "Decline" }));
    expect(await screen.findByText(/You declined Mary Mentor’s invitation. Nothing was shared./)).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-2/decline")).toEqual([undefined]);
    expect(posted(server, "/mentorship/engagements/e-2/consent")).toEqual([]);
  });
});

describe("an engagement on my business", () => {
  it("shows the access log of every read, the agreed plan, and lets me mark my own item done", async () => {
    server = installMentorshipServer();
    server.log.push({ id: "l-9", engagementId: "e-1", mentorId: "u-mentor", mentorName: "Mary Mentor", tenantId: "t-e-1", resource: "snapshot", viewedAt: "2026-11-09T07:30:00.000Z" });
    server.log.push({ id: "l-8", engagementId: "e-1", mentorId: "u-mentor", mentorName: "Mary Mentor", tenantId: "t-e-1", resource: "indicator:GROSS_MARGIN_PCT", viewedAt: "2026-11-08T07:30:00.000Z" });
    const user = userEvent.setup();
    show(<OwnerMentorship />);
    await user.click(await screen.findByRole("button", { name: "Mary Mentor · Active" }));
    const sheet = await screen.findByRole("dialog", { name: "Mentoring engagement" });
    const log = await within(sheet).findByRole("table", { name: /Every read of your business’s figures/ });
    const rows = within(log).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Mary MentorThis month’s figures (revenue, profit, cash)");
    expect(rows[1]).toHaveTextContent("A KPI: Gross margin (%)");
    expect(within(sheet).getByRole("region", { name: "Goals" })).toHaveTextContent("Grow monthly revenue · target KES 150,000.00On track");
    expect(within(sheet).getByRole("region", { name: "Agreed KPIs" })).toHaveTextContent("Target KES 100,000.00");

    // My item can be marked done; the mentor's cannot be by me.
    expect(within(sheet).queryByRole("button", { name: "Mark “Send pricing template” done" })).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole("button", { name: "Mark “Reconcile the till weekly” done" }));
    await waitFor(() => expect(posted(server, "/mentorship/my-action-items/a-1", "PATCH")).toEqual([{ status: "DONE" }]));
    await waitFor(() => expect(within(sheet).getByRole("listitem", { name: "Reconcile the till weekly" })).toHaveTextContent("Done"));
    expect(await axeViolations()).toEqual([]);
  });

  it("ends the engagement, after which the mentor can read nothing", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<OwnerMentorship />);
    await user.click(await screen.findByRole("button", { name: "Mary Mentor · Active" }));
    const sheet = await screen.findByRole("dialog", { name: "Mentoring engagement" });
    await user.click(await within(sheet).findByRole("button", { name: "End this engagement" }));
    await user.click(within(sheet).getByRole("button", { name: "Yes, end it" }));
    expect(await screen.findByText(/They can no longer read your figures/)).toBeInTheDocument();
    expect(posted(server, "/mentorship/engagements/e-1/end")).toEqual([{}]);
    expect(server.engagements.find((e) => e.id === "e-1")?.status).toBe("ENDED");
  });
});

describe("donor programmes", () => {
  it("explains that figures count only with consent, consents, withdraws, and shows the access log", async () => {
    server = installMentorshipServer();
    const user = userEvent.setup();
    show(<OwnerMentorship />);
    await user.click(await screen.findByRole("tab", { name: "Programmes" }));
    const programme = await screen.findByRole("region", { name: "Grow Kenya 2026" });
    expect(programme).toHaveTextContent("Awaiting your consent");
    expect(programme).toHaveTextContent("NOT read and not counted");
    await user.click(within(programme).getByRole("button", { name: "I consent" }));
    expect(await within(programme).findByText(/Your figures now count in Grow Kenya 2026’s cohort totals/)).toBeInTheDocument();
    expect(posted(server, "/donor-projects/my-memberships/m-1/consent")).toEqual([undefined]);
    await user.click(await within(programme).findByRole("button", { name: "Withdraw consent" }));
    expect(await within(programme).findByText(/no longer reads your figures/)).toBeInTheDocument();
    expect(posted(server, "/donor-projects/my-memberships/m-1/withdraw")).toEqual([undefined]);

    await user.click(within(programme).getByRole("button", { name: "Show the access log" }));
    const log = await within(programme).findByRole("list", { name: "Programme access log" });
    expect(log).toHaveTextContent("The programme’s cohort totals");
    expect(log).toHaveTextContent("by Grace Officer");
  });
});
