// ===========================================================================
// GOOGLE-SIGNED OIDC FOR THE MACHINE JOB TRIGGER (M4.5 Wave 5).
//
// GCP Cloud Scheduler can call the trigger with `Authorization: Bearer <ID token>` — a JWT Google
// signs (RS256) for the scheduler's service account. It is accepted ONLY when every check passes:
//   * the signature verifies against GOOGLE'S PUBLISHED KEYS (the JWKS at GOOGLE_JWKS_URL, cached by
//     its Cache-Control max-age), by the `kid` in the token header, algorithm RS256 only;
//   * `iss` is accounts.google.com or https://accounts.google.com;
//   * `aud` equals JOB_TRIGGER_OIDC_AUDIENCE (unset = the OIDC path is OFF);
//   * `exp` is in the future and `iat` / `nbf` not in the future (60 s of clock skew);
//   * when JOB_TRIGGER_OIDC_SERVICE_ACCOUNT is set, `email` equals it and `email_verified` is true.
// Anything else is simply "not authorised" — the route answers the same bare 404 as a wrong secret.
// Verification uses node:crypto only (a JWK becomes a public key; the signature is checked over the
// exact header.payload bytes). The key fetcher is swappable for tests; nothing here logs a token.
// ===========================================================================

import { createPublicKey, verify as verifySignature, type webcrypto } from "node:crypto";

type JsonWebKey = webcrypto.JsonWebKey;

export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const SKEW_SECONDS = 60;

interface Jwks {
  keys: Array<JsonWebKey & { kid?: string; alg?: string; kty?: string }>;
}

/** Fetches Google's keys; returns them with how long they may be cached. Swappable for tests. */
export const jwksSource = {
  async fetch(): Promise<{ jwks: Jwks; maxAgeSeconds: number }> {
    const response = await fetch(GOOGLE_JWKS_URL, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`Google's signing keys could not be fetched (HTTP ${response.status.toString()}).`);
    const maxAge = /max-age=(\d+)/.exec(response.headers.get("cache-control") ?? "");
    return { jwks: (await response.json()) as Jwks, maxAgeSeconds: maxAge ? Number(maxAge[1]) : 3_600 };
  },
};

let cache: { jwks: Jwks; until: number } | null = null;

/** Clears the cached keys (tests, and a key the cache does not know yet). */
export function clearJwksCache(): void {
  cache = null;
}

async function keyFor(kid: string): Promise<JsonWebKey | null> {
  const now = Date.now();
  if (cache === null || cache.until <= now || !cache.jwks.keys.some((k) => k.kid === kid)) {
    const fetched = await jwksSource.fetch();
    cache = { jwks: fetched.jwks, until: now + Math.min(fetched.maxAgeSeconds, 86_400) * 1_000 };
  }
  return cache.jwks.keys.find((k) => k.kid === kid && (k.kty ?? "RSA") === "RSA") ?? null;
}

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface OidcPolicy {
  audience: string;
  serviceAccount: string | null;
}

/** The configured policy, or null when the OIDC path is off. */
export function oidcPolicy(): OidcPolicy | null {
  const audience = process.env.JOB_TRIGGER_OIDC_AUDIENCE?.trim();
  if (audience === undefined || audience === "") return null;
  const account = process.env.JOB_TRIGGER_OIDC_SERVICE_ACCOUNT?.trim();
  return { audience, serviceAccount: account === undefined || account === "" ? null : account.toLowerCase() };
}

/** True only for a Google-signed ID token meeting every check of the policy. Never throws. */
export async function verifyGoogleIdToken(token: string, policy: OidcPolicy, now: Date = new Date()): Promise<boolean> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const [rawHeader = "", rawPayload = "", rawSignature = ""] = parts;
    const header = decodePart(rawHeader);
    const payload = decodePart(rawPayload);
    if (header === null || payload === null) return false;
    if (header.alg !== "RS256" || typeof header.kid !== "string") return false;
    const jwk = await keyFor(header.kid);
    if (jwk === null) return false;
    const signed = verifySignature("RSA-SHA256", Buffer.from(`${rawHeader}.${rawPayload}`), createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(rawSignature, "base64url"));
    if (!signed) return false;

    const seconds = Math.floor(now.getTime() / 1_000);
    if (typeof payload.iss !== "string" || !ISSUERS.has(payload.iss)) return false;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(policy.audience)) return false;
    if (typeof payload.exp !== "number" || payload.exp + SKEW_SECONDS <= seconds) return false;
    if (typeof payload.iat === "number" && payload.iat - SKEW_SECONDS > seconds) return false;
    if (typeof payload.nbf === "number" && payload.nbf - SKEW_SECONDS > seconds) return false;
    if (policy.serviceAccount !== null) {
      if (typeof payload.email !== "string" || payload.email.toLowerCase() !== policy.serviceAccount) return false;
      if (payload.email_verified !== true) return false;
    }
    return true;
  } catch {
    // A malformed key, token or signature is simply not a valid token.
    return false;
  }
}
