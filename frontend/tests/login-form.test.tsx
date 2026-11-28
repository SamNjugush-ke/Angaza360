// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/login-form";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }) }));

interface Posted {
  url: string;
  init: RequestInit;
}

let posted: Posted[];

function backend(respond: () => Promise<Response> | Response) {
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    posted.push({ url, init });
    return respond();
  });
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  posted = [];
  push.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function fillAndSubmit(email = "amina@shop.co.ke", password = "correct horse", remember = false) {
  const user = userEvent.setup();
  if (email) await user.type(screen.getByLabelText("Email address"), email);
  if (password) await user.type(screen.getByLabelText("Password"), password);
  if (remember) await user.click(screen.getByLabelText("Keep me signed in"));
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  return user;
}

describe("LoginForm", () => {
  it("posts the credentials to the BFF and routes the user by role", async () => {
    backend(() => json(200, { user: { id: "u1" }, role: "CASHIER", tenant: null }));
    render(<LoginForm returnTo={null} />);
    await fillAndSubmit("amina@shop.co.ke", "correct horse", true);

    await waitFor(() => expect(push).toHaveBeenCalledWith("/pos"));
    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe("/api/auth/login");
    expect(posted[0].init.method).toBe("POST");
    expect(JSON.parse(posted[0].init.body as string)).toEqual({
      email: "amina@shop.co.ke",
      password: "correct horse",
      remember: true,
    });
  });

  it.each([
    ["MSME_OWNER", "/dashboard"],
    ["WAREHOUSE_STAFF", "/inventory"],
    ["HR_OFFICER", "/payroll"],
    ["COACH", "/mentorship"],
    ["PROGRAM_OFFICER", "/admin"],
  ])("lands a %s on %s", async (role, path) => {
    backend(() => json(200, { role }));
    render(<LoginForm returnTo={null} />);
    await fillAndSubmit();
    await waitFor(() => expect(push).toHaveBeenCalledWith(path));
  });

  it("returns to an allowed returnTo instead", async () => {
    backend(() => json(200, { role: "CASHIER" }));
    render(<LoginForm returnTo="/inventory/products" />);
    await fillAndSubmit();
    await waitFor(() => expect(push).toHaveBeenCalledWith("/inventory/products"));
  });

  it("shows the generic error on a 401 and stays on the page", async () => {
    backend(() => json(401, { statusCode: 401, error: "Unauthorized", message: "Invalid email or password." }));
    render(<LoginForm returnTo={null} />);
    await fillAndSubmit();

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password.");
    expect(push).not.toHaveBeenCalled();
    // The form can be tried again.
    expect(screen.getByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("shows the unavailable message on a 502 or an unreachable server", async () => {
    backend(() => json(502, { statusCode: 502, error: "BadGateway", message: "The sign-in service is unavailable." }));
    render(<LoginForm returnTo={null} />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Service is temporarily unavailable.");

    cleanup();
    backend(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<LoginForm returnTo={null} />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Service is temporarily unavailable.");
  });

  it("shows the server's message for an inactive business", async () => {
    backend(() => json(403, { statusCode: 403, error: "Forbidden", message: "Your tenant is not active." }));
    render(<LoginForm returnTo={null} />);
    await fillAndSubmit();
    expect(await screen.findByRole("alert")).toHaveTextContent("Your tenant is not active.");
  });

  it("validates before posting, wiring each error to its field", async () => {
    backend(() => json(200, { role: "CASHIER" }));
    render(<LoginForm returnTo={null} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Email address"), "not-an-email");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const email = screen.getByLabelText("Email address");
    const password = screen.getByLabelText("Password");
    expect(await screen.findByText("Enter a valid email address.")).toBeInTheDocument();
    expect(screen.getByText("Enter your password.")).toBeInTheDocument();
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAccessibleDescription("Enter a valid email address.");
    expect(password).toHaveAccessibleDescription("Enter your password.");
    expect(posted).toHaveLength(0);
  });

  it("disables the button while submitting", async () => {
    let release: (r: Response) => void = () => undefined;
    backend(() => new Promise<Response>((resolve) => (release = resolve)));
    render(<LoginForm returnTo={null} />);
    await fillAndSubmit();

    const button = await screen.findByRole("button", { name: "Signing in…" });
    expect(button).toBeDisabled();
    release(json(401, { statusCode: 401, error: "Unauthorized", message: "x" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeEnabled();
  });

  it("shows and hides the password", async () => {
    render(<LoginForm returnTo={null} />);
    const user = userEvent.setup();
    const password = screen.getByLabelText("Password");
    expect(password).toHaveAttribute("type", "password");
    await user.click(screen.getByRole("button", { name: "Show password" }));
    expect(password).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: "Hide password" })).toHaveAttribute("aria-pressed", "true");
    await user.click(screen.getByRole("button", { name: "Hide password" }));
    expect(password).toHaveAttribute("type", "password");
  });

  it("links to password reset", () => {
    render(<LoginForm returnTo={null} />);
    expect(screen.getByRole("link", { name: "Forgot password?" })).toHaveAttribute("href", "/forgot");
  });
});
