import { PROTECTED_PREFIXES } from "@/lib/auth/landing";

// What the crawlers are told. The indexable routes are the landing page ("/"), the sign-in page
// and the business application; the password-reset and invitation pages are noindex (a recovery step or a
// single-use invitation has nothing to rank for). Every authenticated prefix (the app, admin and
// mentorship areas), the BFF (/api), /invite — whose addresses carry an invitation's secret — and
// /workspace (a signed-in redirect with nothing to show a crawler) are disallowed; the protected ones derive from PROTECTED_PREFIXES, so a new protected section
// is disallowed by default.

export const INDEXABLE_PATHS = ["/", "/login", "/signup", "/privacy", "/terms", "/cookies", "/acceptable-use", "/contact"] as const;

export const DISALLOWED_PATHS: readonly string[] = [...PROTECTED_PREFIXES, "/api", "/application", "/invite", "/setup", "/workspace"];
