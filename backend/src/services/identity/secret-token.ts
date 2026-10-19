// ===========================================================================
// Single-use bearer secrets for identity flows (Task T-A4; reused by T-A5).
//
// A password-reset code and a staff-invitation token are generated here and stored
// ONLY as their sha256 hex — exactly how sessions."refreshTokenHash" stores a
// refresh token. The raw value is returned to the caller once, to be delivered to
// its subject through the notification channel, and is never persisted or logged.
// ===========================================================================

import { createHash, randomBytes } from "node:crypto";

const TOKEN_BYTES = 32; // 256 bits

export interface IssuedSecretToken {
  /** The raw token. Delivered once to its subject; never stored, never logged. */
  readonly raw: string;
  /** sha256 hex of the raw token — the only form the database holds. */
  readonly hash: string;
}

export function hashSecretToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function issueSecretToken(): IssuedSecretToken {
  const raw = randomBytes(TOKEN_BYTES).toString("base64url");
  return { raw, hash: hashSecretToken(raw) };
}
