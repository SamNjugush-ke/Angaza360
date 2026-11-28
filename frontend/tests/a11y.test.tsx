// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "@/components/shell/app-shell";
import type { ShellContext } from "@/components/shell/types";
import { SectionError } from "@/components/states/section-error";
import { NotAuthorizedState } from "@/components/states/states";
import { ToastProvider, useToast } from "@/components/toast/toast";
import AppError from "@/app/(app)/error";
import LoginPage from "@/app/login/page";
import NotFound from "@/app/not-found";
import type { Role } from "@/lib/auth/landing";
import { resolveWorkspace } from "@/lib/nav/workspace";

// The automated accessibility check (axe-core 4.14.0) over the sign-in page and the shell in
// every state a user can put it in. It runs the WCAG 2.0/2.1/2.2 A and AA rules plus axe's best
// practices and requires ZERO violations.
//
// jsdom loads no Tailwind CSS, so the rules that decide which bar a viewport shows are injected
// (desktop: lg:*; mobile: neither), the way the browser applies them — otherwise the hidden bar
// would count as visible. jsdom has no layout, so colour contrast and target size are not
// measurable here: contrast is proven from the tokens in tests/contrast.test.ts, and every
// control's 44px minimum is asserted below from its classes.

let pathname = "/dashboard";
const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ usePathname: () => pathname, useRouter: () => router }));

const LOCATIONS = [
  { id: "loc-main", name: "Main store", code: "MAIN", type: "MAIN", isDefault: true, isActive: true },
  { id: "loc-till", name: "Till 1", code: "TILL1", type: "POS", isDefault: false, isActive: true },
];

const VIEWPORT_CSS = {
  mobile: ".hidden{display:none}",
  desktop: ".hidden{display:none} .lg\\:hidden{display:none !important} .lg\\:flex{display:flex !important}",
} as const;
type Viewport = keyof typeof VIEWPORT_CSS;

let style: HTMLStyleElement;
function viewport(which: Viewport) {
  style.textContent = VIEWPORT_CSS[which];
}

beforeEach(() => {
  // What the root layout sets on every page.
  document.documentElement.lang = "en-KE";
  document.title = "Angaza360";
  style = document.head.appendChild(document.createElement("style"));
  viewport("desktop");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ data: LOCATIONS, count: 2 }), { status: 200 }));
});
afterEach(() => {
  cleanup();
  style.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function violations(): Promise<string[]> {
  const result = await axe.run(document, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, "target-size": { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
}

function context(role: Role): ShellContext {
  return {
    fullName: "Wanjiku Kamau",
    email: "wanjiku@nakuru-hardware.co.ke",
    role,
    workspace: resolveWorkspace(role),
    contextName: "Nakuru Hardware",
  };
}

async function shell(role: Role, at: string, page: ReactElement = <h1>Page body</h1>) {
  pathname = at;
  render(<AppShell context={context(role)}>{page}</AppShell>, { wrapper: ToastProvider });
  // Let the location selector settle (it loads through the BFF).
  await act(async () => undefined);
}

function RaiseFailure() {
  const { failure } = useToast();
  return (
    <button type="button" className="min-h-11" onClick={() => failure()}>
      Fail
    </button>
  );
}

describe("axe: the sign-in page", () => {
  it.each(["desktop", "mobile"] as const)("has no violations (%s)", async (which) => {
    viewport(which);
    render(await LoginPage({ searchParams: Promise.resolve({}) }), { wrapper: ToastProvider });
    expect(await violations()).toEqual([]);
  });

  it("has no violations with validation errors shown", async () => {
    const user = userEvent.setup();
    render(await LoginPage({ searchParams: Promise.resolve({}) }), { wrapper: ToastProvider });
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Enter your email address.")).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("has no violations with the session-expiry toast up", async () => {
    render(await LoginPage({ searchParams: Promise.resolve({ reason: "expired" }) }), { wrapper: ToastProvider });
    expect(await screen.findByText("Your session has ended")).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });
});

describe("axe: the shell", () => {
  it.each([
    ["MSME_OWNER", "/dashboard"],
    ["CASHIER", "/pos"],
    ["HR_OFFICER", "/payroll"],
    ["MENTOR", "/mentorship"],
    ["SUPER_ADMIN", "/admin/tenants"],
  ] as const)("has no violations for %s on desktop and mobile", async (role, at) => {
    await shell(role, at);
    // The injected rules really decide visibility: one bar per viewport.
    const toolbar = screen.getByRole("banner", { name: "Toolbar" });
    expect(getComputedStyle(toolbar).display).toBe("flex");
    expect(await violations()).toEqual([]);
    viewport("mobile");
    expect(getComputedStyle(toolbar).display).toBe("none");
    expect(await violations()).toEqual([]);
  });

  it("has no violations with the user menu open", async () => {
    const user = userEvent.setup();
    await shell("MSME_OWNER", "/dashboard");
    await user.click(within(screen.getByRole("banner", { name: "Toolbar" })).getByRole("button", { name: /^Account/ }));
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(1);
    expect(await violations()).toEqual([]);
  });

  it("has no violations with the More sheet open (mobile)", async () => {
    const user = userEvent.setup();
    viewport("mobile");
    await shell("MSME_OWNER", "/expenses");
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "More" }));
    expect(screen.getByRole("dialog", { name: "All sections" })).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("has no violations with a failure toast up", async () => {
    const user = userEvent.setup();
    await shell("MSME_OWNER", "/dashboard", <RaiseFailure />);
    await user.click(screen.getByRole("button", { name: "Fail" }));
    expect(within(screen.getByRole("region", { name: "Notifications" })).getByText("Something went wrong")).toBeInTheDocument();
    expect(await violations()).toEqual([]);
  });

  it("has no violations while the locations load, or when they fail", async () => {
    vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
    await shell("MSME_OWNER", "/dashboard");
    expect(await violations()).toEqual([]);
    cleanup();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }));
    await shell("MSME_OWNER", "/dashboard");
    expect(await violations()).toEqual([]);
  });

  it("has no violations on the 403, in-shell error and section error states", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = Object.assign(new Error("x"), { name: "Error" });
    await shell("CASHIER", "/payroll", <NotAuthorizedState section="Payroll" homeHref="/pos" />);
    expect(await violations()).toEqual([]);
    cleanup();
    await shell("MSME_OWNER", "/people", <AppError error={failure} reset={() => undefined} />);
    expect(await violations()).toEqual([]);
    cleanup();
    await shell("MSME_OWNER", "/payroll", <SectionError error={failure} reset={() => undefined} />);
    expect(await violations()).toEqual([]);
  });
});

describe("axe: the 404", () => {
  it("has no violations", async () => {
    render(<NotFound />);
    expect(await violations()).toEqual([]);
  });
});

describe("keyboard and targets", () => {
  it("the first Tab reaches the skip link, which moves focus to the content", async () => {
    const user = userEvent.setup();
    await shell("MSME_OWNER", "/dashboard");
    await user.tab();
    const skip = screen.getByRole("link", { name: "Skip to content" });
    expect(skip).toHaveFocus();
    expect(skip).toHaveAttribute("href", "#main");
    expect(document.getElementById("main")).toHaveAttribute("tabindex", "-1");
  });

  it("Tab order follows the page: skip link, sidebar nav, then the toolbar", async () => {
    const user = userEvent.setup();
    await shell("MSME_OWNER", "/dashboard");
    const order: string[] = [];
    for (let i = 0; i < 19; i += 1) {
      await user.tab();
      const el = document.activeElement as HTMLElement;
      const label = el instanceof HTMLSelectElement ? el.labels?.[0]?.textContent : el.getAttribute("aria-label");
      order.push(label ?? el.textContent?.trim() ?? el.tagName);
    }
    expect(order.slice(0, 3)).toEqual(["Skip to content", "Dashboard", "Point of Sale"]);
    const location = order.indexOf("Location");
    expect(order.indexOf("Mentorship")).toBeLessThan(location);
    expect(order.slice(location, location + 3)).toEqual(["Location", "New sale", "Account: Wanjiku Kamau"]);
  });

  it("the location selector is a labelled native select, operable from the keyboard", async () => {
    const user = userEvent.setup();
    await shell("MSME_OWNER", "/dashboard");
    const select = within(screen.getByRole("banner", { name: "Toolbar" })).getByRole("combobox", { name: "Location" });
    select.focus();
    await user.keyboard("{ArrowDown}");
    await user.selectOptions(select, "loc-till");
    expect(select).toHaveValue("loc-till");
  });

  it("every interactive control in the shell carries a 44px minimum (or is a native select of h/min-h 11)", async () => {
    const user = userEvent.setup();
    viewport("mobile");
    await shell("MSME_OWNER", "/dashboard", <RaiseFailure />);
    await user.click(screen.getByRole("button", { name: "Fail" }));
    await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "More" }));
    const MIN = /(^|\s)(min-h-11|min-h-14|h-11|size-11|h-14)(\s|$)/;
    const controls = Array.from(document.querySelectorAll<HTMLElement>("a[href], button, select, input:not([type=hidden])")).filter(
      (el) => el.textContent !== "Skip to content",
    );
    expect(controls.length).toBeGreaterThan(20);
    const small = controls.filter((el) => !MIN.test(el.className)).map((el) => el.getAttribute("aria-label") ?? el.textContent);
    expect(small).toEqual([]);
  });
});
