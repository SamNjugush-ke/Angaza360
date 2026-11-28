// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";
import { AccountSecurity } from "@/components/account/security";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// The staged sign-in and the account security page (M4.5 Wave 1), against stubbed BFF routes.

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

interface Posted {
  url: string;
  body: unknown;
}

let posted: Posted[];
let answers: Record<string, Array<() => Response>>;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function answer(url: string, ...responses: Array<() => Response>) {
  answers[url] = [...(answers[url] ?? []), ...responses];
}

beforeEach(() => {
  posted = [];
  answers = {};
  push.mockReset();
  vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
    posted.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    const queue = answers[url];
    const next = queue?.shift();
    if (!next) throw new TypeError(`no stub for ${url}`);
    return next();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function signIn() {
  const user = userEvent.setup();
  render(<LoginForm returnTo={null} />);
  await user.type(screen.getByLabelText("Email address"), "admin@angaza.test");
  await user.type(screen.getByLabelText("Password"), "correct horse");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("the second step at sign-in", () => {
  it("asks for the authenticator code, then lands the user", async () => {
    answer("/api/auth/login", () => json(200, { status: "MFA_REQUIRED" }));
    answer("/api/auth/login/mfa", () => json(200, { status: "AUTHENTICATED", role: "SUPER_ADMIN", user: {}, tenant: null }));
    const user = await signIn();
    expect(await screen.findByRole("heading", { name: "Two-step verification" })).toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
    const field = screen.getByLabelText("Authentication code");
    expect(field).toHaveAttribute("autocomplete", "one-time-code");
    expect(field).toHaveAttribute("inputmode", "numeric");
    await user.type(field, "12a3456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin"));
    expect(posted.at(-1)).toEqual({ url: "/api/auth/login/mfa", body: { code: "123456" } });
  });

  it("refuses a short code without calling the server, and says so on a wrong one", async () => {
    answer("/api/auth/login", () => json(200, { status: "MFA_REQUIRED" }));
    answer("/api/auth/login/mfa", () => json(401, { statusCode: 401, error: "InvalidCode", message: "That code is not valid." }));
    const user = await signIn();
    await user.type(await screen.findByLabelText("Authentication code"), "123");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the 6-digit code");
    expect(posted).toHaveLength(1);
    await user.type(screen.getByLabelText("Authentication code"), "456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("That code didn’t work");
    expect(push).not.toHaveBeenCalled();
  });

  it("offers a backup code instead", async () => {
    answer("/api/auth/login", () => json(200, { status: "MFA_REQUIRED" }));
    answer("/api/auth/login/mfa", () => json(200, { status: "AUTHENTICATED", role: "MSME_OWNER", user: {}, tenant: {} }));
    const user = await signIn();
    await user.click(await screen.findByRole("button", { name: "Lost your phone? Use a backup code" }));
    await user.type(screen.getByLabelText("Backup code"), "abcde-fghjk");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/dashboard"));
    expect(posted.at(-1)?.body).toEqual({ code: "ABCDE-FGHJK" });
  });

  it("an expired sign-in goes back to the password with the reason", async () => {
    answer("/api/auth/login", () => json(200, { status: "MFA_REQUIRED" }));
    answer("/api/auth/login/mfa", () => json(401, { statusCode: 401, error: "ChallengeInvalid", message: "Your sign-in has expired. Enter your email and password again." }));
    const user = await signIn();
    await user.type(await screen.findByLabelText("Authentication code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your sign-in has expired");
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });
});

describe("the forced new password", () => {
  it("cannot be skipped: it checks the two entries, then continues", async () => {
    answer("/api/auth/login", () => json(200, { status: "PASSWORD_RESET_REQUIRED" }));
    answer("/api/auth/login/password", () => json(200, { status: "AUTHENTICATED", role: "CASHIER", user: {}, tenant: {} }));
    const user = await signIn();
    expect(await screen.findByRole("heading", { name: "Choose a new password" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("New password"), "a-brand-new-password");
    await user.type(screen.getByLabelText("Confirm new password"), "a-different-password");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    expect(screen.getByText("The two passwords don’t match.")).toBeInTheDocument();
    expect(posted).toHaveLength(1);
    await user.clear(screen.getByLabelText("Confirm new password"));
    await user.type(screen.getByLabelText("Confirm new password"), "a-brand-new-password");
    await user.click(screen.getByRole("button", { name: "Set password and continue" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/pos"));
    expect(posted.at(-1)).toEqual({ url: "/api/auth/login/password", body: { newPassword: "a-brand-new-password" } });
  });
});

describe("an administrator's required enrolment", () => {
  it("shows the QR code and key, confirms, then holds the backup codes until they are saved", async () => {
    answer("/api/auth/login", () => json(200, { status: "MFA_ENROLLMENT_REQUIRED" }));
    answer("/api/auth/login/mfa-enrollment/start", () => json(200, { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/Angaza360:a?secret=JBSWY3DPEHPK3PXP" }));
    answer("/api/auth/login/mfa-enrollment/confirm", () =>
      json(200, { status: "AUTHENTICATED", role: "SUPER_ADMIN", user: {}, tenant: null, backupCodes: ["ABCDE-FGHJK", "KMNPQ-RSTVW"] }),
    );
    const user = await signIn();
    expect(await screen.findByRole("heading", { name: "Set up two-step verification" })).toBeInTheDocument();
    expect(await screen.findByAltText("QR code to add Angaza360 to your authenticator app")).toBeInTheDocument();
    expect(screen.getByText("JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Code from your app"), "654321");
    await user.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
    expect(await screen.findByRole("heading", { name: "Save your backup codes" })).toBeInTheDocument();
    expect(screen.getByText("ABCDE-FGHJK")).toBeInTheDocument();
    const go = screen.getByRole("button", { name: "Continue to Angaza360" });
    expect(go).toBeDisabled();
    expect(push).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("I have saved these codes"));
    await user.click(go);
    expect(push).toHaveBeenCalledWith("/admin");
  });
});

describe("the account security page", () => {
  function renderPage() {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AccountSecurity />
      </QueryClientProvider>,
    );
  }

  it("sets up opt-in two-step verification and shows the codes once", async () => {
    answer("/api/v1/auth/mfa", () => json(200, { enabled: false, required: false, enrolledAt: null, backupCodesRemaining: 0 }), () =>
      json(200, { enabled: true, required: false, enrolledAt: "2026-11-15T09:00:00.000Z", backupCodesRemaining: 10 }),
    );
    answer("/api/v1/auth/mfa/setup", () => json(200, { secret: "JBSWY3DPEHPK3PXP", otpauthUri: "otpauth://totp/x?secret=JBSWY3DPEHPK3PXP" }));
    answer("/api/v1/auth/mfa/confirm", () => json(200, { backupCodes: ["ABCDE-FGHJK"] }));
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole("button", { name: "Set up two-step verification" }));
    expect(await screen.findByAltText("QR code to add Angaza360 to your authenticator app")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Code from your app"), "123456");
    await user.click(screen.getByRole("button", { name: "Turn on two-step verification" }));
    expect(await screen.findByText("ABCDE-FGHJK")).toBeInTheDocument();
    await user.click(screen.getByLabelText("I have saved these codes"));
    await user.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByRole("heading", { name: "Two-step verification is on" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Turn off two-step verification" })).toBeInTheDocument();
  });

  it("an administrator sees it is required and has no way to turn it off", async () => {
    answer("/api/v1/auth/mfa", () => json(200, { enabled: true, required: true, enrolledAt: "2026-11-15T09:00:00.000Z", backupCodesRemaining: 9 }));
    renderPage();
    expect(await screen.findByText(/Your role requires it/)).toBeInTheDocument();
    expect(screen.getByText(/9 unused backup codes left/)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Turn off two-step verification" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Replace your backup codes" })).toBeInTheDocument();
  });
});
