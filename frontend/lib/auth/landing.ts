import type { paths } from "@/lib/api/schema";

// Where each role lands after signing in, and which paths sit behind a session. Shared by the
// server (the root redirect, the proxy) and the login form; it holds no secret.

export type Role = paths["/v1/auth/me"]["get"]["responses"][200]["content"]["application/json"]["role"];

export const ROLE_LANDING: Readonly<Record<Role, string>> = {
  MSME_OWNER: "/dashboard",
  MSME_MANAGER: "/dashboard",
  ACCOUNTANT: "/dashboard",
  VIEWER_AUDITOR: "/dashboard",
  CASHIER: "/pos",
  WAREHOUSE_STAFF: "/inventory",
  HR_OFFICER: "/payroll",
  MENTOR: "/mentorship",
  COACH: "/mentorship",
  SUPER_ADMIN: "/admin",
  PROGRAM_OFFICER: "/admin",
};

/** Every path under these prefixes requires a session. */
export const PROTECTED_PREFIXES = [
  "/dashboard",
  "/pos",
  "/sales",
  "/products",
  "/inventory",
  "/procurement",
  "/customers",
  "/expenses",
  "/accounting",
  "/payroll",
  "/tax",
  "/people",
  "/settings",
  "/mentorship",
  "/admin",
  // A business's own reports and exports (M4.5 W4, T-B4).
  "/exports",
  // The signed-in person's OWN account (M4.5 W1: two-step verification) — every role.
  "/account",
] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/**
 * A returnTo is honoured only when it is a same-site path inside the protected area — never an
 * absolute URL, a protocol-relative "//host", a backslash trick or anything outside the app, so
 * the login redirect cannot be turned into an open redirect.
 */
export function safeReturnTo(value: string | null | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(value, "http://same.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://same.invalid" || !isProtectedPath(url.pathname)) return null;
  return `${url.pathname}${url.search}`;
}

/** Where a role lands; a valid returnTo wins. */
export function landingFor(role: Role, returnTo?: string | null): string {
  return safeReturnTo(returnTo) ?? ROLE_LANDING[role];
}
