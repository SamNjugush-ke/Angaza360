// Names shared by the server modules and proxy.ts (which cannot import "server-only" modules).
// Server code only: no client component imports this file.

/** The HttpOnly access-token cookie. */
export const SESSION_COOKIE = "ag_session";

/**
 * RETIRED (T-B-ME-NAME): the business name used to be captured at login in this cookie; /v1/auth/me
 * now carries it. Only expired now, so a browser that still holds one drops it.
 */
export const LEGACY_TENANT_NAME_COOKIE = "ag_tenant_name";

/** Set by proxy.ts on protected requests, so a server layout can build a returnTo. */
export const PATHNAME_HEADER = "x-angaza-pathname";

/** Where proxy.ts sends a page load whose access token has expired but can be refreshed: under
 *  the refresh cookie's own path, so the browser sends that cookie with it. */
export const REFRESH_CONTINUE_PATH = "/api/auth/refresh/continue";

/** Where a signed-in visitor's "/" is sent: it resolves their role's workspace (app/workspace). */
export const WORKSPACE_PATH = "/workspace";
