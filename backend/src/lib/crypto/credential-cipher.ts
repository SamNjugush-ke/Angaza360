// ===========================================================================
// Credential cipher (Task 3.4) — AES-256-GCM over node:crypto ONLY.
//
// This is the single encryption primitive for integration secrets. It is
// deliberately shape-agnostic: it encrypts and decrypts an opaque JSON string.
// What is INSIDE that JSON is the credential store's / provider-schemas'
// business, never this module's.
//
// GCM (not CBC) because it is authenticated: a tampered ciphertext, IV, or tag
// fails the auth-tag check instead of decrypting to plausible garbage. That is
// what makes a credential row tamper-EVIDENT rather than merely encrypted.
//
// THE KMS SEAM. Every blob carries a `keyRef` naming WHICH key encrypted it.
// This module owns exactly one keyRef ("app-v1"). A row carrying any other
// keyRef is refused here with a message naming it, so a future Cloud KMS
// migration is: re-encrypt each blob under the KMS key, write the new keyRef,
// and route that keyRef to the KMS decryptor. No schema change, and no chance
// of an app-encrypted and a KMS-encrypted row being confused for one another.
//
// NEVER logged: the key, the plaintext, or any decrypted field. No error
// message in this file interpolates key material or plaintext.
// ===========================================================================

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce: the GCM-recommended size
const AUTH_TAG_BYTES = 16;

// The key this module owns. Bump the suffix (and keep decrypt support for the
// old value) if the application-level key is ever rotated in place.
export const APP_KEY_REF = "app-v1";

// The encrypted blob, split into the four columns the credential tables carry.
// All parts are base64.
export interface EncryptedCredential {
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly keyRef: string;
}

// Thrown when a stored blob cannot be turned back into its plaintext: tampered
// ciphertext/IV/tag, a key that no longer matches, an unrecognised keyRef, or a
// decrypted payload that is not the expected JSON object. Deliberately distinct
// from CredentialValidationError (which is about a well-decrypted blob whose
// FIELDS are wrong).
export class CredentialDecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialDecryptError";
  }
}

export function encryptCredential(plaintextJson: string): EncryptedCredential {
  // A fresh random IV per encryption. Reusing an IV under the same key is
  // catastrophic for GCM, so it is never derived from or stored with anything
  // reusable.
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, env.credentialEncryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintextJson, "utf8"),
    cipher.final(),
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
    keyRef: APP_KEY_REF,
  };
}

export function decryptCredential(parts: EncryptedCredential): string {
  if (parts.keyRef !== APP_KEY_REF) {
    // The KMS seam. This is not a failure of the data — it is a blob this
    // decryptor does not own.
    throw new CredentialDecryptError(
      `Credential is encrypted under keyRef "${parts.keyRef}", which the application-level cipher does not recognise (it owns only "${APP_KEY_REF}"). Route this row to the key manager that owns that keyRef.`,
    );
  }

  const iv = Buffer.from(parts.iv, "base64");
  if (iv.length !== IV_BYTES) {
    throw new CredentialDecryptError(
      `Credential IV is ${iv.length} bytes; AES-256-GCM requires ${IV_BYTES}. The stored row is corrupt.`,
    );
  }
  const authTag = Buffer.from(parts.authTag, "base64");
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new CredentialDecryptError(
      `Credential auth tag is ${authTag.length} bytes; AES-256-GCM requires ${AUTH_TAG_BYTES}. The stored row is corrupt.`,
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, env.credentialEncryptionKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(parts.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    // decipher.final() throws when the GCM tag does not verify. The cause is
    // always one of: the ciphertext was tampered with, the tag was tampered
    // with, or the row was encrypted under a different key. We do not echo the
    // ciphertext or any key material — only the fact and the causes.
    throw new CredentialDecryptError(
      "Credential could not be decrypted: the AES-256-GCM authentication tag did not verify. The stored blob was tampered with, or it was encrypted under a different key.",
    );
  }
}

// A credential blob is a flat JSON object of string fields. Callers hand this
// module an object and get a string back (and vice versa) so no caller ever
// hand-rolls JSON around a secret.
export type CredentialFieldMap = Readonly<Record<string, string>>;

export function serialiseCredentialFields(fields: CredentialFieldMap): string {
  return JSON.stringify(fields);
}

export function parseCredentialFields(json: string): CredentialFieldMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CredentialDecryptError(
      "Decrypted credential blob is not valid JSON. The stored row is corrupt.",
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CredentialDecryptError(
      "Decrypted credential blob is not a JSON object of fields. The stored row is corrupt.",
    );
  }
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      // Field NAMES are safe to surface (they are schema, not secrets); values
      // never are.
      throw new CredentialDecryptError(
        `Decrypted credential blob field "${key}" is not a string. The stored row is corrupt.`,
      );
    }
    fields[key] = value;
  }
  return fields;
}
