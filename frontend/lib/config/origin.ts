import "server-only";

// The app's own origin, for the CSRF Origin check. Behind a reverse proxy that rewrites the Host
// header, set APP_ORIGIN (e.g. https://app.angaza360.co.ke) so the check compares against the
// public origin; otherwise the request's own host is the app's host.

export function configuredAppOrigin(): string | null {
  const value = process.env.APP_ORIGIN;
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    throw new Error(`APP_ORIGIN is not a valid URL: "${value}"`);
  }
}

/** The host a same-origin request's Origin header must name. */
export function expectedAppHost(requestHost: string): string {
  const origin = configuredAppOrigin();
  return origin === null ? requestHost : new URL(origin).host;
}
