import { describe, expect, it } from "vitest";
import { parseAppBaseUrl } from "../../src/config/env";

// T-B-INVITE-LINK: invitation links point at APP_BASE_URL — required and https in production,
// the Next.js dev server by default elsewhere.

describe("APP_BASE_URL", () => {
  it("defaults to the local web app outside production and drops a trailing slash", () => {
    expect(parseAppBaseUrl(undefined, "development")).toBe("http://localhost:3000");
    expect(parseAppBaseUrl("https://app.angaza360.co.ke/", "production")).toBe("https://app.angaza360.co.ke");
  });

  it("is required, and https, in production", () => {
    expect(() => parseAppBaseUrl(undefined, "production")).toThrow(/Missing required environment variable: APP_BASE_URL/);
    expect(() => parseAppBaseUrl("http://app.angaza360.co.ke", "production")).toThrow(/https in production/);
    expect(() => parseAppBaseUrl("not a url", "development")).toThrow(/is not a URL/);
    expect(() => parseAppBaseUrl("ftp://x.test", "development")).toThrow(/http\(s\)/);
  });
});
