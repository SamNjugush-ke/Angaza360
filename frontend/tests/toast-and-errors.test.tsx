// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoginNotice } from "@/components/auth/login-notice";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { SectionError } from "@/components/states/section-error";
import { DEFAULT_TOAST_MS, FAILURE_TITLE, ToastProvider, useToast, type ToastOptions } from "@/components/toast/toast";
import AppError from "@/app/(app)/error";
import GlobalError from "@/app/global-error";
import NotFound from "@/app/not-found";

let pathname = "/payroll";
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => router }));

beforeEach(() => {
  router.push.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Trigger({ options }: { options: ToastOptions | "failure" }) {
  const api = useToast();
  return (
    <button type="button" onClick={() => (options === "failure" ? api.failure() : api.toast(options))}>
      Raise
    </button>
  );
}

const region = () => screen.getByRole("region", { name: "Notifications" });
const live = () => within(region()).getByRole("status");

describe("toasts", () => {
  it("keeps one polite live region in the page before anything is announced", () => {
    render(<ToastProvider>body</ToastProvider>);
    expect(live()).toHaveAttribute("aria-live", "polite");
    expect(live()).toBeEmptyDOMElement();
  });

  it("announces a toast in the live region, and dismisses itself after its duration", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger options={{ title: "Saved", tone: "success" }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Raise" }));
    expect(live()).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_MS - 1));
    expect(live()).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(1));
    expect(live()).toBeEmptyDOMElement();
  });

  it("pauses while hovered, and a persistent toast stays until dismissed", () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Trigger options={{ title: "Hold on" }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Raise" }));
    fireEvent.mouseEnter(within(live()).getByText("Hold on").closest("[data-tone]") as HTMLElement);
    act(() => vi.advanceTimersByTime(DEFAULT_TOAST_MS * 3));
    expect(live()).toHaveTextContent("Hold on");
    cleanup();

    render(
      <ToastProvider>
        <Trigger options={{ title: "Stays", duration: null }} />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Raise" }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(live()).toHaveTextContent("Stays");
  });

  it("is dismissed by its button and by Escape, from the keyboard", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger options={{ title: "First", duration: null }} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Raise" }));
    await user.click(screen.getByRole("button", { name: "Raise" }));
    const dismissers = within(live()).getAllByRole("button", { name: "Dismiss: First" });
    expect(dismissers).toHaveLength(2);
    dismissers[0].focus();
    await user.keyboard("{Enter}");
    expect(within(live()).getAllByRole("button", { name: "Dismiss: First" })).toHaveLength(1);
    within(live()).getByRole("button", { name: "Dismiss: First" }).focus();
    await user.keyboard("{Escape}");
    expect(live()).toBeEmptyDOMElement();
  });

  it("gives every failed action the same generic notice", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger options="failure" />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Raise" }));
    expect(live()).toHaveTextContent(`${FAILURE_TITLE}Please try again.`);
  });

  it("animates only under motion-safe (prefers-reduced-motion is respected)", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger options={{ title: "Moves" }} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Raise" }));
    const classes = (within(live()).getByText("Moves").closest("[data-tone]") as HTMLElement).className.split(/\s+/);
    const motion = classes.filter((c) => /animate|fade|slide|transition/.test(c));
    expect(motion.length).toBeGreaterThan(0);
    for (const c of motion) expect(c.startsWith("motion-safe:")).toBe(true);
  });

  it("refuses to be used outside a provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Trigger options="failure" />)).toThrow(/ToastProvider/);
  });
});

describe("sign-out and session notices", () => {
  it("signs out to /login?reason=signed-out, where the sign-in page says so", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
    render(
      <ToastProvider>
        <SignOutButton />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(router.replace).toHaveBeenCalledWith("/login?reason=signed-out");
    cleanup();

    window.history.replaceState(null, "", "/login?reason=signed-out");
    render(
      <ToastProvider>
        <LoginNotice reason="signed-out" />
      </ToastProvider>,
    );
    expect(live()).toHaveTextContent("Signed out");
    expect(window.location.search).toBe("");
  });

  it("raises the generic failure toast when sign-out fails, and stays signed in", async () => {
    const user = userEvent.setup();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    render(
      <ToastProvider>
        <SignOutButton />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(live()).toHaveTextContent(FAILURE_TITLE);
    expect(router.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  it("shows the session-expiry notice until dismissed, once, keeping the returnTo", () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/login?reason=expired&returnTo=%2Fpayroll");
    const { rerender } = render(
      <ToastProvider>
        <LoginNotice reason="expired" />
      </ToastProvider>,
    );
    rerender(
      <ToastProvider>
        <LoginNotice reason="expired" />
      </ToastProvider>,
    );
    expect(within(live()).getAllByText("Your session has ended")).toHaveLength(1);
    act(() => vi.advanceTimersByTime(60_000));
    expect(live()).toHaveTextContent("Please sign in again.");
    expect(window.location.search).toBe("?returnTo=%2Fpayroll");
  });
});

describe("error and not-found boundaries", () => {
  const failure = Object.assign(new Error("payslip for jane@example.com, token eyJsecret"), { name: "TypeError", digest: "d1" });

  it("renders the branded 404 with a way home", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Angaza360" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to your home" })).toHaveAttribute("href", "/");
  });

  it("the in-shell error retries (refresh + reset), links home, and logs the error NAME only", async () => {
    const user = userEvent.setup();
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reset = vi.fn();
    render(<AppError error={failure} reset={reset} />);
    expect(screen.getByRole("heading", { level: 1, name: "Something went wrong" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(router.refresh).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go to your home" })).toHaveAttribute("href", "/");
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("TypeError");
    expect(logged).not.toMatch(/jane|eyJ|payslip/);
  });

  it("a data section shows the ErrorState with a retry, named from the nav", async () => {
    const user = userEvent.setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reset = vi.fn();
    pathname = "/payroll/runs/7";
    render(<SectionError error={failure} reset={reset} />);
    expect(screen.getByRole("heading", { level: 1, name: "Payroll" })).toBeInTheDocument();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load Payroll");
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalled();
  });

  it("the global fallback renders its own html and body, on the brand, without logging the message", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const html = renderToStaticMarkup(<GlobalError error={failure} reset={() => undefined} />);
    expect(html).toMatch(/^<html lang="en-KE">/);
    expect(html).toMatch(/<body class="bg-background[^"]*">/);
    expect(html).toContain('src="/brand/angaza360-logo.svg" alt="Angaza360"');
    expect(html).toContain("<h1");
    expect(html).toContain("Try again");
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/jane|eyJ/);
  });
});
