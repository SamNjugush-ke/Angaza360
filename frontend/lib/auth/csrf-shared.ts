// The CSRF double-submit names, shared by the server (which sets and checks them) and the
// browser (which echoes the readable cookie in a header). The CSRF token is NOT a credential:
// it only proves a request came from a page that can read this site's cookies. Nothing here
// names or touches the access or refresh token, which stay HttpOnly and server-side.

export const CSRF_COOKIE = "ag_csrf";
export const CSRF_HEADER = "x-csrf-token";

/** The CSRF token from a cookie string (the browser's document.cookie), or null. */
export function readCsrfToken(cookieString: string): string | null {
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq !== -1 && part.slice(0, eq).trim() === CSRF_COOKIE) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return null;
}
