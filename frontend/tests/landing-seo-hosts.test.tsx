// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hostConfig, hostKind, normalizeHost } from "@/lib/hosts";
import { proxy } from "@/proxy";

// The landing page's SEO (indexable, canonical on the apex, the og-image, truthful JSON-LD) and the
// apex/app hostname split (lib/hosts.ts, applied by proxy.ts to "/" only).

// next/font/local is compiled by Next's build, not by Vitest; stand it in for the layout import.
vi.mock("next/font/local", () => ({ default: () => ({ variable: "font-var", className: "font" }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const ROOT = process.cwd();

describe("the landing page's metadata", () => {
  it("is indexable, canonical on the apex, with its own title, description and the og-image", async () => {
    const { metadata } = await import("@/app/(marketing)/page");
    expect(metadata.robots).toEqual({ index: true, follow: true });
    expect(metadata.alternates?.canonical).toBe("/");
    expect(metadata.title).toEqual({ absolute: "Angaza360" });
    expect(metadata.description).toBe("All-in-one accounting, POS, inventory, payroll and KRA eTIMS compliance for Kenyan businesses.");
    expect(metadata.openGraph).toMatchObject({
      url: "/",
      locale: "en_KE",
      title: "Angaza360 - Point of sale, stock, books, payroll and KRA eTIMS for Kenyan businesses",
      images: [expect.objectContaining({ url: "/og-image.png", width: 1200, height: 630 })],
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", images: ["/og-image.png"] });
    // The canonical resolves against the root layout's metadataBase — the apex.
    const { metadata: root } = await import("@/app/layout");
    expect(new URL("/", root.metadataBase as URL).toString()).toBe("https://angaza360.co.ke/");
  });

  it("lives outside the (app) noindex group, with no layout of its own", () => {
    expect(existsSync(join(ROOT, "app", "(marketing)", "page.tsx"))).toBe(true);
    expect(existsSync(join(ROOT, "app", "(marketing)", "layout.tsx"))).toBe(false);
    expect(existsSync(join(ROOT, "app", "page.tsx"))).toBe(false);
  });

  it("renders valid JSON-LD: the Organization and the SoftwareApplication, the page's own FAQ, and nothing it cannot back", async () => {
    const { default: Home } = await import("@/app/(marketing)/page");
    const { container } = render(<Home />);
    const scripts = container.querySelectorAll('script[type="application/ld+json"]');
    expect(scripts).toHaveLength(2);
    // The FAQPage carries exactly the questions and answers the page shows (M4.5 W3).
    const faq = JSON.parse(scripts[1].innerHTML) as { "@type": string; mainEntity: Array<{ name: string; acceptedAnswer: { text: string } }> };
    expect(faq["@type"]).toBe("FAQPage");
    const shown = [...container.querySelectorAll("#faq details")].map((d) => [d.querySelector("h3")?.textContent, d.querySelector("p")?.textContent]);
    expect(faq.mainEntity.map((q) => [q.name, q.acceptedAnswer.text])).toEqual(shown);
    // No rating, review, offer or search claimed (as schema.org keys — the answers' own words may say "reviewed").
    expect(scripts[1].innerHTML).not.toMatch(/"(offers|aggregateRating|review|potentialAction)"\s*:|SearchAction/);
    const data = JSON.parse(scripts[0].innerHTML) as { "@context": string; "@graph": { "@type": string; url?: string }[] };
    expect(data["@context"]).toBe("https://schema.org");
    expect(data["@graph"].map((n) => n["@type"])).toEqual(["Organization", "SoftwareApplication"]);
    for (const node of data["@graph"]) expect(node.url).toBe("https://angaza360.co.ke/");
    expect(scripts[0].innerHTML).not.toMatch(/offers|aggregateRating|review|SearchAction/);
    expect(container.querySelectorAll("h1")).toHaveLength(1);
  });
});

describe("hosts", () => {
  it("normalises a host: lower case, no port, no trailing dot", () => {
    expect(normalizeHost("App.Angaza360.co.ke:443")).toBe("app.angaza360.co.ke");
    expect(normalizeHost("angaza360.co.ke.")).toBe("angaza360.co.ke");
    expect(normalizeHost("localhost:3000")).toBe("localhost");
    expect(normalizeHost("[::1]:3000")).toBe("[::1]");
    expect(normalizeHost(null)).toBe("");
  });

  it("defaults to the brand's apex and app.<apex>; env overrides each", () => {
    expect(hostConfig({})).toEqual({ marketingHost: "angaza360.co.ke", appHost: "app.angaza360.co.ke" });
    expect(hostConfig({ MARKETING_HOST: "example.test" })).toEqual({ marketingHost: "example.test", appHost: "app.example.test" });
    expect(hostConfig({ MARKETING_HOST: "example.test", APP_HOST: "office.example.test:443" })).toEqual({
      marketingHost: "example.test",
      appHost: "office.example.test",
    });
  });

  it("classifies the apex and www as marketing, the app host and a business subdomain as app, anything else as marketing", () => {
    const config = hostConfig({});
    expect(
      ["angaza360.co.ke", "www.angaza360.co.ke", "app.angaza360.co.ke", "nakuru-hardware.angaza360.co.ke", "localhost:3000", "127.0.0.1", "preview.vercel.app", ""].map(
        (h) => [h, hostKind(h, config)],
      ),
    ).toEqual([
      ["angaza360.co.ke", "marketing"],
      ["www.angaza360.co.ke", "marketing"],
      ["app.angaza360.co.ke", "app"],
      ["nakuru-hardware.angaza360.co.ke", "app"],
      ["localhost:3000", "marketing"],
      ["127.0.0.1", "marketing"],
      ["preview.vercel.app", "marketing"],
      ["", "marketing"],
    ]);
  });
});

describe("proxy: what / shows depends on the host", () => {
  const visit = (url: string, cookies: Record<string, string> = {}, host?: string) => {
    const headers = new Headers();
    const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (jar) headers.set("cookie", jar);
    if (host) headers.set("host", host);
    return proxy(new NextRequest(url, { headers }));
  };
  const location = (response: Response) => response.headers.get("location");

  it("localhost, by default: / is the landing", () => {
    const response = visit("http://localhost:3000/");
    expect([response.status, location(response)]).toEqual([200, null]);
  });

  it("the apex (and www): / is the landing", () => {
    for (const url of ["https://angaza360.co.ke/", "https://www.angaza360.co.ke/"]) {
      const response = visit(url);
      expect([url, response.status, location(response)]).toEqual([url, 200, null]);
    }
  });

  it("the app host and a business subdomain: an anonymous / goes to sign in", () => {
    expect(location(visit("https://app.angaza360.co.ke/"))).toBe("https://app.angaza360.co.ke/login");
    expect(location(visit("https://nakuru-hardware.angaza360.co.ke/"))).toBe("https://nakuru-hardware.angaza360.co.ke/login");
    // A session cookie the proxy cannot use (and cannot refresh) says why.
    expect(location(visit("https://app.angaza360.co.ke/", { ag_session: "" }))).toBe("https://app.angaza360.co.ke/login?reason=expired");
  });

  it("reads the Host header the request arrived with", () => {
    expect(location(visit("http://internal:3000/", {}, "app.angaza360.co.ke"))).toBe("http://internal:3000/login");
    expect(visit("http://internal:3000/", {}, "angaza360.co.ke").status).toBe(200);
  });

  it("follows MARKETING_HOST / APP_HOST from the environment", () => {
    vi.stubEnv("MARKETING_HOST", "example.test");
    vi.stubEnv("APP_HOST", "office.example.test");
    expect(visit("https://example.test/").status).toBe(200);
    expect(location(visit("https://office.example.test/"))).toBe("https://office.example.test/login");
    expect(location(visit("https://shop.example.test/"))).toBe("https://shop.example.test/login");
    // The brand's own hosts are no longer special under this configuration.
    expect(visit("https://app.angaza360.co.ke/").status).toBe(200);
  });

  it("a signed-in visitor goes to their workspace on either host; the rest of the app is unchanged", () => {
    expect(location(visit("https://angaza360.co.ke/", { ag_session: "x" }))).toBe("https://angaza360.co.ke/workspace");
    expect(location(visit("https://app.angaza360.co.ke/", { ag_session: "x" }))).toBe("https://app.angaza360.co.ke/workspace");
    // The apex still serves /login (it is indexable), and a protected page still needs a session.
    expect(visit("https://angaza360.co.ke/login").status).toBe(200);
    expect(location(visit("https://angaza360.co.ke/dashboard"))).toBe(`https://angaza360.co.ke/login?returnTo=${encodeURIComponent("/dashboard")}`);
  });
});
