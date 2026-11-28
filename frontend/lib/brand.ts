// The frontend's brand source of truth: the product name, the site's base URL and the
// one-line description. Every page and the metadata read these — no other file carries
// the literals. (The backend's counterpart is backend/src/config/brand.ts.)

export const PRODUCT_NAME = "Angaza360";

/**
 * The CANONICAL host (the apex), which metadataBase, canonicals, the sitemap and JSON-LD resolve
 * against. The app itself is served from app.angaza360.co.ke and stays noindex; www → apex is a
 * redirect at the edge (see README).
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://angaza360.co.ke";

/** The same sentence as site.webmanifest's description. */
export const PRODUCT_DESCRIPTION =
  "All-in-one accounting, POS, inventory, payroll and KRA eTIMS compliance for Kenyan businesses.";

/** The brand primary — the browser theme colour and site.webmanifest's theme_color. */
export const THEME_COLOR = "#006078";

/** The landing page's headline promise — its <title> and its Open Graph title. */
export const PRODUCT_TAGLINE = "Point of sale, stock, books, payroll and KRA eTIMS for Kenyan businesses";
