import { SITE_URL } from "@/lib/brand";

// APEX / APP HOST SPLIT. The same build serves the marketing site on the apex and the application
// on its own host. Only "/" differs between them: on the marketing host an anonymous visitor sees
// the landing page; on the app host (app.<domain>, or a business's own subdomain) "/" is the door
// to the application, so an anonymous visitor goes to sign in. A signed-in visitor goes to their
// workspace on either.
//
// Configured by env, read at request time (server-side, never sent to the browser):
//   MARKETING_HOST  the apex, e.g. angaza360.co.ke         (default: SITE_URL's host)
//   APP_HOST        the application host                    (default: app.<MARKETING_HOST>)
// Any other subdomain of MARKETING_HOST except www is a business's subdomain, so the app; www is
// the marketing site (the edge redirects it to the apex anyway). A host matching neither —
// localhost, 127.0.0.1, a preview deployment — is treated as marketing, so local development
// keeps "/" = the landing page.

export type HostKind = "marketing" | "app";

export interface HostConfig {
  marketingHost: string;
  appHost: string;
}

/** A bare, lower-case hostname: no port, no trailing dot. Empty for nothing usable. */
export function normalizeHost(value: string | null | undefined): string {
  if (!value) return "";
  let host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    // An IPv6 literal: [::1]:3000
    const end = host.indexOf("]");
    return end === -1 ? "" : host.slice(0, end + 1);
  }
  const colon = host.indexOf(":");
  if (colon !== -1) host = host.slice(0, colon);
  return host.replace(/\.$/, "");
}

export function hostConfig(env: Readonly<Record<string, string | undefined>> = process.env): HostConfig {
  const marketingHost = normalizeHost(env.MARKETING_HOST) || normalizeHost(new URL(SITE_URL).host);
  const appHost = normalizeHost(env.APP_HOST) || `app.${marketingHost}`;
  return { marketingHost, appHost };
}

export function hostKind(host: string | null | undefined, config: HostConfig): HostKind {
  const name = normalizeHost(host);
  if (!name) return "marketing";
  if (name === config.appHost) return "app";
  if (name === config.marketingHost || name === `www.${config.marketingHost}`) return "marketing";
  if (config.marketingHost && name.endsWith(`.${config.marketingHost}`)) return "app";
  return "marketing";
}
