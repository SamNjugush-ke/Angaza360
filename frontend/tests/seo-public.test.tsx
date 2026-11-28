// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Analytics } from "@/components/analytics/analytics";
import { JsonLd, publicEntryStructuredData } from "@/components/seo/json-ld";
import { analyticsEnabled, CONSENT_COOKIE, readAnalyticsConsent } from "@/lib/analytics/consent";
import { PROTECTED_PREFIXES } from "@/lib/auth/landing";

// next/font/local is compiled by Next's build, not by Vitest; stand it in for the layout import.
vi.mock("next/font/local", () => ({ default: () => ({ variable: "font-var", className: "font" }) }));
vi.mock("next/navigation", () => ({ usePathname: () => "/login", useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const ROOT = process.cwd();
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");

afterEach(() => {
  cleanup();
  document.cookie = `${CONSENT_COOKIE}=; path=/; max-age=0`;
});

describe("metadata", () => {
  it("resolves against the APEX host, with the og-image on Open Graph and a large Twitter card", async () => {
    const { metadata } = await import("@/app/layout");
    expect(metadata.metadataBase?.toString()).toBe("https://angaza360.co.ke/");
    expect(metadata.openGraph?.images).toEqual([expect.objectContaining({ url: "/og-image.png", width: 1200, height: 630 })]);
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", images: ["/og-image.png"] });
  });

  it.each([
    ["@/app/login/page", "/login", true],
    ["@/app/forgot/page", "/forgot", false],
    ["@/app/signup/page", "/signup", true],
    ["@/app/invite/page", "/invite", false],
  ] as const)("%s has its own title, description, canonical, OG and Twitter card", async (module, path, indexable) => {
    const { metadata } = (await import(/* @vite-ignore */ module)) as { metadata: import("next").Metadata };
    expect(typeof metadata.title).toBe("string");
    expect(metadata.description?.length).toBeGreaterThan(30);
    expect(metadata.alternates?.canonical).toBe(path);
    expect(metadata.openGraph).toMatchObject({ url: path, images: [expect.objectContaining({ url: "/og-image.png" })] });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image", images: ["/og-image.png"] });
    expect(metadata.robots).toEqual(indexable ? undefined : { index: false, follow: true });
  });

  it("every page in the authenticated area is under the noindex layout and none overrides it", async () => {
    const { metadata } = await import("@/app/(app)/layout");
    expect(metadata.robots).toEqual({ index: false, follow: false });
    const pages: string[] = [];
    (function walk(dir: string) {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/^(page|layout)\.tsx$/.test(name)) pages.push(full);
      }
    })(join(ROOT, "app", "(app)"));
    for (const page of pages) expect([page, /robots\s*:/.test(readFileSync(page, "utf8")) && !page.endsWith(join("(app)", "layout.tsx"))]).toEqual([page, false]);
  });
});

describe("robots and sitemap", () => {
  it("the invitation and reset pages send no Referer, and an invitation's own page has no canonical", async () => {
    for (const page of ["@/app/forgot/page", "@/app/invite/page", "@/app/invite/[token]/page"]) {
      const { metadata } = (await import(/* @vite-ignore */ page)) as { metadata: import("next").Metadata };
      expect([page, metadata.referrer]).toEqual([page, "no-referrer"]);
    }
    const { metadata } = (await import("@/app/invite/[token]/page")) as { metadata: import("next").Metadata };
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(metadata.alternates).toBeUndefined();
  });

  it("robots allows the public site (the landing included) and disallows exactly the app, admin, mentorship and API areas, /invite, /workspace and the applicant pages (/application)", async () => {
    const robots = (await import("@/app/robots")).default();
    const rule = Array.isArray(robots.rules) ? robots.rules[0] : robots.rules;
    expect(rule.userAgent).toBe("*");
    expect(rule.allow).toBe("/");
    expect([...(rule.disallow as string[])].sort()).toEqual(
      [
        "/dashboard", "/pos", "/inventory", "/payroll", "/mentorship", "/admin", "/account", "/api", "/customers",
        "/expenses", "/accounting", "/tax", "/products", "/sales", "/procurement", "/people", "/settings", "/invite", "/workspace", "/application", "/setup", "/exports",
      ].sort(),
    );
    expect(robots.sitemap).toBe("https://angaza360.co.ke/sitemap.xml");
  });

  it("the sitemap lists only public, indexable routes on the apex", async () => {
    const urls = (await import("@/app/sitemap")).default().map((entry) => entry.url);
    expect(urls).toEqual(
      ["/", "/login", "/signup", "/privacy", "/terms", "/cookies", "/acceptable-use", "/contact"].map((path) => `https://angaza360.co.ke${path}`),
    );
    for (const url of urls) {
      const path = new URL(url).pathname;
      expect(PROTECTED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))).toBe(false);
    }
  });
});

describe("JSON-LD is truthful", () => {
  const data = publicEntryStructuredData();
  const json = JSON.stringify(data);

  it("describes the Organization and the SoftwareApplication — nothing else", () => {
    const graph = data["@graph"] as { "@type": string }[];
    expect(graph.map((node) => node["@type"])).toEqual(["Organization", "SoftwareApplication"]);
    expect(graph[0]).toMatchObject({ name: "Angaza360", url: "https://angaza360.co.ke/", logo: "https://angaza360.co.ke/icons/icon-512.png" });
    expect(graph[1]).toMatchObject({ applicationCategory: "BusinessApplication", operatingSystem: "Web" });
  });

  it("claims no search, rating, review or offer", () => {
    for (const claim of ["WebSite", "SearchAction", "potentialAction", "aggregateRating", "review", "offers"]) {
      expect(json).not.toContain(claim);
    }
  });

  it("renders as an escaped application/ld+json script on the sign-in page", () => {
    const { container } = render(<JsonLd data={{ name: "</script><b>x" }} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.innerHTML).toBe('{"name":"\\u003c/script>\\u003cb>x"}');
    expect(source("app/login/page.tsx")).toContain("<JsonLd data={publicEntryStructuredData()} />");
  });
});

describe("assets", () => {
  it("public/og-image.png is a 1200×630 PNG", () => {
    const png = readFileSync(join(ROOT, "public", "og-image.png"));
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it("the fonts are vendored OFL woff2 files with their licences — no Google fetch", () => {
    const layout = source("app/layout.tsx");
    expect(layout).not.toContain("next/font/google");
    const paths = [...layout.matchAll(/path: "\.\/(fonts\/[^"]+\.woff2)"/g)].map((m) => m[1]);
    expect(paths).toHaveLength(8); // Montserrat 600/700/800, Plex Sans 400/500/600/700, Plex Mono 500
    for (const path of paths) {
      const file = readFileSync(join(ROOT, "app", path));
      expect([path, file.subarray(0, 4).toString()]).toEqual([path, "wOF2"]);
    }
    for (const family of ["montserrat", "ibm-plex-sans", "ibm-plex-mono"]) {
      expect(source(`app/fonts/${family}/OFL.txt`)).toContain("SIL Open Font License, Version 1.1");
    }
  });
});

describe("toasts have ONE provider, in the root layout", () => {
  it("is mounted by the root layout and by nothing else", () => {
    expect(source("app/layout.tsx")).toContain("<ToastProvider>{children}</ToastProvider>");
    for (const file of ["app/login/page.tsx", "components/shell/app-shell.tsx", "app/(app)/layout.tsx"]) {
      expect([file, source(file).includes("ToastProvider")]).toEqual([file, false]);
    }
  });
});

describe("analytics is gated and off", () => {
  const slot = () => document.querySelector("[data-analytics-slot]");

  it("reads consent from its cookie; absent or unknown is not consent", () => {
    expect(readAnalyticsConsent("")).toBeNull();
    expect(readAnalyticsConsent(`a=1; ${CONSENT_COOKIE}=granted`)).toBe("granted");
    expect(readAnalyticsConsent(`${CONSENT_COOKIE}=denied`)).toBe("denied");
    expect(readAnalyticsConsent(`${CONSENT_COOKIE}=yes`)).toBeNull();
    expect(analyticsEnabled(undefined, "granted")).toBe(false);
    expect(analyticsEnabled("G-TEST", null)).toBe(false);
    expect(analyticsEnabled("G-TEST", "denied")).toBe(false);
    expect(analyticsEnabled("G-TEST", "granted")).toBe(true);
  });

  it("renders nothing without a measurement id, even with consent", async () => {
    document.cookie = `${CONSENT_COOKIE}=granted; path=/`;
    render(<Analytics measurementId={undefined} />);
    await act(async () => undefined);
    expect(slot()).toBeNull();
  });

  it("renders nothing with an id but no consent, or with consent denied", async () => {
    render(<Analytics measurementId="G-TEST" />);
    await act(async () => undefined);
    expect(slot()).toBeNull();
    cleanup();
    document.cookie = `${CONSENT_COOKIE}=denied; path=/`;
    render(<Analytics measurementId="G-TEST" />);
    await act(async () => undefined);
    expect(slot()).toBeNull();
  });

  it("opens the slot only with an id AND consent — and loads no script", async () => {
    document.cookie = `${CONSENT_COOKIE}=granted; path=/`;
    render(<Analytics measurementId="G-TEST" />);
    await act(async () => undefined);
    expect(slot()).toHaveAttribute("data-analytics-slot", "G-TEST");
    expect(document.querySelectorAll("script")).toHaveLength(0);
  });

  it("is off in this deployment: no NEXT_PUBLIC_GA_ID is configured", () => {
    expect(process.env.NEXT_PUBLIC_GA_ID).toBeUndefined();
    expect(existsSync(join(ROOT, ".env.local"))).toBe(false);
  });
});
