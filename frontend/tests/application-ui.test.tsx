// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SignupPage from "@/app/signup/page";
import { ApplicationStatus } from "@/components/application/application-status";
import { GuidedSetup } from "@/components/setup/guided-setup";
import type { Readiness } from "@/lib/dashboard/types";
import { applicableSteps, SETUP_STEPS } from "@/lib/setup/setup";
import { show } from "./support/mentorship";

// M4.5 W2, the applicant's half and the first-login setup: the six-step application (it explains
// why each sensitive item is asked for, saves a draft only once the owner's details are in, uploads
// the ID front and back, puts the backend's field errors back on their fields), the status page
// (the link's token leaves the address bar at once and goes only to the BFF), and the skippable
// guided setup (opening stock is not offered to a services-only business).

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

interface Sent {
  url: string;
  method: string;
  body: unknown;
  contentType: string | null;
}

let sent: Sent[];
let answers: Record<string, (sent: Sent) => Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const OPTIONS = { counties: ["Kilifi", "Mombasa", "Nakuru"], businessStructures: ["SOLE_PROPRIETOR", "PARTNERSHIP", "LIMITED_COMPANY"], taxRegimes: [], tiers: [], maxDocumentBytes: 5 * 1024 * 1024 };

beforeEach(() => {
  sent = [];
  answers = { "GET /api/application/options": () => json(200, OPTIONS) };
  push.mockReset();
  document.documentElement.lang = "en-KE";
  document.title = "Angaza360";
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const call: Sent = { url: input, method, body: typeof init.body === "string" ? JSON.parse(init.body) : init.body, contentType: headers.get("content-type") };
    sent.push(call);
    const answer = answers[`${method} ${new URL(input, "http://app.test").pathname}`];
    if (!answer) throw new TypeError("Failed to fetch");
    return answer(call);
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

async function violations(): Promise<string[]> {
  const result = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

const JPEG = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0xff, 0xd9])], "id-front.jpg", { type: "image/jpeg" });
const PNG = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "id-back.png", { type: "image/png" });

type User = ReturnType<typeof userEvent.setup>;

async function businessStep(user: User) {
  await user.type(screen.getByLabelText("Business name"), "Kilifi Fresh Produce");
  await user.click(screen.getByRole("radio", { name: /Sole proprietor/ }));
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: /Step 2 of 6/ });
  await user.type(screen.getByLabelText(/Where the business operates/), "Stall 4, Kilifi Market");
  await user.selectOptions(await screen.findByLabelText("County"), "Kilifi");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: /Step 3 of 6/ });
  await user.selectOptions(screen.getByLabelText("How is the business taxed?"), "TURNOVER_TAX");
  await user.click(screen.getByRole("button", { name: "Continue" }));
  await screen.findByRole("heading", { name: /Step 4 of 6/ });
}

async function ownerStep(user: User, phone = "0712 345 678") {
  await user.type(screen.getByLabelText(/Owner’s full legal name/), "Zawadi Mwangi");
  await user.type(screen.getByLabelText(/Owner’s email/), "zawadi@kilifi-fresh.co.ke");
  if (phone !== "") await user.type(screen.getByLabelText("Owner’s phone"), phone);
  await user.type(screen.getByLabelText(/Owner’s National ID number/), "12345678");
  await user.click(screen.getByRole("button", { name: "Continue" }));
}

/** The step-5 form, with the draft accepted. */
async function toIdStep(user: User) {
  answers["POST /api/application"] = () => json(201, { applicationId: "app-1" });
  answers["PATCH /api/application"] = () => new Response(null, { status: 204 });
  render(<SignupPage />);
  await businessStep(user);
  await ownerStep(user);
  await screen.findByRole("heading", { name: /Step 5 of 6/ });
}

describe("the business application form", () => {
  it("walks six steps, saves the draft once the owner is in, uploads both ID sides and submits", async () => {
    const user = userEvent.setup();
    answers["POST /api/application"] = () => json(201, { applicationId: "app-1" });
    answers["PATCH /api/application"] = () => new Response(null, { status: 204 });
    answers["PUT /api/application/documents/FRONT"] = () => json(201, { side: "FRONT" });
    answers["PUT /api/application/documents/BACK"] = () => json(201, { side: "BACK" });
    answers["POST /api/application/submit"] = () => json(202, { message: "Received." });
    render(<SignupPage />);
    expect(await violations()).toEqual([]);

    await businessStep(user);
    // Nothing is sent before the owner's details: a half-filled form is not stored anywhere.
    expect(sent.filter((s) => s.url !== "/api/application/options")).toEqual([]);
    expect(screen.getByText(/to verify the owner’s identity and prevent fraud/)).toBeInTheDocument();
    await ownerStep(user);

    await screen.findByRole("heading", { name: /Step 5 of 6/ });
    const created = sent.find((s) => s.method === "POST" && s.url === "/api/application");
    expect(created?.body).toMatchObject({
      businessName: "Kilifi Fresh Produce",
      businessStructure: "SOLE_PROPRIETOR",
      businessKraPin: null,
      physicalAddress: "Stall 4, Kilifi Market",
      county: "Kilifi",
      taxRegime: "TURNOVER_TAX",
      ownerFullName: "Zawadi Mwangi",
      ownerPhone: "+254712345678",
      ownerNationalId: "12345678",
    });
    expect(screen.getByText(/Kenya Data Protection Act/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    await user.upload(screen.getByLabelText("Front of the National ID"), JPEG);
    await user.upload(screen.getByLabelText("Back of the National ID"), PNG);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    const uploads = sent.filter((s) => s.method === "PUT");
    expect(uploads.map((u) => [u.url, u.contentType])).toEqual([
      ["/api/application/documents/FRONT", "image/jpeg"],
      ["/api/application/documents/BACK", "image/png"],
    ]);
    expect(await violations()).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: /Step 6 of 6/ });
    const review = screen.getByText("Owner’s National ID").closest("dl") as HTMLElement;
    expect(within(review).getByText("•••678")).toBeInTheDocument();
    expect(within(review).queryByText("12345678")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Submit the application" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/accept the Terms and Privacy Policy/);
    expect(sent.some((s) => s.url === "/api/application/submit")).toBe(false);
    await user.click(screen.getByRole("checkbox", { name: /I confirm these details are correct/ }));
    await user.click(screen.getByRole("button", { name: "Submit the application" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/application/status"));
  });

  it("asks a partnership or company for its own KRA PIN and a company for its registration number", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.type(screen.getByLabelText("Business name"), "Kilifi Fresh Ltd");
    await user.click(screen.getByRole("radio", { name: /Limited company/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("A company’s registration number is required.")).toBeInTheDocument();
    expect(screen.getByText("Enter the business’s own KRA PIN.")).toBeInTheDocument();
    expect(screen.getByText(/to meet the business’s tax obligations/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Step 1 of 6/ })).toBeInTheDocument();
    expect(sent.filter((s) => s.url !== "/api/application/options")).toEqual([]);
  });

  it("puts the backend's field errors back on their field and step", async () => {
    const user = userEvent.setup();
    answers["POST /api/application"] = () =>
      json(400, { statusCode: 400, error: "BadRequest", message: "businessName: Taken.", errors: [{ field: "businessName", message: "A business with that name is already registered. Pick another." }] });
    render(<SignupPage />);
    await businessStep(user);
    await ownerStep(user);
    expect(await screen.findByRole("heading", { name: /Step 1 of 6/ })).toBeInTheDocument();
    expect(screen.getByText(/already registered\. Pick another\./)).toBeInTheDocument();
    expect(screen.getByLabelText("Business name")).toHaveAttribute("aria-invalid", "true");
  });

  it("refuses a file that is not JPG, PNG or PDF before sending anything", async () => {
    const user = userEvent.setup({ applyAccept: false });
    answers["POST /api/application"] = () => json(201, { applicationId: "app-1" });
    answers["PATCH /api/application"] = () => new Response(null, { status: 204 });
    render(<SignupPage />);
    await businessStep(user);
    await ownerStep(user);
    await screen.findByRole("heading", { name: /Step 5 of 6/ });
    await user.upload(screen.getByLabelText("Front of the National ID"), new File(["<html>"], "id.html", { type: "text/html" }));
    expect(await screen.findByText("Choose a JPG, PNG or PDF file.")).toBeInTheDocument();
    expect(sent.some((s) => s.method === "PUT")).toBe(false);
  });

  it("clears a side, and a new file replaces an earlier rejection", async () => {
    const user = userEvent.setup();
    let refuse = true;
    answers["PUT /api/application/documents/FRONT"] = () =>
      refuse ? json(400, { statusCode: 400, error: "BadRequest", message: "The file contains content that an ID scan never does." }) : json(201, { side: "FRONT" });
    answers["PUT /api/application/documents/BACK"] = () => json(201, { side: "BACK" });
    await toIdStep(user);
    const front = screen.getByLabelText("Front of the National ID") as HTMLInputElement;

    // A refusal stays until something is done about it; Clear removes it.
    await user.upload(front, JPEG);
    expect(await screen.findByText(/never does/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear front" }));
    expect(screen.queryByText(/never does/)).not.toBeInTheDocument();
    expect(front.value).toBe("");

    // A NEW file clears the old message before it is judged, and an accepted one shows as uploaded.
    await user.upload(front, JPEG);
    expect(await screen.findByText(/never does/)).toBeInTheDocument();
    refuse = false;
    await user.upload(front, new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "clearer.jpg", { type: "image/jpeg" }));
    expect(await screen.findByText(/Uploaded: clearer\.jpg/)).toBeInTheDocument();
    expect(screen.queryByText(/never does/)).not.toBeInTheDocument();

    // Clearing an uploaded side means it must be uploaded again before continuing.
    await user.upload(screen.getByLabelText("Back of the National ID"), PNG);
    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "Clear back" }));
    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Clear back" })).not.toBeInTheDocument();
  });

  it("requires the owner's phone, defaults to Kenya, and sends it in E.164", async () => {
    const user = userEvent.setup();
    answers["POST /api/application"] = () => json(201, { applicationId: "app-1" });
    render(<SignupPage />);
    await businessStep(user);
    expect(screen.getByLabelText("Country code")).toHaveValue("KE");
    expect(screen.queryByText(/Owner’s phone \(optional\)/)).not.toBeInTheDocument();

    // Blank: refused before anything is sent.
    await ownerStep(user, "");
    expect(await screen.findByText("Enter the owner’s phone number.")).toBeInTheDocument();
    expect(screen.getByLabelText("Owner’s phone")).toHaveAttribute("aria-invalid", "true");
    expect(sent.some((s) => s.method === "POST" && s.url === "/api/application")).toBe(false);

    // Too short for a Kenyan number: refused too.
    await user.type(screen.getByLabelText("Owner’s phone"), "0712 345");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/Enter a valid phone number/)).toBeInTheDocument();

    // Another country, chosen from the list: its code is used and the leading 0 dropped.
    await user.clear(screen.getByLabelText("Owner’s phone"));
    await user.selectOptions(screen.getByLabelText("Country code"), "UG");
    await user.type(screen.getByLabelText("Owner’s phone"), "0772 123 456");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: /Step 5 of 6/ });
    expect(sent.find((s) => s.method === "POST" && s.url === "/api/application")?.body).toMatchObject({ ownerPhone: "+256772123456" });
  });

  it("shows the phone as it will be stored once the field is left, whichever way it was typed", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    await businessStep(user);
    const phone = screen.getByLabelText("Owner’s phone");
    for (const typed of ["0729866328", "254729866328", "729 866 328", "+254 729-866-328"]) {
      await user.clear(phone);
      await user.type(phone, typed);
      await user.tab();
      expect(phone).toHaveValue("+254729866328");
      expect(screen.getByLabelText("Country code")).toHaveValue("KE");
    }
    // A "+" number from another country moves the selector to that country.
    await user.clear(phone);
    await user.type(phone, "+2348012345678");
    await user.tab();
    expect(phone).toHaveValue("+2348012345678");
    expect(screen.getByLabelText("Country code")).toHaveValue("NG");
    // An unreadable number is left as typed for the check to name.
    await user.clear(phone);
    await user.type(phone, "0712 345");
    await user.tab();
    expect(phone).toHaveValue("0712 345");
  });

  it("names the plans in words, and sends the platform's tier", async () => {
    const user = userEvent.setup();
    render(<SignupPage />);
    await user.type(screen.getByLabelText("Business name"), "Kilifi Fresh Produce");
    await user.click(screen.getByRole("radio", { name: /Sole proprietor/ }));
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: /Step 2 of 6/ });
    await user.type(screen.getByLabelText(/Where the business operates/), "Stall 4, Kilifi Market");
    await user.selectOptions(await screen.findByLabelText("County"), "Kilifi");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    await screen.findByRole("heading", { name: /Step 3 of 6/ });
    const plan = screen.getByLabelText("Plan");
    expect(within(plan).getAllByRole("option").map((o) => [o.getAttribute("value"), o.textContent])).toEqual([
      ["", "Not sure yet"],
      ["MWANZO", "Starter"],
      ["UKUAJI", "Growth"],
      ["BIASHARA", "Business"],
      ["MSTAWI", "Scale"],
      ["ENTERPRISE", "Enterprise"],
    ]);
    expect(screen.getByText(/the team will confirm the plan with you/)).toBeInTheDocument();
  });
});

const STATUS = {
  status: "NEEDS_CHANGES",
  application: { businessName: "Kilifi Fresh Produce", ownerFullName: "Zawadi Mwangi", ownerNationalIdMasked: "•••••678", county: "Kilifi" },
  documents: [{ side: "FRONT", contentType: "image/jpeg", byteSize: 2048, uploadedAt: "2026-11-16T08:00:00.000Z", deleted: false }],
  changesRequested: "The ID photo is blurred — upload a clearer one.",
  rejectionReason: null,
  timeline: [
    { kind: "SUBMITTED", message: null, corrections: [], at: "2026-11-16T08:00:00.000Z" },
    { kind: "CORRECTED", message: null, corrections: [{ field: "county", from: "Kilif", to: "Kilifi" }], at: "2026-11-16T09:00:00.000Z" },
  ],
  nextActions: ["MAKE_CHANGES_AND_RESUBMIT"],
  editable: true,
};

describe("the applicant's status page", () => {
  it("hands the link's token to the BFF once, clears it from the address bar, and shows what to change", async () => {
    const token = "tok_status_0123456789abcdef";
    window.history.replaceState(null, "", `/application/status#${token}`);
    answers["POST /api/application/open"] = () => new Response(null, { status: 204 });
    answers["GET /api/application"] = () => json(200, STATUS);
    render(
      <main>
        <ApplicationStatus />
      </main>,
    );
    expect(await screen.findByRole("heading", { name: "Changes needed" })).toBeInTheDocument();
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(token);
    expect(sent[0]).toMatchObject({ url: "/api/application/open", method: "POST", body: { token } });
    expect(sent[1]).toMatchObject({ url: "/api/application", method: "GET" });
    expect(screen.getByText(/The ID photo is blurred/)).toBeInTheDocument();
    expect(screen.getByText(/County changed from “Kilif” to “Kilifi”/)).toBeInTheDocument();
    expect(screen.getByText("•••••678")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Make the changes" })).toHaveAttribute("href", "/application/edit");
    expect(await violations()).toEqual([]);
  });

  it("says so when the link has expired, without reading anything", async () => {
    window.history.replaceState(null, "", "/application/status#tok_expired_0123456789");
    answers["POST /api/application/open"] = () => json(404, { statusCode: 404, error: "NotFound", message: "Not found." });
    render(
      <main>
        <ApplicationStatus />
      </main>,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or is not complete/);
    expect(sent.map((s) => s.url)).toEqual(["/api/application/open"]);
  });

  it("shows the reason and a way to apply again for a rejected application", async () => {
    answers["GET /api/application"] = () =>
      json(200, { ...STATUS, status: "REJECTED", changesRequested: null, rejectionReason: "Not a Kenyan business.", nextActions: ["APPLY_AGAIN"], editable: false });
    render(
      <main>
        <ApplicationStatus />
      </main>,
    );
    expect(await screen.findByRole("heading", { name: "Not approved" })).toBeInTheDocument();
    expect(screen.getByText("Not a Kenyan business.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Apply again" })).toHaveAttribute("href", "/signup");
    expect(screen.queryByRole("link", { name: /Make the changes/ })).not.toBeInTheDocument();
  });
});

const check = (key: Readiness["checks"][number]["key"], pass: boolean): Readiness["checks"][number] => ({ key, label: key, required: true, pass, detail: key });
const READINESS: Readiness = {
  readyToTrade: false,
  checks: [check("ACTIVE_PRODUCT", true), check("STOCK_OR_SERVICE", true), check("TAX_REGIME_SET", true), check("FIRST_SALE", false), check("KRA_PIN", false), check("STAFF_BEYOND_OWNER", false)],
};

function setupServer(goods: number) {
  answers["GET /api/v1/dashboard/readiness"] = () => json(200, READINESS);
  answers["GET /api/v1/products"] = (call) =>
    json(200, { data: [], pagination: { total: new URL(call.url, "http://app.test").searchParams.get("kind") === "GOOD" ? goods : 3, take: 1, skip: 0 } });
}

describe("the first-login guided setup", () => {
  it("lists every step with its screen, takes done from the backend's readiness, and can be skipped", async () => {
    setupServer(2);
    window.localStorage.clear();
    const user = userEvent.setup();
    show(<GuidedSetup role="MSME_OWNER" businessName="Kilifi Fresh" />);
    const list = await screen.findByRole("list");
    await waitFor(() => expect(within(list).getByText(/Add what you sell/)).toHaveTextContent("done"));
    expect(within(list).getAllByRole("listitem")).toHaveLength(SETUP_STEPS.length);
    expect(within(list).getByText(/Record your opening stock/)).toBeInTheDocument();
    expect(within(list).getByRole("link", { name: "Invite staff" })).toHaveAttribute("href", "/people");
    expect(within(list).getByRole("link", { name: "Open integrations" })).toHaveAttribute("href", "/settings?tab=integrations");
    const branding = within(list).getByText(/Brand your receipts/).closest("li") as HTMLElement;
    await user.click(within(branding).getByRole("button", { name: "Skip" }));
    expect(within(branding).getByText(/Brand your receipts/)).toHaveTextContent("skipped");
    expect(JSON.parse(window.localStorage.getItem("ag_setup_marks") ?? "{}")).toEqual({ branding: "skipped" });
    await user.click(within(branding).getByRole("button", { name: "Undo" }));
    expect(within(branding).getByText(/Brand your receipts/)).toHaveTextContent("to do");
    expect(await violations()).toEqual([]);
  });

  it("does not offer opening stock to a business that sells only services", async () => {
    setupServer(0);
    show(<GuidedSetup role="MSME_OWNER" businessName="Kilifi Salon" />);
    const list = await screen.findByRole("list");
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(SETUP_STEPS.length - 1));
    expect(within(list).queryByText(/opening stock/)).not.toBeInTheDocument();
    expect(applicableSteps(true, false).some((s) => s.key === "stock")).toBe(false);
    expect(applicableSteps(false, false).some((s) => s.key === "stock")).toBe(true);
  });

  it("offers a manager only the screens a manager may open", async () => {
    setupServer(2);
    show(<GuidedSetup role="MSME_MANAGER" businessName="Kilifi Fresh" />);
    const list = await screen.findByRole("list");
    await within(list).findByRole("link", { name: "Open products" });
    expect(within(list).queryByRole("link", { name: "Invite staff" })).not.toBeInTheDocument();
  });
});
