// ===========================================================================
// THE BRAND — the single source of truth for the product name and the base domain
// (Task T-A14). This is the ONLY file in which either literal may appear;
// test/brand/no-stale-brand.test.ts pins that no legacy name survives elsewhere.
//
// A plain module with no env dependency. The base domain may become deployment
// configuration later; callers already go through tenantHost, so that is a change here.
// ===========================================================================

export const PRODUCT_NAME = "Angaza360";

export const BASE_DOMAIN = "angaza360.co.ke";

/** A tenant's host on the base domain: `<subdomain>.angaza360.co.ke`. */
export function tenantHost(subdomain: string): string {
  return `${subdomain}.${BASE_DOMAIN}`;
}
