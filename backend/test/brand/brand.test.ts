// ===========================================================================
// THE BRAND (Task T-A14): one source of truth for the product name and base domain.
// ===========================================================================

import { describe, expect, it } from "vitest";
import { BASE_DOMAIN, PRODUCT_NAME, tenantHost } from "../../src/config/brand";

describe("brand", () => {
  it("names the product Angaza360 on angaza360.co.ke", () => {
    expect(PRODUCT_NAME).toBe("Angaza360");
    expect(BASE_DOMAIN).toBe("angaza360.co.ke");
  });

  it("builds a tenant's host on the base domain", () => {
    expect(tenantHost("acme")).toBe("acme.angaza360.co.ke");
  });
});
