// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ForgotPasswordPage from "@/app/forgot/page";
import InviteCodePage from "@/app/invite/page";
import InvitePage from "@/app/invite/[token]/page";
import LoginPage from "@/app/login/page";
import { SENT_NOTICE } from "@/components/auth/forgot-flow";
import { INVALID_INVITATION } from "@/components/auth/invite-accept";
import { ToastProvider } from "@/components/toast/toast";
import { passwordStrength } from "@/lib/auth/password-strength";

// The public account flows end to end in the browser half: password recovery in two steps and
// accepting an invitation — each against a stubbed BFF, each with an axe pass over the page in
// its states. Tokens and passwords go only to the BFF.

const push = vi.fn();
vi.mock("next/navigation", () => ({ usePathname: () => "/", useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

interface Sent {
  url: string;
  method: string;
  body: unknown;
}

let sent: Sent[];
let answers: Record<string, () => Response>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const refusal = (status: number, message: string) => json(status, { statusCode: status, error: "BadRequest", message });

beforeEach(() => {
  sent = [];
  answers = {};
  push.mockReset();
  // What the root layout sets on every page.
  document.documentElement.lang = "en-KE";
  document.title = "Angaza360";
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    sent.push({ url, method, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const answer = answers[`${method} ${url}`];
    if (!answer) throw new TypeError("Failed to fetch");
    return answer();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function violations(): Promise<string[]> {
  const result = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

describe("password strength hint", () => {
  it("rates what was typed; only length is a rule", () => {
    expect(passwordStrength("short")).toBe("too-short");
    expect(passwordStrength("abcdefghij")).toBe("fair");
    expect(passwordStrength("abcdefghijkl")).toBe("good");
    expect(passwordStrength("Abcdefgh12!x")).toBe("strong");
    expect(passwordStrength("correct horse battery")).toBe("strong");
  });
});

describe("forgot password", () => {
  it("step 1 always says 'if an account exists', step 2 resets and goes to sign-in with a notice", async () => {
    const user = userEvent.setup();
    answers["POST /api/auth/password/forgot"] = () => json(202, { message: "ack" });
    answers["POST /api/auth/password/reset"] = () => new Response(null, { status: 204 });
    render(<ForgotPasswordPage />);
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);

    await user.type(screen.getByLabelText("Email address"), "amina@shop.co.ke");
    await user.click(screen.getByRole("button", { name: "Send reset code" }));
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent(SENT_NOTICE);
    expect(notice).toHaveFocus();
    expect(sent[0]).toEqual({ url: "/api/auth/password/forgot", method: "POST", body: { email: "amina@shop.co.ke" } });
    expect(await violations()).toEqual([]);

    await user.type(screen.getByLabelText("Reset code"), "  CODE-123  ");
    await user.type(screen.getByLabelText("New password"), "a long new password");
    expect(screen.getByText(/Strong\./)).toBeInTheDocument();
    await user.type(screen.getByLabelText("Confirm new password"), "a long new password");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login?reason=reset"));
    expect(sent[1]).toEqual({ url: "/api/auth/password/reset", method: "POST", body: { token: "CODE-123", newPassword: "a long new password" } });
  });

  it("shows the same step-2 notice whatever the email (the BFF's 202 is the only signal)", async () => {
    const user = userEvent.setup();
    answers["POST /api/auth/password/forgot"] = () => json(202, { message: "ack" });
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText("Email address"), "nobody@nowhere.test");
    await user.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(await screen.findByRole("status")).toHaveTextContent(SENT_NOTICE);
  });

  it("checks the password rules before sending, and shows the backend's refusal of a code", async () => {
    const user = userEvent.setup();
    answers["POST /api/auth/password/forgot"] = () => json(202, { message: "ack" });
    answers["POST /api/auth/password/reset"] = () => refusal(400, "This reset code is invalid or has expired.");
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText("Email address"), "amina@shop.co.ke");
    await user.click(screen.getByRole("button", { name: "Send reset code" }));
    await screen.findByRole("status");

    await user.type(screen.getByLabelText("Reset code"), "x");
    await user.type(screen.getByLabelText("New password"), "short");
    await user.type(screen.getByLabelText("Confirm new password"), "different");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByText("Use at least 10 characters.")).toBeInTheDocument();
    expect(screen.getByText("The two passwords do not match.")).toBeInTheDocument();
    expect(screen.getByLabelText("New password")).toHaveAttribute("aria-invalid", "true");
    expect(sent).toHaveLength(1);
    expect(await violations()).toEqual([]);

    await user.clear(screen.getByLabelText("New password"));
    await user.type(screen.getByLabelText("New password"), "a long new password");
    await user.clear(screen.getByLabelText("Confirm new password"));
    await user.type(screen.getByLabelText("Confirm new password"), "a long new password");
    await user.click(screen.getByRole("button", { name: "Reset password" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This reset code is invalid or has expired.");
    expect(push).not.toHaveBeenCalled();
  });

  it("says the service is unavailable when the BFF cannot be reached", async () => {
    const user = userEvent.setup();
    render(<ForgotPasswordPage />);
    await user.type(screen.getByLabelText("Email address"), "amina@shop.co.ke");
    await user.click(screen.getByRole("button", { name: "Send reset code" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
  });
});

const PREVIEW = { email: "kevin@test.co.ke", role: "CASHIER", businessName: "Nakuru Hardware", expiresAt: "2026-11-03T08:00:00.000Z" };

describe("accepting an invitation", () => {
  it("shows what the invitation offers, creates the account and goes to sign-in with a welcome", async () => {
    const user = userEvent.setup();
    answers["GET /api/users/invitations/tok-123"] = () => json(200, PREVIEW);
    answers["POST /api/users/invitations/tok-123/accept"] = () => json(201, { email: PREVIEW.email });
    render(await InvitePage({ params: Promise.resolve({ token: "tok-123" }) }));
    expect(await screen.findByText(/You’ve been invited to join/)).toHaveTextContent("Nakuru Hardware as Cashier");
    expect(screen.getByLabelText("Email address")).toHaveValue(PREVIEW.email);
    expect(screen.getByLabelText("Email address")).toHaveAttribute("readonly");
    expect(await violations()).toEqual([]);

    await user.type(screen.getByLabelText("Your full name"), "Kevin Otieno");
    await user.type(screen.getByLabelText("Choose a password"), "a long password");
    await user.type(screen.getByLabelText("Confirm password"), "a long password");
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/login?reason=welcome"));
    expect(sent[1]).toEqual({ url: "/api/users/invitations/tok-123/accept", method: "POST", body: { fullName: "Kevin Otieno", password: "a long password" } });
  });

  it("shows one invalid-or-expired state, never a form", async () => {
    answers["GET /api/users/invitations/gone"] = () => refusal(400, "This invitation is invalid or has expired. Ask for a new one.");
    render(await InvitePage({ params: Promise.resolve({ token: "gone" }) }));
    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_INVITATION);
    expect(screen.queryByLabelText("Choose a password")).not.toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("turns an invitation that lapsed while the page was open into the invalid state", async () => {
    const user = userEvent.setup();
    answers["GET /api/users/invitations/tok-123"] = () => json(200, PREVIEW);
    answers["POST /api/users/invitations/tok-123/accept"] = () => refusal(400, "This invitation is invalid or has expired. Ask for a new one.");
    render(await InvitePage({ params: Promise.resolve({ token: "tok-123" }) }));
    await user.type(await screen.findByLabelText("Your full name"), "Kevin Otieno");
    await user.type(screen.getByLabelText("Choose a password"), "a long password");
    await user.type(screen.getByLabelText("Confirm password"), "a long password");
    await user.click(screen.getByRole("button", { name: "Accept invitation" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(INVALID_INVITATION);
    expect(push).not.toHaveBeenCalled();
  });

  it("offers a retry when the service is unreachable", async () => {
    const user = userEvent.setup();
    render(await InvitePage({ params: Promise.resolve({ token: "tok-123" }) }));
    expect(await screen.findByRole("alert")).toHaveTextContent("temporarily unavailable");
    answers["GET /api/users/invitations/tok-123"] = () => json(200, PREVIEW);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/You’ve been invited to join/)).toBeInTheDocument();
  });

  it("the code page opens the invitation the code names", async () => {
    const user = userEvent.setup();
    render(<InviteCodePage />);
    expect(await violations()).toEqual([]);
    await user.type(screen.getByLabelText("Invitation code"), " tok-123 ");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(push).toHaveBeenCalledWith("/invite/tok-123");
  });
});

describe("the sign-in page's notices", () => {
  it.each([
    ["reset", "Password reset"],
    ["welcome", "Welcome — your account is ready"],
  ])("raises the %s notice", async (reason, title) => {
    render(await LoginPage({ searchParams: Promise.resolve({ reason }) }), { wrapper: ToastProvider });
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it("links to password recovery and the application", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({}) }), { wrapper: ToastProvider });
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot");
    expect(screen.getByRole("link", { name: "Apply to open an account" })).toHaveAttribute("href", "/signup");
  });
});
