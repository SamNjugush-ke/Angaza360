// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LandingPage } from "@/components/landing/landing-page";
import { AGING, HERO_SALE, PAYSLIP, STATEMENT, sum } from "@/components/landing/figures";
import { CAPABILITIES, comingNext } from "@/lib/landing/content";
import { ROLE_LANDING } from "@/lib/auth/landing";
import { formatKES } from "@/lib/money";
import { axeViolations } from "./support/catalog";

// THE PUBLIC LANDING PAGE ("/"): what it says, what it links to, that its figures add up, and that
// it keeps the brand's rules (one h1, gold twice, mono for KES only, no arrows or mid-dots).

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (jar.has(name) ? { value: jar.get(name) as string } : undefined) }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`);
  },
}));

afterEach(() => {
  cleanup();
  jar.clear();
  vi.unstubAllGlobals();
});

const ROOT = process.cwd();
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");
const LANDING_SOURCES = [
  ...["landing-page.tsx", "hero-glimpse.tsx", "feature-glimpses.tsx", "figures.tsx", "device-frame.tsx", "glyphs.tsx", "vision-sections.tsx"].map((f) =>
    source(join("components", "landing", f)),
  ),
  source(join("lib", "landing", "content.ts")),
];

describe("the landing page", () => {
  it("has exactly one h1 and every section in order, each named by its heading", () => {
    render(<LandingPage />);
    const h1 = screen.getAllByRole("heading", { level: 1 });
    expect(h1).toHaveLength(1);
    expect(h1[0]).toHaveTextContent("Every sale, in proper books and ready for compliance.");
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Built for how Kenya does business",
      "The counter and the back office, in one place",
      "Features",
      "Made for the way your trade works",
      "Frequently Asked Questions (FAQ)",
      "Bring the counter and the books together.",
      "Product",
      "Contact",
      "Legal",
    ]);
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("carries the feature rows' real copy, in order", () => {
    render(<LandingPage />);
    const features = document.getElementById("features") as HTMLElement;
    expect(within(features).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Ring every sale - cash, M-Pesa or credit.",
      "Know what you have, and when to reorder.",
      "See who owes you, and who you owe.",
      "Proper books, without the headache.",
      "Pay your people, file the statutories.",
    ]);
    for (const point of ["M-Pesa STK prompts", "Split payments", "Instant receipts", "Shift close", "Stock across locations", "Purchase orders", "Goods receipts", "Customer accounts", "Supplier bills", "Statements", "Aging", "Double-entry ledger", "VAT or turnover tax", "eTIMS invoices", "Financial statements", "Employees", "Payroll runs", "PAYE, NSSF, SHIF and housing levy", "Payslips"]) {
      expect(within(features).getByText(point, { selector: "li" })).toBeInTheDocument();
    }
    const trust = screen.getByRole("heading", { name: "Built for how Kenya does business" }).closest("section") as HTMLElement;
    expect(within(trust).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "M-Pesa",
      "eTIMS invoices",
      "Real double-entry books",
      "Multi-till and locations",
    ]);
  });

  it("sends visitors to request access, sign in, and the page's own sections", () => {
    render(<LandingPage />);
    const requestAccess = screen.getAllByRole("link", { name: "Request access" });
    expect(requestAccess.length).toBeGreaterThanOrEqual(3);
    for (const link of requestAccess) expect(link).toHaveAttribute("href", "/signup");
    for (const link of screen.getAllByRole("link", { name: "Sign in" })) expect(link).toHaveAttribute("href", "/login");
    const main = screen.getByRole("navigation", { name: "Main" });
    expect(within(main).getAllByRole("link").map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Features", "#features"],
      ["FAQ", "#faq"],
    ]);
    for (const id of ["features", "industries", "faq", "capabilities", "main"]) expect(document.getElementById(id)).not.toBeNull();
    // The removed sections are gone, and nothing links to them.
    for (const id of ["pricing", "accountants"]) expect(document.getElementById(id)).toBeNull();
    for (const link of screen.getAllByRole("link")) expect(link.getAttribute("href") ?? "").not.toMatch(/#(pricing|accountants)$/);
    const product = screen.getByRole("navigation", { name: "Product" });
    expect(within(product).getAllByRole("link").map((a) => a.textContent)).toEqual(["Features", "Industries", "FAQ", "Request access"]);
    // The mobile menu is a native disclosure: no script needed to open it.
    expect(screen.getByRole("navigation", { name: "Menu" }).closest("details")).not.toBeNull();
  });

  it("shows every feature as an icon and a name, marks what is coming soon, and offers nothing coming to switch on", () => {
    render(<LandingPage />);
    const grid = screen.getByRole("list", { name: "Features" });
    const items = within(grid).getAllByRole("listitem");
    expect(items.map((li) => li.querySelector("p")?.textContent)).toEqual(CAPABILITIES.map((c) => c.name));
    for (const item of items) expect(item.querySelector("svg")).not.toBeNull();
    const coming = items.filter((li) => li.dataset.status === "coming");
    expect(coming.map((li) => li.querySelector("p")?.textContent)).toEqual([
      "Offline-capable point of sale",
      "Online storefront",
      "Business-to-business marketplace",
      "AI business advisory",
      "Business Trust Score",
      "Advanced business intelligence",
    ]);
    // A coming item carries the pill, and offers no link, button or form to activate it.
    for (const item of coming) {
      expect(item).toHaveTextContent("Coming Soon");
      expect(item.querySelector("a, button, form, input")).toBeNull();
    }
    // An available item carries no pill.
    for (const item of items.filter((li) => li.dataset.status === "available")) expect(item).not.toHaveTextContent("Coming Soon");
    // The only way in is still to apply: no call to action mentions a coming capability.
    for (const link of screen.getAllByRole("link")) {
      for (const item of comingNext()) expect(link.textContent ?? "").not.toContain(item.name);
    }
    // Flipping an item's status moves it: the page reads the list, not hard-coded copy.
    expect(CAPABILITIES.filter((c) => c.status === "available")).toHaveLength(8);
  });

  it("shows the industries it serves and answers the common questions, honestly", () => {
    render(<LandingPage />);
    const industries = document.getElementById("industries") as HTMLElement;
    expect(within(industries).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "Hardware stores",
      "Groceries and dukas",
      "Agrovets",
      "Salons and service businesses",
      "Several shops or tills",
    ]);
    const faq = document.getElementById("faq") as HTMLElement;
    const offline = within(faq).getByText("Does the till work without an internet connection?").closest("details") as HTMLElement;
    expect(offline).toHaveTextContent("Not yet.");
    expect(within(faq).getByText("How much does it cost?").closest("details")).toHaveTextContent("Prices are not published yet.");
    // The FAQ opens without script: native disclosures.
    expect(faq.querySelectorAll("details")).toHaveLength(9);
    // No testimonials, certifications or ratings anywhere on the page.
    expect(document.body.textContent ?? "").not.toMatch(/testimonial|certified|ISO \d|5 stars|rated/i);
  });

  it("states no price, and invents no contact address while none is configured", () => {
    render(<LandingPage />);
    const faq = document.getElementById("faq") as HTMLElement;
    expect(faq.textContent).toMatch(/Prices are not published yet/);
    expect(faq.textContent).not.toMatch(/KES|per month|free trial/i);
    expect(document.querySelector('a[href^="mailto:"]')).toBeNull();
  });

  it("the product glimpses are described illustrations whose figures add up", () => {
    render(<LandingPage />);
    const images = screen.getAllByRole("img").filter((el) => el.tagName === "DIV");
    expect(images).toHaveLength(6);
    for (const img of images) expect(img.getAttribute("aria-label")?.length).toBeGreaterThan(40);

    expect(HERO_SALE.subtotal + HERO_SALE.vat).toBe(HERO_SALE.total);
    expect(sum(HERO_SALE.tenders.map((t) => t.amount))).toBe(HERO_SALE.total);
    expect(formatKES(HERO_SALE.total, { currency: true })).toBe("KES 3,712.00");
    expect(formatKES(HERO_SALE.vat)).toBe("512.00");
    expect(formatKES(PAYSLIP.net)).toBe("70,441.65");
    expect(PAYSLIP.gross - sum(PAYSLIP.deductions.map((d) => d.amount))).toBe(PAYSLIP.net);
    expect(STATEMENT.revenue - STATEMENT.costOfSales - STATEMENT.expenses).toBe(STATEMENT.net);
    expect(formatKES(sum(AGING.receivable.map((r) => r.amount)))).toBe("53,250.00");

    const hero = screen.getByRole("img", { name: /The Angaza360 till/ });
    expect(hero.getAttribute("aria-label")).toContain("KES 2,000.00 in cash and KES 1,712.00 by M-Pesa");
    expect(hero.textContent).toContain("eTIMS invoice");
  });

  it("uses IBM Plex Mono only for KES figures", () => {
    render(<LandingPage />);
    const mono = [...document.querySelectorAll(".font-mono")].map((el) => el.textContent ?? "");
    expect(mono.length).toBeGreaterThan(20);
    for (const text of mono) expect(text).toMatch(/^(KES )?\d{1,3}(,\d{3})*\.\d{2}$/);
  });

  it("keeps gold to ONE metric and ONE underline, and the copy free of arrows, mid-dots and caps eyebrows", () => {
    const all = LANDING_SOURCES.join("\n");
    expect(all.match(/text-angaza-gold/g)).toHaveLength(1);
    expect(all.match(/decoration-angaza-gold/g)).toHaveLength(1);
    expect(all).not.toMatch(/(bg|fill|stroke|border)-angaza-gold/);
    expect(all).not.toMatch(/uppercase/);
    render(<LandingPage />);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/[→·—]/);
    expect(text).not.toMatch(/\b0[1-9]\b/);
  });

  it("forces the light Precision palette and gives the hero its single entrance", () => {
    render(<LandingPage />);
    expect(document.querySelector(".landing")).not.toBeNull();
    expect(document.querySelectorAll(".landing-rise").length).toBeGreaterThan(0);
    for (const el of document.querySelectorAll(".landing-rise")) expect(el.closest("section")?.getAttribute("aria-labelledby")).toBe("hero-title");
    const css = source(join("app", "globals.css"));
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.landing-rise \{\s*animation: none;/);
  });

  it("is accessible (axe)", async () => {
    render(<LandingPage />);
    expect(await axeViolations()).toEqual([]);
  });
});

describe("/ for a signed-in visitor: /workspace resolves their workspace", () => {
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends a signed-in visitor to their role's landing", async () => {
    jar.set("ag_session", "access-1");
    vi.stubGlobal("fetch", async () =>
      json(200, {
        user: { id: "u1", fullName: "Amina", email: "a@shop.co.ke", role: "CASHIER", isActive: true },
        role: "CASHIER",
        tenant: { id: "t1", name: "Shop", subdomain: "shop", status: "ACTIVE", subscriptionTier: "MWANZO" },
      }),
    );
    const { default: Workspace } = await import("@/app/workspace/page");
    await expect(Workspace()).rejects.toThrow(`REDIRECT ${ROLE_LANDING.CASHIER}`);
  });

  it("sends a visitor whose session the backend refuses to sign in again", async () => {
    jar.set("ag_session", "stale");
    vi.stubGlobal("fetch", async () => json(401, { statusCode: 401, error: "Unauthorized", message: "no" }));
    const { default: Workspace } = await import("@/app/workspace/page");
    await expect(Workspace()).rejects.toThrow("REDIRECT /login?reason=expired");
  });

  it("is noindex, and the landing is static", async () => {
    const { metadata } = await import("@/app/workspace/page");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    const landing = await import("@/app/(marketing)/page");
    expect(landing.dynamic).toBe("force-static");
  });
});
