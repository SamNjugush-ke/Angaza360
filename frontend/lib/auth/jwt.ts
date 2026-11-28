// Reading an access JWT's `exp` claim WITHOUT verifying it — shared by the cookie writer (to size
// a persistent cookie) and proxy.ts (to notice an expired session before rendering). Neither
// trusts the token: the backend verifies it on every call. No "server-only" and no Node Buffer,
// so the proxy can import it.

/** Seconds of slack: a token this close to expiry is treated as expired, so a page load never
 *  starts with a token that dies mid-render. */
export const EXPIRY_SKEW_SECONDS = 30;

function decodeBase64Url(segment: string): string {
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** The token's `exp` (epoch seconds), or null when it has none that can be read. */
export function jwtExpiry(token: string): number | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  let claims: unknown;
  try {
    claims = JSON.parse(decodeBase64Url(payload));
  } catch {
    // Not a readable JWT payload: there is no expiry to report.
    return null;
  }
  if (typeof claims === "object" && claims !== null && "exp" in claims && typeof claims.exp === "number") {
    return claims.exp;
  }
  return null;
}

/**
 * Whether an access token is worth sending. Absent -> no. No readable exp -> yes (the backend is
 * the judge, and requireSession asks it). Otherwise, yes until EXPIRY_SKEW_SECONDS before exp.
 */
export function isAccessTokenUsable(token: string | undefined, nowSeconds: number = Date.now() / 1000): boolean {
  if (!token) return false;
  const exp = jwtExpiry(token);
  return exp === null || exp - EXPIRY_SKEW_SECONDS > nowSeconds;
}
