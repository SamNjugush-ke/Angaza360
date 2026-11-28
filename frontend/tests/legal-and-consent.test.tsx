// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metadata } from "next";

// THE PUBLIC LEGAL PAGES AND THE COOKIE BANNER (M4.5 Wave 2).
// * Each page is public, INDEXABLE, canonical, in the sitemap, with ONE h1.
// * The copy is the project's legal text VERBATIM: every word of the source renders, nothing is
//   added, and an unset operator detail is a visible "[to be completed]" — never a made-up value.
// * The banner: analytics off until accepted; the choice recorded (what, version, when); changeable.

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/" }));

const ROOT = join(__dirname, "..");
const LEGAL_ENV = [
  "NEXT_PUBLIC_LEGAL_ENTITY",
  "NEXT_PUBLIC_LEGAL_REGISTERED_ADDRESS",
  "NEXT_PUBLIC_LEGAL_DPO_NAME",
  "NEXT_PUBLIC_LEGAL_DPO_EMAIL",
  "NEXT_PUBLIC_LEGAL_SUPPORT_EMAIL",
  "NEXT_PUBLIC_CONTACT_EMAIL",
  "NEXT_PUBLIC_LEGAL_ODPC_REG_NO",
  "NEXT_PUBLIC_LEGAL_EFFECTIVE_DATE",
  "NEXT_PUBLIC_LEGAL_GOVERNING_COUNTY",
  "NEXT_PUBLIC_LEGAL_REVIEWED",
];

beforeEach(() => {
  for (const name of LEGAL_ENV) vi.stubEnv(name, "");
  vi.resetModules();
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Path=/; Max-Age=0`;
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const VISIBLE = [
  ["/privacy", "@/app/(marketing)/privacy/page", "PRIVACY_POLICY", "Privacy Policy"],
  ["/terms", "@/app/(marketing)/terms/page", "TERMS_OF_SERVICE", "Terms of Service"],
  ["/cookies", "@/app/(marketing)/cookies/page", "COOKIE_POLICY", "Cookie Policy"],
  ["/acceptable-use", "@/app/(marketing)/acceptable-use/page", "ACCEPTABLE_USE_POLICY", "Acceptable Use Policy"],
  ["/contact", "@/app/(marketing)/contact/page", "CONTACT", "Contact"],
] as const;

const HIDDEN = [
  ["/billing-policy", "@/app/(marketing)/billing-policy/page", "BILLING_POLICY", "Billing, Cancellation and Refund Policy"],
  ["/data-processing-agreement", "@/app/(marketing)/data-processing-agreement/page", "DATA_PROCESSING_AGREEMENT", "Data Processing Agreement"],
  ["/subprocessors", "@/app/(marketing)/subprocessors/page", "SUBPROCESSORS", "Service Providers and Data Transfers"],
  ["/security", "@/app/(marketing)/security/page", "SECURITY", "Security and Responsible Disclosure"],
] as const;

/** The source's words with markup, headings and link syntax stripped — what a reader must see. */
function plainPieces(markdown: string): string[] {
  return markdown
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/`?\[\[[^\]]+\]\]`?/g, "\u0000")
    .replace(/\*\*|`|^- /gm, "")
    .replace(/\*/g, "")
    .split("\u0000")
    .map((piece) => normal(piece))
    .filter((piece) => piece !== "");
}

/** Whitespace dropped: headings, paragraphs and list items render back to back. */
const normal = (text: string) => text.replace(/\s+/g, "");

describe("the legal pages", () => {
  it.each(VISIBLE)("%s is public, indexable, canonical, has one h1, and renders the final copy verbatim", async (path, modulePath, constant, title) => {
    const page = (await import(/* @vite-ignore */ modulePath)) as { default: () => React.ReactElement; metadata: Metadata };
    expect(page.metadata.robots).toEqual({ index: true, follow: true });
    expect(page.metadata.alternates?.canonical).toBe(path);
    render(page.default());
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(title);

    const content = (await import("@/lib/legal/content")) as unknown as Record<string, { body: string }>;
    const source = content[constant]?.body ?? "";
    const article = normal(document.querySelector("article")?.textContent ?? "");
    for (const piece of plainPieces(source)) expect(article).toContain(piece);
    const raw = document.querySelector("article")?.textContent ?? "";
    expect(raw).not.toContain("](");
    expect(raw).not.toContain("[[");
    expect(raw).not.toContain("[to be completed]");
    expect(raw).not.toContain("Draft —");
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it.each(HIDDEN)("%s renders with one h1 but is noindex and not in the footer or sitemap", async (path, modulePath, constant, title) => {
    const page = (await import(/* @vite-ignore */ modulePath)) as { default: () => React.ReactElement; metadata: Metadata };
    expect(page.metadata.robots).toEqual({ index: false, follow: true });
    render(page.default());
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(title);
    const content = (await import("@/lib/legal/content")) as unknown as Record<string, { body: string }>;
    const article = normal(document.querySelector("article")?.textContent ?? "");
    for (const piece of plainPieces(content[constant]?.body ?? "")) expect(article).toContain(piece);

    const { LEGAL_PAGES } = await import("@/lib/legal/config");
    expect(LEGAL_PAGES.map((p) => p.href)).not.toContain(path);
    const urls = (await import("@/app/sitemap")).default().map((entry) => new URL(entry.url).pathname);
    expect(urls).not.toContain(path);
  });

  it("the Terms and Privacy pages cross-link to the hidden pages", async () => {
    const terms = (await import("@/app/(marketing)/terms/page")) as { default: () => React.ReactElement };
    render(terms.default());
    for (const href of ["/data-processing-agreement", "/billing-policy", "/privacy", "/acceptable-use", "/contact"]) {
      expect(document.querySelector(`article a[href="${href}"]`)).not.toBeNull();
    }
    cleanup();
    const privacy = (await import("@/app/(marketing)/privacy/page")) as { default: () => React.ReactElement };
    render(privacy.default());
    for (const href of ["/data-processing-agreement", "/subprocessors", "/contact"]) {
      expect(document.querySelector(`article a[href="${href}"]`)).not.toBeNull();
    }
  });

  it("the footer shows exactly the five visible pages — never the hidden ones", async () => {
    const { LandingPage } = await import("@/components/landing/landing-page");
    render(<LandingPage />);
    const legal = screen.getAllByRole("navigation", { name: "Legal" })[0];
    for (const label of ["Privacy Policy", "Terms of Service", "Cookie Policy", "Acceptable Use Policy"]) {
      expect(legal).toContainElement(screen.getAllByRole("link", { name: label })[0] ?? null);
    }
    expect(screen.getByRole("link", { name: "How to reach us" })).toHaveAttribute("href", "/contact");
    for (const hidden of ["/billing-policy", "/data-processing-agreement", "/subprocessors", "/security"]) {
      expect(legal?.querySelector(`a[href="${hidden}"]`)).toBeNull();
    }
    cleanup();
    for (const source of ["app/login/page.tsx", "app/signup/page.tsx"]) {
      expect(readFileSync(join(ROOT, source), "utf8")).toContain("<LegalLinks />");
    }
  });

  it("the five visible pages are in the sitemap and none is disallowed by robots", async () => {
    const sitemap = (await import("@/app/sitemap")).default();
    const urls = sitemap.map((entry) => new URL(entry.url).pathname);
    const robots = (await import("@/app/robots")).default();
    const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    for (const path of ["/privacy", "/terms", "/cookies", "/acceptable-use", "/contact"]) {
      expect(urls).toContain(path);
      expect(rule?.disallow).not.toContain(path);
    }
  });

  it("/contact shows the operator email and website, and no unfilled marker", async () => {
    const page = (await import("@/app/(marketing)/contact/page")) as { default: () => React.ReactElement; metadata: Metadata };
    expect(page.metadata.robots).toEqual({ index: true, follow: true });
    render(page.default());
    const main = document.querySelector("main");
    expect(main?.querySelector('a[href="mailto:info@angazafuture.org"]')).not.toBeNull();
    expect(main?.querySelector('a[href="https://www.angaza360.co.ke/"]')).not.toBeNull();
    expect(main?.textContent ?? "").toContain("Angaza Future International");
    expect(screen.queryByText("[to be completed]")).not.toBeInTheDocument();
  });
});

describe("the cookie banner", () => {
  async function mount(measurementId = "G-TEST") {
    const { CookieBanner, CookieSettingsButton } = await import("@/components/consent/cookie-consent");
    const { Analytics } = await import("@/components/analytics/analytics");
    render(
      <>
        <Analytics measurementId={measurementId} />
        <CookieBanner />
        <CookieSettingsButton />
      </>,
    );
    await act(async () => undefined);
  }
  const slot = () => document.querySelector("[data-analytics-slot]");

  it("asks on a first visit; analytics stays off until accepted, and the choice is recorded", async () => {
    await mount();
    expect(screen.getByRole("region", { name: "Cookies on Angaza360" })).toBeInTheDocument();
    expect(slot()).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept analytics" }));
    expect(screen.queryByRole("region", { name: "Cookies on Angaza360" })).not.toBeInTheDocument();
    expect(slot()).not.toBeNull();
    const { readConsentRecord, CONSENT_VERSION } = await import("@/lib/analytics/consent");
    expect(readConsentRecord(document.cookie)).toMatchObject({ version: CONSENT_VERSION, value: "granted" });
  });

  it("declining is one click, and consent can be withdrawn later from Cookie settings", async () => {
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Accept analytics" }));
    expect(slot()).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Cookie settings" }));
    expect(screen.getByRole("status")).toHaveTextContent("Analytics is currently allowed.");
    await user.click(screen.getByRole("button", { name: "Essential only" }));
    expect(slot()).toBeNull();
    const { readAnalyticsConsent } = await import("@/lib/analytics/consent");
    expect(readAnalyticsConsent(document.cookie)).toBe("denied");
  });

  it("asks again when the policy version changes", async () => {
    document.cookie = "ag_analytics_consent=granted; Path=/";
    document.cookie = `ag_consent_record=${encodeURIComponent("0|granted|2026-01-01T00:00:00.000Z")}; Path=/`;
    await mount();
    expect(screen.getByRole("region", { name: "Cookies on Angaza360" })).toBeInTheDocument();
  });

  it("does not ask again once answered under the current version", async () => {
    const { setAnalyticsConsent } = await import("@/lib/analytics/consent");
    setAnalyticsConsent("denied");
    await mount();
    expect(screen.queryByRole("region", { name: "Cookies on Angaza360" })).not.toBeInTheDocument();
    expect(slot()).toBeNull();
  });
});
